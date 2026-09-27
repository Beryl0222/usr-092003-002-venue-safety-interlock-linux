"use strict";

const {
  EVENT_PROFILES,
  SECURITY_LEVELS,
  isActiveStatus,
  overlaps,
  addDays,
  computeOccupancy,
  computeRequirements,
  securityNeeded,
  maxAttendanceForSecurity,
} = require("./domain");

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// ---------- 资源可用性 ----------

function equipmentFaultsDuring(unit, occupancy, asOf) {
  return (unit.faults || []).filter(
    (f) => f.reportedAt <= asOf && overlaps(f.from, f.to, occupancy.setupStart, occupancy.teardownEnd)
  );
}

// 已被其他在场次占用的资源（占用区间含布撤场窗口）。
function reservedByOthers(store, occupancy, excludeBookingId) {
  const equipment = new Set();
  const personnel = new Set();
  for (const other of store.activeBookings()) {
    if (other.id === excludeBookingId) continue;
    if (!overlaps(occupancy.setupStart, occupancy.teardownEnd, other.occupancy.setupStart, other.occupancy.teardownEnd)) {
      continue;
    }
    for (const ids of Object.values(other.assignments.equipment)) ids.forEach((id) => equipment.add(id));
    for (const ids of Object.values(other.assignments.personnel)) ids.forEach((id) => personnel.add(id));
  }
  return { equipment, personnel };
}

function freeEquipmentUnits(store, type, occupancy, excludeBookingId, asOf) {
  const used = reservedByOthers(store, occupancy, excludeBookingId).equipment;
  return [...store.equipment.values()].filter(
    (u) => u.type === type && !used.has(u.id) && equipmentFaultsDuring(u, occupancy, asOf || store.now()).length === 0
  );
}

function qualificationValidThrough(person, role, throughIso) {
  const expiry = (person.qualifications || {})[role];
  return typeof expiry === "string" && expiry >= throughIso;
}

function freePersonnel(store, role, occupancy, excludeBookingId) {
  const used = reservedByOthers(store, occupancy, excludeBookingId).personnel;
  return [...store.personnel.values()].filter(
    (p) => !used.has(p.id) && qualificationValidThrough(p, role, occupancy.teardownEnd)
  );
}

function permitValidAt(permit, asOf) {
  return !permit.revokedAt || permit.revokedAt > asOf;
}

function findPermit(store, scope, start, end, asOf, excludePermitId) {
  return [...store.permits.values()].find(
    (p) =>
      p.id !== excludePermitId &&
      p.scope === scope &&
      p.validFrom <= start &&
      p.validTo >= end &&
      permitValidAt(p, asOf)
  );
}

// ---------- 预留评估：布撤场窗口 + 安全容量 + 资源联锁 ----------

function evaluate(store, spec, excludeBookingId) {
  const profile = EVENT_PROFILES[spec.eventType];
  const level = store.levelAt(spec.start);
  const occupancy = computeOccupancy(profile, spec.start, spec.end);
  const requirements = computeRequirements(profile, spec.attendance, level);
  const conflicts = [];
  const gaps = [];
  const selection = { equipment: {}, personnel: {}, permits: [] };

  for (const other of store.activeBookings()) {
    if (other.id === excludeBookingId || other.spaceId !== spec.spaceId) continue;
    if (overlaps(occupancy.setupStart, occupancy.teardownEnd, other.occupancy.setupStart, other.occupancy.teardownEnd)) {
      conflicts.push({
        kind: "space",
        bookingId: other.id,
        title: other.title,
        status: other.status,
        occupancy: other.occupancy,
      });
    }
  }

  for (const [type, needed] of Object.entries(requirements.equipment)) {
    const free = freeEquipmentUnits(store, type, occupancy, excludeBookingId);
    if (free.length < needed) {
      gaps.push({ kind: "equipment", type, needed, available: free.length });
    } else {
      selection.equipment[type] = free.slice(0, needed).map((u) => u.id);
    }
  }

  const rolesNeeded = { security: requirements.securityPersonnel, ...requirements.personnel };
  for (const [role, needed] of Object.entries(rolesNeeded)) {
    const free = freePersonnel(store, role, occupancy, excludeBookingId);
    if (free.length < needed) {
      gaps.push({ kind: "personnel", role, needed, available: free.length });
    } else {
      selection.personnel[role] = free.slice(0, needed).map((p) => p.id);
    }
  }

  for (const scope of requirements.permitScopes) {
    const permit = findPermit(store, scope, spec.start, spec.end, store.now());
    if (!permit) {
      gaps.push({ kind: "permit", scope });
    } else {
      selection.permits.push(permit.id);
    }
  }

  return { profile, occupancy, requirements, conflicts, gaps, selection };
}

