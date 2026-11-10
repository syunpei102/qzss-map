const fs = require('node:fs');
const path = require('node:path');
const cases = [];
const base = { is_test_data: true, report_classification_no: 1, report_classification: '最優先', information_type_no: 0, information_type: '発表', satellite_id: 56, satellite_prn: 184 };
const coordinates = (lon, lat) => ({ lat_d: Math.floor(Math.abs(lat)), lat_m: (Math.abs(lat) % 1) * 60, lat_s: 0, lat_ns: lat < 0 ? 1 : 0, lon_d: Math.floor(Math.abs(lon)), lon_m: (Math.abs(lon) % 1) * 60, lon_s: 0, lon_ew: lon < 0 ? 1 : 0 });
function add(name, group, settings, reports, expected) {
  const id = `case-${String(cases.length + 1).padStart(3, '0')}`;
  cases.push({ id, name, group, settings: { weatherEnabled: false, volcanoEnabled: false, ...settings }, reports: reports.map((r, i) => ({ ...base, ...r, raw: `local-review:${id}:${i}` })), expected });
}
const locations = [
  ['東京本土のみ', [16], [139.5,35.6], 30, 350], ['深発・東京のみ', [16], [140,27.5], 600, 350],
  ['千島列島・代表点', [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,19,20,21,22,24,25,26,27,28], null, 140, 912],
  ['伊豆諸島のみ', [17], [139.5,32], 50, 390], ['小笠原のみ', [18], [142,27], 50, 391],
  ['関東地方', [59], [141,35], 80, 350], ['伊豆地方コード', [60], [140,32], 100, 390],
  ['小笠原地方コード', [61], [142,26], 100, 391], ['座標・震央コード不明', [16], null, 30, 9999],
  ['遠方太平洋', [16], [178,40], 50, 9998], ['九州', [40,41,42,43,44,45,46,47,48,49,50,51], [131,32], 100, 760],
  ['東日本広域・深発', [57,58,59,62,63,64], [140,28], 500, 350],
];
for (const [label, regions, point, depth, epicenter] of locations) {
  const report = { type:'QzssDcReportJmaEarthquakeEarlyWarning', disaster_category_no:1, disaster_category:'緊急地震速報', seismic_epicenter:label, seismic_epicenter_raw:epicenter, ...(point ? {coordinates_of_hypocenter:coordinates(...point)} : {}), eew_forecast_regions_raw:regions, eew_forecast_regions:[label], depth_of_hypocenter:`${depth}km`, depth_of_hypocenter_raw:depth, magnitude:'6.8', magnitude_raw:68, seismic_intensity_lower_limit:'震度5弱', seismic_intensity_lower_limit_raw:5, seismic_intensity_upper_limit:'震度6弱', seismic_intensity_upper_limit_raw:7 };
  for (const variant of ['発表','続報','取消','公式訓練OFF','期限切れ']) {
    const reports = variant === '続報' ? [report, {...report,magnitude:'7.0',magnitude_raw:70}] : variant === '取消' ? [report,{...report,information_type_no:2,information_type:'取消'}] : [{...report,...(variant === '公式訓練OFF' ? {report_classification_no:7} : {}),...(variant === '期限切れ' ? {replay_age_ms:16*60*1000} : {})}];
    add(`${label}／${variant}`, '緊急地震速報', {}, reports, { visible: ['発表','続報'].includes(variant), originAndAffectedRegions: point ? point[0] >= 100 && point[0] <= 170 && point[1] >= 15 && point[1] <= 55 : epicenter === 912, note: '東京本土コードだけでは離島をズームに含めない．震源が離島側にある場合は震源を含める．' });
  }
}
const weatherGroups = [[130010],[130020],[130030],[130040],[130000],[130010,130040],[130010,130020,130030,130040],[130010,140010],[130020,130030],[130000,140010]];
for (const codes of weatherGroups) for (const enabled of [false,true]) add(`気象 ${codes.join('＋')}／${enabled?'ON':'OFF'}`, '気象情報', {weatherEnabled:enabled}, [{ type:'QzssDcReportJmaWeather', disaster_category_no:10, disaster_category:'気象情報', weather_forecast_regions_raw:codes, weather_forecast_regions:codes.map(String), weather_related_disaster_sub_categories:codes.map(()=> '大雨警報') }], {visible:enabled, note:enabled?'東京都の区域は別々に巡回する．':'気象の塗り・カード・通知を出さない．'});
for (const name of ['桜島','浅間山','富士山','未登録火山']) for (const category of [8,9]) for (const enabled of [false,true]) add(`${name}／${category===8?'噴火警報':'降灰'}／${enabled?'ON':'OFF'}`, '火山情報', {volcanoEnabled:enabled}, [{ type:category===8?'QzssDcReportJmaVolcano':'QzssDcReportJmaAshFall', disaster_category_no:category,disaster_category:category===8?'火山':'降灰',volcano_name:name,volcano_name_raw:name,volcanic_warning_code_raw:14,volcanic_warning_code:'噴火警報（居住地域）',ash_fall_warning_codes_raw:[2],ash_fall_warning_codes:['多量の降灰'],local_governments_raw:[1310100],local_governments:['千代田区'],expected_ash_fall_times:[1]}], {visible:enabled,note:enabled?'火山位置が不明なら文字情報を残す．':'火山・降灰の図形・カード・通知を出さない．'});
for (const category of [2,3,5,11]) add(`他種別の回帰／分類${category}`, '地震・津波・洪水', {}, [{ type:'QzssDcReportJmaControl',disaster_category_no:category,disaster_category:({2:'震源',3:'震度',5:'津波',11:'洪水'})[category],coordinates_of_hypocenter:coordinates(140,35),seismic_epicenter:'東京湾',seismic_epicenter_raw:350,prefectures_raw:category===3?[13]:[],seismic_intensities_raw:[4],tsunami_warning_code_raw:category===5?3:undefined,tsunami_warning_code:'津波警報',tsunami_forecast_regions_raw:category===5?[320]:[],tsunami_forecast_regions:['東京湾内湾'],flood_forecast_regions_raw:category===11?[8303060001]:[],flood_forecast_regions:['利根川'],flood_warning_levels_raw:[3],flood_warning_levels:['氾濫危険情報']}],{visible:true,note:'気象・火山OFFでもこの種別は処理する．'});
if(cases.length!==100)throw Error(`Expected 100 cases, got ${cases.length}`);
fs.writeFileSync(path.join(__dirname,'../test/fixtures/review/cases.json'),JSON.stringify({schemaVersion:1,synthetic:true,description:'ローカル目視確認用．デコード後の合成データ．本番送信禁止．',cases},null,2)+'\n');
console.log(`Generated ${cases.length} review cases`);
