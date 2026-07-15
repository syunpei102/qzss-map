const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");
const webpush = require("web-push");
const compression = require("compression");
const { Storage } = require("@google-cloud/storage");
const { verifyKey, InteractionType, InteractionResponseType, InteractionResponseFlags } = require("discord-interactions");

// ==== 設定 ====
// ローカルでもCloud Run上でも同じコードで動くように、
// 静的ファイル配信・WebSocket配信・受信API(/ingest)を
// すべて同じHTTPサーバー/ポートにまとめている。
const PORT = process.env.PORT || 8080;
const INGEST_TOKEN = (process.env.INGEST_TOKEN || "").trim();
const FIFO_PATH = path.resolve(__dirname, "qzss_pipe");
const PUBLIC_DIR = path.resolve(__dirname, "public");

const app = express();
// 市区町村境界データ(municipalities.geojson、数MB)を素で返すと
// 特にモバイル回線で初回読み込みが遅くなるため、gzip圧縮する
app.use(compression());
// 地図データ(pmtiles/geojson)は展示中・運用中はほぼ変化しないため、
// ブラウザに一定時間キャッシュさせて往復を減らす(ラズパイのループバック
// (kiosk表示)では無視できるコストだが、Cloud Run経由のWeb配信では
// 地味に効いてくる)。
//
// 注意: immutable指定はあえて付けていない。immutableにすると
// キャッシュ有効期間中はブラウザが確認リクエストすら送らなくなり、
// こちらがデータを更新しても同じファイル名のままだと最大キャッシュ
// 期間ぶん反映が遅れて気づけない、という事故が起きうる。maxAgeだけに
// しておけば、期限が切れた際にブラウザが軽い確認(If-None-Match等)を
// 送り、中身が同じならほぼノーコストな304応答、変わっていれば自動的に
// 新しい内容を取得する(=更新の反映漏れが起きない)。1日程度に留め、
// 万一のズレも自動的に解消されるようにする
app.use('/data', express.static(path.join(PUBLIC_DIR, 'data'), {
  maxAge: '1d',
}));
app.use(express.static(PUBLIC_DIR));
// Discord Interactionsの署名検証には生のリクエストボディが要る。
// express.jsonのverifyフックでパースする前の生バイト列を控えておく
// (他のルートはreq.bodyだけ使うので、この変更による影響は無い)
app.use(express.json({
  limit: "256kb",
  verify: (req, res, buf) => { req.rawBody = buf; },
}));

// ==== プッシュ通知(Web Push) ====
// VAPID鍵は `npx web-push generate-vapid-keys` で生成し、環境変数で渡す。
// 未設定でも他の機能(地図表示・WebSocket)には影響しない(通知だけ無効になる)。
const VAPID_PUBLIC_KEY = (process.env.VAPID_PUBLIC_KEY || "").trim();
const VAPID_PRIVATE_KEY = (process.env.VAPID_PRIVATE_KEY || "").trim();
const PUSH_ENABLED = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (PUSH_ENABLED) {
  webpush.setVapidDetails("mailto:qzss-map@example.com", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn("⚠️ VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY が未設定です。プッシュ通知は無効化されます。");
}

// 購読情報はメモリ上にのみ保持する(このプロジェクトの規模では十分。
// Cloud Runの再デプロイ/再起動で失われるが、その場合はアプリ側の
// 「通知を有効にする」ボタンを再度押してもらえば再登録される)。
const pushSubscriptions = new Map(); // endpoint -> subscription object

app.post("/push/subscribe", (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: "invalid subscription" });
  pushSubscriptions.set(sub.endpoint, sub);
  console.log(`🔔 プッシュ通知を購読登録しました(現在 ${pushSubscriptions.size} 件)`);
  res.status(201).json({ ok: true });
});

app.post("/push/unsubscribe", (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  if (endpoint) pushSubscriptions.delete(endpoint);
  res.status(204).end();
});

app.get("/push/vapid-public-key", (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY, enabled: PUSH_ENABLED });
});

// 地図に表示している対象(緊急地震速報・震源・震度速報・津波・
// 南海トラフ・火山・降灰・気象警報・洪水)を全て通知する。ラズパイ側で
// 既に重要度フィルタ済みなので、届いた時点でカテゴリを絞る必要はほぼ
// ないが、念のためHeartbeat等を除外する。台風(12)は表示自体をしない
// ため通知もしない。
const PUSH_NOTIFY_CATEGORY_NOS = new Set([1, 2, 3, 4, 5, 8, 9, 10, 11]);

function shouldNotify(report) {
  if (!PUSH_ENABLED || !report) return false;
  if (report.type === "Heartbeat" || report.type === "DecodeError") return false;
  if (report.type === "QzssDcxJAlert" || report.type === "QzssDcxLAlert") return true;
  return PUSH_NOTIFY_CATEGORY_NOS.has(report.disaster_category_no);
}

const JALERT_HAZARD_JA = {
  "Missile attack": "ミサイル発射",
  "Air strike": "航空攻撃",
  "Guerrilla attack": "ゲリラ・特殊部隊による攻撃",
  "Terrorism": "テロ",
  "Chemical attack": "化学攻撃",
  "Attack with nuclear weapons": "核攻撃",
  "Earthquake": "地震",
  "Tsunami": "津波",
  "Volcano eruption": "火山噴火",
  "Safety warning": "安全に関する警告",
};

// Lアラート(地方公共団体からの災害情報)は180種類近いCAP標準の災害種別を
// 取りうるが、日本の市区町村が実際に発信するものはこの範囲にほぼ収まる。
// 未知の種別は英語のまま表示する(Jアラートと同じフォールバック方針)
const LALERT_HAZARD_JA = {
  "Earthquake": "地震",
  "Tsunami": "津波",
  "Tidal wave": "高波",
  "Flood": "洪水",
  "Coastal flooding": "高潮",
  "Rainfall": "大雨",
  "Debris flow": "土石流",
  "Landslide": "地すべり",
  "Crack in the ground / sinkhole": "地割れ・陥没",
  "Avalanche risk": "雪崩",
  "Snowdrifts": "吹きだまり",
  "Snow storm / blizzard": "暴風雪",
  "Snowfall": "大雪",
  "Volcano eruption": "火山噴火",
  "Ash fall": "降灰",
  "Lava flow": "溶岩流",
  "Pyroclastic flow": "火砕流",
  "Volcanic mud flow": "融雪型火山泥流",
  "Tornado": "竜巻",
  "Tropical cyclone (typhoon)": "台風",
  "Storm or thunderstorm": "暴風・雷",
  "Wind / wave / storm surge": "強風・高波・高潮",
  "Lightning": "雷",
  "Hail": "ひょう",
  "Structure fire / Industrial fire": "火災",
  "Forest fire": "林野火災",
  "Building collapse": "建物倒壊",
  "Dam failure or bursting of a dam": "ダム決壊",
  "Dike failure or bursting of a dike": "堤防決壊",
  "Life Threatening situation": "生命に関わる状況",
  "Safety warning": "安全に関する警告",
};

