/* すべて架空の想定．デコード済み形式の表示試験であり，実電文ではない． */
(() => {
  const base = { is_test_data: true, report_classification_no: 1, report_classification: '最優先',
    information_type_no: 0, information_type: '発表', satellite_id: 56, satellite_prn: 184 };
  const coords = { lat_d: 33, lat_m: 0, lat_s: 0, lat_ns: 0, lon_d: 135, lon_m: 30, lon_s: 0, lon_ew: 0 };
  const quake = { ...base, seismic_epicenter: '紀伊半島沖（想定）', magnitude: '8.8', magnitude_raw: 88,
    depth_of_hypocenter: '20km', depth_of_hypocenter_raw: 20, coordinates_of_hypocenter: coords };
  const eew = { ...quake, type: 'QzssDcReportJmaEarthquakeEarlyWarning', disaster_category_no: 1, disaster_category: '緊急地震速報',
    seismic_intensity_lower_limit: '震度6弱', seismic_intensity_lower_limit_raw: 8,
    seismic_intensity_upper_limit: '震度7', seismic_intensity_upper_limit_raw: 10,
    eew_forecast_regions_raw: [64,65,67,68], eew_forecast_regions: ['東海','近畿','四国','九州'],
    notifications_on_disaster_prevention: ['これは画面検証用の架空の通報です．'] };
  const hypocenter = { ...quake, type: 'QzssDcReportJmaHypocenter', disaster_category_no: 2, disaster_category: '震源' };
  const intensity = { ...quake, type: 'QzssDcReportJmaSeismicIntensity', disaster_category_no: 3, disaster_category: '震度',
    prefectures_raw: [30,39,24,36,29,38,22,23,27,37,45,28],
    prefectures: ['和歌山県','高知県','三重県','徳島県','奈良県','愛媛県','静岡県','愛知県','大阪府','香川県','宮崎県','兵庫県'],
    seismic_intensities_raw: [7,7,6,6,5,5,4,4,4,4,4,3],
    seismic_intensities: ['7','7','6強','6強','6弱','6弱','5強','5強','5強','5強','5強','5弱'] };
  const tsunami = { ...quake, type: 'QzssDcReportJmaTsunami', disaster_category_no: 5, disaster_category: '津波',
    tsunami_warning_code_raw: 3, tsunami_warning_code: '津波警報',
    tsunami_forecast_regions_raw: [380,390,400,530,580,610,760],
    tsunami_forecast_regions: ['静岡県','愛知県外海','三重県南部','和歌山県','徳島県','高知県','宮崎県'] };
  const jalert = { ...base, type: 'QzssDcxJAlert', dcx_message_type: 'J-Alert', a1_message_type: 'Alert',
    a4_hazard_type: 'Missile attack', a5_severity: 'Extreme', ex8_target_area_list_type: 'Prefecture code',
    ex9_target_area_list_ja: ['北海道','青森県','岩手県'],
    a11_japanese_library_ja: 'これは画面の動作確認用の架空のメッセージです．実際の警報ではありません．' };
  window.QzssTestCases = [
    { id: 'eew', name: '緊急地震速報', detail: '対象地域・震源・自動ズームを確認', steps: [{ name: '緊急地震速報', report: eew }] },
    { id: 'tsunami', name: '津波警報', detail: '沿岸の点滅・警報パネルを確認', steps: [{ name: '津波警報', report: tsunami }] },
    { id: 'jalert', name: 'Jアラート', detail: '対象地域とメッセージを確認', steps: [{ name: 'Jアラート', report: jalert }] },
    { id: 'nankai', name: '南海トラフ想定・連続受信', detail: '緊急地震速報 → 震源 → 震度 → 津波を10秒間隔で受信',
      steps: [{ name: '緊急地震速報', report: eew }, { name: '震源情報', report: hypocenter },
        { name: '震度情報', report: intensity }, { name: '津波警報', report: tsunami }] },
  ];
})();
