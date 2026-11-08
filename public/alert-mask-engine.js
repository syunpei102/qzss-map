// 固定した区域図形を再投入せず，区域IDごとに警報色だけ更新する．
// MapLibreの描画コンテキストを利用する試作段階の警報マスクエンジン．
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AlertMaskEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  class AlertMaskEngine {
    constructor(map) {
      this.map = map;
      this.colorsBySource = new Map();
    }

    sync(source, colors) {
      const previous = this.colorsBySource.get(source) || new Map();
      let changed = 0;
      for (const [id] of previous) {
        if (colors.has(id)) continue;
        this.map.removeFeatureState({ source, id }, 'color');
        changed++;
      }
      for (const [id, color] of colors) {
        if (previous.get(id) === color) continue;
        this.map.setFeatureState({ source, id }, { color });
        changed++;
      }
      this.colorsBySource.set(source, new Map(colors));
      return changed;
    }
  }

  return AlertMaskEngine;
});