function notificationTitleFor(report) {
  let title;
  if (report.type === "QzssDcxJAlert") {
    title = "Jアラート: " + (JALERT_HAZARD_JA[report.a4_hazard_type] || report.a4_hazard_type || "緊急情報");
  } else if (report.type === "QzssDcxLAlert") {
    const hazard = LALERT_HAZARD_JA[report.a4_hazard_type] || report.a4_hazard_type || "災害情報";
    title = report.a1_message_type === "All Clear" ? `Lアラート解除: ${hazard}` : `Lアラート: ${hazard}`;
  } else {
    const titles = {
      1: "緊急地震速報", 2: "震源に関する情報", 3: "震度速報", 5: "津波情報",
      4: "南海トラフ地震関連情報", 8: "噴火警報・予報", 9: "降灰予報",
      10: "気象警報・注意報", 11: "洪水予報",
    };
    title = titles[report.disaster_category_no] || report.disaster_category || "防災情報";
  }
  if (report.is_test_data) return `[テスト]${title}`;
  // report_classification_no===7は衛星から実際に配信される公式の訓練/試験放送
  // (自分で送るテストデータとは別物)。本物の警報と見分けがつくようにする
  if (report.report_classification_no === 7) return `[訓練]${title}`;
  return title;
}

function notificationBodyFor(report) {
  if (report.information_type_no === 2) return "キャンセル報";
  if (report.type === "QzssDcxJAlert") {
    const areas = report.ex9_target_area_list_ja || [];
    return areas.length ? areas.slice(0, 5).join("・") + (areas.length > 5 ? " 他" : "") : "アプリを開いて確認してください。";
  }
  if (report.type === "QzssDcxLAlert") {
    if (report.ex1_target_area_ja) return report.ex1_target_area_ja;
    if (typeof report.a14_ellipse_semi_major_axis === "number") {
      return `半径約${Math.round(report.a14_ellipse_semi_major_axis)}km圏内`;
    }
    return "アプリを開いて確認してください。";
  }
  if (report.seismic_epicenter) {
    const mag = report.magnitude ? ` M${report.magnitude}` : "";
    return `${report.seismic_epicenter}${mag}`;
  }
  if (report.tsunami_warning_code) return report.tsunami_warning_code;
  if (report.disaster_category_no === 10) {
    const regions = (report.weather_forecast_regions || []).join("・");
    const subs = [...new Set(report.weather_related_disaster_sub_categories || [])].join("・");
    if (regions && subs) return `${regions} ${subs}`;
    return regions || subs || "アプリを開いて確認してください。";
  }
  if (report.disaster_category_no === 11) {
    const regions = (report.flood_forecast_regions || []).join("・");
    const levels = [...new Set(report.flood_warning_levels || [])].join("・");
    if (regions && levels) return `${regions} ${levels}`;
    return regions || levels || "アプリを開いて確認してください。";
  }
  if (report.disaster_category_no === 8) {
    const name = report.volcano_name || "";
    const code = report.volcanic_warning_code || "";
    if (name && code) return `${name} ${code}`;
    return name || code || "アプリを開いて確認してください。";
  }
  if (report.disaster_category_no === 9) {
    const name = report.volcano_name || "";
    const codes = [...new Set(report.ash_fall_warning_codes || [])].join("・");
    if (name && codes) return `${name} ${codes}`;
    return name || codes || "アプリを開いて確認してください。";
  }
  const firstLine = (report.description || "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("防災気象情報"));
  return firstLine || "アプリを開いて確認してください。";
}

function sendPushNotifications(report) {
  if (!shouldNotify(report) || pushSubscriptions.size === 0) return;
  const payload = JSON.stringify({
    title: notificationTitleFor(report),
    body: notificationBodyFor(report),
  });
  for (const [endpoint, sub] of pushSubscriptions) {
    webpush.sendNotification(sub, payload).catch((err) => {
      if (err.statusCode === 410 || err.statusCode === 404) {
        pushSubscriptions.delete(endpoint);
      } else {
        console.error("⚠️ プッシュ通知の送信に失敗しました:", err.statusCode || err.message);
      }
    });
  }
}

// 現在「表示中」とみなせる重要な通報を覚えておき、ブラウザが
// リロード/新規接続した時に再送する(そうしないとページを開き直すだけで
// 表示がリセットされてしまう)。取消・津波警報解除など「終了」を示す
// 信号を受信したら、保持していた分から該当するものだけを取り除く。
//
// 過去にはここで activeReports = [] と「全部」消していたため、例えば
// EEWの取消が1件届いただけで、同時にアクティブだった無関係の気象警報や
// Lアラートまで(新規接続したブラウザから見て)消えてしまうバグがあった
// (52パターンのテストケースを流して発見)。reportGroupKey で「同じ
// 通報グループ」を判定し、一致するものだけを取り除くようにする。
let activeReports = [];

function isEndSignal(report) {
  if (!report) return false;
  if (report.information_type_no === 2) return true; // キャンセル報(取消)
  if (report.disaster_category_no === 5 && [1, 2].includes(report.tsunami_warning_code_raw)) return true; // 津波警報解除/なし
  // Jアラート/Lアラート(DCX)の解除。DCRの取消(information_type_no)とは
  // 別の仕組みで、a1_message_typeが'All Clear'になる
  if ((report.type === "QzssDcxJAlert" || report.type === "QzssDcxLAlert") && report.a1_message_type === "All Clear") return true;
  return false;
}

// 「同じ災害・同じ対象」とみなせる通報どうしをまとめるための緩いキーを作る。
// クライアント側(main.js)の epicenterRaw/lalertMatchKey 等と考え方を
// 揃えているが、こちらは「新規接続時に何を再送するか」の粗い絞り込み用
// なので、完全な一致判定ではなく「取消が無関係の通報まで巻き込まない」
// ことを目的とした簡易版にとどめる。
function reportGroupKey(report) {
  if (!report) return null;
  if (report.type === "QzssDcxJAlert") {
    const areas = [...(report.ex9_target_area_list_ja || [])].sort().join(",");
    return `jalert|${report.a4_hazard_type || ""}|${areas}`;
  }
  if (report.type === "QzssDcxLAlert") {
    if (typeof report.ex1_target_area_code_raw === "number") {
      return `lalert|${report.a4_hazard_type || ""}|ex1:${report.ex1_target_area_code_raw}`;
    }
    if (typeof report.a12_ellipse_centre_latitude === "number") {
      return `lalert|${report.a4_hazard_type || ""}|ellipse:${report.a12_ellipse_centre_latitude.toFixed(2)},${report.a13_ellipse_centre_longitude.toFixed(2)}`;
    }
    return `lalert|${report.a4_hazard_type || ""}|unknown`;
  }
  if (report.disaster_category_no === 5) return "tsunami"; // 津波は種別を問わずまとめて解除扱い
  if (report.disaster_category_no === 10) {
    const codes = [...(report.weather_forecast_regions_raw || [])].sort().join(",");
    return `weather|${codes}`;
  }
  if (typeof report.disaster_category_no === "number") {
    if ([1, 2, 3].includes(report.disaster_category_no)) {
      // 地震系(EEW/震源/震度)は震央コード、無ければ発生時刻でグルーピングする
      if (typeof report.seismic_epicenter_raw === "number") return `eq|epi:${report.seismic_epicenter_raw}`;
      if (report.occurrence_time_of_earthquake) return `eq|time:${report.occurrence_time_of_earthquake}`;
      return "eq|unknown";
    }
    return `cat:${report.disaster_category_no}`;
  }
  return null;
}

function isReplayable(report) {
  // ハートビートやデコードエラーは再送する意味が無いので対象外
  return !!report && report.type !== "Heartbeat" && report.type !== "DecodeError";
}

// 災危通報は同一内容が配信終了条件を満たすまで数秒おきに繰り返し配信される仕様
// のため、内容がまったく同じ通報が何度も届く。これをそのままブラウザへ流すと、
// 受信のたびに地図の巡回やカード表示がリセットされてしまう(ずっとズームイン
// されたままになる)。そこでサーバー側で直近に配信した内容を覚えておき、完全に
// 同一内容の再送はブラウザへ流さない。
// 同一判定は、受信時刻など揮発的な値は無視し、DCRメッセージ本体(hex)で行う。
//
// 「見たことがあるか」を無期限に覚えるのではなく、DEDUP_WINDOW_MS 以内に
// 同一内容を見た場合だけ重複とみなす(直近の最終確認時刻を更新するLRU的な
// Map)。実際の再送は数秒おきに繰り返されるだけなので、この時間内の完全一致は
// 確実に「同じ通報の再送」だが、時間を空けて全く同じ内容がもう一度発表される
// (例: テスト送信を発表→取消→再度発表、と手動で繰り返す場合など)は、
// 別の発生として扱われるべきなので誤って握りつぶさないようにする。
const DEDUP_WINDOW_MS = 10 * 1000;
const RECENT_CONTENT_KEY_LIMIT = 500;
const recentContentKeys = new Map(); // key -> 最終確認時刻(ms)

function reportContentKey(report) {
  if (!report || typeof report !== "object") return null;
  // raw = DCRメッセージ本体。プリアンブル(A/B/C=53/9A/C6)・CRC・衛星IDを含まない
  // ため、内容が同じなら常に一致する。災危通報はプリアンブルが送信ごとに巡回する
  // 仕様のため、message / sentence / nmea は内容が同じでも毎回変化してしまう。
  // したがって raw を最優先の重複判定キーにする。
  //
  // ただし information_type_no (発表/訂正/取消) も併せてキーに含める。実データ
  // では取消時にビット列(raw)自体が変わるため本来は不要だが、動作確認用の
  // テスト送信(read_legacy*.py の c+Enter など)は、デコード済みdictの
  // information_type だけを書き換えて取消を模擬しており raw は元のまま
  // 変わらない。これを raw だけで判定すると「取消メッセージ」が直前の
  // 「発表メッセージ」と同一とみなされて握りつぶされ、取消がいつまでも
  // 反映されない不具合になる。
  const infoType = report.information_type_no !== undefined ? report.information_type_no : "";
  if (report.raw) return "r:" + report.raw + ":" + infoType;
  if (report.message) return "m:" + report.message + ":" + infoType;
  if (report.sentence) return "s:" + report.sentence + ":" + infoType;
  // 上記が無いテストデータ等は timestamp を除いた内容で判定する
  const clone = { ...report };
  delete clone.timestamp;
  return "o:" + JSON.stringify(clone);
}

function isDuplicateReport(report) {
  const key = reportContentKey(report);
  if (key === null) return false;
  const now = Date.now();
  const lastSeen = recentContentKeys.get(key);
  const isDup = lastSeen !== undefined && (now - lastSeen) < DEDUP_WINDOW_MS;
  // Mapは再setしても既存キーの挿入順が変わらないため、LRU的に古い順で
  // 削除できるよう、更新のたびに一度削除してから入れ直す。
  recentContentKeys.delete(key);
  recentContentKeys.set(key, now);
  if (recentContentKeys.size > RECENT_CONTENT_KEY_LIMIT) {
    recentContentKeys.delete(recentContentKeys.keys().next().value);
  }
  return isDup;
}

function handleIncomingLine(line) {
  let report = null;
  try {
    report = JSON.parse(line);
  } catch (e) {
    // JSONとして解釈できないものはそのまま流すだけで、保持対象にはしない
  }

  // ハートビートは接続状態の指標なので、重複判定の対象にせず必ず流す
  if (report && report.type === "Heartbeat") {
    broadcast(line);
    return;
  }

  // テスト送信(is_test_data)はユーザーが動作確認のために意図的に何度も送るもので、
  // 固定の test sentence を使うため raw が毎回完全に同一になる。これを実運用向けの
  // 重複排除(衛星からの再送ノイズ対策)にかけると、短時間で連続テストした際に
  // 「握りつぶされて画面に何も出ない」という紛らわしい状態になるため対象外にする。
  //
  // 同一内容の再送はブラウザへ流さない(巡回/表示がリセットされるのを防ぐ)。
  // 取消・解除などの終了信号も、内容が変わるので初回は必ず通り、再送だけ弾かれる。
  if (!(report && report.is_test_data) && isDuplicateReport(report)) {
    return;
  }

  if (isEndSignal(report)) {
    const key = reportGroupKey(report);
    if (key !== null) {
      activeReports = activeReports.filter((r) => reportGroupKey(r) !== key);
    }
    // key が判定できない場合は何もしない(誤って無関係の通報まで
    // 消してしまうより、消し忘れて残る方が安全なため)
  } else if (isReplayable(report)) {
    activeReports.push(report);
  }
  broadcast(line);
  sendPushNotifications(report);
}

// ラズパイなど現地の受信機からデコード済みJSONを受け取るエンドポイント。
// 拠点ごとのトークン(X-Api-Keyヘッダ)で照合する。1台分が漏えいしても
// 他の拠点は影響を受けない(requireDeviceToken参照)。
app.post("/ingest", (req, res) => {
  const auth = requireDeviceToken(req, res);
  if (!auth.ok) return;
  const line = JSON.stringify(req.body);
  console.log(`📡 ingest受信${auth.deviceId ? `[${auth.deviceId}]` : ""}:`, line.slice(0, 400));
  handleIncomingLine(line);
  res.status(204).end();
});

// ==================================================
// デバイス管理(ラズパイ本体の健康状態・リモート再起動)
//
// ラズパイ側は外部からの着信を一切受け付けない設計(OTA更新と同じ
// pull型の考え方)にしているため、ここでも「ラズパイが定期的に自分の
// 状態を送ってくる(push)」「ラズパイが定期的に保留中のコマンドが
// 無いか確認しに来る(pull)」という組み合わせにする。
// 状態はメモリ上にのみ保持する(Cloud Runの再起動で消えるが、次の
// 状態報告(1時間おき)で自然に復元されるので実運用上問題ない)。
// ==================================================
const deviceStatus = new Map(); // device_id -> 最新の状態報告
const pendingCommands = new Map(); // device_id -> [{command, requestedAt}, ...]
const DEVICE_OFFLINE_AFTER_MS = 130 * 60 * 1000; // この時間報告が無ければオフライン扱い(状態報告は1時間おきなので、それより余裕を持たせる)

// 拠点ごとのINGEST_TOKEN(deviceIngestTokens、GCS永続化)で認証する。
// トークンから拠点IDを逆引きするため、リクエスト本文の自己申告
// device_idは信用しない(なりすまし防止)。deviceIngestTokensの実体は
// このファイル下部(GCS永続化セクション)で定義しているが、実際に
// 呼ばれるのはサーバー起動・GCS読み込み完了後なので参照して問題ない。
//
// 後方互換/ローカル動作確認用に、共有のINGEST_TOKENも引き続き使える
// (この場合は拠点を特定できないのでdeviceId=nullを返す)。
function requireDeviceToken(req, res) {
  if (deviceIngestTokens.size === 0 && !INGEST_TOKEN) return { ok: true, deviceId: null };
  const token = req.get("X-Api-Key") || "";
  const deviceId = resolveDeviceToken(token);
  if (deviceId === undefined) {
    res.status(401).json({ error: "unauthorized" });
    return { ok: false, deviceId: null };
  }
  return { ok: true, deviceId };
}

// ==================================================
// 管理サイト(/device-admin)のログイン(メール+パスワード)
//
// 管理者は運用者1人だけの想定なので、複数ユーザーやDBは持たず、
// 環境変数(ADMIN_EMAIL / ADMIN_PASSWORD_HASH)と照合するだけのシンプルな
// 作りにする。パスワードはハッシュ化して比較し(平文保存しない)、
// ログイン成功後はHMAC署名付きの改ざん検知可能なCookieでセッションを
// 維持する(新規npm依存を増やさず、Node標準のcryptoだけで実装)。
// ==================================================
// Web管理画面(/device-admin)自体は残すが、Discord Botからの操作に
// 一本化したためCloud Run本番では既定で無効(未設定=false)にする。
// ローカルや将来的な復活時は ENABLE_WEB_ADMIN=true で有効化できる。
const ENABLE_WEB_ADMIN = (process.env.ENABLE_WEB_ADMIN || "").trim() === "true";
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const SESSION_SECRET = (process.env.SESSION_SECRET || "").trim();
// パスワードは/device-admin画面から自分で変更できるようにするため、
// 環境変数ADMIN_PASSWORD_HASHは「初回起動時の初期値」としてのみ使い、
// 実際に照合に使う値はGCSに永続化された最新のものを優先する
// (loadAdminPasswordHashで起動時に上書きされる)
let currentAdminPasswordHash = (process.env.ADMIN_PASSWORD_HASH || "").trim();

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}
const SESSION_COOKIE_NAME = "qzss_admin_session";
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7日

