// デバイスコマンドの配送状態管理(Issue #18)．副作用を持たず，永続化は呼び出し側が行う．
//
// 端末がack対応(status報告の supports_ack:true)の場合は，ackされるまで期限内・
// 最大配送回数まで再配信する(at-least-once)．ack非対応の旧端末は，再配信すると
// rebootを繰り返す恐れがあるため従来どおり1回だけ渡す(at-most-once)．
// 端末は非冪等なコマンド(reboot)を実行する「前に」ackすること．
const COMMAND_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_DELIVERIES = 5;
const MAX_FINISHED_HISTORY = 20;
const SUPPORTED_COMMANDS = ["reboot", "force_update_check"];

const crypto = require("node:crypto");

class DeviceCommandQueue {
  constructor({ now = Date.now, ttlMs = COMMAND_TTL_MS, maxDeliveries = MAX_DELIVERIES, newId = () => crypto.randomUUID() } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxDeliveries = maxDeliveries;
    this.newId = newId;
    this.byDevice = new Map(); // deviceId -> record[]
  }

  enqueue(deviceId, command) {
    const t = this.now();
    const record = {
      id: this.newId(), command, requestedAt: t, expiresAt: t + this.ttlMs,
      // pending -> delivered -> acked / expired / failed / sent_unconfirmed(旧端末)
      state: "pending", deliveryCount: 0, deliveredAt: null, ackedAt: null,
    };
    const list = this.byDevice.get(deviceId) || [];
    list.push(record);
    this.byDevice.set(deviceId, list);
    return record;
  }

  // 端末のstatus報告時に呼ぶ．返り値は今回端末へ渡すコマンド．
  collect(deviceId, { supportsAck = false, ackedIds = [] } = {}) {
    const list = this.byDevice.get(deviceId);
    if (!list) return [];
    const t = this.now();
    const acks = new Set(Array.isArray(ackedIds) ? ackedIds.filter(id => typeof id === "string") : []);
    const out = [];
    for (const r of list) {
      if (acks.has(r.id) && (r.state === "pending" || r.state === "delivered" || r.state === "failed")) {
        r.state = "acked";
        r.ackedAt = t;
        continue;
      }
      if (r.state !== "pending" && r.state !== "delivered") continue;
      if (t >= r.expiresAt) { r.state = "expired"; continue; }
      if (supportsAck) {
        if (r.deliveryCount >= this.maxDeliveries) { r.state = "failed"; continue; }
        r.state = "delivered";
      } else {
        if (r.state === "delivered") continue;
        r.state = "sent_unconfirmed";
      }
      r.deliveryCount += 1;
      r.deliveredAt = t;
      out.push({ id: r.id, command: r.command, requestedAt: r.requestedAt });
    }
    this._trim(deviceId);
    return out;
  }

  // 管理者向け: 配信・確認状態(期限切れも反映)
  list(deviceId) {
    const t = this.now();
    const list = this.byDevice.get(deviceId) || [];
    for (const r of list) if ((r.state === "pending" || r.state === "delivered") && t >= r.expiresAt) r.state = "expired";
    return list.map(r => ({ ...r }));
  }

  hasDevice(deviceId) { return this.byDevice.has(deviceId); }
  delete(deviceId) { return this.byDevice.delete(deviceId); }

  _trim(deviceId) {
    const list = this.byDevice.get(deviceId);
    const open = list.filter(r => r.state === "pending" || r.state === "delivered");
    const finished = list.filter(r => !(r.state === "pending" || r.state === "delivered")).slice(-MAX_FINISHED_HISTORY);
    const next = [...finished, ...open].sort((a, b) => a.requestedAt - b.requestedAt);
    if (next.length) this.byDevice.set(deviceId, next); else this.byDevice.delete(deviceId);
  }

  toJSON() { return Object.fromEntries(this.byDevice); }

  restore(data) {
    if (!data || typeof data !== "object") return;
    for (const [deviceId, list] of Object.entries(data)) {
      if (!Array.isArray(list)) continue;
      const valid = list.flatMap(r => {
        if (!r || typeof r.id !== "string" || !SUPPORTED_COMMANDS.includes(r.command) || !Number.isFinite(r.requestedAt)) return [];
        const state = ["pending", "delivered", "acked", "expired", "failed", "sent_unconfirmed"].includes(r.state) ? r.state : "pending";
        return [{
          id: r.id,
          command: r.command,
          requestedAt: r.requestedAt,
          expiresAt: Number.isFinite(r.expiresAt) ? r.expiresAt : r.requestedAt + this.ttlMs,
          state,
          deliveryCount: Number.isInteger(r.deliveryCount) && r.deliveryCount >= 0 ? r.deliveryCount : 0,
          deliveredAt: Number.isFinite(r.deliveredAt) ? r.deliveredAt : null,
          ackedAt: Number.isFinite(r.ackedAt) ? r.ackedAt : null,
        }];
      });
      if (valid.length) this.byDevice.set(deviceId, valid);
    }
  }
}

module.exports = { DeviceCommandQueue, COMMAND_TTL_MS, MAX_DELIVERIES, SUPPORTED_COMMANDS };
