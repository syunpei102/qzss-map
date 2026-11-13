// 再接続時に同じ表示を復元するための，副作用のない通報保存処理．
const { ttlMsForReport } = require("./public/report-ttl");
const ReportGeography = require("./public/report-geography");
const TrainingReportFilter = require("./public/training-report-filter");
const identity = require("./public/earthquake-identity");
const DisplayEvents = require("./public/display-events");

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
  return DisplayEvents.sameIdentity(a, b);
}

function sameGroup(a, b) {
  if (isEarthquake(a) && isEarthquake(b)) return sameEarthquake(a, b);
  const key = reportGroupKey(a);
  return key !== null && key === reportGroupKey(b);
}

function reportScope(report) {
  return report.is_test_data ? "test" :
    TrainingReportFilter.isOfficialTraining(report) ? "training" : "live";
}

// 津波は1電文に最大5地域，洪水も複数河川が入る．地域単位で保存し，
// 一部の地域だけが更新されても他の地域を失わないようにする．
function splitReport(report) {
  if (report.disaster_category_no === 10 && report.weather_forecast_regions_raw?.includes(130000)) {
    const areas = ReportGeography.weatherAreas(report);
    report = { ...report, weather_forecast_regions_raw: areas.map(area => area.code),
      weather_forecast_regions: areas.map(area => area.name || String(area.code)),
      weather_related_disaster_sub_categories: areas.map(area => area.subCategory) };
  }
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
  if (a.type === "QzssDcxJAlert" && b.type === a.type) return reportScope(a) === reportScope(b) && DisplayEvents.warningId(a) === DisplayEvents.warningId(b);
  if (isEarthquake(a) && isEarthquake(b)) {
    return a.disaster_category_no === b.disaster_category_no && reportScope(a) === reportScope(b)
      && (a.display_event_id || DisplayEvents.resolveEarthquakeId(a)) === (b.display_event_id || DisplayEvents.resolveEarthquakeId(b)) && storageDetail(a) === storageDetail(b);
  }
  const key = storageKey(a);
  return key !== null && key === storageKey(b);
}

// 通知の従来の遅延通報抑止にのみ使う．表示状態はこの判定で削除しない．
function isSupersededEarthquakeReport(entries, report) {
  if (!isEarthquake(report)) return false;
  const incomingTime = Date.parse(report.occurrence_time_of_earthquake || '');
  if (!Number.isFinite(incomingTime)) return false;
  return entries.some(entry => entry.report.disaster_category_no === 1
    && reportScope(entry.report) === reportScope(report)
    && !sameEarthquake(entry.report, report)
    && Date.parse(entry.report.occurrence_time_of_earthquake || '') > incomingTime);
}