function verifyPassword(password, storedHash) {
  const [saltHex, hashHex] = storedHash.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function signSession(payloadObj) {
  const payloadB64 = base64url(JSON.stringify(payloadObj));
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payloadB64).digest("base64url");
  return `${payloadB64}.${sig}`;
}

function verifySession(token) {
  if (!token) return null;
  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return null;
  const expectedSig = crypto.createHmac("sha256", SESSION_SECRET).update(payloadB64).digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    if (!payload.admin || typeof payload.exp !== "number" || Date.now() > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

// express.jsonはContent-Type: application/jsonのみを対象にするため、
// Cookieヘッダ用に軽量な自前パーサを使う(単一Cookieのみなので
// cookie-parser依存は不要)
function getCookie(req, name) {
  const header = req.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

function requireAdminAuth(req, res) {
  if (!ADMIN_EMAIL || !currentAdminPasswordHash || !SESSION_SECRET) {
    res.status(503).json({ error: "admin機能が無効です(ADMIN_EMAIL/ADMIN_PASSWORD_HASH/SESSION_SECRET未設定)" });
    return false;
  }
  const session = verifySession(getCookie(req, SESSION_COOKIE_NAME));
  if (!session) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

if (ENABLE_WEB_ADMIN) {
  app.post("/admin/api/login", (req, res) => {
    if (!ADMIN_EMAIL || !currentAdminPasswordHash || !SESSION_SECRET) {
      return res.status(503).json({ error: "admin機能が無効です(ADMIN_EMAIL/ADMIN_PASSWORD_HASH/SESSION_SECRET未設定)" });
    }
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    if (email !== ADMIN_EMAIL || !password || !verifyPassword(password, currentAdminPasswordHash)) {
      return res.status(401).json({ error: "メールアドレスまたはパスワードが違います" });
    }
    const token = signSession({ admin: true, exp: Date.now() + SESSION_MAX_AGE_MS });
    res.cookie(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: SESSION_MAX_AGE_MS,
      path: "/",
    });
    res.json({ ok: true });
  });

  // 画面から自分でパスワードを変更できるようにするエンドポイント。
  // セッションCookieだけでなく現在のパスワードも要求する(Cookie漏えい
  // だけで恒久的に乗っ取られないようにするため)。
  app.post("/admin/api/change-password", (req, res) => {
    if (!requireAdminAuth(req, res)) return;
    const currentPassword = String(req.body.currentPassword || "");
    const newPassword = String(req.body.newPassword || "");
    if (!verifyPassword(currentPassword, currentAdminPasswordHash)) {
      return res.status(401).json({ error: "現在のパスワードが違います" });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: "新しいパスワードは8文字以上にしてください" });
    }
    currentAdminPasswordHash = hashPassword(newPassword);
    persistAdminPasswordHash();
    res.json({ ok: true });
  });

  app.post("/admin/api/logout", (req, res) => {
    res.clearCookie(SESSION_COOKIE_NAME, { httpOnly: true, secure: true, sameSite: "lax", path: "/" });
    res.json({ ok: true });
  });
}

// ラズパイ側(report_status.sh)が数分おきに現在の状態を送ってくる。
// 同じリクエストへの応答で、保留中のコマンド(reboot等)も一緒に返す
// (ラズパイ側から見れば「状態を送ったら、ついでにやることが無いか
// 教えてもらえる」という1往復で完結する設計)
app.post("/device/status", (req, res) => {
  const auth = requireDeviceToken(req, res);
  if (!auth.ok) return;
  // 拠点ごとのトークンで認証できていればそちらを正とする(本文の
  // device_idはなりすまし防止のため信用しない)。共有トークン使用時
  // (auth.deviceId===null、後方互換/ローカル動作確認用)のみ本文を使う
  const deviceId = auth.deviceId || String(req.body.device_id || req.body.hostname || "unknown");
  deviceStatus.set(deviceId, {
    ...req.body,
    deviceId,
    receivedAt: Date.now(),
  });
  const commands = pendingCommands.get(deviceId) || [];
  pendingCommands.delete(deviceId); // 一度渡したら消す(取りに来た=実行される前提)
  res.json({ ok: true, commands });
});

// 管理サイトから「次にこのデバイスが状態報告に来た時にreboot等を
// 実行させる」ためのコマンドを予約する。Web管理画面・Discordの
// どちらのハンドラからも呼ぶ共通処理。
function queueDeviceCommand(deviceId, command) {
  if (!["reboot", "force_update_check"].includes(command)) {
    return { ok: false, error: "未対応のコマンドです" };
  }
  const list = pendingCommands.get(deviceId) || [];
  list.push({ command, requestedAt: Date.now() });
  pendingCommands.set(deviceId, list);
  console.log(`🛠️ デバイス[${deviceId}]にコマンドを予約しました: ${command}`);
  return { ok: true };
}

if (ENABLE_WEB_ADMIN) {
  // 管理サイトから見る、全デバイスの最新状態一覧
  app.get("/admin/api/devices", (req, res) => {
    if (!requireAdminAuth(req, res)) return;
    const now = Date.now();
    const devices = [...deviceStatus.values()].map((d) => ({
      ...d,
      online: now - d.receivedAt < DEVICE_OFFLINE_AFTER_MS,
      homePrefectureId: (deviceRegionConfig.get(d.deviceId) || {}).homePrefectureId ?? null,
    }));
    res.json({ devices });
  });

  app.post("/admin/api/devices/:deviceId/command", (req, res) => {
    if (!requireAdminAuth(req, res)) return;
    const result = queueDeviceCommand(req.params.deviceId, String(req.body.command || ""));
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ok: true });
  });

  app.get("/device-admin", (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, "device-admin.html"));
  });
}

