# 索引落后巡检修复（index-health-staleness-fix）— GitNexus 调研记录

- 任务：`index-health-staleness-fix`（Bug 修复：索引落后调度缺陷）
- 阶段：`gitnexus-inquiry`（只读调研，不修改任何源代码/测试/配置）
- 工作区：`D:\workplace\typescript\GitNexus`，分支 `xiexiongkun/source-customization-v1.6.13-rc.182`，HEAD `fe7f6a28`
- 调研时间：2026-11-08
- 前序调研：`docs/engineering/plans/index-staleness-scheduling-gitnexus-inquiry.md`（2026-11-07，本记录与其差异处行号以本次为准，代码已因 `fe7f6a28` reconcile 提交变动）

## 1. 查询范围与主查询记录

按时间顺序：

1. `mcp__remote_gitnexus__list_repos` → 返回 36 个仓库（hasMore=false），全部为业务仓（oanew、nc-segments、orginfo 等），**不含 GitNexus 源码仓库本身**。负结果类别：目标仓未索引。
2. 主查询（第一次，`repo` 传空串）：`query({repo:"", search_query:"在所有已索引仓库中，围绕'索引落后巡检 / stale index analyze / index health check / worktree branch mismatch / 失败隔离'定位入口、调度实现、分支判定、失败重试与调用链", goal:"定位索引落后巡检的入口、调度实现、分支判定、失败重试与调用链", task_context:"修复 GitNexus 索引落后调度缺陷…"})`
   → `Error: Repository is not available through this MCP server.`（空串不是合法的跨仓库聚合取值）。
3. 主查询（第二次，省略 `repo` 参数，查询词不变）→ **超时**（36 仓跨仓库聚合，工具未返回）。负结果类别：工具错误/超时。
4. 按规范降级为受限本地检索（Grep/Read，范围仅工作区）。本记录所有代码事实标记 `source=local_search, authority=non_gitnexus`。
5. GitHub 检索：`gh search code`（查询词均为通用技术词，不含内部项目名/地址/凭据），见 §4。

## 2. 代码事实（当前 workspace，均 source=local_search）

### 2.1 `runIndexHealthCheck` 定义与调用点

- 定义：`gitnexus/src/server/api.ts:1781-1975`，签名 `runIndexHealthCheck(source: 'startup' | 'manual')`。
- 防重入：`let indexHealthCheckRunning = false`（api.ts:1777）；入口处 `if (indexHealthCheckRunning) return { skipped: true }`（:1784-1785），`finally` 复位（:1972-1973）。
- 全部调用点仅两处：
  - 启动时一次性：`void runIndexHealthCheck('startup')`（api.ts:1982-1984）；
  - 手动触发：`app.post('/api/index-health-check')` → `void runIndexHealthCheck('manual')`，立即返回 202 `{ok:true, accepted:true}`（api.ts:1986-1991）。
- api.ts 内其余 `setInterval`（:2120、:3635、:3636）均为 SSE keepalive，与巡检无关。**进程内无任何周期性巡检定时器**（Grep `setInterval|cron|scheduleInterval` 于 src 全量核实）→ 确认诊断 1。

### 2.2 worktree 分支误判链（确认诊断 2，且为结构性必然）

- `/webhook/:env/index`（api.ts:2889-2930）处理 env webhook 时：
  - worktree checkout 分支 = `registryName`（`<env>-<project>`，如 `dev-nc-segments`），api.ts:2909-2915（`branch: registryName`）；
  - 配置文件 `repos.<env>.json` 写入的是 **源分支** `sourceBranch`（如 `dev`），api.ts:2903-2907；
  - 注册分析的 `registryBranch` 也是 `sourceBranch`（api.ts:2929）。
- `loadWebhookInspectionTargets`（api.ts:342-396）：env 配置项的 `target.branch` 取配置的 `entry.branch`（=源分支，:368），`repoPath` 取 worktree 路径 `getManagedWorktreePath(...)`（:376-378；webhook-worktree.ts:57-63 = `<dirname>/<env>-<project>`）。
- 巡检内 `webhookBranchByPath = Map(worktree路径 → 源分支)`（api.ts:1789-1792）；
  `registryBranch = webhookBranchByPath.get(path.resolve(entry.path)) ?? entry.branch`（api.ts:1837）——**webhook 映射优先于注册表 `entry.branch`**（后者对 worktree 恰为 `dev-<name>`，与 checkout 一致，本可匹配）。
- `isKnownBranchMismatch(currentBranch, indexBranch)`（stale-analyze-scheduler.ts:10-13）：`Boolean(indexBranch) && currentBranch !== indexBranch`。对每个 env worktree：`currentBranch="dev-<name>"` vs `registryBranch="<source>"` → **恒为 true**，api.ts:1900-1910 记录 `Stale index analyze skipped: branch mismatch` 并 `continue`，永不进入候选列表。dev-oanew/dev-nc-segments/dev-orginfo 等 worktree 落后因此无法被巡检修复。

### 2.3 `staleAnalyzeFailedRepoPaths` 生命周期（确认诊断 3）

