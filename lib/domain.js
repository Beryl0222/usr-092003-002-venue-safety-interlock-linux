"use strict";

// 领域核心：档期窗口、安全容量、资源占用与影响分析。
// 全部为纯函数，不持有状态，便于单测与回放复用。

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

// 处于这些状态的预留会真实占用资源（防止暂定/签约/进场被重复占用）
const ACTIVE_STATES = ["tentative", "contracted", "load-in"];

// 监管保障级别 → 安全容量系数
const LEVEL_FACTORS = { 1: 1, 2: 0.8, 3: 0.5 };

// 每名安保人员可保障的观众数
const SECURITY_RATIO = 250;

function toMs(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

function toIso(ms) {
  return new Date(ms).toISOString();
}

// 半开区间 [start, end) 重叠判断
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function isActive(booking) {
  return ACTIVE_STATES.includes(booking.status);
}

// 由活动参数计算布场/撤场窗口：占用区间 = [开场-布场, 散场+撤场)
function computeWindows(req) {
  const eventStart = toMs(req.eventStart);
  const eventEnd = toMs(req.eventEnd);
  return {
    setupStart: toIso(eventStart - (req.setupHours || 0) * HOUR_MS),
    eventStart: toIso(eventStart),
    eventEnd: toIso(eventEnd),
    teardownEnd: toIso(eventEnd + (req.teardownHours || 0) * HOUR_MS),
  };
}

// 某场地在某时刻生效的监管保障级别（取覆盖该时刻的最高级别）
function effectiveLevel(state, spaceId, atMs) {
  let level = 1;
  for (const reg of state.regulations) {
    if (reg.spaceId !== "*" && reg.spaceId !== spaceId) continue;
    const from = toMs(reg.from);
    const until = reg.until ? toMs(reg.until) : Infinity;
    if (from <= atMs && atMs < until && reg.level > level) level = reg.level;
  }
  return level;
}

function levelFactor(level) {
  return LEVEL_FACTORS[level] || 1;
}

// 安全容量 = 场地容量 × 当前保障级别系数
function allowedCapacity(state, spaceId, atMs) {
  const space = state.spaces[spaceId];
  if (!space) return { level: 1, allowed: 0 };
  const level = effectiveLevel(state, spaceId, atMs);
  return { level, allowed: Math.floor(space.capacity * levelFactor(level)) };
}

// 按观众数推导所需安保人数
function requiredSecurity(attendance) {
  if (!attendance || attendance <= 0) return 0;
  return Math.ceil(attendance / SECURITY_RATIO);
}

// 合并显性人员需求与按观众数推导的安保需求（同资质取最大值）
function mergedStaffRequirements(req) {
  const map = new Map();
  for (const s of req.staff || []) {
    map.set(s.qualification, Math.max(map.get(s.qualification) || 0, s.count));
  }
  const explicit = map.has("security");
  const sec = requiredSecurity(req.expectedAttendance);
  if (sec > 0) map.set("security", Math.max(map.get("security") || 0, sec));
  return [...map.entries()].map(([qualification, count]) => ({
    qualification,
    count,
    derived: qualification === "security" && !explicit,
  }));
}

// 设备在窗口内的可用量 = 总量 - 故障占用 - 其他有效预留占用
function equipmentAvailability(state, equipmentId, startMs, endMs, excludeBookingId) {
  const eq = state.equipment[equipmentId];
  if (!eq) return 0;
  let used = 0;
  for (const f of Object.values(state.faults)) {
    if (f.equipmentId !== equipmentId || f.status !== "open") continue;
    if (overlaps(startMs, endMs, toMs(f.from), toMs(f.until))) used += f.qty;
  }
  for (const b of Object.values(state.bookings)) {
    if (b.id === excludeBookingId || !isActive(b)) continue;
    if (!overlaps(startMs, endMs, toMs(b.windows.setupStart), toMs(b.windows.teardownEnd))) continue;
    for (const n of b.equipment || []) {
      if (n.equipmentId === equipmentId) used += n.qty;
    }
  }
  return eq.total - used;
}

// 窗口内已被其他有效预留占用的人员
function busyStaffIds(state, startMs, endMs, excludeBookingId) {
  const busy = new Set();
  for (const b of Object.values(state.bookings)) {
    if (b.id === excludeBookingId || !isActive(b)) continue;
    if (!overlaps(startMs, endMs, toMs(b.windows.setupStart), toMs(b.windows.teardownEnd))) continue;
    for (const p of b.staffPlan || []) {
      for (const id of p.assigned) busy.add(id);
    }
  }
  return busy;
}

// 挑选资质有效（覆盖到活动结束）且未被占用的人员
function findStaff(state, qualification, count, startMs, endMs, validThroughMs, excludeBookingId) {
  const busy = busyStaffIds(state, startMs, endMs, excludeBookingId);
  const assigned = [];
  for (const s of Object.values(state.staff)) {
    if (assigned.length >= count) break;
    if (busy.has(s.id)) continue;
    const ok = (s.qualifications || []).some(
      (q) => q.type === qualification && toMs(q.validUntil) >= validThroughMs
    );
    if (ok) assigned.push(s.id);
  }
  return { assigned, shortfall: count - assigned.length };
}

// 查找覆盖活动窗口且满足保障级别的监管批文
function permitCovering(state, spaceId, startMs, endMs, level) {
  const candidates = Object.values(state.permits)
    .filter((p) => p.status !== "revoked")
    .filter((p) => p.scope === "*" || p.scope === spaceId)
    .filter((p) => toMs(p.validFrom) <= startMs && toMs(p.validUntil) >= endMs)
    .filter((p) => (p.maxLevel || 1) >= level)
    .sort((a, b) => toMs(b.validUntil) - toMs(a.validUntil));
  return candidates[0] || null;
}

// 核心评估：对一笔预留计算窗口、硬冲突（拒绝）与软缺口（可见、签约前须解决）
function evaluateBooking(state, req, excludeBookingId) {
  const windows = computeWindows(req);
  const result = { windows, conflicts: [], gaps: [], capacity: null, permit: null, staffPlan: [] };
  const space = state.spaces[req.spaceId];
  if (!space) {
    result.conflicts.push({ type: "space-missing", spaceId: req.spaceId });
    return result;
  }
  const ws = toMs(windows.setupStart);
  const we = toMs(windows.teardownEnd);
  const es = toMs(windows.eventStart);
  const ee = toMs(windows.eventEnd);

  // 场地占用冲突（含布撤场窗口）
  for (const b of Object.values(state.bookings)) {
    if (b.id === excludeBookingId || !isActive(b) || b.spaceId !== req.spaceId) continue;
    if (overlaps(ws, we, toMs(b.windows.setupStart), toMs(b.windows.teardownEnd))) {
      result.conflicts.push({ type: "space-occupied", bookingId: b.id, title: b.title, window: b.windows });
    }
  }

  // 安全容量
  const cap = allowedCapacity(state, req.spaceId, es);
  result.capacity = { level: cap.level, allowed: cap.allowed, expected: req.expectedAttendance };
  if (req.expectedAttendance > cap.allowed) {
    result.conflicts.push({
      type: "capacity-exceeded",
      spaceId: req.spaceId,
      level: cap.level,
      allowed: cap.allowed,
      expected: req.expectedAttendance,
    });
  }

  // 监管批文
  const permit = permitCovering(state, req.spaceId, es, ee, cap.level);
  if (!permit) {
    result.conflicts.push({ type: "permit-missing", spaceId: req.spaceId, level: cap.level });
  } else {
    result.permit = { id: permit.id, name: permit.name, validUntil: permit.validUntil };
  }

  // 设备缺口（软）
  for (const need of req.equipment || []) {
    const avail = equipmentAvailability(state, need.equipmentId, ws, we, excludeBookingId);
    if (avail < need.qty) {
      result.gaps.push({
        type: "equipment-shortfall",
        equipmentId: need.equipmentId,
        need: need.qty,
        available: Math.max(0, avail),
      });
    }
  }

  // 人员缺口（软，含推导的安保需求）
  for (const sr of mergedStaffRequirements(req)) {
    const found = findStaff(state, sr.qualification, sr.count, ws, we, ee, excludeBookingId);
    result.staffPlan.push({ qualification: sr.qualification, count: sr.count, assigned: found.assigned, derived: sr.derived });
    if (found.shortfall > 0) {
      result.gaps.push({
        type: "staff-shortfall",
        qualification: sr.qualification,
        need: sr.count,
        assigned: found.assigned.length,
      });
    }
  }

  return result;
}

function requestFromBooking(b) {
  return {
    title: b.title,
    spaceId: b.spaceId,
    eventStart: b.eventStart,
    eventEnd: b.eventEnd,
    setupHours: b.setupHours,
    teardownHours: b.teardownHours,
    expectedAttendance: b.expectedAttendance,
    ticketed: b.ticketed,
    equipment: b.equipment || [],
    staff: b.staff || [],
  };
}

// 在未来若干天内寻找完全可行的替代档期（同场地、同时长、同需求）
function findAlternativeSlots(state, req, excludeBookingId, limit = 3) {
  const slots = [];
  const startMs = toMs(req.eventStart);
  const duration = toMs(req.eventEnd) - startMs;
  for (let d = 1; d <= 14 && slots.length < limit; d += 1) {
    const candStart = startMs + d * DAY_MS;
    const cand = { ...req, eventStart: toIso(candStart), eventEnd: toIso(candStart + duration) };
    const ev = evaluateBooking(state, cand, excludeBookingId);
    if (ev.conflicts.length === 0 && ev.gaps.length === 0) {
      slots.push({ eventStart: cand.eventStart, eventEnd: cand.eventEnd });
    }
  }
  return slots;
}

function activeBookings(state) {
  return Object.values(state.bookings).filter(isActive);
}

// 设备故障影响分析：只标出窗口相交且确实无法满足用量的场次
function impactOfFault(state, fault) {
  const eq = state.equipment[fault.equipmentId];
  const affected = [];
  for (const b of activeBookings(state)) {
    const need = (b.equipment || []).find((n) => n.equipmentId === fault.equipmentId);
    if (!need) continue;
    const ws = toMs(b.windows.setupStart);
    const we = toMs(b.windows.teardownEnd);
    if (!overlaps(ws, we, toMs(fault.from), toMs(fault.until))) continue;
    const ownAvailable = equipmentAvailability(state, fault.equipmentId, ws, we, b.id);
    if (ownAvailable >= need.qty) continue;
    const alternatives = [];
    for (const other of Object.values(state.equipment)) {
      if (other.id === eq.id || other.kind !== eq.kind) continue;
      const avail = equipmentAvailability(state, other.id, ws, we, b.id);
      if (avail >= need.qty) {
        alternatives.push({ type: "substitute-equipment", from: eq.id, to: other.id, qty: need.qty });
      }
    }
    if (ownAvailable > 0) {
      alternatives.push({ type: "reduce-quantity", equipmentId: eq.id, maxQty: ownAvailable });
    }
    const slots = findAlternativeSlots(state, requestFromBooking(b), b.id);
    if (slots.length) alternatives.push({ type: "reschedule", slots });
    affected.push({
      bookingId: b.id,
      title: b.title,
      impact: { type: "equipment-shortfall", equipmentId: eq.id, need: need.qty, available: Math.max(0, ownAvailable) },
      alternatives,
    });
  }
  return affected;
}

// 批文吊销影响分析：只标出原本依赖该批文、且再无其他批文覆盖的场次
function impactOfPermit(state, permit) {
  const affected = [];
  for (const b of activeBookings(state)) {
    if (permit.scope !== "*" && b.spaceId !== permit.scope) continue;
    const es = toMs(b.eventStart);
    const ee = toMs(b.eventEnd);
    if (!overlaps(es, ee, toMs(permit.validFrom), toMs(permit.validUntil))) continue;
    const level = effectiveLevel(state, b.spaceId, es);
    if (permitCovering(state, b.spaceId, es, ee, level)) continue;
    const alternatives = [{ type: "renew-permit", scope: b.spaceId, level }];
    const slots = findAlternativeSlots(state, requestFromBooking(b), b.id);
    if (slots.length) alternatives.push({ type: "reschedule", slots });
    affected.push({
      bookingId: b.id,
      title: b.title,
      impact: { type: "permit-missing", permitId: permit.id, spaceId: b.spaceId, level },
      alternatives,
    });
  }
  return affected;
}

// 监管提级影响分析：只标出安全容量被击穿的活动，并给出降员/换馆/改期方案
function impactOfRegulation(state, reg) {
  const affected = [];
  const from = toMs(reg.from);
  const until = reg.until ? toMs(reg.until) : Infinity;
  for (const b of activeBookings(state)) {
    if (reg.spaceId !== "*" && b.spaceId !== reg.spaceId) continue;
    const es = toMs(b.eventStart);
    const ee = toMs(b.eventEnd);
    if (!overlaps(es, ee, from, until)) continue;
    const space = state.spaces[b.spaceId];
    if (!space) continue;
    const level = effectiveLevel(state, b.spaceId, es);
    const allowed = Math.floor(space.capacity * levelFactor(level));
    if (b.expectedAttendance <= allowed) continue;
    const req = requestFromBooking(b);
    const alternatives = [{ type: "reduce-attendance", maxAttendance: allowed }];
    const moves = [];
    for (const sp of Object.values(state.spaces)) {
      if (sp.id === b.spaceId) continue;
      const ev = evaluateBooking(state, { ...req, spaceId: sp.id }, b.id);
      if (ev.conflicts.length === 0) moves.push({ spaceId: sp.id, allowed: ev.capacity.allowed });
    }
    if (moves.length) alternatives.push({ type: "move-space", targets: moves });
    const slots = findAlternativeSlots(state, req, b.id);
    if (slots.length) alternatives.push({ type: "reschedule", slots });
    affected.push({
      bookingId: b.id,
      title: b.title,
      impact: { type: "capacity-exceeded", spaceId: b.spaceId, level, allowed, expected: b.expectedAttendance },
      alternatives,
    });
  }
  return affected;
}

module.exports = {
  ACTIVE_STATES,
  LEVEL_FACTORS,
  SECURITY_RATIO,
  toMs,
  toIso,
  overlaps,
  isActive,
  computeWindows,
  effectiveLevel,
  levelFactor,
  allowedCapacity,
  requiredSecurity,
  mergedStaffRequirements,
  equipmentAvailability,
  findStaff,
  permitCovering,
  evaluateBooking,
  requestFromBooking,
  findAlternativeSlots,
  impactOfFault,
  impactOfPermit,
  impactOfRegulation,
};
