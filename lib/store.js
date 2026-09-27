"use strict";

// 事件溯源存储：所有状态变更先写日志再应用，任何时刻的状态都可由日志回放复原。

function emptyState() {
  return {
    spaces: {},
    equipment: {},
    staff: {},
    permits: {},
    regulations: [],
    faults: {},
    bookings: {},
    notices: {},
  };
}

const APPLY = {
  "space.upsert": (s, d) => { s.spaces[d.space.id] = d.space; },
  "equipment.upsert": (s, d) => { s.equipment[d.equipment.id] = d.equipment; },
  "staff.upsert": (s, d) => { s.staff[d.staff.id] = d.staff; },
  "permit.upsert": (s, d) => { s.permits[d.permit.id] = d.permit; },
  "regulation.add": (s, d) => { s.regulations.push(d.regulation); },
  "fault.upsert": (s, d) => { s.faults[d.fault.id] = d.fault; },
  "booking.upsert": (s, d) => { s.bookings[d.booking.id] = d.booking; },
  "notice.upsert": (s, d) => { s.notices[d.notice.id] = d.notice; },
  // 仅审计留痕（如被拒绝的冲突申请），不改变状态
  "booking.rejected": () => {},
};

function applyEntry(state, entry) {
  const apply = APPLY[entry.action];
  if (!apply) throw new Error("未知日志动作: " + entry.action);
  apply(state, entry.data || {});
}

const copy = (v) => JSON.parse(JSON.stringify(v));

class Store {
  constructor(clock) {
    this.clock = clock || (() => new Date().toISOString());
    this.state = emptyState();
    this.log = [];
    this.seq = 0;
    this.idSeq = 0;
  }

  nextId(prefix) {
    this.idSeq += 1;
    return `${prefix}-${String(this.idSeq).padStart(4, "0")}`;
  }

  // 变更唯一入口：深拷贝后应用并留痕，日志与当前状态互不共享引用
  dispatch(action, data, actor) {
    const entry = {
      seq: this.seq + 1,
      ts: this.clock(),
      actor: actor || "system",
      action,
      data: copy(data || {}),
    };
    applyEntry(this.state, { action: entry.action, data: copy(entry.data) });
    this.seq = entry.seq;
    this.log.push(entry);
    return entry;
  }

  // 回放：复原 asOf 时刻（含）之前所有日志应用后的有效状态
  replay(asOf) {
    const state = emptyState();
    for (const entry of this.log) {
      if (entry.ts <= asOf) applyEntry(state, copy(entry));
    }
    return state;
  }
}

module.exports = { Store, emptyState, applyEntry };