// ==================================================
// デバイスごとの地域設定(拠点の都道府県+周辺地方)
//
// 各拠点(ラズパイ1台)に都道府県を1つ割り当てると、その都道府県が
// 属する地方(region_groups.json)全体まで展開したIDリストを返す
// (例: 東京都→関東7都県)。展開はここで1回だけ行い、ラズパイ・
// 閲覧ブラウザの両方は展開済みの結果を受け取るだけにする。
//
// 管理画面で人が稀に変更するだけの設定値なので、Cloud Run再起動で
// 消えると実害が大きい(毎回設定し直しになる)ため、変更の度にGCSへ
// 保存する(map_caution/server.jsのactiveReports永続化と同じパターン)。
// ==================================================
const REGION_GROUPS = JSON.parse(fs.readFileSync(path.join(__dirname, "region_groups.json"), "utf8")).groups;
const prefectureIdToGroup = new Map();
for (const group of REGION_GROUPS) {
  for (const id of group.prefectureIds) prefectureIdToGroup.set(id, group);
}

// Discordの/set_regionコマンド(都道府県名で指定)用の名前→ID解決と、
// オートコンプリート候補に使う。ブラウザ側(main.js/device-admin.html)は
// prefectures.geojsonを直接fetchするが、こちらはサーバー内部の処理なので
// 起動時に読み込んでおく
const PREFECTURE_LIST = JSON.parse(
  fs.readFileSync(path.join(PUBLIC_DIR, "data", "prefectures.geojson"), "utf8")
).features.map((f) => f.properties).sort((a, b) => a.id - b.id);
const prefectureIdByName = new Map(PREFECTURE_LIST.map((p) => [p.name, p.id]));