- 声明：`const staleAnalyzeFailedRepoPaths = new Set<string>()`（api.ts:1779），注释自述"本进程内不再入队，重启后自然清空"（:1778）。
- 唯一写入点：分析 `queued.done` 失败回调 `add(entry.path)`（api.ts:1966；`isAnalysisAlreadyInProgressError` 除外，:1959-1964）。
- 读取点：候选过滤（`selectStaleAnalyzeCandidates`，stale-analyze-scheduler.ts:22）与跳过日志（api.ts:1932-1939）。
- **全 src 无 `delete`/`clear` 调用**（Grep `staleAnalyzeFailedRepoPaths\.(delete|clear)` → 0 命中）→ 进程级永久隔离，仅重启清空。

### 2.4 `selectStaleAnalyzeCandidates` / `STALE_ANALYZE_MAX_PER_ROUND`（确认诊断 4）

- `STALE_ANALYZE_MAX_PER_ROUND = 10`：stale-analyze-scheduler.ts:2；作为 `selectStaleAnalyzeCandidates` 默认 limit（:19）。
- 定义：过滤 `commitsBehind > 0 && !failed`，按落后数降序稳定排序取前 limit（:16-24）。
- 调用点：api.ts:1941-1944（不传 limit → 恒 10）。
- 实际"串行"来源（非本函数）：候选循环逐个 `enqueueWebhookAnalyze`（api.ts:1950-1957）；队列 `webhookAnalyzeQueue` 并发度由 `ResourceAwareConcurrencyController.getConcurrency('structure')` 决定，基础并发默认 **1**（resource-aware-concurrency.ts:69-72，`GITNEXUS_WEBHOOK_ANALYZE_CONCURRENCY || INDEXING_CONCURRENCY`，fallback 1），仅夜间窗口（默认 22:00-09:00）且空闲内存比 ≥0.4 时升到 2（:6-9、:117-142）。此外任务体内 `await waitForJobManagerIdle(jobManager)`（api.ts:1498）与 JobManager 全局单槽使跨仓分析事实上串行。

### 2.5 巡检主循环其余事实

- 每仓顺序：`syncWithUpstream(entry.path)` → 不一致则 `checkStalenessAsync(entry.path, entry.lastCommit)`；`remoteSync.reset` 时直接记 `commitsBehind: 1`（api.ts:1848-1862）。
- 入队条件 `shouldScheduleStartupIncrementalAnalyze`：`staleness.isStale && commitsBehind > 0`（api.ts:307-309）。
- `syncWithUpstream`（core/git-staleness.ts:209-255）：解析 `@{upstream}` → `ls-remote` 比对 → 不一致时 **无条件 `git fetch --prune` + `git reset --hard <upstream>`**（:238-239），不校验 checkout 分支与索引分支关系，不执行 `clean`（注释 :205-208）。对 worktree（分支 `dev-<name>` 的 upstream 通常指向 `origin/<sourceBranch>`）会把 worktree 硬重置到源分支最新提交——工作树内本地提交/暂存会被丢弃（无本地改动时无感）；这是 reset --hard 风险点，`ensureLocalWorktree` 的同类重置会先 `preserveGitNexusMetadata`（webhook-worktree.ts:299-312），而 `syncWithUpstream` 不做该保护（`.gitnexus` 为未跟踪目录，reset --hard 不删除，实测语义从代码推断）。
- `reconcileMissingWebhookTargets` 仅在 `shouldReconcileMissingWebhookTargets(source, …)` 时执行（api.ts:1794-1802；webhook-repo-reconciler.ts:40-46），即 `fe7f6a28` 新增的"缺失 webhook 仓补齐"，同样只在 startup/manual 触发下运行。
- `GITNEXUS_STARTUP_WEBHOOK_REPOS_ENABLED` 默认 false（api.ts:438-439）。

### 2.6 远端 commitsBehind 披露（remote_gitnexus list_repos 快照）

`list_repos` 返回的 staleness（各仓 indexedAt 2026-10-30~11-07 时点，非实时）：
dev-oanew **352**、dev-nc-segments **125**、dev-orginfo **118**、nc-segments **102**；另观察到更严重者：oa-stock **6847**、oa-order **3593**、saasoanew **5383**、oa-finance **1031**（均 `status: behind`）。
风险提示：结论基于该索引版本快照；`oanew`、`dev-logistics`、`dev-oa-pay`、`huishou`(19)、`dev-autoTransfer`(19) 等条目 staleness 字段缺失或为 unknown，不能据此断言其不落后。

## 3. 项目仓库同类型实现（可复用模式）

