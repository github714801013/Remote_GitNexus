# 索引落后与调度优化 — 规格

- 任务：`index-scheduling-optimization`
- 日期：2026-11-07
- 依据：`docs/engineering/plans/index-scheduling-optimization-澄清定稿.md`

## 问题陈述

GitNexus 每日 22:00 的索引巡检会把所有 stale 仓库一次性投入分析队列。由于分析槽位与队列并发均为 1，每轮实际只能顺序处理极少数仓库；大量仓库长期停留在落后状态。巡检顺序按注册表遍历顺序而非落后程度，差异最大的仓库得不到优先处理。此外，registry 记录的索引分支与仓库当前 checkout 分支不一致时，`commitsBehind` 会产生“假差异”，导致无效分析反复占用队列；分析失败的仓库也会在下一轮巡检中再次入队，挤占本就有限的调度机会。

## 解决方案

在不改动分析并发模型的前提下，只调整巡检调度层：

1. **按落后程度排序**：每轮巡检收集同分支 stale 候选，按 `commitsBehind` 降序排列。
2. **限量调度**：每轮最多调度 10 个仓库，避免一次性塞满队列。
3. **跨分支假差异跳过**：索引分支与 checkout 分支不一致（含 detached HEAD、分支为空）时跳过，并记录仓库名与两个分支值。
4. **失败隔离**：巡检路径中分析失败的仓库记入进程内集合，后续巡检轮次不再入队；进程重启后清空。
5. **日志可见**：调度日志包含仓库名、`commitsBehind`；跳过日志包含跳过原因与分支信息。

webhook 触发的分析与 embedding 修复不受上述限量与隔离影响；分析并发、JobManager 槽位、`waitForJobManagerIdle` 与部署并发配置均保持不变。

## 用户故事

1. 作为 GitNexus 运维者，我希望每轮巡检优先调度落后提交数最多的仓库，以便最陈旧的索引先被修复。
2. 作为 GitNexus 运维者，我希望单轮巡检最多只调度 10 个仓库，以便队列不会因一次性入队过多而长时间拥塞。
3. 作为 GitNexus 运维者，我希望跨分支造成的假差异被跳过，以便无效分析不再占用分析槽位。
4. 作为 GitNexus 运维者，我希望跳过跨分支仓库时日志写明仓库名与两个分支值，以便快速确认跳过原因。
5. 作为 GitNexus 运维者，我希望分析失败的仓库在当前进程内不再重复入队，以便有限的调度机会留给其他仓库。
6. 作为 GitNexus 运维者，我希望失败隔离在进程重启后自动清空，以便修复配置或数据后仓库能重新被调度。
7. 作为 GitNexus 运维者，我希望同分支落后小于 100 的仓库仍按原有条件被调度，以便小差异仓库不会被新规则误伤。
8. 作为 GitNexus 运维者，我希望同分支落后大于等于 100 的仓库在排序中自然优先，以便“差异较大”的仓库先获得处理。
9. 作为 GitNexus 运维者，我希望 webhook 触发的分析不受巡检限量与失败隔离影响，以便代码推送后的索引更新保持及时。
10. 作为 GitNexus 运维者，我希望多个仓库落后数相同时保持注册表原有相对顺序，以便调度结果稳定可复现。
11. 作为 GitNexus 运维者，我希望 `commitsBehind` 为 0 或 HEAD 领先索引提交的仓库不进入候选，以便不做无效分析。
12. 作为 GitNexus 运维者，我希望本次改动不改变分析并发与单槽行为，以便部署配置与资源占用保持现状。

## 实现决策

### 模块与接口

