throw new Error("deliberate-ota-rollback-test: this commit intentionally breaks startup to verify update_check.sh auto-rollback");
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

// 以前はメモリ上にのみ保持していたため、Cloud Runの再デプロイ・再起動の
// たびに登録者全員の購読情報が消え、通知が届かなくなっていた
// (デプロイするたびに毎回「通知を有効にする」を押し直してもらう必要が
// あった)。他の状態(activeReports・latencyHistory等)と同じGCS/
// ローカルファイル永続化に乗せ、再デプロイを挟んでも購読が維持される
// ようにする
const pushSubscriptions = new Map(); // endpoint -> subscription object
const PUSH_SUBSCRIPTIONS_STATE_FILE = "push_subscriptions.json";

async function loadPushSubscriptions() {
  const restored = await loadPersistedJson(PUSH_SUBSCRIPTIONS_STATE_FILE);
  if (restored && typeof restored === "object") {
    for (const [endpoint, sub] of Object.entries(restored)) pushSubscriptions.set(endpoint, sub);
    console.log(`♻️  プッシュ通知の購読情報を復元しました(${pushSubscriptions.size}件)`);
  }
}

function persistPushSubscriptions() {
  persistJson(PUSH_SUBSCRIPTIONS_STATE_FILE, Object.fromEntries(pushSubscriptions));
}

app.post("/push/subscribe", (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: "invalid subscription" });
  pushSubscriptions.set(sub.endpoint, sub);
  persistPushSubscriptions();
  console.log(`🔔 プッシュ通知を購読登録しました(現在 ${pushSubscriptions.size} 件)`);
  res.status(201).json({ ok: true });
});

