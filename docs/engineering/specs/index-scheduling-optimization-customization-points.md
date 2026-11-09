# 索引落后与调度优化 — 二次开发改动面

- 任务：`index-scheduling-optimization`
- 日期：2026-11-07
- 仓库拓扑：`origin` = `github714801013/GitNexus`（fork），`upstream` = `abhigyanpatwari/GitNexus`
- 结论：属于 fork 二次开发；本次修改上游巡检调度入口，新增本地独立选择器模块以缩小上游耦合面。

## 1. 上游基线

- 上游基线 SHA：`02101fdfed84059bb03c24081148f3e63ba092a0`（`git merge-base HEAD upstream/main`，即 `upstream/main` 当前提交）。
- 当前分支：`xiexiongkun/source-customization-v1.6.13-rc.182`，未配置 upstream 跟踪分支。
- 同步策略：沿用仓库既有的 upstream 合并方式；本任务不改变同步策略。

## 2. 本地新增文件

- `docs/engineering/specs/index-scheduling-optimization-spec.md`（本任务规格）
- `docs/engineering/specs/index-scheduling-optimization-customization-points.md`（本文档）
- `docs/engineering/plans/index-scheduling-optimization-澄清定稿.md`（已有）
- `docs/engineering/plans/index-scheduling-optimization-验收条件与必测场景清单.md`（已有）
- `docs/engineering/plans/index-scheduling-optimization-测试数据.md`（已有）
- `gitnexus/src/server/stale-analyze-scheduler.ts`（计划新增：候选选择与分支判定纯函数）
- `gitnexus/test/unit/stale-analyze-scheduler.test.ts`（计划新增：选择器单测）

## 3. 触及的上游文件与符号

| 文件 | 符号 | 改动性质 |
| --- | --- | --- |
| `gitnexus/src/server/api.ts` | `runIndexHealthCheck`（局部闭包） | 在巡检循环中收集候选、跳过跨分支、循环后排序限量入队；失败回调写入进程内隔离集合 |
| `gitnexus/src/server/api.ts` | `scheduleStaleAnalyze`（局部函数） | 日志补充 `commitsBehind`；失败回调登记失败仓库 |
| `gitnexus/src/server/api.ts` | import 区 | 新增引用本地选择器模块与 `getCurrentBranch` |
| `gitnexus/src/storage/git.ts` | `getCurrentBranchAsync` | 新增异步分支读取函数，供巡检批量循环避免阻塞事件循环 |

### 上游核心文件修改说明（`api.ts`）

- **扩展点不足的事实**：巡检调度顺序、限量与失败隔离没有现成 hook、插件或配置入口，只能在上游巡检循环内接入。
- **最小范围**：仅修改 `runIndexHealthCheck` 内部循环与循环后的入队片段；不改路由、响应、返回结构、日志之外的公开行为。
- **受影响接口与调用方**：`runIndexHealthCheck` 为局部函数，无外部调用方；`POST /api/index-health-check` 出入参不变；`shouldScheduleStartupIncrementalAnalyze` 等既有导出不变。
- **兼容策略**：候选条件复用既有 staleness 判定；`commitsBehind < 100` 不被过滤；webhook 与 embedding 修复路径不读取新增状态。
- **耦合方式**：选择器逻辑放入本地独立模块，`api.ts` 仅做最小接线，属适配层接入；业务规则不嵌入上游核心流程。
- **升级时判断**：保留该补丁；上游若重构巡检循环，按“收集候选 → 分支判定 → 排序限量 → 入队”四段重新接线，选择器模块可原样复用。

### 上游核心文件修改说明（`storage/git.ts`）

- **扩展点不足的事实**：既有 `getCurrentBranch` 为同步 `execSync`，巡检对每个 stale 仓库调用会阻塞事件循环；异步 git 工具未导出可复用版本。
- **最小范围**：新增 `getCurrentBranchAsync`，语义与同步版一致（detached/失败返回 `null`）。
- **受影响接口与调用方**：仅新增导出，不改变既有函数签名与行为。
- **耦合方式**：与既有同步函数并列放置，属独立函数新增，不侵入既有逻辑。
- **升级时判断**：若上游提供等价异步 helper，删除本地新增并改用上游实现。

## 4. 升级时判断与验证入口

- **保留**：本地选择器模块、单测、本次在 `api.ts` 的最小接线补丁。
- **重写条件**：上游巡检循环签名或 staleness 返回结构变化时，重写 `api.ts` 接线片段；选择器纯函数接口不变。
- **删除条件**：上游自身实现“按落后排序 + 限量 + 跨分支跳过 + 失败隔离”且行为等价时，删除本地补丁与选择器模块。
- **验证入口**：
  - `cd gitnexus && npx vitest run test/unit/stale-analyze-scheduler.test.ts`
  - `cd gitnexus && npx vitest run test/unit/api-index-health-check-async.test.ts test/unit/startup-embedding-schedule.test.ts`
  - 升级合并后检查 `git diff --stat upstream/main...HEAD -- gitnexus/src/server/api.ts`，确认改动仍限于巡检片段。

## 5. 复现测试

- 单元测试：`cd gitnexus && npx vitest run test/unit/stale-analyze-scheduler.test.ts`
- 回归测试：`cd gitnexus && npx vitest run test/unit/webhook-analyze-queue.test.ts test/unit/resource-aware-concurrency.test.ts`
- 场景复现：构造 11 个 stale 候选（落后数 17–340，含跨分支与已失败条目），断言选择结果为降序前 10、跨分支被跳过、失败条目被过滤。
