# 场馆档期安全联锁

面向同时承接职业联赛、青少年比赛、群众活动与临时国际赛事的综合体育中心，把主馆、训练区、设备、人员资质和监管批文纳入统一的档期联锁服务。

## 核心能力

- **预留即联锁**：任何预留按赛事画像计算布撤场窗口（占用区间 = 布场 + 活动 + 撤场）与安全容量（人数上限、安保配比），并同步锁定设备、持证人员与监管批文；档期或资源冲突当场拒绝并留痕。
- **并发不重复占用**：暂定、签约、进场的状态流转在检查与落库之间不穿插异步操作，两笔并发操作只有一笔生效；签约支持版本号比对（`expectedVersion`）。
- **扰动只标出实际受影响场次**：设备故障、批文撤销、监管提高安保等级时，系统逐场核算影响并给出替代方案（换设备、换批文、增派安保、备选档期、核减人数），生成变更单由值班经理确认后才执行；系统绝不自动挪动已售票活动。
- **进场放行留依据**：放行前复核批文有效性、安保人数与设备状态，固化当场有效的放行依据（批文、安保核算、设备清单、批准人）。
- **角色隔离**：承办方只能看到自己的场次与资源缺口；运营席管理资源与扰动登记；值班经理确认变更、回放审计、复原历史状态。
- **回放与复原**：按日期回放审计日志（为何拒绝冲突申请、哪次变更通知已被确认）；从场次事件流复原任一时刻有效的场地占用、人员排班与放行依据。

## 接口概览

身份通过请求头传递：`x-actor-id`、`x-actor-role`（`organizer` / `ops` / `duty_manager`）。

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| GET | `/health` | 公开 | 健康检查 |
| GET | `/spaces` `/equipment` `/personnel` `/permits` | 视角色 | 资源档案 |
| POST | `/bookings` | organizer/ops | 创建预留（计算布撤场窗口与安全容量） |
| GET | `/bookings` | 按角色过滤 | 承办方仅见自己的场次 |
| GET | `/bookings/:id/gaps` | 本人/内部 | 当前资源缺口 |
| POST | `/bookings/:id/confirm` | 本人/ops | 签约（复核资源仍有效） |
| POST | `/bookings/:id/load-in` | ops/值班经理 | 进场放行（固化放行依据） |
| POST | `/bookings/:id/cancel` `/complete` | 视角色 | 取消 / 结束 |
| POST | `/equipment/:id/faults` | ops/值班经理 | 设备故障登记 → 影响分析 |
| POST | `/permits/:id/revoke` | ops/值班经理 | 批文撤销 → 影响分析 |
| POST | `/regulation/security-level` | ops/值班经理 | 提高安保等级 → 缺口分析 |
| GET | `/changes` | ops/值班经理 | 变更通知单列表 |
| POST | `/changes/:id/ack` | duty_manager | 确认变更（可自动执行的方案即时生效） |
| GET | `/audit/replay?date=YYYY-MM-DD` | duty_manager | 回放当日拒绝原因与变更确认 |
| GET | `/snapshot?at=<ISO>` | duty_manager | 复原某时刻场地状态、排班与放行依据 |

错误统一为 `{ "error": { "code", "message", "details" } }`；冲突返回 `409` 并附带 `conflicts` 与 `gaps` 明细。

## 运行

```bash
npm run check   # 核对服务身份与资源档案
npm test        # 接口契约与联锁行为测试
node service.js # 启动服务，默认 127.0.0.1:8000（PORT 可覆盖）
```

## 结构

- `lib/domain.js` — 赛事画像（布撤场、安保配比、设备/人员/批文需求）与安保等级
- `lib/store.js` — 事件溯源存储与只增审计日志
- `lib/ops.js` — 联锁核心：预留评估、状态流转、影响分析、变更确认、快照复原
- `lib/seed.js` — 演示数据（主馆/训练区、设备、持证人员、监管批文）
- `service.js` — HTTP 路由与角色隔离