| 模块 | 位置 | 实现方式 | 适用边界 |
|---|---|---|---|
| auto-sync 周期循环 | `gitnexus/src/core/auto-sync/starter.ts:74-245` | `setIntervalFn(runSafely, syncIntervalMinutes*60_000)`（:240），重入时合并为一次 follow-up（:153-159），可注入 `setIntervalFn/runOnce`，PID 锁 + 状态文件（:64-105） | 独立 watch 进程模式；server 进程内复用需只取其"防重叠 + 注入间隔"骨架 |
| WAL checkpoint 驱动 | `gitnexus/src/core/lbug/wal-checkpoint-driver.ts:207-241` | 进程内 `setInterval` + 重入 guard + `unref()` | server 进程内周期任务的最贴近先例 |
| 夜间资源感知并发 | `gitnexus/src/server/resource-aware-concurrency.ts:66-165` | 时间窗 22-9 点、空闲内存比阈值、基础/并行并发分离 | 提高单轮 analyze 吞吐时直接可用（现默认已开启） |
| Webhook 队列去重 | `gitnexus/src/server/webhook-analyze-queue.ts:60` | 按 resolved 路径 key 去重/替换 | 周期巡检重复入队时防重 |
| 缺失仓 reconcile | `gitnexus/src/server/webhook-repo-reconciler.ts:40-46` | 纯函数判定 + 注入 `pathExists/enqueue/logger` | 与巡检 source 绑定的补偿模式先例 |
| 纯函数调度核 | `gitnexus/src/server/stale-analyze-scheduler.ts` | 全部导出为可注入纯函数（limit 参数、failed 集合参数化） | 修复点应继续放此处便于单测 |

测试覆盖：

- `gitnexus/test/unit/stale-analyze-scheduler.test.ts`：排序/截取 10、等值稳定序、失败集合过滤、`isKnownBranchMismatch` 三态（:59-73）。**无 worktree 命名分支（`dev-<name>` vs 源分支）用例**。
- `gitnexus/test/unit/api-index-health-check-async.test.ts`：对 api.ts 源码文本的契约测试（202 异步、reconcile 接线），非行为测试。
- `gitnexus/test/unit/api-readonly-wiring.test.ts`、`api-query-readonly-wiring.test.ts`：路由接线契约。
- `gitnexus/test/unit/auto-sync*.test.ts`：周期循环行为测试可参考。

## 4. GitHub 参考实现（source=github_search, authority=external_reference）

命令与结果（均 `gh search code`，账号已认证）：

1. `"stale index scheduling commits behind retry failed repos"` → 0 命中（负结果：长词组 AND 语义下 GitHub 代码搜索几乎不命中）。
2. `"periodic background health check interval node"` → 0 命中（同上）。
3. `"runIndexHealthCheck"` → 命中 **Helweg/open-codebase-index**：`src/tools/operations.ts:808`（已读取 :800-880）——同名函数是 MCP 工具的单次调用 handler（busy 错误转 `IndexBusyResult`），**无周期调度、无失败隔离**，与本任务问题域重合度低；另命中 `mindstone/rebel-app:src/main/services/cloudLocusProbeService.ts`（提及 "kill-on-hang" 超时模式，未读取实现）。
4. `"background scheduler retry failed repos cooldown"`、`"auto-sync interval reindex stale repositories"`、`"stale analyze max per round"` → 均 0 命中。

未覆盖范围：GitHub 代码搜索仅覆盖公共索引用仓库，对"周期巡检 + 失败退避"这类通用模式本次未获得外部实现样本；前序调研（§index-staleness-scheduling-gitnexus-inquiry §1）已有 tubearchivist/searchkick 命中，可复用其结论，本次未重复检索。

## 5. 未确认项 / 风险

1. **worktree upstream 指向**（推断非实证）：`git worktree add -b dev-<name> <path> origin/<source>` 是否设置 upstream 依 git 版本/配置而定，未实测；影响 `syncWithUpstream` 对 worktree 是 reset 到源分支还是 `checked:false` 跳过。实施前应在 10.1.14.158 上 `git -C /projects/oa-java/dev-nc-segments rev-parse --abbrev-ref @{upstream}` 实证。
2. `checkStalenessAsync` 用 `lastCommit...HEAD` 计数：worktree 被 reset 到 origin/dev 后 HEAD 前进即计入 commitsBehind，落后数语义为"checkout 树 vs 索引提交"，非"索引 vs 远端分支"，与 list_repos 展示口径一致但需在修复验收时说明。
3. remote_gitnexus 未索引 GitNexus 源码仓（负结果类别：未索引），且本次主查询超时（工具错误）→ 全程无图查询证据，符号调用关系以行号级 local_search 为准。
4. 修复触及面提示：`runIndexHealthCheck` 的行为测试是源码文本契约（api-index-health-check-async.test.ts），改动该函数体大概率需同步更新该测试断言。
5. `webhookBranchByPath` 优先覆盖 `entry.branch`（api.ts:1837）是误判的直接开关；修改该优先级（如 worktree 路径改用 `registryName` 或 checkout 实分支）对 `/webhook/gitea` 主仓路径（registryBranch=源分支且 checkout 即源分支）无影响，但需回归 2.2 两处写入方（:2906/:2929）。
6. 未检索 10.1.14.158 宿主机 crontab 现状（前序记录为 22:00 每日 POST）；若已有外部 cron 周期触发，"仅启动执行"结论范围限于进程内。
