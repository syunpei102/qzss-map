// 通報種別ごとの「取消が届かなかった場合の安全策TTL」の唯一の定義．
// ブラウザ(public/main.js)とサーバー(server.js)の両方がこのファイルを使い，
// 再接続時に古い情報が復活したり，継続中の情報が早く消えたりしないようにする．
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReportTtl = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const H = 60 * 60 * 1000;
  const TTL = {
    EEW: 20 * 60 * 1000,
    HYPOCENTER_INTENSITY: 20 * 60 * 1000,
    TSUNAMI: 24 * H,
    TSUNAMI_INFO: 3 * H,
    JALERT: 24 * H,
    WEATHER: 3 * H,
    LALERT_UNKNOWN: 3 * H,
    VOLCANO: 12 * H,
    OTHER: 24 * H,
    TEST_DATA: 60 * 1000,
  };
  const LALERT_DURATION_TTL_MS = {
    'Duration < 6H': 6 * H,
    '6H <= Duration < 12H': 12 * H,
    '12H <= Duration < 24H': 24 * H,
  };

  function ttlMsForReport(report) {
    if (!report) return TTL.OTHER;
    if (report.is_test_data) return TTL.TEST_DATA;
    if (report.type === 'QzssDcxJAlert') return TTL.JALERT;
    if (report.type === 'QzssDcxLAlert' || report.type === 'QzssDcxMTInfo') {
      return LALERT_DURATION_TTL_MS[report.a8_hazard_duration] || TTL.LALERT_UNKNOWN;
    }
    switch (report.disaster_category_no) {
      case 1: return TTL.EEW;
      case 2: case 3: return TTL.HYPOCENTER_INTENSITY;
      case 5: return TTL.TSUNAMI;
      case 6: return TTL.TSUNAMI_INFO;
      case 8: return TTL.VOLCANO;
      case 10: return TTL.WEATHER;
      default: return TTL.OTHER;
    }
  }

  return { TTL, LALERT_DURATION_TTL_MS, ttlMsForReport };
});
