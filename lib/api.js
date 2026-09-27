"use strict";

// HTTP 接口层：路由、角色分权、变更串行化。
// 角色通过请求头声明：x-role: manager|organizer，承办方另需 x-organizer-id。
// 所有写操作进入同一串行队列，检查与落库之间不插入其他变更，杜绝并发重复占用。

const domain = require("./domain");

const SERVICE_ID = "venue-safety-interlock";
const SERVICE_NAME = "场馆档期安全联锁";

function healthPayload() {
  return { status: "ok", service: SERVICE_ID, name: SERVICE_NAME };
}

function httpError(status, message, details) {
  const err = new Error(message);
  err.statusCode = status;
  err.details = details;
  return err;
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(httpError(413, "payload-too-large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(httpError(400, "invalid-json"));
      }
    });
    req.on("error", reject);
  });
}

function createApp(store) {
  const routes = [];
  const add = (method, pattern, handler) => {
    const keys = [];
    const regex = new RegExp(
      "^" +
        pattern
          .split("/")
          .map((seg) => (seg.startsWith(":") ? (keys.push(seg.slice(1)), "([^/]+)") : seg))
          .join("/") +
        "$"
    );
    routes.push({ method, regex, keys, handler });
  };

  // 变更串行化：同一时刻只有一个写操作在执行
  let queue = Promise.resolve();
  const enqueue = (fn) => {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  };

  const actorOf = (req) => ({
    role: req.headers["x-role"] === "organizer" ? "organizer" : "manager",
    organizerId: req.headers["x-organizer-id"] ? String(req.headers["x-organizer-id"]) : null,
    name: req.headers["x-actor"] ? String(req.headers["x-actor"]) : "anonymous",
  });
  const actorLabel = (ctx) =>
    ctx.actor.role === "organizer" ? `organizer:${ctx.actor.organizerId}` : `manager:${ctx.actor.name}`;
  const requireManager = (ctx) => {
    if (ctx.actor.role !== "manager") throw httpError(403, "forbidden", "该操作需要值班经理权限");
  };
  const getBooking = (ctx, id) => {
    const booking = store.state.bookings[id];
    if (!booking) throw httpError(404, "booking-not-found");
    if (ctx.actor.role !== "manager" && booking.organizerId !== ctx.actor.organizerId) {
      throw httpError(404, "booking-not-found");
    }
    return booking;
  };
  // 承办方只能看到"时段被占用"这一事实，看不到对方活动细节
  const sanitizeConflicts = (ctx, conflicts) =>
    ctx.actor.role === "manager"
      ? conflicts
      : conflicts.map((c) => (c.type === "space-occupied" ? { type: c.type, window: c.window } : c));

  const evalPatch = (ev) => ({
    windows: ev.windows,
    capacity: ev.capacity,
    permit: ev.permit,
    staffPlan: ev.staffPlan,
    gaps: ev.gaps,
  });

  function normalizeBookingRequest(body) {
    const req = {
      title: typeof body.title === "string" ? body.title.trim() : "",
      spaceId: body.spaceId,
      eventStart: body.eventStart,
      eventEnd: body.eventEnd,
      setupHours: body.setupHours == null ? 0 : body.setupHours,
      teardownHours: body.teardownHours == null ? 0 : body.teardownHours,
      expectedAttendance: body.expectedAttendance,
      ticketed: Boolean(body.ticketed),
      equipment: Array.isArray(body.equipment) ? body.equipment : [],
      staff: Array.isArray(body.staff) ? body.staff : [],
    };
    const errors = [];
    if (!req.title) errors.push("缺少活动名称 title");
    if (!req.spaceId || !store.state.spaces[req.spaceId]) errors.push("未知场地 spaceId");
    const es = domain.toMs(req.eventStart);
    const ee = domain.toMs(req.eventEnd);
    if (es == null || ee == null) errors.push("eventStart/eventEnd 需为 ISO 时间");
    else if (ee <= es) errors.push("eventEnd 必须晚于 eventStart");
    for (const k of ["setupHours", "teardownHours"]) {
      if (typeof req[k] !== "number" || !(req[k] >= 0) || req[k] > 72) errors.push(`${k} 需为 0-72 的数字`);
    }
    if (!Number.isInteger(req.expectedAttendance) || req.expectedAttendance <= 0) {
      errors.push("expectedAttendance 需为正整数");
    }
    for (const e of req.equipment) {
      if (!e || !store.state.equipment[e.equipmentId]) errors.push("未知设备 equipmentId: " + (e && e.equipmentId));
      else if (!Number.isInteger(e.qty) || e.qty <= 0) errors.push("设备数量需为正整数");
    }
    for (const s of req.staff) {
      if (!s || typeof s.qualification !== "string" || !s.qualification) errors.push("人员需求缺少 qualification");
      else if (!Number.isInteger(s.count) || s.count <= 0) errors.push("人员数量需为正整数");
    }
    if (errors.length) throw httpError(400, "invalid-booking", errors);
    return req;
  }

  function logRejection(ctx, stage, extra) {
    store.dispatch("booking.rejected", { stage, ...extra }, actorLabel(ctx));
  }

  // 为受影响场次生成变更通知：只标记、给方案，绝不自动改动
  function raiseNotices(ctx, cause, affected) {
    const notices = [];
    for (const a of affected) {
      const booking = store.state.bookings[a.bookingId];
      if (!booking) continue;
      const notice = {
        id: store.nextId("notice"),
        bookingId: booking.id,
        organizerId: booking.organizerId,
        cause,
        impact: a.impact,
        alternatives: a.alternatives,
        status: "pending",
        createdAt: store.clock(),
      };
      store.dispatch("notice.upsert", { notice }, "system");
      const updated = { ...booking, affected: true, notices: [...(booking.notices || []), notice.id] };
      store.dispatch("booking.upsert", { booking: updated, reason: "impact-flagged" }, "system");
      notices.push(notice);
    }
    return notices;
  }

  // ---------- 基础 ----------

  add("GET", "/health", async (ctx) => send(ctx.res, 200, healthPayload()));

  // ---------- 资源登记（值班经理） ----------

  add("POST", "/spaces", async (ctx) => {
    requireManager(ctx);
    const { name, kind, capacity } = ctx.body;
    if (typeof name !== "string" || !name.trim()) throw httpError(400, "invalid-space", "缺少场地名称");
    if (!Number.isInteger(capacity) || capacity <= 0) throw httpError(400, "invalid-space", "capacity 需为正整数");
    const space = {
      id: ctx.body.id || store.nextId("space"),
      name: name.trim(),
      kind: typeof kind === "string" && kind ? kind : "arena",
      capacity,
    };
    if (ctx.body.id && store.state.spaces[ctx.body.id]) throw httpError(409, "space-exists");
    store.dispatch("space.upsert", { space }, actorLabel(ctx));
    send(ctx.res, 201, { space });
  });

  add("POST", "/equipment", async (ctx) => {
    requireManager(ctx);
    const { name, kind, total } = ctx.body;
    if (typeof name !== "string" || !name.trim()) throw httpError(400, "invalid-equipment", "缺少设备名称");
    if (!Number.isInteger(total) || total <= 0) throw httpError(400, "invalid-equipment", "total 需为正整数");
    const equipment = {
      id: ctx.body.id || store.nextId("equipment"),
      name: name.trim(),
      kind: typeof kind === "string" && kind ? kind : "generic",
      total,
    };
    if (ctx.body.id && store.state.equipment[ctx.body.id]) throw httpError(409, "equipment-exists");
    store.dispatch("equipment.upsert", { equipment }, actorLabel(ctx));
    send(ctx.res, 201, { equipment });
  });

  add("POST", "/staff", async (ctx) => {
    requireManager(ctx);
    const { name, qualifications } = ctx.body;
    if (typeof name !== "string" || !name.trim()) throw httpError(400, "invalid-staff", "缺少人员姓名");
    if (!Array.isArray(qualifications)) throw httpError(400, "invalid-staff", "qualifications 需为数组");
    for (const q of qualifications) {
      if (!q || typeof q.type !== "string" || !q.type || domain.toMs(q.validUntil) == null) {
        throw httpError(400, "invalid-staff", "资质需包含 type 与有效 ISO 时间 validUntil");
      }
    }
    const member = {
      id: ctx.body.id || store.nextId("staff"),
      name: name.trim(),
      qualifications: qualifications.map((q) => ({ type: q.type, validUntil: q.validUntil })),
    };
    if (ctx.body.id && store.state.staff[ctx.body.id]) throw httpError(409, "staff-exists");
    store.dispatch("staff.upsert", { staff: member }, actorLabel(ctx));
    send(ctx.res, 201, { staff: member });
  });

  add("POST", "/permits", async (ctx) => {
    requireManager(ctx);
    const { name, scope, validFrom, validUntil } = ctx.body;
    const maxLevel = ctx.body.maxLevel == null ? 2 : ctx.body.maxLevel;
    if (typeof name !== "string" || !name.trim()) throw httpError(400, "invalid-permit", "缺少批文名称");
    if (scope !== "*" && !store.state.spaces[scope]) throw httpError(400, "invalid-permit", "scope 需为 * 或已登记场地");
    if (domain.toMs(validFrom) == null || domain.toMs(validUntil) == null || domain.toMs(validUntil) <= domain.toMs(validFrom)) {
      throw httpError(400, "invalid-permit", "validFrom/validUntil 需为有效 ISO 时间且后者更晚");
    }
    if (![1, 2, 3].includes(maxLevel)) throw httpError(400, "invalid-permit", "maxLevel 需为 1-3");
    const permit = {
      id: ctx.body.id || store.nextId("permit"),
      name: name.trim(),
      scope,
      validFrom,
      validUntil,
      maxLevel,
      status: "active",
    };
    if (ctx.body.id && store.state.permits[ctx.body.id]) throw httpError(409, "permit-exists");
    store.dispatch("permit.upsert", { permit }, actorLabel(ctx));
    send(ctx.res, 201, { permit });
  });

  add("GET", "/resources", async (ctx) => {
    requireManager(ctx);
    const s = store.state;
    send(ctx.res, 200, {
      spaces: Object.values(s.spaces),
      equipment: Object.values(s.equipment),
      staff: Object.values(s.staff),
      permits: Object.values(s.permits),
      regulations: s.regulations,
      faults: Object.values(s.faults),
    });
  });

  // ---------- 预留生命周期 ----------

  add("POST", "/bookings", async (ctx) => {
    const req = normalizeBookingRequest(ctx.body);
    let organizerId;
    if (ctx.actor.role === "organizer") {
      if (!ctx.actor.organizerId) throw httpError(400, "missing-organizer", "缺少 x-organizer-id 头");
      organizerId = ctx.actor.organizerId;
    } else {
      organizerId = typeof ctx.body.organizerId === "string" && ctx.body.organizerId ? ctx.body.organizerId : "venue-internal";
    }
    const evaluation = domain.evaluateBooking(store.state, req, null);
    if (evaluation.conflicts.length) {
      logRejection(ctx, "create", { organizerId, request: req, reasons: evaluation.conflicts });
      throw httpError(409, "booking-conflict", sanitizeConflicts(ctx, evaluation.conflicts));
    }
    const booking = {
      id: store.nextId("booking"),
      organizerId,
      ...req,
      ...evalPatch(evaluation),
      status: "tentative",
      affected: false,
      notices: [],
      createdAt: store.clock(),
    };
    store.dispatch("booking.upsert", { booking, reason: "create" }, actorLabel(ctx));
    send(ctx.res, 201, { booking });
  });

  add("GET", "/bookings", async (ctx) => {
    let list = Object.values(store.state.bookings);
    if (ctx.actor.role !== "manager") list = list.filter((b) => b.organizerId === ctx.actor.organizerId);
    const status = ctx.query.get("status");
    if (status) list = list.filter((b) => b.status === status);
    send(ctx.res, 200, { bookings: list });
  });

  add("GET", "/bookings/:id", async (ctx) => {
    send(ctx.res, 200, { booking: getBooking(ctx, ctx.params.id) });
  });

  // 承办方查看自己的资源缺口（实时重算）；值班经理另可见冲突明细
  add("GET", "/bookings/:id/gaps", async (ctx) => {
    const booking = getBooking(ctx, ctx.params.id);
    const evaluation = domain.evaluateBooking(store.state, domain.requestFromBooking(booking), booking.id);
    const payload = {
      bookingId: booking.id,
      status: booking.status,
      windows: evaluation.windows,
      capacity: evaluation.capacity,
      gaps: evaluation.gaps,
      staffPlan: evaluation.staffPlan,
      permit: evaluation.permit,
    };
    if (ctx.actor.role === "manager") payload.conflicts = evaluation.conflicts;
    send(ctx.res, 200, payload);
  });

  // 签约：所有硬冲突与资源缺口必须先解决
  add("POST", "/bookings/:id/confirm", async (ctx) => {
    const booking = getBooking(ctx, ctx.params.id);
    if (booking.status !== "tentative") {
      throw httpError(409, "invalid-state", { current: booking.status, expected: "tentative" });
    }
    const evaluation = domain.evaluateBooking(store.state, domain.requestFromBooking(booking), booking.id);
    if (evaluation.conflicts.length || evaluation.gaps.length) {
      logRejection(ctx, "confirm", { bookingId: booking.id, reasons: [...evaluation.conflicts, ...evaluation.gaps] });
      throw httpError(409, "booking-not-ready", {
        conflicts: sanitizeConflicts(ctx, evaluation.conflicts),
        gaps: evaluation.gaps,
      });
    }
    const updated = { ...booking, ...evalPatch(evaluation), status: "contracted", contractedAt: store.clock() };
    store.dispatch("booking.upsert", { booking: updated, reason: "confirm" }, actorLabel(ctx));
    send(ctx.res, 200, { booking: updated });
  });

  // 进场：记录当时有效的放行依据（容量、级别、批文、排班）
  add("POST", "/bookings/:id/load-in", async (ctx) => {
    requireManager(ctx);
    const booking = getBooking(ctx, ctx.params.id);
    if (booking.status !== "contracted") {
      throw httpError(409, "invalid-state", { current: booking.status, expected: "contracted" });
    }
    const evaluation = domain.evaluateBooking(store.state, domain.requestFromBooking(booking), booking.id);
    if (evaluation.conflicts.length) {
      logRejection(ctx, "load-in", { bookingId: booking.id, reasons: evaluation.conflicts });
      throw httpError(409, "booking-conflict", evaluation.conflicts);
    }
    const admissionBasis = {
      at: store.clock(),
      securityLevel: evaluation.capacity.level,
      allowedCapacity: evaluation.capacity.allowed,
      expectedAttendance: booking.expectedAttendance,
      permitId: evaluation.permit ? evaluation.permit.id : null,
      staffPlan: evaluation.staffPlan,
      equipment: booking.equipment,
      openGaps: evaluation.gaps,
    };
    const updated = {
      ...booking,
      ...evalPatch(evaluation),
      status: "load-in",
      loadInAt: store.clock(),
      admissionBasis,
    };
    store.dispatch("booking.upsert", { booking: updated, reason: "load-in" }, actorLabel(ctx));
    send(ctx.res, 200, { booking: updated });
  });

  add("POST", "/bookings/:id/complete", async (ctx) => {
    requireManager(ctx);
    const booking = getBooking(ctx, ctx.params.id);
    if (booking.status !== "load-in") {
      throw httpError(409, "invalid-state", { current: booking.status, expected: "load-in" });
    }
    const updated = { ...booking, status: "completed", completedAt: store.clock() };
    store.dispatch("booking.upsert", { booking: updated, reason: "complete" }, actorLabel(ctx));
    send(ctx.res, 200, { booking: updated });
  });

  add("POST", "/bookings/:id/cancel", async (ctx) => {
    const booking = getBooking(ctx, ctx.params.id);
    if (!domain.ACTIVE_STATES.includes(booking.status)) {
      throw httpError(409, "invalid-state", { current: booking.status, expected: domain.ACTIVE_STATES });
    }
    const updated = { ...booking, status: "cancelled", cancelledAt: store.clock() };
    store.dispatch("booking.upsert", { booking: updated, reason: "cancel" }, actorLabel(ctx));
    send(ctx.res, 200, { booking: updated });
  });

  // 调整：重新评估；已售票活动改动时间/场地必须由值班经理显式确认
  add("POST", "/bookings/:id/adjust", async (ctx) => {
    const booking = getBooking(ctx, ctx.params.id);
    if (!domain.ACTIVE_STATES.includes(booking.status)) {
      throw httpError(409, "invalid-state", { current: booking.status, expected: domain.ACTIVE_STATES });
    }
    const merged = { ...domain.requestFromBooking(booking) };
    for (const k of ["title", "spaceId", "eventStart", "eventEnd", "setupHours", "teardownHours", "expectedAttendance", "ticketed", "equipment", "staff"]) {
      if (ctx.body[k] !== undefined) merged[k] = ctx.body[k];
    }
    const req = normalizeBookingRequest(merged);
    const moved =
      req.spaceId !== booking.spaceId ||
      domain.toMs(req.eventStart) !== domain.toMs(booking.eventStart) ||
      domain.toMs(req.eventEnd) !== domain.toMs(booking.eventEnd);
    if (moved && booking.ticketed && !(ctx.actor.role === "manager" && ctx.body.confirmTicketedMove === true)) {
      logRejection(ctx, "adjust", { bookingId: booking.id, reasons: [{ type: "ticketed-move-requires-confirmation" }] });
      throw httpError(409, "ticketed-move-requires-confirmation", "已售票活动调整时间或场地，需值班经理以 confirmTicketedMove 显式确认");
    }
    const evaluation = domain.evaluateBooking(store.state, req, booking.id);
    if (evaluation.conflicts.length) {
      logRejection(ctx, "adjust", { bookingId: booking.id, request: req, reasons: evaluation.conflicts });
      throw httpError(409, "booking-conflict", sanitizeConflicts(ctx, evaluation.conflicts));
    }
    const updated = { ...booking, ...req, ...evalPatch(evaluation) };
    store.dispatch("booking.upsert", { booking: updated, reason: "adjust" }, actorLabel(ctx));
    send(ctx.res, 200, { booking: updated });
  });

  // ---------- 异常与监管变化：只标记实际受影响场次，由负责人确认 ----------

  add("POST", "/incidents/equipment-fault", async (ctx) => {
    requireManager(ctx);
    const { equipmentId, from, until } = ctx.body;
    const eq = store.state.equipment[equipmentId];
    if (!eq) throw httpError(400, "unknown-equipment", "未知设备");
    if (domain.toMs(from) == null || domain.toMs(until) == null || domain.toMs(until) <= domain.toMs(from)) {
      throw httpError(400, "invalid-fault", "from/until 需为有效 ISO 时间且后者更晚");
    }
    const qty = ctx.body.qty == null ? eq.total : ctx.body.qty;
    if (!Number.isInteger(qty) || qty <= 0 || qty > eq.total) {
      throw httpError(400, "invalid-fault", "qty 需为 1 至设备总量之间的整数");
    }
    const fault = { id: store.nextId("fault"), equipmentId, from, until, qty, status: "open", createdAt: store.clock() };
    store.dispatch("fault.upsert", { fault }, actorLabel(ctx));
    const affected = domain.impactOfFault(store.state, fault);
    const notices = raiseNotices(ctx, { kind: "equipment-fault", refId: fault.id, detail: `设备 ${eq.name} 故障 ${qty} 台（${from} ~ ${until}）` }, affected);
    send(ctx.res, 201, { fault, affected: affected.map((a) => a.bookingId), notices });
  });

  add("POST", "/incidents/equipment-fault/:id/resolve", async (ctx) => {
    requireManager(ctx);
    const fault = store.state.faults[ctx.params.id];
    if (!fault) throw httpError(404, "fault-not-found");
    if (fault.status !== "open") throw httpError(409, "invalid-state", { current: fault.status, expected: "open" });
    const updated = { ...fault, status: "resolved", resolvedAt: store.clock() };
    store.dispatch("fault.upsert", { fault: updated }, actorLabel(ctx));
    send(ctx.res, 200, { fault: updated });
  });

  add("POST", "/permits/:id/revoke", async (ctx) => {
    requireManager(ctx);
    const permit = store.state.permits[ctx.params.id];
    if (!permit) throw httpError(404, "permit-not-found");
    if (permit.status === "revoked") throw httpError(409, "invalid-state", { current: permit.status, expected: "active" });
    const updated = { ...permit, status: "revoked", revokedAt: store.clock() };
    store.dispatch("permit.upsert", { permit: updated }, actorLabel(ctx));
    const affected = domain.impactOfPermit(store.state, updated);
    const notices = raiseNotices(ctx, { kind: "permit-revoked", refId: permit.id, detail: `批文 ${permit.name} 已吊销` }, affected);
    send(ctx.res, 200, { permit: updated, affected: affected.map((a) => a.bookingId), notices });
  });

  add("POST", "/regulations", async (ctx) => {
    requireManager(ctx);
    const { spaceId, level, from } = ctx.body;
    const until = ctx.body.until || null;
    if (spaceId !== "*" && !store.state.spaces[spaceId]) throw httpError(400, "invalid-regulation", "spaceId 需为 * 或已登记场地");
    if (![1, 2, 3].includes(level)) throw httpError(400, "invalid-regulation", "level 需为 1-3");
    if (domain.toMs(from) == null) throw httpError(400, "invalid-regulation", "from 需为有效 ISO 时间");
    if (until != null && domain.toMs(until) <= domain.toMs(from)) throw httpError(400, "invalid-regulation", "until 需晚于 from");
    const regulation = { id: store.nextId("reg"), spaceId, level, from, until, createdAt: store.clock() };
    store.dispatch("regulation.add", { regulation }, actorLabel(ctx));
    const affected = domain.impactOfRegulation(store.state, regulation);
    const notices = raiseNotices(ctx, { kind: "regulation-raised", refId: regulation.id, detail: `保障级别调整为 ${level}（${spaceId}）` }, affected);
    send(ctx.res, 201, { regulation, affected: affected.map((a) => a.bookingId), notices });
  });

  // ---------- 变更通知 ----------

  add("GET", "/notices", async (ctx) => {
    let list = Object.values(store.state.notices);
    if (ctx.actor.role !== "manager") list = list.filter((n) => n.organizerId === ctx.actor.organizerId);
    const status = ctx.query.get("status");
    if (status) list = list.filter((n) => n.status === status);
    send(ctx.res, 200, { notices: list });
  });

  // 负责人确认：值班经理可确认全部，承办方只能确认自己场次的通知
  add("POST", "/notices/:id/ack", async (ctx) => {
    const notice = store.state.notices[ctx.params.id];
    if (!notice) throw httpError(404, "notice-not-found");
    if (ctx.actor.role !== "manager" && notice.organizerId !== ctx.actor.organizerId) {
      throw httpError(404, "notice-not-found");
    }
    if (notice.status !== "pending") throw httpError(409, "invalid-state", { current: notice.status, expected: "pending" });
    const updated = {
      ...notice,
      status: "acknowledged",
      acknowledgedBy: actorLabel(ctx),
      acknowledgedAt: store.clock(),
      note: typeof ctx.body.note === "string" ? ctx.body.note : null,
    };
    store.dispatch("notice.upsert", { notice: updated }, actorLabel(ctx));
    send(ctx.res, 200, { notice: updated });
  });

  // ---------- 审计与回放（值班经理） ----------

  // 回放某日/某单：为何拒绝冲突申请、哪些变更通知已确认
  add("GET", "/audit", async (ctx) => {
    requireManager(ctx);
    const day = ctx.query.get("day");
    const action = ctx.query.get("action");
    const bookingId = ctx.query.get("bookingId");
    let entries = store.log;
    if (day) entries = entries.filter((e) => e.ts.startsWith(day));
    if (action) entries = entries.filter((e) => e.action === action);
    if (bookingId) {
      entries = entries.filter((e) => {
        const d = e.data || {};
        return d.bookingId === bookingId || (d.booking && d.booking.id === bookingId) || (d.notice && d.notice.bookingId === bookingId);
      });
    }
    send(ctx.res, 200, { entries });
  });

  add("GET", "/calendar", async (ctx) => {
    requireManager(ctx);
    const day = ctx.query.get("day");
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw httpError(400, "invalid-day", "day 需为 YYYY-MM-DD");
    const start = Date.parse(day + "T00:00:00.000Z");
    const end = start + 24 * 3600 * 1000;
    const bookings = Object.values(store.state.bookings)
      .filter(domain.isActive)
      .filter((b) => domain.overlaps(domain.toMs(b.windows.setupStart), domain.toMs(b.windows.teardownEnd), start, end));
    send(ctx.res, 200, { day, bookings });
  });

  // 从已结束场次复原：当时有效的场地状态、人员排班与放行依据
  add("GET", "/bookings/:id/replay", async (ctx) => {
    requireManager(ctx);
    const booking = store.state.bookings[ctx.params.id];
    if (!booking) throw httpError(404, "booking-not-found");
    if (booking.status !== "completed") {
      throw httpError(409, "not-completed", "仅已结束的场次支持状态回放");
    }
    const loadInEntry = store.log.find(
      (e) => e.action === "booking.upsert" && e.data.booking && e.data.booking.id === booking.id && e.data.booking.status === "load-in"
    );
    const asOf = loadInEntry ? loadInEntry.ts : booking.completedAt;
    const past = store.replay(asOf);
    const pastBooking = past.bookings[booking.id];
    const space = past.spaces[pastBooking.spaceId];
    const level = domain.effectiveLevel(past, pastBooking.spaceId, domain.toMs(pastBooking.eventStart));
    const permits = Object.values(past.permits)
      .filter((p) => p.status !== "revoked")
      .filter((p) => p.scope === "*" || p.scope === pastBooking.spaceId);
    send(ctx.res, 200, {
      asOf,
      booking: pastBooking,
      space,
      securityLevel: level,
      allowedCapacity: Math.floor(space.capacity * domain.levelFactor(level)),
      permits,
      staffing: pastBooking.staffPlan,
      admissionBasis: pastBooking.admissionBasis || null,
    });
  });

  function match(method, path) {
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.regex.exec(path);
      if (m) {
        const params = {};
        r.keys.forEach((k, i) => {
          params[k] = decodeURIComponent(m[i + 1]);
        });
        return { handler: r.handler, params };
      }
    }
    return null;
  }

  return async function app(req, res) {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const found = match(req.method, url.pathname);
      if (!found) {
        send(res, 404, { error: "not-found" });
        return;
      }
      const body = req.method === "GET" || req.method === "HEAD" ? {} : await readBody(req);
      const ctx = { req, res, params: found.params, query: url.searchParams, body, actor: actorOf(req) };
      if (req.method === "GET") await found.handler(ctx);
      else await enqueue(() => found.handler(ctx));
    } catch (err) {
      send(res, err.statusCode || 500, { error: err.message || "internal-error", details: err.details });
    }
  };
}

module.exports = { createApp, SERVICE_ID, SERVICE_NAME, healthPayload };
