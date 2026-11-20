// Lアラートの表示状態を地図描画から分離する．時刻を注入できるので状態遷移を単体検証できる．
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LAlertDisplay = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const HOUR = 3600000;
  const BANNER_MS = 10000;
  const LIST_MS = 15 * 60000;
  const MAP_MS = 30 * 60000;
  const PAGE_MS = 20000;
  const ranks = { Extreme: 1, Urgent: 1, Severe: 2, Moderate: 3, Minor: 4, Unknown: 5 };
  const durations = { 'Duration < 6H': 6 * HOUR, '6H <= Duration < 12H': 12 * HOUR,
    '12H <= Duration < 24H': 24 * HOUR };
  const isLAlert = report => ['QzssDcxLAlert', 'QzssDcxMTInfo'].includes(report?.type);
  const hasUndefinedHazard = report => report?.a4_hazard_type_raw === 0
    || /^(?:Undefined hazard type \(Code:\s*0\)|Not used)$/i.test(String(report?.a4_hazard_type || '').trim());
  const isTraining = report => report?.is_test_data === true || report?.report_classification_no === 7
    || report?.a1_message_type === 'Test';
  const severity = report => {
    const raw = String(report.a5_severity || 'Unknown');
    return Object.keys(ranks).find(value => raw.startsWith(value)) || 'Unknown';
  };
  const keyOf = report => {
    const hazard = String(report.a4_hazard_type || 'Unknown');
    if (report.ex1_target_area_code_raw != null) return `${hazard}|ex1:${report.ex1_target_area_code_raw}`;
    if (Number.isFinite(report.a12_ellipse_centre_latitude) && Number.isFinite(report.a13_ellipse_centre_longitude))
      return `${hazard}|ellipse:${report.a12_ellipse_centre_latitude.toFixed(2)},${report.a13_ellipse_centre_longitude.toFixed(2)}`;
    return `${hazard}|area:${report.ex1_target_area_ja || ''}`;
  };
  const waitMs = count => count >= 20 ? 60000 : count >= 10 ? 5 * 60000 : 30 * 60000;

  class Manager {
    constructor({ now = Date.now, onChange = () => {}, fullscreenEligible = false, pageSize = 5 } = {}) {
      this.now = now;
      this.onChange = onChange;
      this.fullscreenEligible = fullscreenEligible;
      this.pageSize = pageSize;
      this.records = new Map();
      this.mode = 'map';
      this.disasterActive = false;
      this.calmSince = now();
      this.mapUntil = 0;
      this.listUntil = 0;
      this.bannerSince = now();
      this.pageSince = now();
      this.bannerIndex = 0;
      this.pageIndex = 0;
      this.revision = 0;
    }
    sorted() {
      return [...this.records.values()].sort((a, b) => a.severityRank - b.severityRank
        || b.receivedAt - a.receivedAt || a.id.localeCompare(b.id));
    }
    visible() {
      return this.sorted().filter(record => !record.isCanceling || this.now() < record.cancelScheduledAt + BANNER_MS);
    }
    receive(report) {
      if (!isLAlert(report) || isTraining(report) || hasUndefinedHazard(report)) return false;
      const now = this.now();
      const id = keyOf(report);
      if (report.a1_message_type === 'All Clear') {
        const existing = this.records.get(id);
        if (!existing) return false;
        this.records.set(id, { ...existing, message: `【解除】${existing.areaName}の${existing.hazardNameJa}情報を解除しました．`,
          isCanceling: true, cancelScheduledAt: now, expiresAt: now + BANNER_MS });
        this.bannerIndex = this.sorted().findIndex(record => record.id === id);
        this.bannerSince = now;
      } else {
        const replayAge = Math.max(0, Number(report.replay_age_ms) || 0);
        const ttl = Math.min(24 * HOUR, durations[report.a8_hazard_duration] || 3 * HOUR) - replayAge;
        if (ttl <= 0) return false;
        const level = severity(report);
        const municipalityCode = report.ex1_target_area_code_raw == null ? null
          : String(report.ex1_target_area_code_raw).padStart(5, '0');
        const areaName = String(report.ex1_target_area_ja || (municipalityCode ? `自治体コード ${municipalityCode}` : '対象地域')).trim();
        const message = String(report.a11_japanese_library_ja || '詳細を確認してください．').trim();
        const previous = this.records.get(id);
        if (previous && !previous.isCanceling && previous.severity === level && previous.areaName === areaName
            && previous.message === message && previous.durationCode === report.a8_hazard_duration) return false;
        this.records.set(id, { id, municipalityCode, areaName, hazardType: report.a4_hazard_type || '',
          hazardNameJa: report.hazardNameJa || report.a4_hazard_type || '自治体情報', severity: level,
          severityRank: ranks[level], message, durationCode: report.a8_hazard_duration,
          durationHours: Math.round(ttl / HOUR), receivedAt: now - replayAge, expiresAt: now + ttl,
          isCanceling: false, cancelScheduledAt: null, source: report.type === 'QzssDcxMTInfo' ? '自治体情報' : 'Lアラート' });
      }
      this.revision++;
      this.tick();
      this.onChange();
      return true;
    }
    setDisasterActive(active) {
      const now = this.now();
      if (active === this.disasterActive) return;
      this.disasterActive = active;
      if (active) {
        this.mode = 'map';
        this.calmSince = null;
        this.listUntil = 0;
        this.mapUntil = 0;
      } else {
        this.calmSince = now;
      }
      this.revision++;
      this.onChange();
    }
    tick() {
      const now = this.now();
      let changed = false;
      for (const [id, record] of this.records) {
        if (now >= record.expiresAt || (record.isCanceling && now >= record.cancelScheduledAt + BANNER_MS)) {
          this.records.delete(id);
          changed = true;
        }
      }
      const count = this.records.size;
      if (this.mode === 'list') {
        if (this.disasterActive || count < 5 || now >= this.listUntil) {
          this.mode = 'map';
          this.mapUntil = this.disasterActive ? 0 : now + MAP_MS;
          changed = true;
        } else if (now - this.pageSince >= PAGE_MS) {
          this.pageIndex = (this.pageIndex + Math.floor((now - this.pageSince) / PAGE_MS))
            % Math.max(1, Math.ceil(count / this.pageSize));
          this.pageSince = now;
          changed = true;
        }
      } else if (this.fullscreenEligible && !this.disasterActive && count >= 5 && this.calmSince != null
          && now >= Math.max(this.calmSince + waitMs(count), this.mapUntil)) {
        this.mode = 'list';
        this.listUntil = now + LIST_MS;
        this.pageSince = now;
        this.pageIndex = 0;
        changed = true;
      }
      if (now - this.bannerSince >= BANNER_MS) {
        this.bannerIndex = (this.bannerIndex + Math.floor((now - this.bannerSince) / BANNER_MS)) % Math.max(1, count);
        this.bannerSince = now;
        changed = true;
      }
      if (changed) { this.revision++; this.onChange(); }
      return changed;
    }
    clear() {
      this.records.clear();
      this.mode = 'map';
      this.calmSince = this.disasterActive ? null : this.now();
      this.mapUntil = 0;
      this.listUntil = 0;
      this.bannerIndex = 0;
      this.revision++;
      this.onChange();
    }
  }
  return { Manager, isLAlert, isTraining, hasUndefinedHazard, keyOf, waitMs, BANNER_MS, PAGE_MS };
});
