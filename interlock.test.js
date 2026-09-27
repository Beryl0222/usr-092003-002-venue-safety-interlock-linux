"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createServer } = require("./service");
const { Store } = require("./lib/store");
const { seed } = require("./lib/seed");

async function withApp(run, startTime = "2026-10-01T00:00:00.000Z") {
  const clock = { current: startTime };
  const store = seed(new Store({ now: () => clock.current }));
  const server = createServer({ store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    await run({ base, clock, store });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function api(base, { method = "GET", path, role, id = "user_1", body }) {
  const headers = {};
  if (role) {
    headers["x-actor-id"] = id;
    headers["x-actor-role"] = role;
  }
  if (body) headers["content-type"] = "application/json";
  const response = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json().catch(() => null) };
}

const ORG_A = { role: "organizer", id: "org_a" };
const ORG_B = { role: "organizer", id: "org_b" };
const OPS = { role: "ops", id: "ops_1" };
const MANAGER = { role: "duty_manager", id: "mgr_1" };

test("预留计算布撤场窗口，重叠占用被拒绝并留痕", async () => {
  await withApp(async ({ base }) => {
    const first = await api(base, {
      method: "POST", path: "/bookings", ...ORG_A,
      body: { spaceId: "main_arena", eventType: "pro_league", title: "联赛第12轮", start: "2026-10-10T10:00:00.000Z", end: "2026-10-10T12:00:00.000Z", attendance: 5000, ticketed: true },
    });
    assert.equal(first.status, 201);
    // 职业联赛：布场 240 分钟、撤场 180 分钟
    assert.equal(first.body.booking.occupancy.setupStart, "2026-10-10T06:00:00.000Z");
    assert.equal(first.body.booking.occupancy.teardownEnd, "2026-10-10T15:00:00.000Z");
    assert.equal(first.body.booking.status, "tentative");

    // 群众活动 14:00 开始，布场窗口 13:00 落入上一场撤场窗口 → 冲突
    const clash = await api(base, {
      method: "POST", path: "/bookings", ...ORG_B,
      body: { spaceId: "main_arena", eventType: "community", title: "健身日", start: "2026-10-10T14:00:00.000Z", end: "2026-10-10T15:00:00.000Z", attendance: 200 },
    });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.error.code, "booking_conflict");
    assert.equal(clash.body.error.details.conflicts[0].bookingId, first.body.booking.id);

    // 16:00 开始则布场窗口 15:00，恰好衔接 → 通过
    const ok = await api(base, {
      method: "POST", path: "/bookings", ...ORG_B,
      body: { spaceId: "main_arena", eventType: "community", title: "健身日", start: "2026-10-10T16:00:00.000Z", end: "2026-10-10T17:00:00.000Z", attendance: 200 },
    });
    assert.equal(ok.status, 201);
  });
});

test("超出安全容量的预留被拒绝，回放可见原因", async () => {
  await withApp(async ({ base }) => {
    const res = await api(base, {
      method: "POST", path: "/bookings", ...ORG_A,
      body: { spaceId: "training_a", eventType: "community", title: "广场舞", start: "2026-10-11T09:00:00.000Z", end: "2026-10-11T10:00:00.000Z", attendance: 801 },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "capacity_exceeded");
    assert.equal(res.body.error.details.capacity, 800);

    const replay = await api(base, { path: "/audit/replay?date=2026-10-01", ...MANAGER });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.rejections.length, 1);
    assert.equal(replay.body.rejections[0].details.reason, "capacity_exceeded");
  });
});

test("两笔并发操作不会重复占用同一档期", async () => {
  await withApp(async ({ base }) => {
    const spec = {
      spaceId: "training_a", eventType: "youth_match", title: "青少年邀请赛",
      start: "2026-10-12T10:00:00.000Z", end: "2026-10-12T11:30:00.000Z", attendance: 200,
    };
    const [a, b] = await Promise.all([
      api(base, { method: "POST", path: "/bookings", ...ORG_A, body: spec }),
      api(base, { method: "POST", path: "/bookings", ...ORG_B, body: { ...spec, title: "撞期申请" } }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [201, 409]);
  });
});

test("同一场次的并发签约只有一笔生效", async () => {
  await withApp(async ({ base }) => {
    const created = await api(base, {
      method: "POST", path: "/bookings", ...ORG_A,
      body: { spaceId: "training_b", eventType: "youth_match", title: "训练营", start: "2026-10-13T10:00:00.000Z", end: "2026-10-13T11:30:00.000Z", attendance: 100 },
    });
    const id = created.body.booking.id;
    const [c1, c2] = await Promise.all([
      api(base, { method: "POST", path: `/bookings/${id}/confirm`, ...ORG_A, body: {} }),
      api(base, { method: "POST", path: `/bookings/${id}/confirm`, ...ORG_A, body: {} }),
    ]);
    assert.deepEqual([c1.status, c2.status].sort(), [200, 409]);
  });
});

test("设备故障只标出受影响场次，确认后换设备且不挪动已售票活动", async () => {
  await withApp(async ({ base }) => {
    const created = await api(base, {
      method: "POST", path: "/bookings", ...ORG_A,
      body: { spaceId: "main_arena", eventType: "pro_league", title: "联赛第13轮", start: "2026-10-10T10:00:00.000Z", end: "2026-10-10T12:00:00.000Z", attendance: 5000, ticketed: true },
    });
    const bookingId = created.body.booking.id;
    assert.equal(created.body.booking.assignments.equipment.scoreboard[0], "eq_score_1");
    await api(base, { method: "POST", path: `/bookings/${bookingId}/confirm`, ...ORG_A, body: {} });

    // 不相关设备故障：不应产生任何变更单
    await api(base, {
      method: "POST", path: "/equipment/eq_timing_1/faults", ...OPS,
      body: { from: "2026-10-09T00:00:00.000Z", to: "2026-10-11T00:00:00.000Z", reason: "计时模块损坏" },
    });
    let changes = await api(base, { path: "/changes", ...MANAGER });
    assert.equal(changes.body.changes.length, 0);

    // 记分屏故障覆盖活动窗口：只影响该场次
    const fault = await api(base, {
      method: "POST", path: "/equipment/eq_score_1/faults", ...OPS,
      body: { from: "2026-10-09T00:00:00.000Z", to: "2026-10-11T00:00:00.000Z", reason: "屏幕主板故障" },
    });
    assert.equal(fault.status, 201);
    assert.equal(fault.body.changes.length, 1);
    const change = fault.body.changes[0];
    assert.equal(change.impact.equipmentId, "eq_score_1");
    assert.equal(change.proposals[0].kind, "reassign_equipment");
    assert.equal(change.proposals[0].auto, true);

    const ack = await api(base, { method: "POST", path: `/changes/${change.id}/ack`, ...MANAGER, body: {} });
    assert.equal(ack.status, 200);
    assert.equal(ack.body.change.status, "resolved");
    assert.equal(ack.body.change.acknowledgedBy, MANAGER.id);

    const after = await api(base, { path: `/bookings/${bookingId}`, ...ORG_A });
    assert.deepEqual(after.body.booking.assignments.equipment.scoreboard, ["eq_score_2"]);
    // 已售票活动未被挪动
    assert.equal(after.body.booking.start, "2026-10-10T10:00:00.000Z");
    assert.equal(after.body.booking.status, "confirmed");

    const replay = await api(base, { path: "/audit/replay?date=2026-10-01", ...MANAGER });
    assert.equal(replay.body.changeAcknowledgements.length, 1);
    assert.equal(replay.body.changeAcknowledgements[0].details.applied, "reassign_equipment");
  });
});

test("监管批文撤销后标出受影响场次，无替代批文时要求重新申办", async () => {
  await withApp(async ({ base }) => {
    const created = await api(base, {
      method: "POST", path: "/bookings", ...ORG_A,
      body: { spaceId: "main_arena", eventType: "pro_league", title: "联赛第14轮", start: "2026-11-01T10:00:00.000Z", end: "2026-11-01T12:00:00.000Z", attendance: 6000, ticketed: true },
    });
    const bookingId = created.body.booking.id;
    assert.deepEqual(created.body.booking.permitsUsed, ["permit_large"]);
    await api(base, { method: "POST", path: `/bookings/${bookingId}/confirm`, ...ORG_A, body: {} });

    const revoke = await api(base, { method: "POST", path: "/permits/permit_large/revoke", ...MANAGER, body: { reason: "监管整改" } });
    assert.equal(revoke.status, 200);
    assert.equal(revoke.body.changes.length, 1);
    const change = revoke.body.changes[0];
    assert.equal(change.kind, "permit_revoked");
    assert.equal(change.proposals[0].kind, "obtain_permit");
    assert.equal(change.proposals[0].auto, false);

    // 承办方只能看到自己的资源缺口
    const gaps = await api(base, { path: `/bookings/${bookingId}/gaps`, ...ORG_A });
    assert.equal(gaps.status, 200);
    assert.equal(gaps.body.gaps[0].kind, "permit");

    // 负责人确认：无自动方案，状态为已确认待人工处理
    const ack = await api(base, { method: "POST", path: `/changes/${change.id}/ack`, ...MANAGER, body: {} });
    assert.equal(ack.body.change.status, "acknowledged");
    // 已售票场次未被系统改动
    const after = await api(base, { path: `/bookings/${bookingId}`, ...ORG_A });
    assert.equal(after.body.booking.start, "2026-11-01T10:00:00.000Z");
  });
});

test("监管提高安保等级后标出安保缺口，确认后自动增派", async () => {
  await withApp(async ({ base }) => {
    const created = await api(base, {
      method: "POST", path: "/bookings", ...ORG_A,
      body: { spaceId: "main_arena", eventType: "pro_league", title: "联赛第15轮", start: "2026-10-20T10:00:00.000Z", end: "2026-10-20T12:00:00.000Z", attendance: 5000 },
    });
    const bookingId = created.body.booking.id;
    // 常态：10 + 5000×0.01 = 60 名安保
    assert.equal(created.body.booking.assignments.personnel.security.length, 60);
    await api(base, { method: "POST", path: `/bookings/${bookingId}/confirm`, ...ORG_A, body: {} });

    const raised = await api(base, { method: "POST", path: "/regulation/security-level", ...MANAGER, body: { level: "heightened" } });
    assert.equal(raised.status, 200);
    assert.equal(raised.body.changes.length, 1);
    const change = raised.body.changes[0];
    // 加强等级：60×1.25 = 75，缺口 15
    assert.equal(change.impact.needed, 75);
    assert.equal(change.impact.shortage, 15);
    assert.equal(change.proposals[0].kind, "assign_security");

    const ack = await api(base, { method: "POST", path: `/changes/${change.id}/ack`, ...MANAGER, body: {} });
    assert.equal(ack.body.change.status, "resolved");
    const after = await api(base, { path: `/bookings/${bookingId}`, ...ORG_A });
    assert.equal(after.body.booking.assignments.personnel.security.length, 75);
  });
});

test("承办方之间资源与缺口互相不可见", async () => {
  await withApp(async ({ base }) => {
    const created = await api(base, {
      method: "POST", path: "/bookings", ...ORG_A,
      body: { spaceId: "training_a", eventType: "community", title: "社区联赛", start: "2026-10-15T09:00:00.000Z", end: "2026-10-15T10:00:00.000Z", attendance: 100 },
    });
    const bookingId = created.body.booking.id;

    const listB = await api(base, { path: "/bookings", ...ORG_B });
    assert.equal(listB.body.bookings.length, 0);
    assert.equal((await api(base, { path: `/bookings/${bookingId}`, ...ORG_B })).status, 404);
    assert.equal((await api(base, { path: `/bookings/${bookingId}/gaps`, ...ORG_B })).status, 404);
    // 承办方无权查看变更单、审计回放与快照
    assert.equal((await api(base, { path: "/changes", ...ORG_B })).status, 403);
    assert.equal((await api(base, { path: "/audit/replay?date=2026-10-01", ...ORG_B })).status, 403);
    assert.equal((await api(base, { path: "/snapshot?at=2026-10-15T09:30:00.000Z", ...ORG_B })).status, 403);
    // 未认证请求被拒绝
    assert.equal((await api(base, { path: "/bookings" })).status, 401);
  });
});

test("进场放行固化依据，结束后可复原当时状态与排班", async () => {
  await withApp(async ({ base, clock }) => {
    const created = await api(base, {
      method: "POST", path: "/bookings", ...ORG_A,
      body: { spaceId: "training_a", eventType: "youth_match", title: "青少年决赛", start: "2026-10-05T10:00:00.000Z", end: "2026-10-05T11:30:00.000Z", attendance: 200, ticketed: true },
    });
    const bookingId = created.body.booking.id;
    await api(base, { method: "POST", path: `/bookings/${bookingId}/confirm`, ...ORG_A, body: {} });

    // 未到布场窗口不能放行
    const early = await api(base, { method: "POST", path: `/bookings/${bookingId}/load-in`, ...MANAGER, body: {} });
    assert.equal(early.status, 409);
    assert.equal(early.body.error.code, "outside_load_in_window");

    // 进入布场窗口（10:00 开始前 90 分钟）后放行
    clock.current = "2026-10-05T08:35:00.000Z";
    const loadIn = await api(base, { method: "POST", path: `/bookings/${bookingId}/load-in`, ...MANAGER, body: {} });
    assert.equal(loadIn.status, 200);
    const basis = loadIn.body.booking.loadInBasis;
    assert.equal(basis.approvedBy, MANAGER.id);
    assert.equal(basis.securityLevel, "normal");
    assert.equal(basis.security.needed, 5); // 4 + 200×0.005
    assert.equal(basis.permits[0].id, "permit_youth");

    clock.current = "2026-10-05T12:40:00.000Z";
    const done = await api(base, { method: "POST", path: `/bookings/${bookingId}/complete`, ...MANAGER, body: {} });
    assert.equal(done.body.booking.status, "completed");

    // 复原活动进行中的状态：场地占用、人员排班、放行依据
    const snapshot = await api(base, { path: "/snapshot?at=2026-10-05T10:30:00.000Z", ...MANAGER });
    assert.equal(snapshot.status, 200);
    const snapBooking = snapshot.body.bookings.find((b) => b.id === bookingId);
    assert.equal(snapBooking.status, "load_in");
    assert.ok(snapBooking.loadInBasis);
    const block = snapshot.body.spaces.find((s) => s.id === "training_a").blocks[0];
    assert.equal(block.bookingId, bookingId);
    const roles = snapshot.body.roster.filter((r) => r.bookingId === bookingId).map((r) => r.role);
    assert.ok(roles.includes("security") && roles.includes("medical") && roles.includes("referee"));
    assert.ok(snapshot.body.permits.find((p) => p.id === "permit_youth").validAt);

    // 回放当天：能看到放行记录
    const replay = await api(base, { path: "/audit/replay?date=2026-10-05", ...MANAGER });
    assert.ok(replay.body.entries.some((e) => e.action === "booking.load_in" && e.entityId === bookingId));
  });
});
