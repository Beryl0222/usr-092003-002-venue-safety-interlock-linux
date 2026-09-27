"use strict";

// 演示数据：node service.js --seed 时载入，便于本地联调。

function seed(store) {
  const at = (s) => store.dispatch(s.action, s.data, "seed");
  at({ action: "space.upsert", data: { space: { id: "main-arena", name: "主馆", kind: "arena", capacity: 18000 } } });
  at({ action: "space.upsert", data: { space: { id: "training-a", name: "训练区A", kind: "training", capacity: 800 } } });
  at({ action: "equipment.upsert", data: { equipment: { id: "stage-1", name: "移动舞台", kind: "stage", total: 2 } } });
  at({ action: "equipment.upsert", data: { equipment: { id: "scanner-1", name: "安检门", kind: "scanner", total: 20 } } });
  for (let i = 1; i <= 8; i += 1) {
    at({
      action: "staff.upsert",
      data: {
        staff: {
          id: `sec-${i}`,
          name: `安保${i}号`,
          qualifications: [{ type: "security", validUntil: "2027-12-31T00:00:00.000Z" }],
        },
      },
    });
  }
  at({
    action: "permit.upsert",
    data: {
      permit: {
        id: "permit-2026",
        name: "大型活动监管批文（2026）",
        scope: "*",
        validFrom: "2026-01-01T00:00:00.000Z",
        validUntil: "2026-12-31T23:59:59.000Z",
        maxLevel: 2,
        status: "active",
      },
    },
  });
}

module.exports = seed;
