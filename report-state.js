// 再接続時に同じ表示を復元するための，副作用のない通報保存処理．
function reportGroupKey(report) {
  if (!report) return null;
  if (report.type === "QzssDcxJAlert") {
    const areas = [...(report.ex9_target_area_list_ja || [])].sort().join(",");
    return `jalert|${report.a4_hazard_type || ""}|${areas}`;
  }
  if (report.type === "QzssDcxLAlert" || report.type === "QzssDcxMTInfo") {
    // QzssDcxLAlert(消防庁経由)とQzssDcxMTInfo(自治体からの直接配信)は
    // フィールド構成が同一のため同じキー形式でグルーピングする
    if (typeof report.ex1_target_area_code_raw === "number") {
      return `lalert|${report.a4_hazard_type || ""}|ex1:${report.ex1_target_area_code_raw}`;
    }
    if (typeof report.a12_ellipse_centre_latitude === "number") {
      return `lalert|${report.a4_hazard_type || ""}|ellipse:${report.a12_ellipse_centre_latitude.toFixed(2)},${report.a13_ellipse_centre_longitude.toFixed(2)}`;
    }
    return `lalert|${report.a4_hazard_type || ""}|unknown`;
  }
  if ([8, 9].includes(report.disaster_category_no)) {
    return `cat:${report.disaster_category_no}|volcano:${report.volcano_name_raw ?? report.volcano_name ?? "unknown"}`;
  }
  if (report.disaster_category_no === 11 && report.flood_forecast_regions_raw?.length) {
    return `flood|${[...report.flood_forecast_regions_raw].sort().join(",")}`;
  }
  if (report.disaster_category_no === 5) return "tsunami"; // 津波は種別を問わずまとめて解除扱い
  if (report.disaster_category_no === 10) {
    const codes = [...(report.weather_forecast_regions_raw || [])].sort().join(",");
    return `weather|${codes}`;
  }
  if (typeof report.disaster_category_no === "number") {
    if ([1, 2, 3].includes(report.disaster_category_no)) {
      // 地震系(EEW/震源/震度)は震央コード、無ければ発生時刻でグルーピングする
      if (typeof report.seismic_epicenter_raw === "number") return `eq|epi:${report.seismic_epicenter_raw}`;
      if (report.occurrence_time_of_earthquake) return `eq|time:${report.occurrence_time_of_earthquake}`;
      return "eq|unknown";
    }
    return `cat:${report.disaster_category_no}`;
  }
  return null;
}


function reportScope(report) {
  return report.is_test_data ? "test" :
    (report.report_classification_no === 7 || report.a1_message_type === "Test") ? "training" : "live";
}

// 津波は1電文に最大5地域，洪水も複数河川が入る．地域単位で保存し，
// 一部の地域だけが更新されても他の地域を失わないようにする．
function splitReport(report) {
  const fields = report.disaster_category_no === 5
    ? ["tsunami_forecast_regions_raw", "tsunami_forecast_regions", "tsunami_heights_raw",
       "tsunami_heights", "expected_tsunami_arrival_times"]
    : report.disaster_category_no === 11
    ? ["flood_forecast_regions_raw", "flood_forecast_regions", "flood_warning_levels_raw", "flood_warning_levels"]
    : null;
  if (!fields || !report[fields[0]]?.length) return [report];
  return report[fields[0]].map((_, i) => {
    const part = { ...report };
    for (const field of fields) if (Array.isArray(report[field])) part[field] = report[field].slice(i, i + 1);
    return part;
  });
}

function storageKey(report) {
  const group = reportGroupKey(report);
  if (group === null) return null;
  let detail = "";
  if ([1, 2, 3].includes(report.disaster_category_no)) {
    detail = `|kind:${report.disaster_category_no}|areas:${JSON.stringify(report.prefectures_raw || report.eew_forecast_regions_raw || [])}`;
  } else if (report.disaster_category_no === 5) {
    detail = `|areas:${JSON.stringify(report.tsunami_forecast_regions_raw || [])}`;
  } else if (report.disaster_category_no === 9) {
    detail = `|areas:${JSON.stringify(report.local_governments_raw || [])}`;
  }
  return `${reportScope(report)}|${group}${detail}`;
}

function updateActiveReports(entries, report, receivedAt, isEnd) {
  // 旧形式の永続データも最初の更新時に地域単位へ展開する．
  let result = entries.flatMap(entry => splitReport(entry.report).map(part => ({ ...entry, report: part })));
  for (const part of splitReport(report)) {
    const group = reportGroupKey(part);
    if (isEnd) {
      if (group !== null) result = result.filter(entry => {
        if (reportScope(entry.report) !== reportScope(part)) return true;
        // 対象河川がない取消だけは，従来通り洪水全体を解除する．
        if (part.disaster_category_no === 11 && !part.flood_forecast_regions_raw?.length) {
          return entry.report.disaster_category_no !== 11;
        }
        return reportGroupKey(entry.report) !== group;
      });
    } else {
      const key = storageKey(part);
      if (key !== null) result = result.filter(entry => storageKey(entry.report) !== key);
      result.push({ report: part, receivedAt });
    }
  }
  return result;
}

module.exports = { reportGroupKey, splitReport, storageKey, updateActiveReports };
