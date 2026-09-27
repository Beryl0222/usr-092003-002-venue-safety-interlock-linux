"use strict";

const { isActiveStatus } = require("./domain");

// 统一存储：资源档案 + 场次 + 变更单 + 只增审计日志。
// 所有写操作同步完成（检查与落库之间不穿插 await），保证两笔并发操作不会重复占用同一资源。
class Store {
  constructor(options = {}) {
    this._now = options.now || (() => new Date().toISOString());
    this.spaces = new Map(); // 场地（主馆/训练区）
    this.equipment = new Map(); // 设备
    this.personnel = new Map(); // 人员及资质
    this.permits = new Map(); // 监管批文
    this.bookings = new Map(); // 场次（当前态）
    this.bookingEvents = []; // 场次事件流，用于按时间点复原状态
    this.changes = new Map(); // 变更通知单
    this.levelHistory = [{ level: "normal", at: "1970-01-01T00:00:00.000Z" }]; // 安保等级历史
    this.auditLog = []; // 只增审计日志
    this._seq = 0;
    this._counters = new Map();
  }

  now() {
    return this._now();
  }

  nextId(prefix) {
    const n = (this._counters.get(prefix) || 0) + 1;
    this._counters.set(prefix, n);
    return prefix + "_" + String(n).padStart(4, "0");
  }

  // 追加一条审计记录。拒绝、确认、放行等关键判定全部留痕，供值班经理回放。
  log(actor, action, entityType, entityId, summary, details) {
    const entry = {
      seq: ++this._seq,
      at: this.now(),
      actorId: actor ? actor.id : "system",
      actorRole: actor ? actor.role : "system",
      action,
      entityType,
      entityId: entityId || null,
      summary,
      details: details || {},
    };
    this.auditLog.push(entry);
    return entry;
  }

  // 追加场次事件（状态复原的事实来源）。
  recordBookingEvent(bookingId, type, data) {
    const event = { bookingId, type, at: this.now(), seq: this._seq, data: data || {} };
    this.bookingEvents.push(event);
    return event;
  }

  levelAt(isoTime) {
    let level = "normal";
    for (const entry of this.levelHistory) {
      if (entry.at <= isoTime) level = entry.level;
    }
    return level;
  }

  activeBookings() {
    return [...this.bookings.values()].filter((b) => isActiveStatus(b.status));
  }
}

module.exports = { Store };