function expandHomePrefecture(prefectureId) {
  const group = prefectureIdToGroup.get(prefectureId);
  return group ? group.prefectureIds : [prefectureId];
}

const deviceRegionConfig = new Map(); // device_id -> { homePrefectureId, updatedAt }
const REGION_STATE_BUCKET = process.env.REGION_STATE_BUCKET || "qzss-map-state";
const REGION_STATE_FILE = "device_region_config.json";
const gcsStorage = new Storage();

// server.jsはCloud Run上でもラズパイの完全ローカルkiosk運用
// (start_pi_local.sh、インターネット接続なし)でも同じコードで動く。
// 完全ローカル運用ではそもそもインターネットに届かずGCSは使えない
// (使おうとしても無駄な待ち時間・警告ログが出るだけ)ため、
// LOCAL_STATE_ONLY=true が設定されている場合はGCSに一切アクセスせず、
// 最初からローカルディスクのJSONファイルだけを永続化先にする
// (start_demo.sh/start_prod.sh/start_pi_local.shが自動で設定する)。
// 未設定(Cloud Run本番)の場合はGCSが実質的な永続化先になる。
const LOCAL_STATE_ONLY = (process.env.LOCAL_STATE_ONLY || "").trim() === "true";
const LOCAL_STATE_DIR = path.join(__dirname, ".local_state");

