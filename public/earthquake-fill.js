// 緊急地震速報の予測範囲と観測震度の塗りを，地震ごとに独立して管理する．
// カード自体のTTLとは別に，予測範囲だけを最後の速報から5分で消す．
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EarthquakeFill = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const EEW_FILL_TTL_MS = 5 * 60 * 1000;

  function fromReport(report, prefectures, now = Date.now()) {
    if (report.disaster_category_no === 3) {
      // 対象県が空でも「観測情報を受けた」ことを記録する．
      return { phase: 'observed', prefectures, deadline: null };
    }
    if (report.disaster_category_no !== 1) {
      return { phase: 'none', prefectures: [], deadline: null };
    }
    const replayAgeMs = Number.isFinite(report.replay_age_ms) && report.replay_age_ms >= 0
      ? report.replay_age_ms : 0;
    const remainingMs = EEW_FILL_TTL_MS - replayAgeMs;
    if (remainingMs <= 0) return { phase: 'expired', prefectures: [], deadline: null };
    return { phase: 'eew', prefectures, deadline: now + remainingMs };
  }

  function merge(current, incoming) {
    if (incoming.phase === 'observed') return incoming;
    if (incoming.phase === 'eew' || incoming.phase === 'expired') {
      // 観測震度の後にEEWの続報や保存通報が届いても，予測範囲へ戻さない．
      return current?.phase === 'observed' ? current : incoming;
    }
    return current || incoming;
  }

  function expire(state, now = Date.now()) {
    if (state?.phase !== 'eew' || state.deadline > now) return state;
    return { phase: 'expired', prefectures: [], deadline: null };
  }

  return { EEW_FILL_TTL_MS, fromReport, merge, expire };
});