- 新增巡检调度选择器模块，暴露纯函数：
  - `selectStaleAnalyzeCandidates(candidates, failedRepoPaths, limit = 10)`：过滤失败隔离集合，按 `commitsBehind` 降序稳定排序，截取前 `limit` 个。
  - `isKnownBranchMismatch(currentBranch, registryBranch)`：仅当索引分支已知且与 checkout 分支不一致时返回真；索引分支缺失时保持原有调度行为；detached HEAD（`null`）在索引分支已知时视为不一致。
  - 常量 `STALE_ANALYZE_MAX_PER_ROUND = 10`，不新增环境变量或配置键。
- 巡检循环复用既有 `getCurrentBranch` 读取 checkout 分支；不新增 Git 命令封装。
- 失败隔离集合为巡检所在服务实例内的 `Set<string>`，键为仓库路径；仅由巡检路径的 `enqueueWebhookAnalyze` 失败回调写入。

### 行为规则

- 候选条件：同分支、`isStale = true` 且 `commitsBehind > 0`。
- 分支判定在 staleness 计算之后、入队之前进行；索引分支已知且不一致时记录 `Stale index analyze skipped: branch mismatch` 日志，字段含仓库名、索引分支、checkout 分支（detached 标注 `detached`），然后跳过；索引分支缺失时保持原有调度行为。
- 候选按 `commitsBehind` 降序排序；相等时保持注册表遍历顺序（稳定排序）。
- 排序后取前 10 个，逐个记录 `Stale index analyze scheduled`（含 `commitsBehind`）并入队。
- 入队失败回调中，除“分析已在进行中”外的错误都将仓库路径加入失败集合；下一轮选择时过滤。
- `commitsBehind < 100` 的仓库不因阈值被过滤；它们只是排序靠后，候选不足 10 个时仍会被调度。
- embedding 修复调度保持原有位置与条件，不纳入本轮限量。

### 异常与边界

- `commitsBehind = 0` 或负数：不进入候选。
- 恰好 10 / 11 个候选：10 个全部调度；第 11 个留待下一轮。
- 多个仓库落后数相同：稳定排序，不抖动。
- detached HEAD：索引分支已知时视为不一致并跳过；registry 分支为空：保持原有调度行为。
- 分析已在进行中：不加入失败隔离，不改变现有“跳过并继续”的行为。
- 进程重启：失败集合随实例重建而清空。
- webhook 入口：不读取失败集合，不受 10 个上限约束。

### 非目标

- 不修改 `JobManager` 单槽、`waitForJobManagerIdle`、`WebhookAnalyzeQueue` 并发。
- 不修改 `docker-compose.yml` / `remote_deploy.sh` 的并发环境变量。
- 不做队列持久化、跨重启恢复、分析器内部成本优化。
- 不做存量 unowned 数据批量迁移。
- 不新增配置键或管理界面。

## 测试决策

- 测试 seam：巡检调度选择器模块的纯函数（最高且唯一的业务 seam）。不 mock 内部协作者，不验证私有实现。
- 覆盖用例：T01 排序、T02 截断、T03/B 分支判定、T04 失败过滤、T05 阈值下仍调度、T08 新实例清空；边界含并列值、0/负值、detached HEAD、空分支。
- 先例：`gitnexus/test/unit/webhook-analyze-queue.test.ts`、`gitnexus/test/unit/resource-aware-concurrency.test.ts` 的纯函数/组件级测试风格。
- 验证命令：`npm test -- stale-analyze-scheduler`（工作目录 `gitnexus/`）。
- 日志验收作为集成观察项，不写自动化断言；以单测行为为准。

## 范围之外

- 分析并发与资源感知并行的开启/调参。
- 索引分析器性能优化。
- unowned storage metadata 的批量修复。
- 巡检失败告警与可视化。
- `commitsBehind` 下降的量化目标（作为上线后观察项）。

## 补充说明

- 领域词表：仓库根未发现 `GLOSSARY.md` / `GLOSSARY-MAP.md`，本规格沿用澄清定稿中的术语定义。
- 二次开发改动面见 `docs/engineering/specs/index-scheduling-optimization-customization-points.md`。
