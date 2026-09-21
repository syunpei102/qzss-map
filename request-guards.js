// 公開APIの入力検証・レート制限・リッスン設定・認証省略条件．副作用を持たない．
const net = require("node:net");

// ---- リッスン設定 (Issue #22) ----
function isLoopbackAddress(address) {
  if (!address) return false;
  const a = String(address).replace(/^::ffff:/i, "");
  return a === "::1" || a === "localhost" || (net.isIPv4(a) && a.startsWith("127."));
}

// LOCAL_STATE_ONLY(Pi単体運用)は既定でloopbackだけで待ち受ける．LANへ公開する場合は
// HOSTを明示し，INGEST_TOKENも設定するか，QZSS_ALLOW_INSECURE_LAN=trueで危険を承認する．
// Cloud Run(LOCAL_STATE_ONLYなし)は従来どおり全インターフェース．
function resolveListenConfig(env) {
  const local = (env.LOCAL_STATE_ONLY || "").trim() === "true";
  const port = env.PORT || 8080;
  const host = (env.HOST || "").trim() || (local ? "127.0.0.1" : "0.0.0.0");
  const exposed = !isLoopbackAddress(host);
  const hasToken = !!(env.INGEST_TOKEN || "").trim();
  const allowInsecure = (env.QZSS_ALLOW_INSECURE_LAN || "").trim() === "true";
  if (local && exposed && !hasToken && !allowInsecure) {
    return {
      error: `LOCAL_STATE_ONLYで${host}へ公開するにはINGEST_TOKENの設定が必要です(認証なしで公開する危険を承知の場合のみ QZSS_ALLOW_INSECURE_LAN=true)`,
    };
  }
  return { host, port, local, exposed, authenticated: hasToken };
}

// トークンが1つも設定されていない場合に無認証を許す接続か．loopbackか明示フラグのみ．
function mayBypassAuth(remoteAddress, env) {
  return isLoopbackAddress(remoteAddress) || (env.QZSS_ALLOW_INSECURE_LAN || "").trim() === "true";
}

// ---- レート制限 (Issue #14) ----
function createRateLimiter({ windowMs, max, maxKeys = 10000, now = Date.now }) {
  const hits = new Map(); // key -> { start, count }
  return function allow(key) {
    const t = now();
    let entry = hits.get(key);
    if (!entry || t - entry.start >= windowMs) {
      if (!entry && hits.size >= maxKeys) {
        for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
        if (hits.size >= maxKeys) return false;
      }
      entry = { start: t, count: 0 };
      hits.set(key, entry);
    }
    entry.count += 1;
    return entry.count <= max;
  };
}

// ---- Web Push購読の検証 (Issue #14) ----
const MAX_ENDPOINT_LENGTH = 2048;
const MAX_KEY_LENGTH = 200;
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

function validatePushSubscription(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "invalid subscription" };
  const { endpoint, keys, expirationTime } = body;
  if (typeof endpoint !== "string" || endpoint.length > MAX_ENDPOINT_LENGTH) return { ok: false, error: "invalid endpoint" };
  let url;
  try { url = new URL(endpoint); } catch { return { ok: false, error: "invalid endpoint" }; }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")
      || net.isIP(host.replace(/^\[|\]$/g, "")) || host === "localhost" || !host.includes(".")
      || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost")) {
    return { ok: false, error: "endpoint not allowed" };
  }
  if (!keys || typeof keys !== "object") return { ok: false, error: "invalid keys" };
  for (const name of ["p256dh", "auth"]) {
    const v = keys[name];
    if (typeof v !== "string" || v.length < 8 || v.length > MAX_KEY_LENGTH || !BASE64URL.test(v)) return { ok: false, error: "invalid keys" };
  }
  if (expirationTime !== undefined && expirationTime !== null && !Number.isFinite(expirationTime)) return { ok: false, error: "invalid expirationTime" };
  // 余計なフィールドは保存しない
  return { ok: true, subscription: { endpoint, expirationTime: expirationTime ?? null, keys: { p256dh: keys.p256dh, auth: keys.auth } } };
}

// ---- レイテンシ計測の検証 (Issue #14) ----
const MAX_SPAN_MS = 24 * 60 * 60 * 1000;
function validateReportSummary(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) return null;
  // main.jsはオブジェクトを送る．ダッシュボードが使う項目だけを型・サイズ制限付きで保存する．
  const summary = {};
  const textFields = ["type", "disaster_category", "information_type", "a1_message_type",
    "a4_hazard_type", "a5_severity", "a8_hazard_duration", "report_time",
    "seismic_epicenter", "seismic_intensity_lower_limit", "ex1_target_area_ja"];
  for (const key of textFields) {
    if (typeof report[key] === "string") summary[key] = report[key].slice(0, 200);
  }
  for (const key of ["disaster_category_no", "report_classification_no", "magnitude"]) {
    if (Number.isFinite(report[key])) summary[key] = report[key];
  }
  // マグニチュードはデコーダによって文字列(不明など)の場合もある．
  if (typeof report.magnitude === "string") summary.magnitude = report.magnitude.slice(0, 200);
  for (const key of ["eew_forecast_regions", "ex9_target_area_list_ja", "weather_forecast_regions"]) {
    if (Array.isArray(report[key])) {
      summary[key] = report[key].slice(0, 100).filter(v => typeof v === "string").map(v => v.slice(0, 200));
    }
  }
  return Object.keys(summary).length ? summary : null;
}

function validateClientTiming(ts) {
  if (!ts || typeof ts !== "object" || Array.isArray(ts)) return null;
  const { t0_received_ms: t0, t1_decoded_ms: t1, t2_server_received_ms: t2, t3_dispatched_ms: t3, client_processing_ms: render } = ts;
  const nums = [t0, t1, t2, t3, render];
  if (!nums.every(Number.isFinite) || t0 <= 0 || render < 0 || render > MAX_SPAN_MS) return null;
  const decodeMs = t1 - t0, networkMs = t2 - t1, dispatchPrepMs = t3 - t2;
  if ([decodeMs, networkMs, dispatchPrepMs].some(v => Math.abs(v) > MAX_SPAN_MS)) return null;
  const summary = validateReportSummary(ts.reportSummary);
  return { decodeMs, networkMs, dispatchPrepMs, renderMs: render, totalMs: decodeMs + networkMs + dispatchPrepMs + render, reportSummary: summary, isTestData: !!ts.isTestData };
}

// ---- 通知tag (Issue #17) ----
// 地震は同一事象の更新を置換する(事象キーのみ)．地域単位で積み上がる種別は
// 本文も含め，別の地域・内容の通知を上書きしない．
function notificationTag(groupKey, body, isEarthquake) {
  if (!groupKey) return undefined;
  if (isEarthquake) return groupKey.slice(0, 120);
  let h = 5381;
  for (const ch of String(body || "")) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0;
  return `${groupKey}#${h.toString(36)}`.slice(0, 160);
}

// 両方の識別子がある場合は必ず両方を含め，同一時刻でも震央が異なる
// 別地震の通知を同じtagで上書きしない．
function earthquakeNotificationKey(report) {
  const parts = [];
  if (report && report.occurrence_time_of_earthquake) parts.push(`time:${report.occurrence_time_of_earthquake}`);
  if (report && typeof report.seismic_epicenter_raw === "number") parts.push(`epi:${report.seismic_epicenter_raw}`);
  return `n:eq${parts.length ? `|${parts.join("|")}` : ""}`;
}

module.exports = { isLoopbackAddress, resolveListenConfig, mayBypassAuth, createRateLimiter, validatePushSubscription, validateClientTiming, notificationTag, earthquakeNotificationKey };
