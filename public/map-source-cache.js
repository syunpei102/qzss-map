// 同じ地図データをMapLibreのワーカーへ繰り返し送らない．
// ソースが再作成された場合は新しいオブジェクトとして必ず初回更新する．
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MapSourceCache = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const lastKeys = new WeakMap();
  const lastLayerValues = new WeakMap();

  function setDataIfChanged(source, key, data) {
    if (!source || typeof source.setData !== 'function') return false;
    if (lastKeys.get(source) === key) return false;
    source.setData(typeof data === 'function' ? data() : data);
    lastKeys.set(source, key);
    return true;
  }

  function updateLayerIfChanged(map, layerId, property, value, apply) {
    const layer = map.getLayer(layerId);
    if (!layer) return false;
    let values = lastLayerValues.get(layer);
    if (!values) { values = new Map(); lastLayerValues.set(layer, values); }
    const key = JSON.stringify(value);
    if (values.get(property) === key) return false;
    apply();
    values.set(property, key);
    return true;
  }

  function setFilterIfChanged(map, layerId, filter) {
    return updateLayerIfChanged(map, layerId, 'filter', filter, () => map.setFilter(layerId, filter));
  }

  function setPaintIfChanged(map, layerId, property, value) {
    return updateLayerIfChanged(map, layerId, `paint:${property}`, value,
      () => map.setPaintProperty(layerId, property, value));
  }

  return { setDataIfChanged, setFilterIfChanged, setPaintIfChanged };
});