app.post("/push/unsubscribe", (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  if (endpoint && pushSubscriptions.delete(endpoint)) persistPushSubscriptions();
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

// 衛星は同一の通報を配信終了条件を満たすまで数分〜数時間おきに繰り返し
// 配信する仕様のため、受信機(ラズパイ)側の重複排除は「直近5分以内に
// 送った同じ内容」しか覚えない(意図的に短い。ずっと続いている警報かの
// 確認も兼ねる)。このため受信機のプロセスが再起動する(OTA更新・
// クラッシュ・今回行ったHDMI設定変更に伴う再起動など)と、直前まで
// 何時間も抑制され続けていた同じ内容の再送を「初めて見た」と誤認し、
// 何時間も前に発表・解除済みの古い情報をプッシュ通知してしまうバグが
// 実機で確認された。受信機側の状態(プロセス再起動で消える)に頼らず、
// サーバー側で「その通報自体が申告している発表時刻」を見て、あまりに
// 古い(=もう何度も通知済みのはずの)ものは通知しないようにする
const STALE_NOTIFICATION_THRESHOLD_MS = 30 * 60 * 1000; // 30分

function reportEffectiveTimeMs(report) {
  const raw = report && report.report_time;
  if (typeof raw !== "string") return null;
  // report_time はタイムゾーン指定なしのISO文字列(UTC)で届く。指定が
  // 無いとJSはブラウザ/サーバーのローカルタイムゾーンとして解釈してしまう
  // (Cloud Run/ラズパイは基本UTCだが、環境依存にしないよう明示的にZを補う)
  const iso = /[zZ]|[+-]\d\d:\d\d$/.test(raw) ? raw : `${raw}Z`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

function isStaleForNotification(report) {
  const t = reportEffectiveTimeMs(report);
  if (t === null) return false; // 発表時刻を持たない種別(Jアラート等)は対象外
  return Date.now() - t > STALE_NOTIFICATION_THRESHOLD_MS;
}

function shouldNotify(report) {
  if (!PUSH_ENABLED || !report) return false;
  if (report.type === "Heartbeat" || report.type === "DecodeError") return false;
  if (!report.is_test_data && isStaleForNotification(report)) return false;
  // 訓練放送(DCRはreport_classification_no===7、DCX/LアラートJアラートは
  // a1_message_type==='Test')は、地図側(public/main.jsのrenderReport)
  // がshowTrainingBroadcastsに従って表示するかどうかを決めているのに、
  // プッシュ通知はその設定に関わらず常に送っていた。訓練放送の表示を
  // OFFにしているのに通知だけ届き、地図で確認すると何も描画されていない
  // (=通知とmapの表示が食い違う)という紛らわしい状態になっていたため、
  // 通知も同じ設定に従わせる。通知には拠点(device)の紐付けが無いため、
  // 全体設定(globalShowTrainingBroadcasts)を見る
  const isOfficialTrainingBroadcast = report.report_classification_no === 7 || report.a1_message_type === "Test";
  if (isOfficialTrainingBroadcast && !globalShowTrainingBroadcasts) return false;
  if (report.type === "QzssDcxJAlert" || report.type === "QzssDcxLAlert" || report.type === "QzssDcxMTInfo") return true;
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

// 通知だけを見て「Lアラートなのか気象警報なのか」「新規発表なのか解除
// なのか」が分かるようにする。以前は情報源ごとに書式がバラバラ(Lアラート
// だけ解除を扱っていて、気象警報・その他DCRは新規発表と解除の区別が
// タイトルに一切出ず、本文側も「キャンセル報」とだけ表示され「何が」
// 解除されたのか分からなかった)だったのを統一する。
// 気象警報は1通に複数の災害種別(例: 大雨警報・洪水警報)を同時に含み
// うるため、「気象警報・注意報」という総称だけでは具体的に何が起きて
// いるのか通知だけでは分からない、という指摘を受けて種別名を直接出す
function notificationTitleFor(report) {
  const isCancel = report.information_type_no === 2 || report.a1_message_type === "All Clear";
  const statusSuffix = isCancel ? "(解除)" : "";
  let title;
  if (report.type === "QzssDcxJAlert") {
    title = `Jアラート: ${JALERT_HAZARD_JA[report.a4_hazard_type] || report.a4_hazard_type || "緊急情報"}${statusSuffix}`;
  } else if (report.type === "QzssDcxLAlert" || report.type === "QzssDcxMTInfo") {
    const label = report.type === "QzssDcxMTInfo" ? "自治体情報" : "Lアラート";
    const hazard = LALERT_HAZARD_JA[report.a4_hazard_type] || report.a4_hazard_type || "災害情報";
    title = `${label}: ${hazard}${statusSuffix}`;
  } else if (report.disaster_category_no === 10) {
    const subs = [...new Set(report.weather_related_disaster_sub_categories || [])];
    title = `気象: ${subs.length ? subs.join("・") : "気象警報・注意報"}${statusSuffix}`;
  } else {
    const titles = {
      1: "緊急地震速報", 2: "震源に関する情報", 3: "震度速報", 5: "津波情報",
      4: "南海トラフ地震関連情報", 8: "噴火警報・予報", 9: "降灰予報", 11: "洪水予報",
    };
    // 津波は警報レベル(大津波警報/津波警報/津波注意報)自体が既に具体的な
    // ので、総称の「津波情報」より優先してそのまま使う
    const base = report.tsunami_warning_code || titles[report.disaster_category_no] || report.disaster_category || "防災情報";
    title = `${base}${statusSuffix}`;
  }
  if (report.is_test_data) return `[テスト]${title}`;
  // report_classification_no===7は衛星から実際に配信される公式の訓練/試験放送
  // (自分で送るテストデータとは別物)。本物の警報と見分けがつくようにする
  if (report.report_classification_no === 7 || report.a1_message_type === "Test") return `[訓練]${title}`;
  return title;
}

// 以前は解除・取消(information_type_no===2)の通報だと、対象地域や
// 種別を一切見ずに一律「キャンセル報」とだけ表示していたため、通知欄
// だけでは「何が」解除されたのか分からなかった。解除信号でも通常通り
// 対象地域・種別の詳細を組み立て、頭に「解除: 」を付けるだけにする
function notificationBodyFor(report) {
  const isCancel = report.information_type_no === 2 || report.a1_message_type === "All Clear";
  const detail = notificationBodyDetail(report);
  return isCancel ? `解除: ${detail}` : detail;
}

function notificationBodyDetail(report) {
  if (report.type === "QzssDcxJAlert") {
    const areas = report.ex9_target_area_list_ja || [];
    return areas.length ? areas.slice(0, 5).join("・") + (areas.length > 5 ? " 他" : "") : "アプリを開いて確認してください。";
  }
  if (report.type === "QzssDcxLAlert" || report.type === "QzssDcxMTInfo") {
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
        persistPushSubscriptions();
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
//
// { report, receivedAt } の配列で保持する(receivedAtは下記の安全策用)。
let activeReports = [];

// 安全策: 取消・解除信号を万一受信し損ねた場合、その通報が永久に
// activeReportsに居座り新規接続の全員に配信され続けてしまう
// (実機テストで、テストデータの取消を送らなかったところ何分経っても
// 再送され続けることを確認した)。実際の災危通報がこれほど長時間
// アクティブで居続けることは無いはずなので、24時間を安全策の上限とする
// (通常はreportGroupKeyによる正規の取消処理で先に消える)
const ACTIVE_REPORT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// 震源・震度速報(disaster_category_no 2/3)はそもそも「取消」の仕組みが
// 無い(発表して終わりの事実情報)ため、24時間の安全策だけでは長すぎる。
// public/main.jsのttlMsForReportと同じ考え方(実機で見つけたバグ:
// クライアント側のTTLはそのブラウザの表示だけを消し、activeReportsには
// 反映されないため、何時間経っても新規接続に再送され続けていた)を
// サーバー側にも適用し、判定できる場合はより短いTTLで安全策を効かせる
const TTL_HYPOCENTER_INTENSITY_MS = 15 * 60 * 1000; // 震源・震度速報: 15分
const TTL_TSUNAMI_MS = 24 * 60 * 60 * 1000; // 津波: 24時間(解除信号が主、これは保険)
const TTL_TEST_DATA_MS = 60 * 1000; // テストデータ: 1分
// 気象警報・注意報とLアラートは、public/main.js側のTTL_WEATHER_MS/
// TTL_LALERT_UNKNOWN_MSと同じ3時間に揃える(以前は24時間の安全策
// 任せで、新規接続のたびに何時間も前の警報が再送され続けていた)
const TTL_WEATHER_LALERT_MS = 3 * 60 * 60 * 1000;

function ttlMsForReport(report) {
  if (report.is_test_data) return TTL_TEST_DATA_MS;
  if (report.disaster_category_no === 2 || report.disaster_category_no === 3) return TTL_HYPOCENTER_INTENSITY_MS;
  if (report.disaster_category_no === 5) return TTL_TSUNAMI_MS;
  if (report.disaster_category_no === 10) return TTL_WEATHER_LALERT_MS;
  if (report.type === "QzssDcxLAlert" || report.type === "QzssDcxMTInfo") return TTL_WEATHER_LALERT_MS;
  return null; // 判定できないものは従来通りACTIVE_REPORT_MAX_AGE_MSの安全策に任せる
}

function pruneStaleActiveReports() {
  const before = activeReports.length;
  activeReports = activeReports.filter((entry) => {
    const maxAge = ttlMsForReport(entry.report) ?? ACTIVE_REPORT_MAX_AGE_MS;
    return Date.now() - entry.receivedAt < maxAge;
  });
  if (activeReports.length !== before) {
    console.log(`🧹 期限切れのactiveReportsを削除しました(${before - activeReports.length}件)`);
    persistActiveReports();
  }
}

// 新しい通報が届かない間もいずれ安全策が効くよう、定期的にも確認する。
// 震源・震度速報の15分TTLに対して精度が出るよう、1時間より短くする
setInterval(pruneStaleActiveReports, 5 * 60 * 1000);

function isEndSignal(report) {
  if (!report) return false;
  if (report.information_type_no === 2) return true; // キャンセル報(取消)
  if (report.disaster_category_no === 5 && [1, 2].includes(report.tsunami_warning_code_raw)) return true; // 津波警報解除/なし
  // Jアラート/Lアラート(DCX)の解除。DCRの取消(information_type_no)とは
  // 別の仕組みで、a1_message_typeが'All Clear'になる
  if (
    (report.type === "QzssDcxJAlert" || report.type === "QzssDcxLAlert" || report.type === "QzssDcxMTInfo") &&
    report.a1_message_type === "All Clear"
  ) return true;
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
  if (report.type === "QzssDcxLAlert" || report.type === "QzssDcxMTInfo") {
    // QzssDcxLAlert(消防庁経由)とQzssDcxMTInfo(自治体からの直接配信)は
    // フィールド構成が同一のため同じキー形式でグルーピングする
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

  // レイテンシ計測: T3(WebSocket配信直前)を追記し、ここまでの各段階の
  // 所要時間をログに出す(T4はブラウザ側で描画完了後にこの値を使って
  // 計算し、/client-timingへ返してくる)
  if (report && report.client_timestamps) {
    const ts = report.client_timestamps;
    ts.t3_dispatched_ms = Date.now();
    if (ts.t0_received_ms && ts.t1_decoded_ms && ts.t2_server_received_ms) {
      console.log(
        `⏱️ レイテンシ内訳: デコード${ts.t1_decoded_ms - ts.t0_received_ms}ms `
        + `→ 受信機→サーバー${ts.t2_server_received_ms - ts.t1_decoded_ms}ms `
        + `→ 配信準備${ts.t3_dispatched_ms - ts.t2_server_received_ms}ms`
      );
    }
    line = JSON.stringify(report);
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
      activeReports = activeReports.filter((entry) => reportGroupKey(entry.report) !== key);
      persistActiveReports();
    }
    // key が判定できない場合は何もしない(誤って無関係の通報まで
    // 消してしまうより、消し忘れて残る方が安全なため)
  } else if (isReplayable(report)) {
    // 災危通報は同一内容が配信終了条件を満たすまで数秒〜数分おきに
    // 繰り返し配信される仕様(isDuplicateReportの10秒ウィンドウより
    // 間隔が空くと重複排除をすり抜ける)。以前はここで無条件にpushして
    // いたため、同じ警報が長時間続くほどactiveReportsに同一内容の
    // エントリが積み上がっていた(実機で確認: L-Alert訓練放送が数分
    // おきに3件重複)。reportGroupKeyが一致する既存エントリがあれば
    // 置き換える(受信時刻も更新=最新の配信を起点にTTLが延びる)
    const key = reportGroupKey(report);
    if (key !== null) {
      // findIndexで最初の1件だけ差し替えると、何らかの理由(Cloud Runの
      // コールドスタート時のGCS読み込みと書き込みの競合等)で同じキーの
      // エントリが複数溜まってしまっていた場合に1件しか解消されず、
      // 残りが新規接続のたびに再送され続けてしまう(実機で確認: 十津川村
      // 宛のend-to-endテスト配信が3件重複したまま残っていた)。
      // isEndSignal側と同じくfilterで一致する分を全て取り除いてから
      // 新しい1件を積み直す
      activeReports = activeReports.filter((entry) => reportGroupKey(entry.report) !== key);
    }
    activeReports.push({ report, receivedAt: Date.now() });
    pruneStaleActiveReports();
    persistActiveReports();
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
  // レイテンシ計測(T0受信→T1デコード→T2サーバー受信→T3配信→T4描画完了)。
  // 受信機側が埋めたT0/T1がある場合のみ、ここでT2を追記する
  if (req.body && req.body.client_timestamps) {
    req.body.client_timestamps.t2_server_received_ms = Date.now();
  }
  const line = JSON.stringify(req.body);
  console.log(`📡 ingest受信${auth.deviceId ? `[${auth.deviceId}]` : ""}:`, line.slice(0, 400));
  handleIncomingLine(line);
  res.status(204).end();
});

// レイテンシ計測(T0受信〜T4描画完了)の履歴。ダッシュボード表示用に
// 直近LATENCY_HISTORY_MAX_SIZE件だけ保持する。deviceRegionConfig等と
// 同じパターンでGCS/ローカルファイルに永続化し、デプロイ・再起動を
// またいでも消えないようにする
const LATENCY_HISTORY_MAX_SIZE = 200;
const LATENCY_HISTORY_STATE_FILE = "latency_history.json";
const latencyHistory = [];

async function loadLatencyHistory() {
  const restored = await loadPersistedJson(LATENCY_HISTORY_STATE_FILE);
  if (Array.isArray(restored)) {
    latencyHistory.push(...restored);
    console.log(`♻️  レイテンシ履歴を復元しました(${latencyHistory.length}件)`);
  }
}

function persistLatencyHistory() {
  persistJson(LATENCY_HISTORY_STATE_FILE, latencyHistory);
}

// ラズパイのローカルキオスクは、誰も公開サイトを見ていなくても実測値を
// 貯めておきたい(資料用途)ため、設定されていればここで受けた計測を
// そのままクラウド側の/client-timingへも転送する(相手も同じ処理をして
// 自分のlatencyHistoryに積む)。ローカルのqzss-map.serviceにだけ設定する
// 環境変数で、Cloud Run側では未設定のまま(自分自身には転送しない)
const CLOUD_LATENCY_REPORT_URL = (process.env.CLOUD_LATENCY_REPORT_URL || "").trim();

// レイテンシ計測(T0受信〜T4描画完了)のブラウザ側からの報告を1箇所の
// ログにまとめる。認証不要(値そのものに機密性は無く、失敗しても
// 実運用に影響しない計測専用の経路のため)
app.post("/client-timing", (req, res) => {
  const ts = req.body || {};
  if (ts.t0_received_ms && typeof ts.client_processing_ms === "number") {
    // decodeMs(受信機内、同じ時計)・networkMs(受信機→サーバー)・
    // dispatchPrepMs(サーバー内、同じ時計)はそれぞれ計算に使う2つの
    // 時刻が同じ機器の時計同士なので問題無い。renderMs(配信→描画完了)
    // だけは以前「サーバーが配信した時刻」と「ブラウザが描画し終えた
    // 時刻」という別々の機器の時計を引き算していて、機器間の時計のズレが
    // そのまま誤差になっていた(キオスク端末で特に顕著: マイナスや
    // 数秒〜十数秒という明らかにおかしな値が実機のダッシュボードで
    // 確認された)。ブラウザが自分の時計だけで測った所要時間
    // (client_processing_ms)をそのまま使い、totalMsも各区間を足し算
    // する形にして、機器間の時刻比較を一切行わないようにする
    const decodeMs = ts.t1_decoded_ms - ts.t0_received_ms;
    const networkMs = ts.t2_server_received_ms - ts.t1_decoded_ms;
    const dispatchPrepMs = ts.t3_dispatched_ms - ts.t2_server_received_ms;
    const renderMs = ts.client_processing_ms;
    const entry = {
      recordedAt: Date.now(),
      isTestData: !!ts.isTestData,
      reportSummary: ts.reportSummary || null,
      decodeMs,
      networkMs,
      dispatchPrepMs,
      renderMs,
      totalMs: decodeMs + networkMs + dispatchPrepMs + renderMs,
    };
    console.log(
      `⏱️ end-to-end合計: ${entry.totalMs}ms `
      + `(受信→デコード${entry.decodeMs}ms, `
      + `受信機→サーバー${entry.networkMs}ms, `
      + `配信準備${entry.dispatchPrepMs}ms, `
      + `配信→描画完了${entry.renderMs}ms)`
    );
    latencyHistory.push(entry);
    if (latencyHistory.length > LATENCY_HISTORY_MAX_SIZE) latencyHistory.shift();
    persistLatencyHistory();

    if (CLOUD_LATENCY_REPORT_URL) {
      fetch(CLOUD_LATENCY_REPORT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ts),
      }).catch((err) => console.warn("⚠️ クラウドへのレイテンシ転送に失敗:", err.message));
    }
  }
  res.status(204).end();
});

// ダッシュボード(public/latency.html)用に直近の計測履歴を返す
app.get("/api/latency-history", (req, res) => {
  res.json(latencyHistory);
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

// 現在アクティブな通報(activeReports)の永続化。Cloud Runのインスタンス
// 再起動(デプロイ・コールドスタート等)を挟んでも、まだ解除されていない
// 警報が新規接続の閲覧者から見えなくならないようにする
const ACTIVE_REPORTS_STATE_FILE = "active_reports.json";

async function loadActiveReports() {
  const restored = await loadPersistedJson(ACTIVE_REPORTS_STATE_FILE);
  if (Array.isArray(restored)) {
    activeReports = restored;
    pruneStaleActiveReports(); // 長期間落ちていた場合、復元直後に古いものを除く
    console.log(`♻️  アクティブな通報を復元しました(${activeReports.length}件)`);
  }
}

function persistActiveReports() {
  persistJson(ACTIVE_REPORTS_STATE_FILE, activeReports);
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

// ラズパイのローカルkiosk(LOCAL_STATE_ONLY=true)専用の同期エンドポイント。
// Discordの/set_training_broadcastsはCloud Run(公開URL)にしか届かず、
// LAN内だけのローカルkioskサーバーはそのWebhookを一切受け取れない。
// そのため、ラズパイの受信プログラム(read_legacy_dual.py)側がCloud Run
// の/configを定期ポーリングし(region_config_refresh_loopと同じ方式)、
// 変化を検知したらこのエンドポイント経由でローカルサーバーの設定に
// 反映する。LOCAL_STATE_ONLYでない(=Cloud Run本番)場合は絶対に登録
// しない(公開URLに無認証の設定変更エンドポイントを晒さないため)
if (LOCAL_STATE_ONLY) {
  app.post("/local-sync/training-broadcasts", (req, res) => {
    setTrainingBroadcastSetting(null, !!req.body.enabled);
    broadcast(JSON.stringify({ type: "TrainingBroadcastSettingChanged" }));
    res.status(204).end();
  });
}

// 拠点をまるごと「忘れる」(Discordの/delete_device)。状態報告履歴・
// 予約中コマンド・地域設定・発行済みトークン(以後そのトークンでの
// 送信は拒否される)・訓練放送の個別設定をすべて削除する。
// 取り消せない操作なので呼び出し側(handleCommand)で結果を明示する
function deleteDevice(deviceId) {
  const existed =
    deviceStatus.has(deviceId) ||
    pendingCommands.has(deviceId) ||
    deviceRegionConfig.has(deviceId) ||
    deviceIngestTokens.has(deviceId) ||
    deviceTrainingBroadcastOverrides.has(deviceId);

  deviceStatus.delete(deviceId);
  pendingCommands.delete(deviceId);

  if (deviceRegionConfig.delete(deviceId)) persistRegionConfig();
  if (deviceIngestTokens.delete(deviceId)) persistDeviceIngestTokens();
  if (deviceTrainingBroadcastOverrides.delete(deviceId)) persistTrainingBroadcastSettings();

  return { ok: true, existed };
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
  if (interaction.data.name === "clear_region") {
    if (!deviceId) return ephemeralReply("❌ deviceを指定してください");
    const result = setDeviceRegion(deviceId, null);
    return ephemeralReply(result.ok
      ? `✅ ${deviceId} の対象地域設定を解除しました(絞り込み無し・全国に戻りました)`
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
    // 既に繋がっているブラウザは/configをページ読み込み時にしか見ないため、
    // このままだと「OFFにしたのに今表示中の訓練放送が消えない」ことに
    // なる。設定変更をWebSocketで通知し、各クライアント側で即座に
    // /configを再取得して反映(表示中のものもクリア)させる
    broadcast(JSON.stringify({ type: "TrainingBroadcastSettingChanged" }));
    return ephemeralReply(
      targetDevice
        ? `✅ ${targetDevice} の訓練放送表示を${enabled ? "ON" : "OFF"}にしました(この拠点だけの設定)`
        : `✅ 全体(拠点ごとの上書きが無い端末すべて)の訓練放送表示を${enabled ? "ON" : "OFF"}にしました`
    );
  }
  if (interaction.data.name === "delete_device") {
    if (!deviceId) return ephemeralReply("❌ deviceを指定してください");
    const result = deleteDevice(deviceId);
    if (!result.existed) return ephemeralReply(`ℹ️ ${deviceId} という拠点の記録は元々ありませんでした`);
    return ephemeralReply(
      `✅ ${deviceId} を削除しました(状態報告・地域設定・トークン・訓練放送設定を全て削除。` +
      `トークンは即座に無効化されたので、以後そのトークンでの送信は拒否されます)`
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
  loadActiveReports(),
  loadLatencyHistory(),
  loadPushSubscriptions(),
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
  // 順番に再送する(ブラウザ側の統合ロジックが同じ表示状態を再現する)。
  // client_timestamps(T0-T3)は元の配信時刻のまま埋め込まれているため、
  // そのまま送るとブラウザが「今」をT4として計算し、実際の受信からの
  // 経過時間がまるごとレイテンシとして記録されてしまう(実機で数時間分の
  // 異常値として確認)。再送分はレイテンシ計測の対象外にする
  for (const entry of activeReports) {
    const { client_timestamps, ...report } = entry.report;
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
      console.log("📦 FIFO受信:", trimmed.slice(0, 400));
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