function getBooking(store, id) {
  const booking = store.bookings.get(id);
  if (!booking) throw new HttpError(404, "booking_not_found", "场次不存在");
  return booking;
}

// 校验已分配资源在当下仍然有效（签约/进场前复核）。
function verifyAssignments(store, booking) {
  const problems = [];
  for (const [type, ids] of Object.entries(booking.assignments.equipment)) {
    for (const id of ids) {
      const unit = store.equipment.get(id);
      if (!unit) {
        problems.push({ kind: "equipment", type, equipmentId: id, reason: "设备不存在" });
      } else {
        const faults = equipmentFaultsDuring(unit, booking.occupancy, store.now());
        if (faults.length > 0) {
          problems.push({ kind: "equipment", type, equipmentId: id, reason: "设备故障", faults });
        }
      }
    }
  }
  for (const [role, ids] of Object.entries(booking.assignments.personnel)) {
    for (const id of ids) {
      const person = store.personnel.get(id);
      if (!person || !qualificationValidThrough(person, role, booking.occupancy.teardownEnd)) {
        problems.push({ kind: "personnel", role, personnelId: id, reason: "资质缺失或已到期" });
      }
    }
  }
  for (const permitId of booking.permitsUsed) {
    const permit = store.permits.get(permitId);
    if (
      !permit ||
      !permitValidAt(permit, store.now()) ||
      permit.validFrom > booking.start ||
      permit.validTo < booking.end
    ) {
      problems.push({ kind: "permit", permitId, reason: "批文失效或被撤销" });
    }
  }
  const needed = securityNeeded(
    EVENT_PROFILES[booking.eventType],
    booking.attendance,
    store.levelAt(booking.start)
  );
  const assigned = (booking.assignments.personnel.security || []).length;
  if (assigned < needed) {
    problems.push({ kind: "security_shortage", needed, assigned });
  }
  return problems;
}

function createBooking(store, actor, input) {
  const { spaceId, eventType, title, start, end, attendance, ticketed } = input || {};
  const space = store.spaces.get(spaceId);
  if (!space) throw new HttpError(400, "validation", "场地不存在: " + spaceId);
  const profile = EVENT_PROFILES[eventType];
  if (!profile) throw new HttpError(400, "validation", "未知赛事类型: " + eventType);
  if (!title || typeof title !== "string") throw new HttpError(400, "validation", "缺少活动名称");
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new HttpError(400, "validation", "起止时间无效");
  }
  if (!Number.isInteger(attendance) || attendance < 1) {
    throw new HttpError(400, "validation", "预计人数必须为正整数");
  }
  // 安全容量联锁：预计人数超过场地容量直接拒绝。
  if (attendance > space.capacity) {
    const details = { capacity: space.capacity, attendance };
    store.log(actor, "booking.rejected", "booking", null, "预留申请被拒绝：超出安全容量", {
      reason: "capacity_exceeded",
      request: { spaceId, eventType, title, start, end, attendance },
      ...details,
    });
    throw new HttpError(409, "capacity_exceeded", "预计人数超出场地安全容量", details);
  }

  const spec = { spaceId, eventType, start, end, attendance };
  const evaluation = evaluate(store, spec, null);
  if (evaluation.conflicts.length > 0 || evaluation.gaps.length > 0) {
    // 拒绝必须留痕，值班经理可回放当日为何拒绝。
    store.log(actor, "booking.rejected", "booking", null, "预留申请被拒绝：档期或资源冲突", {
      reason: "booking_conflict",
      request: { spaceId, eventType, title, start, end, attendance },
      conflicts: evaluation.conflicts,
      gaps: evaluation.gaps,
    });
    throw new HttpError(409, "booking_conflict", "档期或资源冲突，无法预留", {
      conflicts: evaluation.conflicts,
      gaps: evaluation.gaps,
    });
  }

  const booking = {
    id: store.nextId("bk"),
    organizerId: actor.organizerId || actor.id,
    spaceId,
    spaceName: space.name,
    eventType,
    eventTypeLabel: profile.label,
    title,
    start,
    end,
    attendance,
    ticketed: Boolean(ticketed),
    status: "tentative",
    version: 1,
    occupancy: evaluation.occupancy,
    requirements: evaluation.requirements,
    assignments: { equipment: evaluation.selection.equipment, personnel: evaluation.selection.personnel },
    permitsUsed: evaluation.selection.permits,
    loadInBasis: null,
    createdAt: store.now(),
    createdBy: actor.id,
  };
  store.bookings.set(booking.id, booking);
  store.recordBookingEvent(booking.id, "created", { booking: JSON.parse(JSON.stringify(booking)) });
  store.log(actor, "booking.created", "booking", booking.id, "预留成功（暂定）", {
    spaceId,
    title,
    occupancy: booking.occupancy,
    requirements: booking.requirements,
  });
  return booking;
}