function localStatePath(filename) {
  return path.join(LOCAL_STATE_DIR, filename);
}

function loadLocalStateFile(filename) {
  try {
    return JSON.parse(fs.readFileSync(localStatePath(filename), "utf8"));
  } catch (err) {
    return null;
  }
}

async function loadPersistedJson(filename) {
  if (LOCAL_STATE_ONLY) return loadLocalStateFile(filename);
  try {
    const file = gcsStorage.bucket(REGION_STATE_BUCKET).file(filename);
    const [exists] = await file.exists();
    if (exists) {
      const [contents] = await file.download();
      return JSON.parse(contents.toString("utf8"));
    }
  } catch (err) {
    console.warn(`⚠️ GCSからの復元に失敗しました(${filename})。ローカルファイルを試します:`, err.message);
  }
  return loadLocalStateFile(filename);
}

function persistJson(filename, data) {
  const json = JSON.stringify(data);
  try {
    fs.mkdirSync(LOCAL_STATE_DIR, { recursive: true });
    fs.writeFileSync(localStatePath(filename), json);
  } catch (err) {
    console.warn(`⚠️ ローカルファイルへの保存に失敗しました(${filename}):`, err.message);
  }
  if (LOCAL_STATE_ONLY) return;
  gcsStorage
    .bucket(REGION_STATE_BUCKET)
    .file(filename)
    .save(json, { contentType: "application/json" })
    .catch((err) => console.warn(`⚠️ GCSへの保存に失敗しました(${filename}):`, err.message));
}

// ==================================================
// 拠点ごとのINGEST_TOKEN
//
// 以前は全拠点共通の1つのINGEST_TOKENだったが、1台分が漏えいすると
// 全拠点になりすまして偽の通報を送り込めてしまうため、拠点ごとに別々の
// トークンを発行できるようにする(Discordの /create_device_token)。
// 1台分が漏えいしても、そのトークンだけ再発行すれば他の拠点は無傷。
// ==================================================
const deviceIngestTokens = new Map(); // device_id -> token
const DEVICE_TOKENS_STATE_FILE = "device_ingest_tokens.json";

async function loadDeviceIngestTokens() {
  const restored = await loadPersistedJson(DEVICE_TOKENS_STATE_FILE);
  if (restored && typeof restored === "object") {
    for (const [deviceId, token] of Object.entries(restored)) deviceIngestTokens.set(deviceId, token);
    console.log(`♻️  拠点別INGEST_TOKENを復元しました(${deviceIngestTokens.size}件)`);
  }
}

function persistDeviceIngestTokens() {
  persistJson(DEVICE_TOKENS_STATE_FILE, Object.fromEntries(deviceIngestTokens));
}

// 新規発行(既存の拠点IDに対して呼ぶと再発行=旧トークンは即座に失効)
function createDeviceToken(deviceId) {
  const token = crypto.randomBytes(16).toString("hex");
  deviceIngestTokens.set(deviceId, token);
  persistDeviceIngestTokens();
  return token;
}

// トークン→拠点IDの逆引き。一致なしはundefined、共有INGEST_TOKENと
// 一致した場合はnull(拠点不明、後方互換/ローカル動作確認用)を返す
function resolveDeviceToken(token) {
  if (!token) return undefined;
  const tokenBuf = Buffer.from(token);
  for (const [deviceId, t] of deviceIngestTokens) {
    const tBuf = Buffer.from(t);
    if (tBuf.length === tokenBuf.length && crypto.timingSafeEqual(tBuf, tokenBuf)) return deviceId;
  }
  if (INGEST_TOKEN) {
    const sharedBuf = Buffer.from(INGEST_TOKEN);
    if (sharedBuf.length === tokenBuf.length && crypto.timingSafeEqual(sharedBuf, tokenBuf)) return null;
  }
  return undefined;
}

async function loadRegionConfig() {
  const restored = await loadPersistedJson(REGION_STATE_FILE);
  if (restored && typeof restored === "object") {
    for (const [deviceId, config] of Object.entries(restored)) deviceRegionConfig.set(deviceId, config);
    console.log(`♻️  デバイス地域設定を復元しました(${deviceRegionConfig.size}件)`);
  }
}

function persistRegionConfig() {
  persistJson(REGION_STATE_FILE, Object.fromEntries(deviceRegionConfig));
}

// 管理者パスワード(/device-adminから自分で変更できる)。同じバケットに
// 別ファイルとして保存し、環境変数ADMIN_PASSWORD_HASHは「GCSにまだ何も
// 無い場合の初期値」としてのみ使う
const ADMIN_PASSWORD_STATE_FILE = "admin_password_hash.json";

async function loadAdminPasswordHash() {
  const restored = await loadPersistedJson(ADMIN_PASSWORD_STATE_FILE);
  if (restored && restored.hash) {
    currentAdminPasswordHash = restored.hash;
    console.log("♻️  管理者パスワードを復元しました");
  }
}

function persistAdminPasswordHash() {
  persistJson(ADMIN_PASSWORD_STATE_FILE, { hash: currentAdminPasswordHash, updatedAt: Date.now() });
}

// ==================================================
// 訓練放送(report_classification_no===7)の表示ON/OFF
//
// 全体の既定値(globalShowTrainingBroadcasts)と、拠点ごとの上書き
// (deviceTrainingBroadcastOverrides)の2段構え。Discordの
// /set_training_broadcasts で、deviceを指定すればその拠点だけ、
// 指定しなければ全体(=上書きしていない拠点すべて)の設定を変更できる。
// ==================================================
let globalShowTrainingBroadcasts = true;
const deviceTrainingBroadcastOverrides = new Map(); // device_id -> boolean
const TRAINING_BROADCAST_STATE_FILE = "training_broadcast_settings.json";

