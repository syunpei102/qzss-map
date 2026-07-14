const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const webpush = require("web-push");
const compression = require("compression");

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
app.use(express.static(PUBLIC_DIR));
app.use(express.json({ limit: "256kb" }));

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
// 信号を受信したら、保持していた分をクリアする。
let activeReports = [];

function isEndSignal(report) {
  if (!report) return false;
  if (report.information_type_no === 2) return true; // キャンセル報(取消)
  if (report.disaster_category_no === 5 && [1, 2].includes(report.tsunami_warning_code_raw)) return true; // 津波警報解除/なし
  return false;
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
    activeReports = [];
  } else if (isReplayable(report)) {
    activeReports.push(report);
  }
  broadcast(line);
  sendPushNotifications(report);
}

// ラズパイなど現地の受信機からデコード済みJSONを受け取るエンドポイント。
// 秘密トークン(INGEST_TOKEN)を X-Api-Key ヘッダで照合する。
app.post("/ingest", (req, res) => {
  if (INGEST_TOKEN && req.get("X-Api-Key") !== INGEST_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const line = JSON.stringify(req.body);
  console.log("📡 ingest受信:", line.slice(0, 400));
  handleIncomingLine(line);
  res.status(204).end();
});

const server = http.createServer(app);

server.listen(PORT, () => {
  console.log(`✅ サーバー起動: http://localhost:${PORT}`);
  if (!INGEST_TOKEN) {
    console.warn(
      "⚠️ INGEST_TOKEN が未設定です。/ingest は無認証で受け付けます(本番運用では必ず環境変数 INGEST_TOKEN を設定してください)"
    );
  }
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