function transition(store, actor, booking, fromStatuses, toStatus, action, extra) {
  if (!fromStatuses.includes(booking.status)) {
    throw new HttpError(409, "invalid_transition", `当前状态不允许该操作（${booking.status}）`, {
      status: booking.status,
    });
  }
  booking.status = toStatus;
  booking.version += 1;
  store.recordBookingEvent(booking.id, toStatus, extra || {});
  store.log(actor, action, "booking", booking.id, extra && extra.summary ? extra.summary : "状态流转", {
    from: fromStatuses,
    to: toStatus,
    ...(extra && extra.logDetails ? extra.logDetails : {}),
  });
}

function confirmBooking(store, actor, id, expectedVersion) {
  const booking = getBooking(store, id);
  if (expectedVersion !== undefined && expectedVersion !== booking.version) {
    throw new HttpError(409, "version_mismatch", "场次版本已变化，请刷新后重试", { version: booking.version });
  }
  if (booking.status !== "tentative") {
    throw new HttpError(409, "invalid_transition", "仅暂定状态可签约", { status: booking.status });
  }
  const problems = verifyAssignments(store, booking);
  if (problems.length > 0) {
    store.log(actor, "booking.confirm_rejected", "booking", booking.id, "签约复核未通过", { problems });
    throw new HttpError(409, "requirements_broken", "资源状态已变化，签约前复核未通过", { problems });
  }
  transition(store, actor, booking, ["tentative"], "confirmed", "booking.confirmed", { summary: "场次签约" });
  return booking;
}

function loadIn(store, actor, id) {
  const booking = getBooking(store, id);
  if (booking.status !== "confirmed") {
    throw new HttpError(409, "invalid_transition", "仅签约状态可进场", { status: booking.status });
  }
  const now = store.now();
  if (now < booking.occupancy.setupStart || now > booking.occupancy.eventEnd) {
    throw new HttpError(409, "outside_load_in_window", "当前不在布场/活动窗口内，不能放行进场", {
      window: { setupStart: booking.occupancy.setupStart, eventEnd: booking.occupancy.eventEnd },
      now,
    });
  }
  const problems = verifyAssignments(store, booking);
  if (problems.length > 0) {
    store.log(actor, "booking.load_in_rejected", "booking", booking.id, "进场放行复核未通过", { problems });
    throw new HttpError(409, "requirements_broken", "进场前复核未通过", { problems });
  }
  // 放行依据：固化当场有效的批文、安保核算与设备状态，供事后复原。
  const basis = {
    checkedAt: now,
    approvedBy: actor.id,
    securityLevel: store.levelAt(booking.start),
    security: {
      needed: securityNeeded(EVENT_PROFILES[booking.eventType], booking.attendance, store.levelAt(booking.start)),
      assigned: (booking.assignments.personnel.security || []).length,
    },
    permits: booking.permitsUsed.map((pid) => {
      const p = store.permits.get(pid);
      return { id: p.id, scope: p.scope, validFrom: p.validFrom, validTo: p.validTo };
    }),
    equipment: Object.values(booking.assignments.equipment).flat(),
    personnel: booking.assignments.personnel,
  };
  booking.loadInBasis = basis;
  transition(store, actor, booking, ["confirmed"], "load_in", "booking.load_in", {
    summary: "进场放行",
    basis,
    logDetails: { basis },
  });
  return booking;
}

function cancelBooking(store, actor, id) {
  const booking = getBooking(store, id);
  transition(store, actor, booking, ["tentative", "confirmed"], "cancelled", "booking.cancelled", {
    summary: "场次取消",
  });
  return booking;
}

function completeBooking(store, actor, id) {
  const booking = getBooking(store, id);
  transition(store, actor, booking, ["load_in", "in_progress"], "completed", "booking.completed", {
    summary: "场次结束",
  });
  return booking;
}

// ---------- 变更影响分析：只标出实际受影响场次，由负责人确认 ----------

