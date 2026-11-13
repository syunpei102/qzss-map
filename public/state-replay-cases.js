/* 架空のデコード済み通報．本番送信は行わない． */
(function(root,factory){const data=factory();if(typeof module==='object'&&module.exports)module.exports=data;else root.QzssStateReplayCases=data;})(typeof self!=='undefined'?self:this,function(){
  const coords=(lat,lon)=>({lat_d:lat,lat_m:0,lat_s:0,lat_ns:0,lon_d:lon,lon_m:0,lon_s:0,lon_ew:0});
  const origins={a:{occurrence_time_of_earthquake:'2026-11-13T03:00:00',seismic_epicenter_raw:350,seismic_epicenter:'東海地方（架空）',coordinates_of_hypocenter:coords(34,137)},
    b:{occurrence_time_of_earthquake:'2026-11-13T03:02:00',seismic_epicenter_raw:700,seismic_epicenter:'東北地方（架空）',coordinates_of_hypocenter:coords(39,143)}};
  function quake(name,category){return {...origins[name],type:category===1?'QzssDcReportJmaEarthquakeEarlyWarning':category===2?'QzssDcReportJmaHypocenter':'QzssDcReportJmaSeismicIntensity',
    disaster_category_no:category,disaster_category:{1:'緊急地震速報',2:'震源',3:'震度'}[category],report_classification_no:1,information_type_no:0,
    raw:`sim:${name}:${category}`,magnitude:'6.5',depth_of_hypocenter:'20km',
    ...(category===1?{eew_forecast_regions_raw:name==='a'?[27,28]:[6,7],eew_forecast_regions:name==='a'?['静岡','愛知']:['岩手','宮城']}:{}),
    seismic_intensity_lower_limit:'震度5弱',seismic_intensity_lower_limit_raw:6,seismic_intensity_upper_limit:'震度6弱',seismic_intensity_upper_limit_raw:8,
    ...(category===3?{prefectures_raw:name==='a'?[22,23]:[3,4],prefectures:name==='a'?['静岡県','愛知県']:['岩手県','宮城県'],
    seismic_intensities_raw:[4,5],seismic_intensities:['5弱','5強']}:{} )};}
  function tsunami(name){return {type:'QzssDcReportJmaTsunami',disaster_category_no:5,disaster_category:'津波',report_classification_no:1,information_type_no:0,
    raw:`sim:tsunami:${name}`,tsunami_warning_code_raw:3,tsunami_warning_code:'津波警報',
    tsunami_forecast_regions_raw:name==='a'?[380]:[220],tsunami_forecast_regions:name==='a'?['静岡県']:['宮城県'],tsunami_heights:['3m'],tsunami_heights_raw:[4]};}
  const jalert={type:'QzssDcxJAlert',a1_message_type:'Alert',a4_hazard_type:'Missile attack',a5_severity:'Extreme',a6a7_hazard_onset_datetime:'2026-11-13T03:00:00+00:00',
    ex8_target_area_list_type:'Prefecture code',ex9_target_area_list_ja:['北海道','青森県'],a11_japanese_library_ja:'架空の動作確認用メッセージです．'};
  const step=(at,report)=>({at,report,name:report.disaster_category || 'Jアラート'});
  const a=quake('a',1),ai=quake('a',3),b=quake('b',1),bi=quake('b',3),at=tsunami('a'),bt=tsunami('b');
  return {quake,tsunami,jalert,cases:[
    {id:'case1',name:'1．同じ地震：EEWから震度へ',steps:[step(0,a),step(10000,ai)]},
    {id:'case2',name:'2．震度を保持して別地方のEEW',steps:[step(0,a),step(10000,ai),step(20000,b)]},
    {id:'case3',name:'3．2地震の震度を10秒巡回',steps:[step(0,a),step(10000,ai),step(20000,b),step(30000,bi)]},
    {id:'case4',name:'4．津波を残して別地方のEEW',steps:[step(0,a),step(10000,ai),step(20000,at),step(30000,b)]},
    {id:'case5',name:'5．震度の表示中に別地方のEEW',steps:[step(0,ai),step(10000,b)]},
    {id:'case6',name:'6．2地方の津波沿岸を同時表示',steps:[step(0,ai),step(10000,at),step(20000,bi),step(30000,bt)]},
  ]};
});
