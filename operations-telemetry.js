// 既存の受信処理から運用画面に必要な値だけを，プロセス内に有界で保持する．
// 状態をGCSへ追加保存せず，Cloud Monitoring APIも呼ばない．
const SATELLITE_NAMES = {
  55: 'みちびき初号機',
  56: 'みちびき2号機',
  57: 'みちびき4号機',
  58: 'みちびき初号機後継機',
  61: 'みちびき3号機',
};

class OperationsTelemetry {
  constructor({ maxRecent = 20, maxRawChars = 6000 } = {}) {
    this.maxRecent = maxRecent;
    this.maxRawChars = maxRawChars;
    this.startedAt = Date.now();
    this.pageViews = 0;
    this.ingestCount = 0;
    this.lastReceivedAt = null;
    this.lastHeartbeatAt = null;
    this.serialConnected = null;
    this.satellites = new Map();
    this.recent = [];
    this.nextReportId = 1;
  }

  notePageView() { this.pageViews += 1; }

  noteIncoming(report, rawJson, { deviceId = null, now = Date.now() } = {}) {
    if (!report || typeof report !== 'object' || Array.isArray(report)) return;
    this.ingestCount += 1;
    this.lastReceivedAt = now;
    if (Number.isInteger(report.satellite_id) && report.satellite_id >= 0 && report.satellite_id <= 63) {
      this.satellites.set(report.satellite_id, {
        satelliteId: report.satellite_id,
        satellitePrn: Number.isInteger(report.satellite_prn) ? report.satellite_prn : null,
        name: SATELLITE_NAMES[report.satellite_id] || `衛星ID ${report.satellite_id}`,
        receivedAt: now,
      });
    }
    if (report.type === 'Heartbeat') {
      this.lastHeartbeatAt = now;
      if (typeof report.serial_connected === 'boolean') this.serialConnected = report.serial_connected;
      return;
    }
    const serialized = typeof rawJson === 'string' ? rawJson : JSON.stringify(report);
    this.recent.unshift({
      id: this.nextReportId++,
      receivedAt: now,
      deviceId,
      type: String(report.type || '不明').slice(0, 100),
      category: String(report.disaster_category || report.a4_hazard_type || report.message_type || '').slice(0, 100),
      informationType: String(report.information_type || report.a1_message_type || '').slice(0, 100),
      satelliteId: Number.isInteger(report.satellite_id) ? report.satellite_id : null,
      satellitePrn: Number.isInteger(report.satellite_prn) ? report.satellite_prn : null,
      description: String(report.description || '').slice(0, 500),
      rawJson: serialized.slice(0, this.maxRawChars),
      truncated: serialized.length > this.maxRawChars,
    });
    if (this.recent.length > this.maxRecent) this.recent.length = this.maxRecent;
  }

  snapshot(now = Date.now()) {
    return {
      sampledAt: now,
      startedAt: this.startedAt,
      pageViewsSinceStart: this.pageViews,
      ingestCountSinceStart: this.ingestCount,
      lastReceivedAt: this.lastReceivedAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      serialConnected: this.serialConnected,
      satellites: [...this.satellites.values()].sort((a, b) => b.receivedAt - a.receivedAt),
      recent: this.recent.map(({ rawJson, truncated, ...summary }) => summary),
    };
  }

  rawSnapshot() {
    return this.recent.map(({ id, rawJson, truncated }) => ({ id, rawJson, truncated }));
  }
}

module.exports = { OperationsTelemetry };
