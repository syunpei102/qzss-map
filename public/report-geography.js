(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReportGeography = api;
})(typeof self !== 'undefined' ? self : this, function() {
  function tokyoEewWeatherCodes(regions) {
    const result = new Set();
    for (const code of regions || []) {
      if ([16, 59].includes(code)) result.add(130010);
      if ([17, 60].includes(code)) { result.add(130020); result.add(130030); }
      if ([18, 61].includes(code)) result.add(130040);
    }
    return [...result];
  }
  const TOKYO_WEATHER_NAMES = {130010: '東京地方', 130020: '伊豆諸島北部', 130030: '伊豆諸島南部', 130040: '小笠原諸島'};
  function weatherAreas(report) {
    return (report.weather_forecast_regions_raw || []).flatMap((code, i) => {
      const subCategory = report.weather_related_disaster_sub_categories?.[i];
      const codes = code === 130000 ? [130010, 130020, 130030, 130040] : [code];
      return codes.map(value => ({ code: value, name: value === code ? report.weather_forecast_regions?.[i] : TOKYO_WEATHER_NAMES[value], subCategory }));
    });
  }
  function weatherPatrolGroup(code) {
    const prefecture = Math.floor(code / 10000);
    return prefecture === 13 ? `tokyo:${code}` : `pref:${prefecture}`;
  }
  return { tokyoEewWeatherCodes, weatherAreas, weatherPatrolGroup };
});
