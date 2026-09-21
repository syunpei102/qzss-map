// 拠点のオンライン判定(qzss-map #23)．副作用を持たない純粋関数で，境界値をテストできる．
//
// 拠点(qzss-pi-package の report_status.sh)は5分おきに状態を報告する．
// 15分 = 報告3回分なので，1〜2回の一時的な通信失敗(タイマーのずれ・Cloud Runの再起動等)
// ではオフライン扱いにならず，3回連続で途絶えたときだけオフラインになる．
// (以前は報告が1時間おきだったため130分だったが，それでは停止の検知が遅すぎる)
const STATUS_REPORT_INTERVAL_MS = 5 * 60 * 1000;
const MISSED_REPORTS_TOLERATED = 2;
const DEVICE_OFFLINE_AFTER_MS = STATUS_REPORT_INTERVAL_MS * (MISSED_REPORTS_TOLERATED + 1);

// receivedAt(最後の報告受信時刻)から DEVICE_OFFLINE_AFTER_MS 未満ならオンライン．
// 時刻が数値でなければオフラインにする(未来の時刻は経過が負になるためオンライン)．
function isDeviceOnline(receivedAt, now = Date.now(), offlineAfterMs = DEVICE_OFFLINE_AFTER_MS) {
  if (!Number.isFinite(receivedAt) || !Number.isFinite(now)) return false;
  return now - receivedAt < offlineAfterMs;
}

module.exports = { isDeviceOnline, DEVICE_OFFLINE_AFTER_MS, STATUS_REPORT_INTERVAL_MS, MISSED_REPORTS_TOLERATED };