function findAlternativeSlots(store, booking, maxDays) {
  const slots = [];
  for (let d = 1; d <= (maxDays || 14) && slots.length < 3; d += 1) {
    const start = addDays(booking.start, d);
    const end = addDays(booking.end, d);
    const evaluation = evaluate(
      store,
      { spaceId: booking.spaceId, eventType: booking.eventType, start, end, attendance: booking.attendance },
      booking.id
    );
    if (evaluation.conflicts.length === 0 && evaluation.gaps.length === 0) {
      slots.push({ start, end });
    }
  }
  return slots;
}

function createChange(store, actor, kind, booking, impact, proposals) {
  const change = {
    id: store.nextId("chg"),
    kind,
    bookingId: booking.id,
    bookingTitle: booking.title,
    ticketed: booking.ticketed,
    status: "pending",
    impact,
    proposals,
    createdAt: store.now(),
    createdBy: actor ? actor.id : "system",
    acknowledgedBy: null,
    acknowledgedAt: null,
    resolution: null,
  };
  store.changes.set(change.id, change);
  store.log(actor, "change.created", "change", change.id, "变更通知已生成，待负责人确认", {
    kind,
    bookingId: booking.id,
    impact,
    proposals,
  });
  return change;
}

function reportEquipmentFault(store, actor, equipmentId, input) {
  const unit = store.equipment.get(equipmentId);
  if (!unit) throw new HttpError(404, "equipment_not_found", "设备不存在");
  const { from, to, reason } = input || {};
  if (!from || !to || !(from < to)) throw new HttpError(400, "validation", "故障窗口无效");
  const fault = { from, to, reason: reason || "未说明", reportedAt: store.now() };
  unit.faults = unit.faults || [];
  unit.faults.push(fault);
  store.log(actor, "equipment.fault_reported", "equipment", unit.id, "设备故障登记", { fault });

  const changes = [];
  for (const booking of store.activeBookings()) {
    const assigned = booking.assignments.equipment[unit.type] || [];
    if (!assigned.includes(unit.id)) continue;
    if (!overlaps(from, to, booking.occupancy.setupStart, booking.occupancy.teardownEnd)) continue;

    const proposals = [];
    const replacements = {};
    const faultyAssigned = assigned.filter((id) => id === unit.id);
    const pool = freeEquipmentUnits(store, unit.type, booking.occupancy, booking.id).filter((u) => u.id !== unit.id);
    if (pool.length >= faultyAssigned.length) {
      faultyAssigned.forEach((oldId, i) => {
        replacements[oldId] = pool[i].id;
      });
      proposals.push({
        kind: "reassign_equipment",
        auto: true,
        movesEvent: false,
        summary: "更换同类型备用设备，不涉及场次时间变动",
        replacements,
      });
    }
    const slots = findAlternativeSlots(store, booking, 14);
    if (slots.length > 0) {
      proposals.push({
        kind: "reschedule",
        auto: false,
        movesEvent: true,
        summary: booking.ticketed
          ? "已售票活动：仅提供备选档期，须负责人确认后人工调整，系统不会自动挪动"
          : "备选档期，须负责人确认",
        slots,
      });
    }
    changes.push(
      createChange(store, actor, "equipment_fault", booking, {
        equipmentId: unit.id,
        equipmentType: unit.type,
        faultWindow: { from, to },
        reason: fault.reason,
      }, proposals)
    );
  }
  return { fault, changes };
}

function revokePermit(store, actor, permitId, reason) {
  const permit = store.permits.get(permitId);
  if (!permit) throw new HttpError(404, "permit_not_found", "批文不存在");
  if (permit.revokedAt) throw new HttpError(409, "invalid_transition", "批文已处于撤销状态");
  permit.revokedAt = store.now();
  permit.revokeReason = reason || "监管撤销";
  store.log(actor, "permit.revoked", "permit", permit.id, "监管批文被撤销", { reason: permit.revokeReason });

  const changes = [];
  for (const booking of store.activeBookings()) {
    if (!booking.permitsUsed.includes(permit.id)) continue;
    if (booking.occupancy.teardownEnd < store.now()) continue;
    const proposals = [];
    const substitute = findPermit(store, permit.scope, booking.start, booking.end, store.now(), permit.id);
    if (substitute) {
      proposals.push({
        kind: "substitute_permit",
        auto: true,
        movesEvent: false,
        summary: "换用同类有效批文",
        permitId: substitute.id,
        scope: permit.scope,
      });
    } else {
      proposals.push({
        kind: "obtain_permit",
        auto: false,
        movesEvent: false,
        summary: "无替代批文，需重新申办: " + permit.scope,
        scope: permit.scope,
      });
    }
    changes.push(
      createChange(store, actor, "permit_revoked", booking, {
        permitId: permit.id,
        scope: permit.scope,
        reason: permit.revokeReason,
      }, proposals)
    );
  }
  return { permit, changes };
}