function updateActiveReports(entries, report, receivedAt, isEnd, lastReceivedAt = receivedAt) {
  // 旧形式の永続データも最初の更新時に地域単位へ展開する．
  let result = entries.flatMap(entry => splitReport(entry.report).map(part => ({ ...entry, report: part })));
  for (let part of splitReport(report)) {
    if (isEarthquake(part)) {
      const candidates = result.filter(e => isEarthquake(e.report)).map(e => ({ ...e, id: e.report.display_event_id }));
      const id = DisplayEvents.resolveEarthquakeId(part, candidates);
      part = { ...part, display_event_id: id };
    } else if (part.type === 'QzssDcxJAlert') {
      part = {...part, display_event_id: DisplayEvents.resolveWarningId(part, result.filter(e => e.report.type === 'QzssDcxJAlert'))};
    }
    const group = reportGroupKey(part);
    if (isEnd) {
      if (group !== null) result = result.filter(entry => {
        if (reportScope(entry.report) !== reportScope(part)) return true;
        // 対象河川がない取消だけは，従来通り洪水全体を解除する．
        if (part.disaster_category_no === 11 && !part.flood_forecast_regions_raw?.length) {
          return entry.report.disaster_category_no !== 11;
        }
        if (isEarthquake(part)) {
          if (!DisplayEvents.identity(report).time && DisplayEvents.identity(report).epicenter == null && !report.display_event_id) return true;
          return (entry.report.display_event_id || DisplayEvents.resolveEarthquakeId(entry.report)) !== part.display_event_id;
        }
        if (part.type === 'QzssDcxJAlert') return DisplayEvents.warningId(entry.report) !== DisplayEvents.warningId(part);
        if (part.disaster_category_no === 5 && part.tsunami_forecast_regions_raw?.length) {
          return entry.report.disaster_category_no !== 5 || !(entry.report.tsunami_forecast_regions_raw || []).some(c => part.tsunami_forecast_regions_raw.includes(c));
        }
        return !sameGroup(entry.report, part);
      });
    } else {
      if (isEarthquake(part)) {
        if (result.some(entry => reportScope(entry.report) === reportScope(part) && (entry.report.display_event_id || DisplayEvents.resolveEarthquakeId(entry.report)) === part.display_event_id
          && entry.report.disaster_category_no > part.disaster_category_no)) continue;
        result = result.filter(entry => !(isEarthquake(entry.report) && reportScope(entry.report) === reportScope(part)
          && (entry.report.display_event_id || DisplayEvents.resolveEarthquakeId(entry.report)) === part.display_event_id && entry.report.disaster_category_no < part.disaster_category_no));
      }
      if (storageKey(part) !== null) result = result.filter(entry => !sameStorage(entry.report, part));
      result.push({ report: part, receivedAt, lastReceivedAt, firstReceivedAt: lastReceivedAt - (Number(part.display_first_received_age_ms) || (lastReceivedAt - receivedAt)) });
    }
  }
  return result;
}

// receivedAtからTTL以上経過した通報を取り除く(ちょうどTTL経過した時点で期限切れ)．
function pruneExpiredReports(entries, now) {
  return entries.filter(entry => now - entry.receivedAt < ttlMsForReport(entry.report));
}

module.exports = { isSupersededEarthquakeReport, pruneExpiredReports, sameEarthquake, sameGroup, reportGroupKey, splitReport, storageKey, updateActiveReports };


// Keep first receipts after display expiry so RF repeats cannot resurrect old earthquakes．
class EarthquakeReceptions {
  constructor(saved = []) {
    this.entries = [];
    for (const entry of Array.isArray(saved) ? saved : []) {
      if (!entry?.report || !Number.isFinite(entry.at)) continue;
      if (entry.phaseFirst && entry.id) this.entries.push(entry);
      else this.observe({ ...entry.report, raw: entry.key }, entry.at);
    }
  }
  observe(report, now) {
    this.entries = this.entries.filter(e => now - (e.lastSeen ?? e.at) < 172800000);
    const ownTime = DisplayEvents.identity(report).time;
    const candidates = this.entries.filter(e => ownTime && DisplayEvents.identity(e.report).time === ownTime || now - (e.phaseFirst?.[e.highest] ?? e.at) < 600000);
    const id = DisplayEvents.resolveEarthquakeId(report, candidates);
    let existing = this.entries.find(e => e.id === id);
    if (!existing) {
      existing = {id, at:now, phaseFirst:{}, highest:0, report:{}, lastSeen:now};
      this.entries.push(existing);
    }
    existing.lastSeen=now;
    const phase=report.disaster_category_no;
    if (phase < existing.highest) return {rejected:true};
    existing.phaseFirst[phase] ??= now;
    existing.at = Math.min(...Object.values(existing.phaseFirst));
    existing.highest = Math.max(existing.highest,phase);
    existing.report = {disaster_category_no:phase,occurrence_time_of_earthquake:report.occurrence_time_of_earthquake || existing.report.occurrence_time_of_earthquake,
      seismic_epicenter_raw:report.seismic_epicenter_raw ?? existing.report.seismic_epicenter_raw,
      is_test_data:report.is_test_data,report_classification_no:report.report_classification_no};
    this.entries=this.entries.slice(-5000);
    return {at:existing.phaseFirst[phase], firstAt:existing.at, eventId:id, changed:true};
  }
}
module.exports.EarthquakeReceptions = EarthquakeReceptions;
