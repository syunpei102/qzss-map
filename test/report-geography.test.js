const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const Geo=require('../public/report-geography');
test('Tokyo EEW distinguishes mainland, Izu and Ogasawara codes including broad regional codes',()=>{
  assert.deepEqual(Geo.tokyoEewWeatherCodes([16,59]),[130010]);
  assert.deepEqual(Geo.tokyoEewWeatherCodes([17,60]),[130020,130030]);
  assert.deepEqual(Geo.tokyoEewWeatherCodes([18,61]),[130040]);
  assert.deepEqual(Geo.tokyoEewWeatherCodes([80]),[]);
});
test('Tokyo-wide weather reports expand for both issue and cancellation and preserve aligned categories',()=>{
  const r={weather_forecast_regions_raw:[130000,140010],weather_forecast_regions:['東京都','東部'],weather_related_disaster_sub_categories:['大雨警報','強風注意報']};
  for(const information_type_no of [0,2]){
    const areas=Geo.weatherAreas({...r,information_type_no});
    assert.deepEqual(areas.map(a=>a.code),[130010,130020,130030,130040,140010]);
    assert.deepEqual(areas.map(a=>a.subCategory),['大雨警報','大雨警報','大雨警報','大雨警報','強風注意報']);
  }
  assert.notEqual(Geo.weatherPatrolGroup(130010),Geo.weatherPatrolGroup(130040));
  assert.equal(Geo.weatherPatrolGroup(140010),Geo.weatherPatrolGroup(140020));
});
test('real GeoJSON camera bounds for Tokyo-only EEW exclude Ogasawara, island codes use their own regions',()=>{
  const source=fs.readFileSync(require.resolve('../public/main.js'),'utf8');
  const load=file=>JSON.parse(fs.readFileSync(require.resolve('../public/data/'+file))).features;
  const context={ReportGeography:Geo,prefectureFeaturesById:new Map(load('prefectures.geojson').map(f=>[f.properties.id,f])),weatherFeaturesByCode:new Map(load('weather_regions.geojson').map(f=>[f.properties.code,f]))};
  vm.createContext(context);vm.runInContext(source.slice(source.indexOf('function eachCoordinate('),source.indexOf('// 気象庁の 度分秒')),context);
  const start=source.indexOf('function eewPrefectureCameraBounds(');vm.runInContext(source.slice(start,source.indexOf('function buildEventFromReport(',start)),context);
  const mainland=context.eewPrefectureCameraBounds(13,{eew_forecast_regions_raw:[16]});
  assert(mainland[1]>35&&mainland[3]<37,JSON.stringify(mainland));
  const island=context.eewPrefectureCameraBounds(13,{eew_forecast_regions_raw:[18]});
  assert(island[1]<30&&island[3]<30,JSON.stringify(island));
});
test('100 synthetic review cases are reproducible and cover all requested groups',()=>{
  const data=require('./fixtures/review/cases.json');assert.equal(data.cases.length,100);assert.equal(new Set(data.cases.map(c=>c.id)).size,100);
  for(const entry of data.cases){assert.equal(typeof entry.expected.visible,'boolean');assert(entry.reports.length>0);for(const r of entry.reports)assert.equal(r.is_test_data,true);}
  assert.equal(data.cases.filter(c=>c.group==='緊急地震速報').length,60);
  assert.equal(data.cases.filter(c=>c.group==='気象情報').length,20);
  assert.equal(data.cases.filter(c=>c.group==='火山情報').length,16);
});
