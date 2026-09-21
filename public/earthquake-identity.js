// 「同一の地震か」の判定規則の唯一の定義(サーバーのreport-state.jsと
// ブラウザのpublic/main.jsで共有する)．
//  - 両方に発生時刻がある場合は時刻，両方に震央コードがある場合は震央コードを比較し，
//    比較できる項目が全て一致したときだけ同一(同震央・別時刻も同時刻・別震央も別の地震)
//  - 片方の項目が欠ける場合は，比較できる項目だけで判定する(安全なフォールバック)
//  - 手がかりが全く無い同士は allowUnknown のときだけ同一とみなす
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EarthquakeIdentity = api;
})(typeof self !== 'undefined' ? self : this, function () {
  function sameEarthquake(a, b, { allowUnknown = false } = {}) {
    const timeA = a.time || null;
    const timeB = b.time || null;
    const epiA = typeof a.epicenter === 'number' ? a.epicenter : null;
    const epiB = typeof b.epicenter === 'number' ? b.epicenter : null;
    const bothTimes = timeA && timeB;
    const bothEpis = epiA !== null && epiB !== null;
    // 両方の情報が揃っている項目は全て一致が必要(同時刻でも別震央は別の地震)
    if (bothTimes && timeA !== timeB) return false;
    if (bothEpis && epiA !== epiB) return false;
    if (bothTimes || bothEpis) return true;
    return allowUnknown && !timeA && !timeB && epiA === null && epiB === null;
  }
  return { sameEarthquake };
});