async function loadTrainingBroadcastSettings() {
  const restored = await loadPersistedJson(TRAINING_BROADCAST_STATE_FILE);
  if (!restored || typeof restored !== "object") return;
  if (typeof restored.global === "boolean") globalShowTrainingBroadcasts = restored.global;
  if (restored.perDevice && typeof restored.perDevice === "object") {
    for (const [deviceId, val] of Object.entries(restored.perDevice)) {
      if (typeof val === "boolean") deviceTrainingBroadcastOverrides.set(deviceId, val);
    }
  }
}

function persistTrainingBroadcastSettings() {
  persistJson(TRAINING_BROADCAST_STATE_FILE, {
    global: globalShowTrainingBroadcasts,
    perDevice: Object.fromEntries(deviceTrainingBroadcastOverrides),
  });
}

// deviceId=null/undefinedなら全体の既定値を変更する。指定すればその
// 拠点だけの上書きを設定する
function setTrainingBroadcastSetting(deviceId, enabled) {
  if (deviceId) {
    deviceTrainingBroadcastOverrides.set(deviceId, enabled);
  } else {
    globalShowTrainingBroadcasts = enabled;
  }
  persistTrainingBroadcastSettings();
}

function resolveShowTrainingBroadcasts(deviceId) {
  if (deviceId && deviceTrainingBroadcastOverrides.has(deviceId)) return deviceTrainingBroadcastOverrides.get(deviceId);
  return globalShowTrainingBroadcasts;
}

// 拠点の対象地域を設定する共通処理。Web管理画面・Discordのどちらの
// ハンドラからも呼ぶ(homePrefectureId=nullで未設定=全国表示に戻す)。
function setDeviceRegion(deviceId, homePrefectureId) {
  if (homePrefectureId !== null && (!Number.isInteger(homePrefectureId) || !prefectureIdToGroup.has(homePrefectureId))) {
    return { ok: false, error: "不正な都道府県IDです" };
  }
  if (homePrefectureId === null) {
    deviceRegionConfig.delete(deviceId);
  } else {
    deviceRegionConfig.set(deviceId, { homePrefectureId, updatedAt: Date.now() });
  }
  persistRegionConfig();
  console.log(`🗾 デバイス[${deviceId}]の地域設定を更新しました: ${homePrefectureId ?? "(全国)"}`);
  return { ok: true };
}

if (ENABLE_WEB_ADMIN) {
  app.get("/admin/api/devices/:deviceId/region", (req, res) => {
    if (!requireAdminAuth(req, res)) return;
    const config = deviceRegionConfig.get(req.params.deviceId) || { homePrefectureId: null, updatedAt: null };
    res.json(config);
  });

  app.post("/admin/api/devices/:deviceId/region", (req, res) => {
    if (!requireAdminAuth(req, res)) return;
    const raw = req.body.homePrefectureId;
    const homePrefectureId = raw === null || raw === undefined || raw === "" ? null : Number(raw);
    const result = setDeviceRegion(req.params.deviceId, homePrefectureId);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ok: true });
  });
}

// ラズパイ本体・閲覧ブラウザ(?device=拠点ID)の両方が参照する公開エンドポイント。
// 地域設定自体は機密情報ではないため認証は無し。
app.get("/device-region/:deviceId", (req, res) => {
  const config = deviceRegionConfig.get(req.params.deviceId);
  if (!config) {
    return res.json({ deviceId: req.params.deviceId, homePrefectureId: null, prefectureIds: null });
  }
  res.json({
    deviceId: req.params.deviceId,
    homePrefectureId: config.homePrefectureId,
    prefectureIds: expandHomePrefecture(config.homePrefectureId),
  });
});

// ブラウザ(main.js)が起動時に読む、表示挙動の設定値。?device=拠点IDを
// 付ければその拠点の上書き設定(無ければ全体設定)を返す。機密情報では
// ないため認証は無し
app.get("/config", (req, res) => {
  const deviceId = req.query.device ? String(req.query.device) : null;
  res.json({ showTrainingBroadcasts: resolveShowTrainingBroadcasts(deviceId) });
});

// ==================================================
// Discord Bot(HTTP Interactionsエンドポイント)
//
// Web管理画面(/device-admin)の代わりに、Discordのスラッシュコマンドで
// 再起動予約・更新確認予約・拠点の地域設定を行う。Cloud Runは常駐
// プロセスを前提としないため、Gateway Bot(WebSocket常時接続)ではなく
// DiscordがコマンドのたびにこのURLへPOSTしてくるHTTP方式を使う
// (ステートレスなリクエスト/レスポンスで、既存のExpress構成とそのまま
// 相性が良い)。
//
// 署名検証(Ed25519)は discord-interactions パッケージを使う。管理者
// 認証はNode標準cryptoのみで実装した経緯があるが、ここは外部から
// 到達可能なWebhookの検証というセキュリティクリティカルな箇所なので、
// 生鍵の扱いを自前実装するリスクを避けて小さな専用ライブラリに頼る。
// ==================================================
const DISCORD_PUBLIC_KEY = (process.env.DISCORD_PUBLIC_KEY || "").trim();
// 未設定の場合はコマンド実行者を制限しない(Discordサーバー側の権限設定
// だけに頼る)。設定した場合はこのユーザーID以外の実行を拒否する
// (Web管理画面が運用者1人限定だった方針を踏襲した二重の防御)
const DISCORD_ADMIN_USER_ID = (process.env.DISCORD_ADMIN_USER_ID || "").trim();

function ephemeralReply(content) {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: InteractionResponseFlags.EPHEMERAL },
  };
}

function findFocusedOption(options) {
  for (const opt of options || []) {
    if (opt.focused) return opt;
    if (opt.options) {
      const nested = findFocusedOption(opt.options);
      if (nested) return nested;
    }
  }
  return null;
}

