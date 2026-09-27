"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createServer, Store } = require("./service");

async function withService(run) {
  const store = new Store();
  const server = createServer(store);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const call = async (method, path, { role = "manager", organizerId, body } = {}) => {
    const headers = { "content-type": "application/json", "x-role": role };
    if (organizerId) headers["x-organizer-id"] = organizerId;
    const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* 空响应 */
    }
    return { status: res.status, body: json };
  };
  try {
    await run({ call, store });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// 标准资源：主馆(1000)、训练区(300)、舞台2台、安保4人、全年批文(覆盖3级)
async function seedBasic(call) {
  assert.equal((await call("POST", "/spaces", { body: { id: "main", name: "主馆", kind: "arena", capacity: 1000 } })).status, 201);
  assert.equal((await call("POST", "/spaces", { body: { id: "training", name: "训练区", kind: "training", capacity: 300 } })).status, 201);
  assert.equal((await call("POST", "/equipment", { body: { id: "stage", name: "移动舞台", kind: "stage", total: 2 } })).status, 201);
  for (let i = 1; i <= 4; i += 1) {
    assert.equal(
      (
        await call("POST", "/staff", {
          body: { id: `sec-${i}`, name: `安保${i}`, qualifications: [{ type: "security", validUntil: "2027-06-30T00:00:00.000Z" }] },
        })
      ).status,
      201
    );
  }
  assert.equal(
    (
      await call("POST", "/permits", {
        body: {
          id: "permit-1",
          name: "大型活动批文",
          scope: "*",
          validFrom: "2026-01-01T00:00:00.000Z",
          validUntil: "2026-12-31T23:59:59.000Z",
          maxLevel: 3,
        },
      })
    ).status,
    201
  );
}

const EVENT = {
  title: "联赛第1轮",
  spaceId: "main",
  eventStart: "2026-10-10T10:00:00.000Z",
  eventEnd: "2026-10-10T12:00:00.000Z",
  setupHours: 4,
  teardownHours: 2,
  expectedAttendance: 900,
  ticketed: false,
  equipment: [{ equipmentId: "stage", qty: 1 }],
  staff: [],
};

test("预留会计算布撤场窗口、安全容量与安保排班", async () => {
  await withService(async ({ call }) => {
    await seedBasic(call);
    const res = await call("POST", "/bookings", { role: "organizer", organizerId: "org-a", body: EVENT });
    assert.equal(res.status, 201);
    const b = res.body.booking;
    assert.equal(b.status, "tentative");
    assert.equal(b.windows.setupStart, "2026-10-10T06:00:00.000Z");
    assert.equal(b.windows.teardownEnd, "2026-10-10T14:00:00.000Z");
    assert.deepEqual(b.capacity, { level: 1, allowed: 1000, expected: 900 });
    const security = b.staffPlan.find((p) => p.qualification === "security");
    assert.equal(security.count, 4);
    assert.equal(security.assigned.length, 4);
    assert.equal(b.gaps.length, 0);
  });
});

test("布撤场窗口重叠即冲突，且并发预留只有一笔成功", async () => {
  await withService(async ({ call }) => {
    await seedBasic(call);
    const first = await call("POST", "/bookings", { body: EVENT });
    assert.equal(first.status, 201);

    // 11:00 开始布场，落在前一场 06:00-14:00 占用窗口内
    const overlap = await call("POST", "/bookings", {
      body: { ...EVENT, title: "青少年赛", eventStart: "2026-10-10T11:00:00.000Z", eventEnd: "2026-10-10T13:00:00.000Z", setupHours: 0 },
    });
    assert.equal(overlap.status, 409);
    assert.ok(overlap.body.details.some((c) => c.type === "space-occupied"));

    // 14:00 开始布场，与前一场撤场完成时刻首尾相接，不冲突
    const adjacent = await call("POST", "/bookings", {
      body: { ...EVENT, title: "群众健身", eventStart: "2026-10-10T14:00:00.000Z", eventEnd: "2026-10-10T16:00:00.000Z", setupHours: 0, teardownHours: 0 },
    });
    assert.equal(adjacent.status, 201);

    // 并发抢同一时段：恰一笔成功、一笔被拒，且拒绝原因留痕
    const day2 = { ...EVENT, eventStart: "2026-10-12T10:00:00.000Z", eventEnd: "2026-10-12T12:00:00.000Z" };
    const [r1, r2] = await Promise.all([
      call("POST", "/bookings", { role: "organizer", organizerId: "org-a", body: day2 }),
      call("POST", "/bookings", { role: "organizer", organizerId: "org-b", body: day2 }),
    ]);
    assert.deepEqual([r1.status, r2.status].sort(), [201, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    assert.equal(loser.body.error, "booking-conflict");
    // 承办方只能看到"被占用"，看不到对方活动名称
    const occupied = loser.body.details.find((c) => c.type === "space-occupied");
    assert.equal(occupied.title, undefined);

    const audit = await call("GET", "/audit?action=booking.rejected");
    assert.equal(audit.status, 200);
    assert.ok(audit.body.entries.some((e) => e.data.stage === "create" && e.data.reasons.some((r) => r.type === "space-occupied")));
  });
});

test("资源缺口对承办方可见，未解决前不能签约", async () => {
  await withService(async ({ call }) => {
    await seedBasic(call);
    const res = await call("POST", "/bookings", {
      role: "organizer",
      organizerId: "org-a",
      body: { ...EVENT, expectedAttendance: 100, equipment: [{ equipmentId: "stage", qty: 3 }] },
    });
    assert.equal(res.status, 201);
    assert.ok(res.body.booking.gaps.some((g) => g.type === "equipment-shortfall" && g.need === 3 && g.available === 2));

    const id = res.body.booking.id;
    const gaps = await call("GET", `/bookings/${id}/gaps`, { role: "organizer", organizerId: "org-a" });
    assert.equal(gaps.status, 200);
    assert.equal(gaps.body.gaps.length, 1);

    const confirm = await call("POST", `/bookings/${id}/confirm`, { role: "organizer", organizerId: "org-a" });
    assert.equal(confirm.status, 409);
    assert.ok(confirm.body.details.gaps.some((g) => g.type === "equipment-shortfall"));

    const adjust = await call("POST", `/bookings/${id}/adjust`, {
      role: "organizer",
      organizerId: "org-a",
      body: { equipment: [{ equipmentId: "stage", qty: 2 }] },
    });
    assert.equal(adjust.status, 200);
    assert.equal(adjust.body.booking.gaps.length, 0);

    const confirm2 = await call("POST", `/bookings/${id}/confirm`, { role: "organizer", organizerId: "org-a" });
    assert.equal(confirm2.status, 200);
    assert.equal(confirm2.body.booking.status, "contracted");
  });
});

test("设备故障只标记实际受影响场次，通知需负责人确认", async () => {
  await withService(async ({ call }) => {
    await seedBasic(call);
    await call("POST", "/equipment", { body: { id: "stage-b", name: "备用舞台", kind: "stage", total: 2 } });
    const mk = (day, org) =>
      call("POST", "/bookings", {
        role: "organizer",
        organizerId: org,
        body: {
          ...EVENT,
          title: `活动${day}日`,
          eventStart: `2026-10-${day}T10:00:00.000Z`,
          eventEnd: `2026-10-${day}T12:00:00.000Z`,
          expectedAttendance: 100,
          equipment: [{ equipmentId: "stage", qty: 2 }],
        },
      });
    const b1 = await mk("10", "org-a");
    const b2 = await mk("20", "org-b");
    assert.equal(b1.status, 201);
    assert.equal(b2.status, 201);

    const fault = await call("POST", "/incidents/equipment-fault", {
      body: { equipmentId: "stage", from: "2026-10-09T00:00:00.000Z", until: "2026-10-11T00:00:00.000Z", qty: 2 },
    });
    assert.equal(fault.status, 201);
    assert.deepEqual(fault.body.affected, [b1.body.booking.id]);
    assert.equal(fault.body.notices.length, 1);
    const notice = fault.body.notices[0];
    assert.equal(notice.status, "pending");
    assert.ok(notice.alternatives.some((a) => a.type === "substitute-equipment" && a.to === "stage-b"));
    assert.ok(notice.alternatives.some((a) => a.type === "reschedule" && a.slots.length > 0));

    // 未受影响的承办方看不到任何通知
    const noticesB = await call("GET", "/notices", { role: "organizer", organizerId: "org-b" });
    assert.deepEqual(noticesB.body.notices, []);
    // 受影响承办方确认自己场次的通知
    const ack = await call("POST", `/notices/${notice.id}/ack`, { role: "organizer", organizerId: "org-a", body: { note: "已知悉，改用备用舞台" } });
    assert.equal(ack.status, 200);
    assert.equal(ack.body.notice.status, "acknowledged");
    // 重复确认被拒绝
    assert.equal((await call("POST", `/notices/${notice.id}/ack`, { body: {} })).status, 409);
    // 故障期间原预留未被系统改动
    const after = await call("GET", `/bookings/${b1.body.booking.id}`);
    assert.equal(after.body.booking.eventStart, "2026-10-10T10:00:00.000Z");
    assert.equal(after.body.booking.equipment[0].equipmentId, "stage");
  });
});

test("批文吊销与监管提级只影响真正被波及的场次", async () => {
  await withService(async ({ call }) => {
    await seedBasic(call);
    const big = await call("POST", "/bookings", { body: { ...EVENT, title: "职业联赛", expectedAttendance: 900 } });
    const small = await call("POST", "/bookings", {
      body: { ...EVENT, title: "青少年训练", spaceId: "training", eventStart: "2026-10-10T10:00:00.000Z", eventEnd: "2026-10-10T12:00:00.000Z", expectedAttendance: 100, equipment: [] },
    });
    assert.equal(big.status, 201);
    assert.equal(small.status, 201);

    // 监管提级到 3：主馆容量 1000→500，900 人的联赛被击穿，100 人的训练不受影响
    const reg = await call("POST", "/regulations", { body: { spaceId: "main", level: 3, from: "2026-10-01T00:00:00.000Z", until: "2026-11-01T00:00:00.000Z" } });
    assert.equal(reg.status, 201);
    assert.deepEqual(reg.body.affected, [big.body.booking.id]);
    const notice = reg.body.notices[0];
    assert.equal(notice.impact.type, "capacity-exceeded");
    assert.equal(notice.impact.allowed, 500);
    assert.ok(notice.alternatives.some((a) => a.type === "reduce-attendance" && a.maxAttendance === 500));

    // 吊销批文：两场都失去覆盖，各自收到通知
    const revoke = await call("POST", "/permits/permit-1/revoke");
    assert.equal(revoke.status, 200);
    assert.equal(revoke.body.affected.length, 2);
    assert.ok(revoke.body.notices.every((n) => n.alternatives.some((a) => a.type === "renew-permit")));
  });
});

test("已售票活动不得被悄悄挪动", async () => {
  await withService(async ({ call }) => {
    await seedBasic(call);
    const res = await call("POST", "/bookings", { body: { ...EVENT, ticketed: true, expectedAttendance: 100 } });
    const id = res.body.booking.id;
    const moved = { eventStart: "2026-10-11T10:00:00.000Z", eventEnd: "2026-10-11T12:00:00.000Z" };

    // 值班经理未显式确认也不行
    const noConfirm = await call("POST", `/bookings/${id}/adjust`, { body: moved });
    assert.equal(noConfirm.status, 409);
    assert.equal(noConfirm.body.error, "ticketed-move-requires-confirmation");

    // 值班经理显式确认后才生效
    const confirmed = await call("POST", `/bookings/${id}/adjust`, { body: { ...moved, confirmTicketedMove: true } });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.booking.eventStart, moved.eventStart);

    // 未售票活动调整无需额外确认
    const plain = await call("POST", "/bookings", { body: { ...EVENT, expectedAttendance: 100, eventStart: "2026-10-15T10:00:00.000Z", eventEnd: "2026-10-15T12:00:00.000Z" } });
    const adjust = await call("POST", `/bookings/${plain.body.booking.id}/adjust`, {
      body: { eventStart: "2026-10-16T10:00:00.000Z", eventEnd: "2026-10-16T12:00:00.000Z" },
    });
    assert.equal(adjust.status, 200);
  });
});

test("完结场次可回放当时有效的场地状态、排班与放行依据", async () => {
  await withService(async ({ call }) => {
    await seedBasic(call);
    const created = await call("POST", "/bookings", { body: { ...EVENT, expectedAttendance: 100 } });
    const id = created.body.booking.id;
    assert.equal((await call("POST", `/bookings/${id}/confirm`)).status, 200);
    const loadIn = await call("POST", `/bookings/${id}/load-in`);
    assert.equal(loadIn.status, 200);
    assert.equal(loadIn.body.booking.admissionBasis.permitId, "permit-1");

    // 未完结时不允许回放
    assert.equal((await call("GET", `/bookings/${id}/replay`)).status, 409);
    assert.equal((await call("POST", `/bookings/${id}/complete`)).status, 200);

    // 完结后环境发生变化：批文被吊销、监管提级
    await call("POST", "/permits/permit-1/revoke");
    await call("POST", "/regulations", { body: { spaceId: "main", level: 3, from: "2026-10-01T00:00:00.000Z", until: null } });

    const replay = await call("GET", `/bookings/${id}/replay`);
    assert.equal(replay.status, 200);
    // 当时批文仍然有效、保障级别仍为 1、排班与放行依据完整
    assert.ok(replay.body.permits.some((p) => p.id === "permit-1"));
    assert.equal(replay.body.securityLevel, 1);
    assert.equal(replay.body.allowedCapacity, 1000);
    assert.equal(replay.body.admissionBasis.permitId, "permit-1");
    assert.equal(replay.body.staffing.find((p) => p.qualification === "security").assigned.length, 1);
  });
});

test("承办方彼此隔离，值班经理掌握全局", async () => {
  await withService(async ({ call }) => {
    await seedBasic(call);
    const created = await call("POST", "/bookings", { role: "organizer", organizerId: "org-a", body: { ...EVENT, expectedAttendance: 100 } });
    const id = created.body.booking.id;

    assert.equal((await call("GET", `/bookings/${id}`, { role: "organizer", organizerId: "org-b" })).status, 404);
    assert.equal((await call("GET", `/bookings/${id}/gaps`, { role: "organizer", organizerId: "org-b" })).status, 404);
    const listB = await call("GET", "/bookings", { role: "organizer", organizerId: "org-b" });
    assert.deepEqual(listB.body.bookings, []);
    const listA = await call("GET", "/bookings", { role: "organizer", organizerId: "org-a" });
    assert.equal(listA.body.bookings.length, 1);

    // 承办方无权查看审计、日历与资源台账
    assert.equal((await call("GET", "/audit", { role: "organizer", organizerId: "org-a" })).status, 403);
    assert.equal((await call("GET", "/calendar?day=2026-10-10", { role: "organizer", organizerId: "org-a" })).status, 403);
    assert.equal((await call("GET", "/resources", { role: "organizer", organizerId: "org-a" })).status, 403);

    const calendar = await call("GET", "/calendar?day=2026-10-10");
    assert.equal(calendar.body.bookings.length, 1);
  });
});