function raiseSecurityLevel(store, actor, level, effectiveFrom) {
  if (!SECURITY_LEVELS[level]) throw new HttpError(400, "validation", "未知安保等级: " + level);
  const at = effectiveFrom || store.now();
  store.levelHistory.push({ level, at });
  store.log(actor, "regulation.security_level_raised", "regulation", null, "监管提高安保等级", {
    level,
    effectiveFrom: at,
  });

  const changes = [];
  for (const booking of store.activeBookings()) {
    if (booking.occupancy.teardownEnd < at) continue;
    const profile = EVENT_PROFILES[booking.eventType];
    const needed = securityNeeded(profile, booking.attendance, level);
    const assigned = (booking.assignments.personnel.security || []).length;
    if (assigned >= needed) continue;
    const shortage = needed - assigned;
    const candidates = freePersonnel(store, "security", booking.occupancy, booking.id);
    const proposals = [];
    if (candidates.length >= shortage) {
      proposals.push({
        kind: "assign_security",
        auto: true,
        movesEvent: false,
        summary: "增派安保人员补足缺口",
        personnelIds: candidates.slice(0, shortage).map((p) => p.id),
      });
    }
    const maxAllowed = maxAttendanceForSecurity(profile, level, assigned + candidates.length);
    proposals.push({
      kind: "reduce_attendance",
      auto: false,
      movesEvent: false,
      summary: "若无法补足安保，需核减观众上限至 " + maxAllowed,
      maxAllowed,
    });
    changes.push(
      createChange(store, actor, "security_level_raised", booking, {
        level,
        needed,
        assigned,
        shortage,
      }, proposals)
    );
  }
  return { level, effectiveFrom: at, changes };
}

// 负责人确认变更通知。只有不挪动场次的方案可自动执行；
// 改期类方案（尤其已售票活动）永远需要人工另行处理，系统绝不悄悄挪动。
function ackChange(store, actor, changeId) {
  const change = store.changes.get(changeId);
  if (!change) throw new HttpError(404, "change_not_found", "变更单不存在");
  if (change.status !== "pending") {
    throw new HttpError(409, "invalid_transition", "变更单已处理", { status: change.status });
  }
  const booking = store.bookings.get(change.bookingId);
  change.acknowledgedBy = actor.id;
  change.acknowledgedAt = store.now();

  let applied = null;
  for (const proposal of change.proposals) {
    if (!proposal.auto || proposal.movesEvent) continue;
    if (proposal.kind === "reassign_equipment" && booking) {
      const ok = Object.values(proposal.replacements).every((newId) => {
        const unit = store.equipment.get(newId);
        return unit && equipmentFaultsDuring(unit, booking.occupancy, store.now()).length === 0 &&
          !reservedByOthers(store, booking.occupancy, booking.id).equipment.has(newId);
      });
      if (!ok) continue;
      for (const [oldId, newId] of Object.entries(proposal.replacements)) {
        const unit = store.equipment.get(oldId);
        const list = booking.assignments.equipment[unit.type];
        list[list.indexOf(oldId)] = newId;
      }
      applied = proposal;
    } else if (proposal.kind === "substitute_permit" && booking) {
      const permit = store.permits.get(proposal.permitId);
      if (!permit || !permitValidAt(permit, store.now())) continue;
      booking.permitsUsed = booking.permitsUsed.map((id) => (id === change.impact.permitId ? permit.id : id));
      applied = proposal;
    } else if (proposal.kind === "assign_security" && booking) {
      const free = new Set(freePersonnel(store, "security", booking.occupancy, booking.id).map((p) => p.id));
      if (!proposal.personnelIds.every((id) => free.has(id))) continue;
      booking.assignments.personnel.security = booking.assignments.personnel.security.concat(proposal.personnelIds);
      applied = proposal;
    }
    if (applied) break;
  }

  if (applied && booking) {
    booking.version += 1;
    store.recordBookingEvent(booking.id, "adjusted", {
      changeId: change.id,
      proposal: applied.kind,
      assignments: JSON.parse(JSON.stringify(booking.assignments)),
      permitsUsed: [...booking.permitsUsed],
    });
    change.status = "resolved";
    change.resolution = { appliedProposal: applied.kind, summary: applied.summary };
  } else {
    change.status = "acknowledged";
    change.resolution = { note: "已确认，待人工处理（不涉及系统自动调整）" };
  }
  store.log(actor, "change.acknowledged", "change", change.id, "变更通知已被负责人确认", {
    bookingId: change.bookingId,
    applied: applied ? applied.kind : null,
    status: change.status,
  });
  return change;
}

