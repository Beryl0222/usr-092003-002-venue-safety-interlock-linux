"use strict";

const http = require("node:http");
const { Store } = require("./lib/store");
const { seed } = require("./lib/seed");
const ops = require("./lib/ops");

const SERVICE_ID = "venue-safety-interlock";
const SERVICE_NAME = "场馆档期安全联锁";

function healthPayload() {
  return { status: "ok", service: SERVICE_ID, name: SERVICE_NAME };
}

// 角色：organizer=承办方（仅见自己的资源与缺口），ops=运营席，duty_manager=值班经理。
function actorOf(request) {
  const id = request.headers["x-actor-id"];
  const role = request.headers["x-actor-role"];
  if (!id || !role) return null;
  return { id: String(id), role: String(role), organizerId: role === "organizer" ? String(id) : undefined };
}

function send(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new ops.HttpError(400, "bad_json", "请求体不是合法 JSON"));
      }
    });
    request.on("error", reject);
  });
}

function createServer(options = {}) {
  const store = options.store || seed(new Store({ now: options.now }));

  // 路由表：[方法, 路径正则, 允许角色, 处理器]。handler 内同步完成检查与落库。
  const routes = [
    ["GET", /^\/health$/, null, async () => ({ status: 200, body: healthPayload() })],

    // 资源档案
    ["GET", /^\/spaces$/, ["organizer", "ops", "duty_manager"], async () => ({
      status: 200,
      body: { spaces: [...store.spaces.values()] },
    })],
    ["GET", /^\/equipment$/, ["ops", "duty_manager"], async () => ({
      status: 200,
      body: { equipment: [...store.equipment.values()] },
    })],
    ["GET", /^\/personnel$/, ["ops", "duty_manager"], async () => ({
      status: 200,
      body: { personnel: [...store.personnel.values()] },
    })],
    ["GET", /^\/permits$/, ["ops", "duty_manager"], async () => ({
      status: 200,
      body: { permits: [...store.permits.values()] },
    })],

    // 预留：任何预留都计算布撤场窗口与安全容量，冲突即拒绝并留痕
    ["POST", /^\/bookings$/, ["organizer", "ops"], async (req, actor, body) => {
      const booking = ops.createBooking(store, actor, body);
      return { status: 201, body: { booking } };
    }],
    ["GET", /^\/bookings$/, ["organizer", "ops", "duty_manager"], async (req, actor) => {
      const all = [...store.bookings.values()];
      const mine = actor.role === "organizer" ? all.filter((b) => b.organizerId === actor.id) : all;
      return { status: 200, body: { bookings: mine } };
    }],
    ["GET", /^\/bookings\/([^/]+)$/, ["organizer", "ops", "duty_manager"], async (req, actor, body, m) => {
      const booking = store.bookings.get(m[1]);
      if (!booking || (actor.role === "organizer" && booking.organizerId !== actor.id)) {
        throw new ops.HttpError(404, "booking_not_found", "场次不存在");
      }
      return { status: 200, body: { booking } };
    }],
    // 承办方只能看到自己的资源缺口
    ["GET", /^\/bookings\/([^/]+)\/gaps$/, ["organizer", "ops", "duty_manager"], async (req, actor, body, m) => {
      const booking = store.bookings.get(m[1]);
      if (!booking || (actor.role === "organizer" && booking.organizerId !== actor.id)) {
        throw new ops.HttpError(404, "booking_not_found", "场次不存在");
      }
      return { status: 200, body: ops.bookingGaps(store, booking) };
    }],
    ["POST", /^\/bookings\/([^/]+)\/confirm$/, ["organizer", "ops"], async (req, actor, body, m) => {
      const booking = store.bookings.get(m[1]);
      if (!booking || (actor.role === "organizer" && booking.organizerId !== actor.id)) {
        throw new ops.HttpError(404, "booking_not_found", "场次不存在");
      }
      return { status: 200, body: { booking: ops.confirmBooking(store, actor, m[1], body.expectedVersion) } };
    }],
    ["POST", /^\/bookings\/([^/]+)\/cancel$/, ["organizer", "ops"], async (req, actor, body, m) => {
      const booking = store.bookings.get(m[1]);
      if (!booking || (actor.role === "organizer" && booking.organizerId !== actor.id)) {
        throw new ops.HttpError(404, "booking_not_found", "场次不存在");
      }
      return { status: 200, body: { booking: ops.cancelBooking(store, actor, m[1]) } };
    }],
    // 进场放行：复核批文/安保/设备，固化放行依据
    ["POST", /^\/bookings\/([^/]+)\/load-in$/, ["ops", "duty_manager"], async (req, actor, body, m) => ({
      status: 200,
      body: { booking: ops.loadIn(store, actor, m[1]) },
    })],
    ["POST", /^\/bookings\/([^/]+)\/complete$/, ["ops", "duty_manager"], async (req, actor, body, m) => ({
      status: 200,
      body: { booking: ops.completeBooking(store, actor, m[1]) },
    })],

    // 运行扰动：设备故障 / 批文撤销 / 监管提级 → 只标出实际受影响场次并给出替代方案
    ["POST", /^\/equipment\/([^/]+)\/faults$/, ["ops", "duty_manager"], async (req, actor, body, m) => ({
      status: 201,
      body: ops.reportEquipmentFault(store, actor, m[1], body),
    })],
    ["POST", /^\/permits\/([^/]+)\/revoke$/, ["ops", "duty_manager"], async (req, actor, body, m) => ({
      status: 200,
      body: ops.revokePermit(store, actor, m[1], body && body.reason),
    })],
    ["POST", /^\/regulation\/security-level$/, ["ops", "duty_manager"], async (req, actor, body) => ({
      status: 200,
      body: ops.raiseSecurityLevel(store, actor, body.level, body.effectiveFrom),
    })],

    // 变更通知：值班经理（负责人）确认
    ["GET", /^\/changes$/, ["ops", "duty_manager"], async (req) => {
      const status = new URL(req.url, "http://x").searchParams.get("status");
      let list = [...store.changes.values()];
      if (status) list = list.filter((c) => c.status === status);
      return { status: 200, body: { changes: list } };
    }],
    ["POST", /^\/changes\/([^/]+)\/ack$/, ["duty_manager"], async (req, actor, body, m) => ({
      status: 200,
      body: { change: ops.ackChange(store, actor, m[1]) },
    })],

    // 回放：某日为何拒绝冲突申请、哪次变更通知已被确认
    ["GET", /^\/audit\/replay$/, ["duty_manager"], async (req) => {
      const date = new URL(req.url, "http://x").searchParams.get("date");
      if (!date) throw new ops.HttpError(400, "validation", "缺少 date 参数（YYYY-MM-DD）");
      return { status: 200, body: ops.auditReplay(store, date) };
    }],
    // 复原：某时刻有效的场地状态、人员排班与放行依据
    ["GET", /^\/snapshot$/, ["duty_manager"], async (req) => {
      const at = new URL(req.url, "http://x").searchParams.get("at");
      if (!at || !Number.isFinite(Date.parse(at))) {
        throw new ops.HttpError(400, "validation", "缺少 at 参数（ISO 时间）");
      }
      return { status: 200, body: ops.snapshotAt(store, new Date(at).toISOString()) };
    }],
  ];

  return http.createServer(async (request, response) => {
    try {
      const path = new URL(request.url, "http://x").pathname;
      const route = routes
        .map(([method, pattern, roles, handler]) => {
          const m = method === request.method ? path.match(pattern) : null;
          return m ? { roles, handler, m } : null;
        })
        .find(Boolean);
      if (!route) {
        send(response, 404, { error: { code: "not_found", message: "路由不存在" } });
        return;
      }
      const actor = actorOf(request);
      if (route.roles) {
        if (!actor) throw new ops.HttpError(401, "unauthenticated", "缺少身份头（x-actor-id / x-actor-role）");
        if (!route.roles.includes(actor.role)) {
          throw new ops.HttpError(403, "forbidden", "当前角色无权访问该资源");
        }
      }
      const body = request.method === "POST" ? await readBody(request) : {};
      // 关键：进入 handler 后检查与落库同步完成，两笔并发操作不会重复占用。
      const result = await route.handler(request, actor, body, route.m);
      send(response, result.status, result.body);
    } catch (error) {
      if (error instanceof ops.HttpError) {
        send(response, error.status, { error: { code: error.code, message: error.message, details: error.details } });
      } else {
        send(response, 500, { error: { code: "internal", message: "服务内部错误" } });
      }
    }
  });
}

if (require.main === module) {
  if (process.argv.includes("--check")) {
    if (healthPayload().service !== SERVICE_ID) throw new Error("服务身份不一致");
    const probe = seed(new Store({}));
    if (probe.spaces.size === 0 || probe.personnel.size === 0 || probe.permits.size === 0) {
      throw new Error("资源档案不完整");
    }
    process.stdout.write("基础检查通过\n");
  } else {
    const port = Number(process.env.PORT || 8000);
    createServer().listen(port, "127.0.0.1");
  }
}

module.exports = { SERVICE_ID, SERVICE_NAME, createServer, healthPayload };
