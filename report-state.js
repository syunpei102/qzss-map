// 再接続時に同じ表示を復元するための，副作用のない通報保存処理．
const { ttlMsForReport } = require("./public/report-ttl");
const identity = require("./public/earthquake-identity");

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
    // 緯度・経度の両方が有限数のときだけ楕円キーを作る(片側欠損はunknownへ)
    if (Number.isFinite(report.a12_ellipse_centre_latitude) && Number.isFinite(report.a13_ellipse_centre_longitude)) {
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
      // 地震系(EEW/震源/震度)は発生時刻を優先し，無ければ震央コードでグルーピングする．
      // 発生時刻の有無が電文で異なる場合の照合は sameEarthquake が行う．
      if (report.occurrence_time_of_earthquake) return `eq|time:${report.occurrence_time_of_earthquake}`;
      if (typeof report.seismic_epicenter_raw === "number") return `eq|epi:${report.seismic_epicenter_raw}`;
      return "eq|unknown";
    }
    return `cat:${report.disaster_category_no}`;
  }
  return null;
}


const isEarthquake = report => [1, 2, 3].includes(report?.disaster_category_no);

// 両方で比較できる識別子は全て一致を要求する．片方の識別子が欠ける場合は
// 共通して存在する識別子へフォールバックし，手掛かりが無ければ未知同士として扱う．
// server.js の通知キーとpublic/main.jsの照合も同じ規則にする．
function sameEarthquake(a, b) {
  const id = r => ({ time: r.occurrence_time_of_earthquake, epicenter: r.seismic_epicenter_raw });
  return identity.sameEarthquake(id(a), id(b), { allowUnknown: true });
}

function sameGroup(a, b) {
  if (isEarthquake(a) && isEarthquake(b)) return sameEarthquake(a, b);
  const key = reportGroupKey(a);
  return key !== null && key === reportGroupKey(b);
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
    : report.disaster_category_no === 10
    ? ["weather_forecast_regions_raw", "weather_forecast_regions", "weather_related_disaster_sub_categories"]
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

function storageDetail(report) {
  if (isEarthquake(report)) {
    return `|kind:${report.disaster_category_no}|areas:${JSON.stringify(report.prefectures_raw || report.eew_forecast_regions_raw || [])}`;
  } else if (report.disaster_category_no === 5) {
    return `|areas:${JSON.stringify(report.tsunami_forecast_regions_raw || [])}`;
  } else if (report.disaster_category_no === 9) {
    return `|areas:${JSON.stringify(report.local_governments_raw || [])}`;
  }
  return "";
}

function storageKey(report) {
  const group = reportGroupKey(report);
  if (group === null) return null;
  return `${reportScope(report)}|${group}${storageDetail(report)}`;
}

function sameStorage(a, b) {
  if (isEarthquake(a) && isEarthquake(b)) {
    return a.disaster_category_no === b.disaster_category_no && reportScope(a) === reportScope(b)
      && sameEarthquake(a, b) && storageDetail(a) === storageDetail(b);
  }
  const key = storageKey(a);
  return key !== null && key === storageKey(b);
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
        return !sameGroup(entry.report, part);
      });
    } else {
      if (storageKey(part) !== null) result = result.filter(entry => !sameStorage(entry.report, part));
      result.push({ report: part, receivedAt });
    }
  }
  return result;
}

// receivedAtからTTL以上経過した通報を取り除く(ちょうどTTL経過した時点で期限切れ)．
function pruneExpiredReports(entries, now) {
  return entries.filter(entry => now - entry.receivedAt < ttlMsForReport(entry.report));
}

module.exports = { pruneExpiredReports, sameEarthquake, sameGroup, reportGroupKey, splitReport, storageKey, updateActiveReports };
