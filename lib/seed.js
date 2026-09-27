"use strict";

// 演示数据：一座综合体育中心（主馆 + 两个训练区）、设备、持证人员与监管批文。
function seed(store) {
  const spaces = [
    { id: "main_arena", name: "主馆", capacity: 18000 },
    { id: "training_a", name: "训练区A", capacity: 800 },
    { id: "training_b", name: "训练区B", capacity: 800 },
  ];
  for (const s of spaces) store.spaces.set(s.id, s);

  const equipment = [
    { id: "eq_score_1", type: "scoreboard", label: "电子记分屏-1" },
    { id: "eq_score_2", type: "scoreboard", label: "电子记分屏-2" },
    { id: "eq_bc_1", type: "broadcast", label: "转播车组-1" },
    { id: "eq_bc_2", type: "broadcast", label: "转播车组-2" },
    { id: "eq_bc_3", type: "broadcast", label: "转播车组-3" },
    { id: "eq_bc_4", type: "broadcast", label: "转播车组-4" },
    { id: "eq_timing_1", type: "timing", label: "计时计分系统-1" },
  ];
  for (const e of equipment) store.equipment.set(e.id, { ...e, faults: [] });

  const QUALITY_EXPIRY = "2027-06-30T23:59:59.000Z";
  const addPersonnel = (prefix, role, count, label) => {
    for (let i = 1; i <= count; i += 1) {
      const id = prefix + "_" + String(i).padStart(3, "0");
      store.personnel.set(id, {
        id,
        name: label + "-" + i,
        roles: [role],
        qualifications: { [role]: QUALITY_EXPIRY },
      });
    }
  };
  addPersonnel("sec", "security", 120, "安保员");
  addPersonnel("med", "medical", 6, "医疗员");
  addPersonnel("ref", "referee", 8, "裁判");
  addPersonnel("itr", "interpreter", 3, "译员");

  const permits = [
    { id: "permit_large", scope: "large_event", label: "大型群众性活动安全许可", validFrom: "2026-01-01T00:00:00.000Z", validTo: "2026-12-31T23:59:59.000Z" },
    { id: "permit_youth", scope: "youth_event", label: "青少年赛事活动备案", validFrom: "2026-01-01T00:00:00.000Z", validTo: "2026-12-31T23:59:59.000Z" },
    { id: "permit_intl", scope: "international_event", label: "国际赛事临时批文", validFrom: "2026-06-01T00:00:00.000Z", validTo: "2026-12-31T23:59:59.000Z" },
  ];
  for (const p of permits) store.permits.set(p.id, { ...p, revokedAt: null });

  return store;
}

module.exports = { seed };