// ---------- 承办方视角：只看自己的资源缺口 ----------

function bookingGaps(store, booking) {
  return { bookingId: booking.id, status: booking.status, gaps: verifyAssignments(store, booking) };
}

// ---------- 值班经理视角：回放与复原 ----------

function auditReplay(store, date) {
  const entries = store.auditLog.filter((e) => e.at.slice(0, 10) === date);
  return {
    date,
    total: entries.length,
    rejections: entries.filter((e) => e.action.includes("rejected")),
    changeAcknowledgements: entries.filter((e) => e.action === "change.acknowledged"),
    entries,
  };
}

// 从场次事件流复原某一时刻的有效状态：场地占用、人员排班、放行依据。
function snapshotAt(store, at) {
  const bookings = new Map();
  const events = store.bookingEvents.filter((e) => e.at <= at).sort((a, b) => a.seq - b.seq);
  for (const event of events) {
    if (event.type === "created") {
      bookings.set(event.bookingId, JSON.parse(JSON.stringify(event.data.booking)));
    } else {
      const booking = bookings.get(event.bookingId);
      if (!booking) continue;
      if (event.type === "adjusted") {
        booking.assignments = JSON.parse(JSON.stringify(event.data.assignments));
        booking.permitsUsed = [...event.data.permitsUsed];
      } else {
        booking.status = event.type;
        if (event.type === "load_in") booking.loadInBasis = event.data.basis;
      }
      booking.version += 1;
    }
  }

  const bookingList = [...bookings.values()];
  const occupying = bookingList.filter(
    (b) => isActiveStatus(b.status) && b.occupancy.setupStart <= at && at <= b.occupancy.teardownEnd
  );

  const roster = [];
  for (const b of occupying) {
    for (const [role, ids] of Object.entries(b.assignments.personnel)) {
      for (const pid of ids) {
        const person = store.personnel.get(pid);
        roster.push({ personnelId: pid, name: person ? person.name : pid, role, bookingId: b.id, bookingTitle: b.title });
      }
    }
  }

  const spaces = [...store.spaces.values()].map((space) => ({
    id: space.id,
    name: space.name,
    capacity: space.capacity,
    blocks: occupying
      .filter((b) => b.spaceId === space.id)
      .map((b) => ({
        bookingId: b.id,
        title: b.title,
        status: b.status,
        setupStart: b.occupancy.setupStart,
        teardownEnd: b.occupancy.teardownEnd,
      })),
  }));

  const permits = [...store.permits.values()].map((p) => ({
    id: p.id,
    scope: p.scope,
    validFrom: p.validFrom,
    validTo: p.validTo,
    validAt: p.validFrom <= at && p.validTo >= at && permitValidAt(p, at),
  }));

  const equipmentFaults = [];
  for (const unit of store.equipment.values()) {
    for (const f of unit.faults || []) {
      if (f.reportedAt <= at && f.from <= at && at <= f.to) {
        equipmentFaults.push({ equipmentId: unit.id, type: unit.type, from: f.from, to: f.to, reason: f.reason });
      }
    }
  }

  return {
    at,
    securityLevel: store.levelAt(at),
    bookings: bookingList.map((b) => ({
      id: b.id,
      title: b.title,
      organizerId: b.organizerId,
      spaceId: b.spaceId,
      status: b.status,
      start: b.start,
      end: b.end,
      occupancy: b.occupancy,
      ticketed: b.ticketed,
      assignments: b.assignments,
      permitsUsed: b.permitsUsed,
      loadInBasis: b.loadInBasis || null,
    })),
    spaces,
    roster,
    permits,
    equipmentFaults,
  };
}

module.exports = {
  HttpError,
  evaluate,
  createBooking,
  confirmBooking,
  loadIn,
  cancelBooking,
  completeBooking,
  reportEquipmentFault,
  revokePermit,
  raiseSecurityLevel,
  ackChange,
  bookingGaps,
  auditReplay,
  snapshotAt,
};
