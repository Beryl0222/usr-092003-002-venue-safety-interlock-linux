"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const domain = require("./lib/domain");

function baseState() {
  return {
    spaces: { main: { id: "main", name: "主馆", kind: "arena", capacity: 1000 } },
    equipment: { stage: { id: "stage", name: "舞台", kind: "stage", total: 2 } },
    staff: {
      s1: { id: "s1", name: "甲", qualifications: [{ type: "security", validUntil: "2027-01-01T00:00:00.000Z" }] },
      s2: { id: "s2", name: "乙", qualifications: [{ type: "security", validUntil: "2027-01-01T00:00:00.000Z" }] },
    },
    permits: {
      p1: {
        id: "p1",
        name: "批文",
        scope: "*",
        validFrom: "2026-01-01T00:00:00.000Z",
        validUntil: "2026-12-31T23:59:59.000Z",
        maxLevel: 3,
        status: "active",
      },
    },
    regulations: [],
    faults: {},
    bookings: {},
    notices: {},
  };
}

const REQ = {
  title: "测试活动",
  spaceId: "main",
  eventStart: "2026-10-01T10:00:00.000Z",
  eventEnd: "2026-10-01T12:00:00.000Z",
  setupHours: 2,
  teardownHours: 3,
  expectedAttendance: 100,
  ticketed: false,
  equipment: [],
  staff: [],
};

test("布撤场窗口按活动起止前后延伸", () => {
  const w = domain.computeWindows(REQ);
  assert.equal(w.setupStart, "2026-10-01T08:00:00.000Z");
  assert.equal(w.teardownEnd, "2026-10-01T15:00:00.000Z");
});

test("半开区间重叠判断：首尾相接不算冲突", () => {
  assert.equal(domain.overlaps(0, 10, 5, 15), true);
  assert.equal(domain.overlaps(0, 10, 10, 20), false);
  assert.equal(domain.overlaps(10, 20, 0, 10), false);
});

test("安保人数按观众数推导", () => {
  assert.equal(domain.requiredSecurity(0), 0);
  assert.equal(domain.requiredSecurity(1), 1);
  assert.equal(domain.requiredSecurity(250), 1);
  assert.equal(domain.requiredSecurity(251), 2);
  assert.equal(domain.requiredSecurity(900), 4);
});

test("监管级别取覆盖时刻的最高值，安全容量随级别收缩", () => {
  const state = baseState();
  state.regulations.push({ id: "r1", spaceId: "*", level: 2, from: "2026-10-01T00:00:00.000Z", until: null });
  state.regulations.push({ id: "r2", spaceId: "main", level: 3, from: "2026-10-01T06:00:00.000Z", until: "2026-10-02T00:00:00.000Z" });
  const at = domain.toMs("2026-10-01T10:00:00.000Z");
  assert.equal(domain.effectiveLevel(state, "main", at), 3);
  assert.deepEqual(domain.allowedCapacity(state, "main", at), { level: 3, allowed: 500 });
  const later = domain.toMs("2026-11-01T10:00:00.000Z");
  assert.equal(domain.effectiveLevel(state, "main", later), 2);
});

test("设备可用量扣除故障与其他预留占用", () => {
  const state = baseState();
  state.faults.f1 = { id: "f1", equipmentId: "stage", from: "2026-10-01T00:00:00.000Z", until: "2026-10-02T00:00:00.000Z", qty: 1, status: "open" };
  state.bookings.b1 = {
    id: "b1",
    status: "contracted",
    windows: { setupStart: "2026-10-01T08:00:00.000Z", teardownEnd: "2026-10-01T15:00:00.000Z" },
    equipment: [{ equipmentId: "stage", qty: 1 }],
  };
  const avail = domain.equipmentAvailability(state, "stage", domain.toMs("2026-10-01T09:00:00.000Z"), domain.toMs("2026-10-01T11:00:00.000Z"), null);
  assert.equal(avail, 0);
  const later = domain.equipmentAvailability(state, "stage", domain.toMs("2026-10-03T09:00:00.000Z"), domain.toMs("2026-10-03T11:00:00.000Z"), null);
  assert.equal(later, 2);
});

test("评估：容量超售与缺批文是硬冲突，设备/人员不足是软缺口", () => {
  const state = baseState();
  const over = domain.evaluateBooking(state, { ...REQ, expectedAttendance: 1200 }, null);
  assert.ok(over.conflicts.some((c) => c.type === "capacity-exceeded"));

  const noPermitState = baseState();
  noPermitState.permits = {};
  const noPermit = domain.evaluateBooking(noPermitState, REQ, null);
  assert.ok(noPermit.conflicts.some((c) => c.type === "permit-missing"));

  const lacking = domain.evaluateBooking(state, { ...REQ, expectedAttendance: 900, equipment: [{ equipmentId: "stage", qty: 3 }] }, null);
  assert.equal(lacking.conflicts.length, 0);
  assert.ok(lacking.gaps.some((g) => g.type === "equipment-shortfall" && g.need === 3 && g.available === 2));
  assert.ok(lacking.gaps.some((g) => g.type === "staff-shortfall" && g.qualification === "security" && g.assigned === 2));
});

test("资质过期的人员不计入可排班", () => {
  const state = baseState();
  state.staff.s2.qualifications = [{ type: "security", validUntil: "2026-09-01T00:00:00.000Z" }];
  const found = domain.findStaff(
    state,
    "security",
    2,
    domain.toMs("2026-10-01T08:00:00.000Z"),
    domain.toMs("2026-10-01T15:00:00.000Z"),
    domain.toMs("2026-10-01T12:00:00.000Z"),
    null
  );
  assert.deepEqual(found.assigned, ["s1"]);
  assert.equal(found.shortfall, 1);
});

test("替代档期搜索避开已占用窗口", () => {
  const state = baseState();
  state.bookings.b1 = {
    id: "b1",
    status: "contracted",
    spaceId: "main",
    windows: domain.computeWindows({ ...REQ, eventStart: "2026-10-02T10:00:00.000Z", eventEnd: "2026-10-02T12:00:00.000Z" }),
    equipment: [],
    staffPlan: [],
  };
  const slots = domain.findAlternativeSlots(state, REQ, null, 2);
  assert.ok(slots.length >= 1);
  assert.equal(slots[0].eventStart, "2026-10-03T10:00:00.000Z");
});

test("设备故障只影响窗口相交且用量无法满足的场次", () => {
  const state = baseState();
  const mk = (id, day) => ({
    id,
    title: id,
    status: "contracted",
    spaceId: "main",
    eventStart: `2026-10-${day}T10:00:00.000Z`,
    eventEnd: `2026-10-${day}T12:00:00.000Z`,
    expectedAttendance: 100,
    equipment: [{ equipmentId: "stage", qty: 2 }],
    staff: [],
    windows: domain.computeWindows({ eventStart: `2026-10-${day}T10:00:00.000Z`, eventEnd: `2026-10-${day}T12:00:00.000Z`, setupHours: 0, teardownHours: 0 }),
    staffPlan: [],
  });
  state.bookings.b1 = mk("b1", "10");
  state.bookings.b2 = mk("b2", "20");
  const fault = { id: "f1", equipmentId: "stage", from: "2026-10-09T00:00:00.000Z", until: "2026-10-11T00:00:00.000Z", qty: 1, status: "open" };
  state.faults.f1 = fault;
  const affected = domain.impactOfFault(state, fault);
  assert.deepEqual(affected.map((a) => a.bookingId), ["b1"]);
  assert.ok(affected[0].alternatives.some((a) => a.type === "reduce-quantity" && a.maxQty === 1));
});
