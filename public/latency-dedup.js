// 同一情報の計測は，ブラウザ・受信機・復元履歴を通じて最初の1件を残す．
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QzssLatencyDedup = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const stable = value => JSON.stringify(value, (_, item) =>
    item && !Array.isArray(item) && typeof item === 'object'
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

  function identity(entry) {
    const summary = entry.reportSummary;
    // 発表時刻のあるDCRは電文が変わっても同じ内容なら同じ情報．
    // 取消など内容が変わった通報は別件として残す．
    if (summary && Object.keys(summary).length) {
      return `${entry.isTestData ? 'test' : 'live'}:summary:${stable(summary)}`;
    }
    return entry.reportKey ? `${entry.isTestData ? 'test' : 'live'}:raw:${entry.reportKey}` : null;
  }

  function deduplicateLatencyHistory(history) {
    const seen = new Map();
    return history.filter(entry => {
      const key = identity(entry);
      if (!key) return true;
      const first = seen.get(key);
      // 時刻を含まないDCXなどは，後日の同内容を別の情報として扱う．
      const timeless = !entry.reportSummary?.report_time;
      const at = Number(entry.recordedAt) || 0;
      if (first !== undefined && (!timeless || (at >= first && at - first < 30 * 60 * 1000))) return false;
      seen.set(key, at);
      return true;
    });
  }
  return { identity, deduplicateLatencyHistory };
});
