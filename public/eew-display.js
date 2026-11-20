// 衛星電文の震度範囲・仮定震源要素を，パネルと通知で同じ意味に整形する．
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EewDisplay = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const INTENSITIES = ['0', '1', '2', '3', '4', '5弱', '5強', '6弱', '6強', '7'];

  function bound(value, raw) {
    // コードがある場合は仕様の値を使い，なし・不明・予約コードを数値にしない．
    if (Number.isInteger(raw)) return INTENSITIES[raw - 1] ?? null;
    if (typeof value !== 'string') return null;
    const text = value.trim().replace(/^震度/, '');
    return INTENSITIES.includes(text) ? text : null;
  }

  function predictedIntensity(report, { maximumOnly = false } = {}) {
    const lower = bound(report.seismic_intensity_lower_limit, report.seismic_intensity_lower_limit_raw);
    const upper = bound(report.seismic_intensity_upper_limit, report.seismic_intensity_upper_limit_raw);
    const openEnded = report.seismic_intensity_upper_limit_raw === 11
      || (report.seismic_intensity_upper_limit_raw == null
        && /^[〜～~]程度以上$/.test(String(report.seismic_intensity_upper_limit || '').trim()));
    if (openEnded) return lower ? `${lower}程度以上` : '';
    // 下限だけでは最大震度を確定できない．補助表現だけの通知も作らない．
    if (!upper) return '';
    return !maximumOnly && lower && lower !== upper ? `${lower}〜${upper}` : upper;
  }

  function isAssumptive(report) {
    if (report.disaster_category_no !== 1) return false;
    return report.assumptive === true
      || (report.depth_of_hypocenter_raw === 10 && report.magnitude_raw === 10);
  }

  return { predictedIntensity, isAssumptive };
});