// device/prefectureオプションのオートコンプリート。素の文字列入力だと
// デバイスIDや都道府県名の打ち間違いで無言のエラーになりやすいため、
// 既存データ(deviceStatus/PREFECTURE_LIST)から候補を絞り込んで返す
function handleAutocomplete(interaction) {
  const focused = findFocusedOption(interaction.data.options);
  const query = String((focused && focused.value) || "").toLowerCase();
  let choices = [];
  if (focused && focused.name === "device") {
    // create_device_tokenは未稼働の新規拠点にも使うため、状態報告済み
    // (deviceStatus)だけでなく既にトークン発行済み(deviceIngestTokens)の
    // IDも候補に含める。他のコマンドは動いている拠点だけで十分だが、
    // 含めても害はないので共通化する
    const knownIds = new Set([...deviceStatus.keys(), ...deviceIngestTokens.keys()]);
    choices = [...knownIds]
      .filter((id) => id.toLowerCase().includes(query))
      .slice(0, 25)
      .map((id) => ({ name: id, value: id }));
  } else if (focused && focused.name === "prefecture") {
    choices = PREFECTURE_LIST
      .filter((p) => p.name.includes(query))
      .slice(0, 25)
      .map((p) => ({ name: p.name, value: p.name }));
  }
  return { type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT, data: { choices } };
}

function handleCommand(interaction) {
  const invokerId = (interaction.member && interaction.member.user && interaction.member.user.id) ||
    (interaction.user && interaction.user.id);
  if (DISCORD_ADMIN_USER_ID && invokerId !== DISCORD_ADMIN_USER_ID) {
    return ephemeralReply("⛔ このコマンドを実行する権限がありません。");
  }
  const options = {};
  for (const opt of interaction.data.options || []) options[opt.name] = opt.value;
  const deviceId = String(options.device || "");

  if (interaction.data.name === "reboot") {
    const result = queueDeviceCommand(deviceId, "reboot");
    return ephemeralReply(result.ok
      ? `✅ ${deviceId} に再起動を予約しました(次回の状態報告時に実行されます)`
      : `❌ ${result.error}`);
  }
  if (interaction.data.name === "update_check") {
    const result = queueDeviceCommand(deviceId, "force_update_check");
    return ephemeralReply(result.ok ? `✅ ${deviceId} に更新確認を予約しました` : `❌ ${result.error}`);
  }
  if (interaction.data.name === "set_region") {
    const prefectureName = String(options.prefecture || "");
    const prefectureId = prefectureIdByName.get(prefectureName);
    if (prefectureId === undefined) return ephemeralReply(`❌ 都道府県「${prefectureName}」が見つかりません`);
    const result = setDeviceRegion(deviceId, prefectureId);
    return ephemeralReply(result.ok
      ? `✅ ${deviceId} の対象地域を「${prefectureName}」周辺に設定しました`
      : `❌ ${result.error}`);
  }
  if (interaction.data.name === "create_device_token") {
    if (!deviceId) return ephemeralReply("❌ deviceを指定してください");
    const alreadyExisted = deviceIngestTokens.has(deviceId);
    const token = createDeviceToken(deviceId);
    return ephemeralReply(
      `✅ ${deviceId} 用のトークンを${alreadyExisted ? "再発行しました(旧トークンは失効しました)" : "発行しました"}。\n` +
      `この拠点の \`qzss.env\` に設定してください:\n` +
      `\`\`\`\nQZSS_DEVICE_ID=${deviceId}\nQZSS_INGEST_TOKEN=${token}\n\`\`\``
    );
  }
  if (interaction.data.name === "set_training_broadcasts") {
    const enabled = !!options.enabled;
    const targetDevice = deviceId || null; // device未指定なら全体設定を変更する
    setTrainingBroadcastSetting(targetDevice, enabled);
    return ephemeralReply(
      targetDevice
        ? `✅ ${targetDevice} の訓練放送表示を${enabled ? "ON" : "OFF"}にしました(この拠点だけの設定)`
        : `✅ 全体(拠点ごとの上書きが無い端末すべて)の訓練放送表示を${enabled ? "ON" : "OFF"}にしました`
    );
  }
  return ephemeralReply("❌ 未対応のコマンドです");
}

app.post("/discord/interactions", async (req, res) => {
  const signature = req.get("X-Signature-Ed25519");
  const timestamp = req.get("X-Signature-Timestamp");
  const isValid = DISCORD_PUBLIC_KEY && signature && timestamp && req.rawBody &&
    (await verifyKey(req.rawBody, signature, timestamp, DISCORD_PUBLIC_KEY));
  if (!isValid) return res.status(401).send("invalid request signature");

  const interaction = req.body;
  if (interaction.type === InteractionType.PING) {
    return res.json({ type: InteractionResponseType.PONG });
  }
  if (interaction.type === InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE) {
    return res.json(handleAutocomplete(interaction));
  }
  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    return res.json(handleCommand(interaction));
  }
  res.status(400).json({ error: "unsupported interaction type" });
});

const server = http.createServer(app);

Promise.all([
  loadRegionConfig(),
  loadAdminPasswordHash(),
  loadDeviceIngestTokens(),
  loadTrainingBroadcastSettings(),
]).finally(() => {
  server.listen(PORT, () => {
    console.log(`✅ サーバー起動: http://localhost:${PORT}`);
    if (!INGEST_TOKEN) {
      console.warn(
        "⚠️ INGEST_TOKEN が未設定です。/ingest は無認証で受け付けます(本番運用では必ず環境変数 INGEST_TOKEN を設定してください)"
      );
    }
  });
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  console.log("WebSocket クライアント接続");
  // 保持している「現在アクティブな」通報を、新しく繋がったクライアントにだけ
  // 順番に再送する(ブラウザ側の統合ロジックが同じ表示状態を再現する)
  for (const report of activeReports) {
    ws.send(JSON.stringify(report));
  }
});

function broadcast(line) {
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(line);
    }
  }
}

// ローカル動作確認用(start_demo.sh / start_prod.sh): qzss_pipe が
// 存在する場合のみFIFOを読み続けて全クライアントへブロードキャストする。
// 実機のないクラウド環境ではFIFOは作らないので、この経路は使われず
// /ingest 経由の受信のみになる。
let buffer = "";

function readFIFO() {
  const stream = fs.createReadStream(FIFO_PATH, { encoding: "utf8" });

  stream.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop(); // 最後の未完成行は次回に持ち越す

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      console.log("📦 FIFO受信:", trimmed);
      handleIncomingLine(trimmed);
    }
  });

  stream.on("end", () => {
    console.log("🔁 FIFO再接続します...");
    readFIFO(); // 書き込み側が閉じたら再度開き直して待ち受ける
  });

  stream.on("error", (err) => {
    console.error("❌ FIFO読み取りエラー:", err);
    setTimeout(readFIFO, 2000);
  });
}

if (fs.existsSync(FIFO_PATH)) {
  readFIFO();
} else {
  console.log("ℹ️ qzss_pipe が無いため、/ingest 経由の受信のみ待ち受けます");
}
