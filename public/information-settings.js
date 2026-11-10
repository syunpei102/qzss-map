(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.InformationSettings = api;
})(typeof self !== 'undefined' ? self : this, function() {
  const defaults = { weatherEnabled: false, volcanoEnabled: false };
  function normalize(value) {
    return { weatherEnabled: value?.weatherEnabled === true, volcanoEnabled: value?.volcanoEnabled === true };
  }
  function isEnabled(report, settings = defaults) {
    if (report.disaster_category_no === 10) return settings.weatherEnabled === true;
    if ([8, 9].includes(report.disaster_category_no)) return settings.volcanoEnabled === true;
    return true;
  }
  return { defaults, normalize, isEnabled };
});
