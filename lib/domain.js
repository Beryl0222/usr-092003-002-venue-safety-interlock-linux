"use strict";

// 赛事类型画像：决定布撤场窗口、安保配比、设备/人员资质/监管批文需求。
// 任何预留都以此计算占用区间与安全容量，避免合同签订后才发现施工与保障互相挤占。
const EVENT_PROFILES = {
  pro_league: {
    label: "职业联赛",
    setupMinutes: 240,
    teardownMinutes: 180,
    security: { base: 10, perAttendee: 0.01 },
    personnel: { medical: 2, referee: 3 },
    equipment: { scoreboard: 1, broadcast: 2 },
    permitScopes: ["large_event"],
  },
  youth_match: {
    label: "青少年比赛",
    setupMinutes: 90,
    teardownMinutes: 60,
    security: { base: 4, perAttendee: 0.005 },
    personnel: { medical: 1, referee: 2 },
    equipment: { scoreboard: 1 },
    permitScopes: ["youth_event"],
  },
  community: {
    label: "群众活动",
    setupMinutes: 60,
    teardownMinutes: 60,
    security: { base: 2, perAttendee: 0.003 },
    personnel: { medical: 1 },
    equipment: {},
    permitScopes: [],
  },
  international: {
    label: "临时国际赛事",
    setupMinutes: 480,
    teardownMinutes: 360,
    security: { base: 20, perAttendee: 0.0125 },
    personnel: { medical: 4, referee: 4, interpreter: 2 },
    equipment: { scoreboard: 1, broadcast: 4, timing: 1 },
    permitScopes: ["large_event", "international_event"],
  },
};

// 监管安保等级：提高等级会按比例放大安保人数需求。
const SECURITY_LEVELS = {
  normal: { label: "常态", staffingMultiplier: 1 },
  heightened: { label: "加强", staffingMultiplier: 1.25 },
  maximum: { label: "最高", staffingMultiplier: 1.5 },
};

const ACTIVE_STATUSES = ["tentative", "confirmed", "load_in", "in_progress"];

const STATUS_LABELS = {
  tentative: "暂定",
  confirmed: "签约",
  load_in: "进场",
  in_progress: "进行中",
  completed: "已结束",
  cancelled: "已取消",
};

function isActiveStatus(status) {
  return ACTIVE_STATUSES.includes(status);
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function addMinutes(iso, minutes) {
  return new Date(Date.parse(iso) + minutes * 60000).toISOString();
}

function addDays(iso, days) {
  return new Date(Date.parse(iso) + days * 86400000).toISOString();
}

// 占用区间 = 布场窗口 + 活动本体 + 撤场窗口。
function computeOccupancy(profile, start, end) {
  return {
    setupStart: addMinutes(start, -profile.setupMinutes),
    eventStart: start,
    eventEnd: end,
    teardownEnd: addMinutes(end, profile.teardownMinutes),
    setupMinutes: profile.setupMinutes,
    teardownMinutes: profile.teardownMinutes,
  };
}

// 安保人数 = (基数 + 观众 × 配比) × 等级系数，向上取整。
function securityNeeded(profile, attendance, level) {
  const def = SECURITY_LEVELS[level];
  if (!def) throw new Error("未知安保等级: " + level);
  const raw = (profile.security.base + attendance * profile.security.perAttendee) * def.staffingMultiplier;
  return Math.ceil(raw);
}

// 由安保容量反推某等级下允许的最大观众数（用于缩减方案）。
function maxAttendanceForSecurity(profile, level, availableSecurity) {
  const def = SECURITY_LEVELS[level];
  const usable = availableSecurity / def.staffingMultiplier - profile.security.base;
  if (usable <= 0) return 0;
  return Math.floor(usable / profile.security.perAttendee);
}

// 汇总一场活动在某安保等级下的全部资源需求。
function computeRequirements(profile, attendance, level) {
  return {
    securityLevel: level,
    securityPersonnel: securityNeeded(profile, attendance, level),
    personnel: { ...profile.personnel },
    equipment: { ...profile.equipment },
    permitScopes: [...profile.permitScopes],
    setupMinutes: profile.setupMinutes,
    teardownMinutes: profile.teardownMinutes,
  };
}

module.exports = {
  EVENT_PROFILES,
  SECURITY_LEVELS,
  ACTIVE_STATUSES,
  STATUS_LABELS,
  isActiveStatus,
  overlaps,
  addMinutes,
  addDays,
  computeOccupancy,
  computeRequirements,
  securityNeeded,
  maxAttendanceForSecurity,
};
