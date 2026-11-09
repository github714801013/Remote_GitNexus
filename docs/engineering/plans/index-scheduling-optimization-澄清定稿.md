# 索引落后与调度优化实现 — 澄清定稿

- 任务：`index-scheduling-optimization`
- 工作区/分支：`D:\workplace\typescript\GitNexus` · `xiexiongkun/source-customization-v1.6.13-rc.182`
- 澄清时间：2026-11-07
- 结论：用户已确认「全部按推荐」，以下为最终确认版。

## 1. 需求目标

在不改动分析并发模型的前提下，对「差异较大的仓库」做调度优化：

1. 同分支 `commitsBehind ≥ 100` 的仓库优先调度；
2. 跨分支假差异（registry 索引分支与当前 checkout 分支不一致）跳过并记录；
3. 分析失败仓库在进程内隔离，后续巡检不再重复入队；
4. 每轮巡检按差异降序最多调度 10 个仓库。

## 2. 范围

**做：**

- 巡检调度排序：按同分支 `commitsBehind` 降序。
- 每轮巡检限量：取前 10 个。
- 跨分支判定：`registry.branch` 与当前 checkout 分支不一致时跳过并记录。
- 失败隔离：巡检路径中分析失败的仓库进入进程内集合，下一轮跳过。
- 单测覆盖上述行为；日志可见调度顺序与跳过原因。

**不做：**

- 不改 `JobManager.createJob` 全局单槽。
- 不改 `enqueueWebhookAnalyze` 中的 `waitForJobManagerIdle`。
- 不改 `docker-compose.yml` / `remote_deploy.sh` 的并发相关环境变量
  （`GITNEXUS_NIGHTLY_PARALLEL_ENABLED=false`、结构/嵌入并发 1 保持现状）。
- 不做队列持久化、跨重启恢复、分析器内部成本优化。
- 不做存量 unowned 数据批量迁移（仅保留工作区已有的 `storagePath` 写回修复）。

## 3. 术语

- **分析槽（slot）**：`JobManager` 允许同时存在的分析任务数，当前固定为 1。
- **队列并发（queue concurrency）**：`WebhookAnalyzeQueue` 同时运行的任务数，由资源感知控制器决定。
- **stale 巡检**：每日 22:00 crontab 触发的 `POST /api/index-health-check`。
- **差异较大**：同分支 `commitsBehind ≥ 100` 的仓库。
- **跨分支假差异**：registry 记录的分支与 checkout 当前分支不一致导致的 `commitsBehind`。
- **失败隔离**：巡检路径中分析失败的仓库在进程生命周期内不再入队。

词表检查：仓库根无 `GLOSSARY.md` / `GLOSSARY-MAP.md`，未发现词表，不创建根词表。

## 4. 关键决策

| 编号 | 决策 | 结论 |
| --- | --- | --- |
| Q1 | 「差异较大」判定 | 同分支 `commitsBehind ≥ 100`；跨分支假差异单独识别并跳过 |
| Q2 | 优化目标 | 优先分析 + 失败隔离 + 跨分支跳过；不改分析器内部成本 |
| Q3 | 每轮调度数量 | 按落后数降序取前 10，不新增配置键 |
| Q4 | 并发边界 | 单槽、`waitForJobManagerIdle`、部署并发配置均不改 |
| Q5 | 验收 | 单测 + 巡检日志可见；`commitsBehind` 下降为观察项 |

## 5. 数据流向与变动

### 数据流

- 调度：crontab 22:00 → `POST /api/index-health-check` → 遍历 registry 条目 → `syncWithUpstream` → `checkStalenessAsync` → 分支一致性判定 → 差异降序排序 → 取前 10 → `enqueueWebhookAnalyze` → `WebhookAnalyzeQueue` → `JobManager`（单槽）。
- 失败：分析失败 → 记录失败仓库 → 进程内隔离集合 → 下一轮巡检跳过。
- 日志：巡检调度记录仓库名、`commitsBehind`、分支判定结果与跳过原因。

### 变动清单

- 巡检调度顺序：注册表遍历顺序 → 同分支 `commitsBehind` 降序。
- 每轮调度数量：不限（35–48） → 最多 10。
- 跨分支仓库：进入分析队列 → 跳过并记录原因。
- 失败仓库：每轮重复入队 → 进程内隔离，跳过。
- 接口出入参、环境变量、消息体、表结构、文件格式：均不变。

### SQL

本次无 DDL/DML。依据：仅调整内存调度顺序与日志，不读写业务数据库表；索引产物仍由既有 `run-analyze` 流程写入。

### 伪代码

```text
onIndexHealthCheck():
  entries = listRegisteredRepos()
  candidates = []
  failed = processScopedFailedRepos()
  for entry in entries:
    if failed.has(entry): continue
    staleness = checkStalenessAsync(entry.path, entry.lastCommit)
    if !staleness.isStale or staleness.commitsBehind <= 0: continue
    if checkoutBranch(entry.path) != indexBranch(entry): logSkip(); continue
    candidates.push({entry, commitsBehind: staleness.commitsBehind})
  sortDesc(candidates, by: commitsBehind)
  for candidate in candidates[0..min(10, len)): enqueueWebhookAnalyze(candidate.entry)
  onAnalysisFailure(entry): failed.add(entry)
```

## 6. 前端交互与显隐时机

非前端任务，省略。

## 7. 验收与数据基线

- 验收条件与必测场景：`docs/engineering/plans/index-scheduling-optimization-验收条件与必测场景清单.md`
- 测试数据基线：`docs/engineering/plans/index-scheduling-optimization-测试数据.md`
- 测试阶段逐条执行测试数据基线中的用例并回填结论，取值为通过、失败或不适用；原标未覆盖的用例先补齐数据再回填。

## 8. 待确认项

无。用户已明确确认全部推荐项。
