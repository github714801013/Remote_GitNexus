# GitNexus 索引落后与调度优化 — GitNexus 调研记录

- 任务：`index-staleness-scheduling`（业务咨询：深度分析索引落后与调度优化）
- 阶段：`gitnexus-inquiry`
- 工作区：`D:\workplace\typescript\GitNexus`，分支 `xiexiongkun/source-customization-v1.6.13-rc.182`
- 调研时间：2026-11-07
- 结论性质：本记录为调研结论，不实现优化。

## 1. 查询范围与工具记录

- GitNexus MCP 主查询：`query({repo:"GitNexus", search_query:"索引落后与调度优化……"})` 返回
  `Error: Repository is not available through this MCP server.`。按规范先确认索引范围。
- `list_repos` 返回 36 个远端仓库，均为业务项目，无 GitNexus 源码仓库 → 目标仓未索引。
- 本地 `gitnexus` MCP 连接失败（`CONNECTION_CLOSED`），无法使用本地图查询。
- 因此按 `gitnexus-local-fallback.md` 在当前 workspace 执行受限本地检索；
  本地证据标记 `source=local_search`、`authority=non_gitnexus`，只支持当前 workspace 的局部事实。
- Loki 日志：dev 中心（10.1.250.160）`labels ServiceName` 无 `gitnexus` 服务；
  jiuji 中心（192.168.254.53）同样无 `gitnexus` → Loki 未命中（已执行、无结果，不能据此断言无日志）。
  替代日志证据来自 10.1.14.158 宿主机 `docker logs gitnexus-mcp-proxy`（只读，近 7 天）。
- GitHub 同类实现检索（`gh search code`，不含内部信息）：
  - `"stale index reindex queue scheduler" --language TypeScript` → 0 条；
  - `"embedding repair cooldown retry"` → 0 条；
  - `"reindex queue"` → 命中 `tubearchivist/tubearchivist`（backend/task/tasks.py、backend/appsettings/src/reindex.py）、
    `ankane/searchkick`、`zhayujie/CowAgent`；已读取 tubearchivist 两处实现。
  - `gh search repos "code graph index"` → 命中 `Fanaperana/adaptive-codegraph`、
    `isitraghav/codebase-graph-indexing-using-neo4j` 等，仅作参考未读取实现体。

## 2. 代码事实（当前项目）

### 2.1 巡检与调度入口

- 每日巡检由宿主机 crontab 触发（10.1.14.158）：
  `0 22 * * * curl -X POST http://127.0.0.1:1347/api/index-health-check`；
  `0 23 * * * curl -X POST http://127.0.0.1:1347/api/embed`。
- `POST /api/index-health-check` → `runIndexHealthCheck('manual')`，`gitnexus/src/server/api.ts:1927-1931`。
- 巡检对每个注册仓库依次执行：
  `syncWithUpstream(entry.path)` → `checkStalenessAsync(entry.path, entry.lastCommit)` →
  `shouldScheduleStartupIncrementalAnalyze(staleness)` → `enqueueWebhookAnalyze(...)`，
  `gitnexus/src/server/api.ts:1811-1913`；条件为 `staleness.isStale && commitsBehind > 0`（api.ts:297-299）。
- `syncWithUpstream` 在本地 HEAD 与 upstream 不一致时无条件 `git fetch --prune` + `git reset --hard <upstream>`，
  不校验当前 checkout 分支是否等于索引分支，`gitnexus/src/core/git-staleness.ts:209-255`。

### 2.2 分析队列与单槽

- `WebhookAnalyzeQueue` 默认 `concurrency = 1`，同 key 入队去重/替换，
  `gitnexus/src/server/webhook-analyze-queue.ts:60-99`（并发默认值 :69，去重 :86-94）。
- `enqueueWebhookAnalyze` 在任务体内 `await waitForJobManagerIdle(jobManager)`，
  即等待当前所有非终态 job 结束才启动下一个，`gitnexus/src/server/api.ts:1465-1514`（等待 :1488）。
- `waitForJobManagerIdle` 轮询所有 job，直到无 `queued/analyzing` 状态，
  `gitnexus/src/server/analyze-job-wait.ts:5-11`。
- `JobManager.createJob` 全局单槽：存在任意占用槽位的 job 时抛
  `Analysis already in progress (job ...)`，`gitnexus/src/server/analyze-job.ts:128-168`。
- 结构槽在 embeddings 进度 ≥90% 时释放（`releaseStructureSlot`），但 job 仍在 jobManager 中占用单槽，
  `gitnexus/src/server/api.ts:1493-1499`；因此下一仓库仍会阻塞在 `waitForJobManagerIdle`。

### 2.3 embedding repair

- repo 级冷却默认 5 分钟、批大小 8：`DEFAULT_EMBEDDING_REPAIR_REPO_COOLDOWN_MS = 5 * 60_000`，
  `gitnexus/src/server/search.ts:349-352`；冷却读写 :399-416。
- 系统性失败判定（request failed/timed out/circuit open/fetch failed/network/ECONN/ENOTFOUND/EAI_AGAIN），
  `gitnexus/src/server/search.ts:418-423`；系统性失败后整体延迟 :485。
- repair 协调器每 repo 最多 3 次尝试，退避 1s/2s，`gitnexus/src/server/embedding-repair-coordinator.ts:39-40, 89-104`。
- 启动巡检中 embedding repair 与 stale analyze 是两条独立路径：
  Neo4j 下 `startEmbeddingRepairForEntry`（api.ts:1890-1896），分析后再由 `onAnalysisFinalized`
  触发 finalization repair（api.ts:1675-1679）。
- 手动入口 `POST /api/embed` 同步持有 repo 锁并创建 embed job，30 分钟超时，
  `gitnexus/src/server/api.ts:3155-3231`。

### 2.4 staleness 与账实口径

- MCP 结果中的 `staleness` 使用 `meta.lastCommit` 覆盖 registry 的 `lastCommit`：
  `repo.lastCommit = meta.lastCommit ?? repo.lastCommit`，`gitnexus/src/mcp/local/local-backend.ts:2514-2517`。
- `checkStalenessAsync` 用 `git rev-list --left-right --count <lastCommit>...HEAD`，
  `gitnexus/src/core/git-staleness.ts:170-203`；HEAD 与索引 commit 分叉时返回 `diverged`（:91-109），
  回退场景有独立提示（:37-43）。

### 2.5 storage 归属错误

- webhook 分析失败日志中的错误：
  `Storage path is in state "unowned" but requires one of: missing, empty, owned. External storage metadata does not bind the index to this storage directory.`
  说明存量 `gitnexus.json` 未写 `storagePath` 时，分析在启动/收尾校验阶段被拒绝，重试无法自愈。
- 当前工作区未提交修改 `gitnexus/src/core/run-analyze.ts:3339` 已为 Neo4j 成功路径补写 `storagePath`；
  该修改尚未提交、尚未对存量仓库全量生效（仅 oanew 已手工 force 重分析修复）。

## 3. 远端日志证据（10.1.14.158，近 7 天）

- 日志总量 715,181 行；其中 `Analyze worker progress` 714,617 行。
- `Stale index analyze scheduled` 193 条，按小时分布：
  - 11-04 04 时 35 条、05 时 34 条（服务两次启动，04:16、05:07）；
  - 11-04 22 时 35 条、11-05 22 时 41 条、11-06 22 时 48 条（每日 crontab 巡检）。
- `Analyze worker started` 126 次；重复最多的仓库：oanew 14、node-ai 13、web-e2e-platform 13、nc-segments 9、small-oa 8。
- 任务耗时（进度首末估算，非精确完成时间）：
  jiuyun-moa 516 分钟、web-e2e-platform 332/299 分钟、pick-goods-platform 248/218 分钟、
  node-ai 242/242/165/123/113 分钟、jiuji-m 149 分钟、oa-salary 136 分钟。
- `Neo4j embedding repair deferred after systemic embedding endpoint failure` 15 次（11-06 00:54 至 11-07 10:04）；
  `embedding repair deferred: embedding endpoint failures cooling repo down` 5 次。
- `gitea webhook analyze failed` 24 次，集中为 nc-segments、huishou 等，错误均为上节 unowned storage metadata。
- `Skipping registry entry ... storage is not a usable owned code index` 6 次，均在 11-04 04:16-04:17 启动时。
- `index project reset to remote upstream; scheduling reanalysis` 64 次（每次巡检/启动对不一致 checkout 强制 reset）。
- 容器 `gitnexus-mcp-proxy` 7 天内仅 2 次启动（11-04 04:16、05:07），当前 Up 3 天。

## 4. 推断（非代码事实）

1. 每日 22:00 一次巡检把 35-48 个 stale 仓库全部入队，但队列并发 1 + jobManager 单槽 + 单任务 2-8 小时，
   实际每天只能消化少数仓库；次日巡检再次全量入队，形成持续积压与重复调度。
2. node-ai、web-e2e-platform 等大仓库反复出现在 `Analyze worker started`，与其长期停在 embeddings 90-96% 相互印证，
   说明 embedding 阶段是主要耗时与失败源，进一步放大单槽阻塞。
3. `syncWithUpstream` 的 `reset --hard` 与索引分支口径不一致时，staleness 比较的 HEAD 可能来自另一条分支，
   产生数千提交的「落后」表象（远端 `list_repos` 中 oa-order 3593、oa-stock 6847、saasoanew 5383）。
4. 存量 unowned meta 的仓库（nc-segments、huishou 等）在 webhook/巡检分析启动后失败，
   现有重试不会修复 meta 归属，需一次性重新分析或迁移写入 `storagePath`。

## 5. 未确认项

- 每日 22:00 巡检之外是否还有 Webhook/Gitea push 触发的高频分析（日志有 24 次 webhook 失败，但未统计成功 webhook 频率）。
- 远端各仓库 registry.branch 与实际 checkout 分支的逐仓对应关系未逐一核对，跨分支假象的数量未精确统计。
- embedding 端点（EMBEDDING_*）的容量、超时与限流配置未在本节点核实。
- `list_repos` 的 `commitsBehind` 为 MCP 侧计算值，未与 meta.indexedAt 逐一交叉验证。

## 6. 优化方向（咨询结论，不实现）

1. **队列持久化与巡检解耦**：巡检只做「标记 stale + 入队」，队列按仓库持久化并按变化量/等待时长排序；
   同 key 合并保留最新请求，避免次日巡检覆盖或重复入队。
2. **提高有效并发或分离阶段**：在 CPU/内存允许时把结构分析与 embedding 分为两个执行槽；
   结构槽释放后允许下一仓库进入结构阶段，同时限制 embedding 并发，避免单槽被长 embedding 独占。
3. **巡检与 embedding repair 错峰**：22:00 巡检与 23:00 `/api/embed` 分时；同一仓库的 repair 与 analyze 互斥已由 repo 锁保证，
   但队列层仍可避免同一仓库同轮重复请求。
4. **修复存量归属数据**：对 unowned 仓库执行一次性 force 重分析（写回 storagePath），
   并让巡检把失败原因汇总到可查询的巡检结果，而不是只写日志。
5. **统一 staleness 口径**：巡检前校验 registry.branch 与 checkout HEAD；
   跨分支索引单独标注或不与当前 HEAD 直接比较；同步更新 registry.lastCommit 与 meta.lastCommit，避免 MCP 与巡检口径不一致。
6. **失败可见性**：把 `Stale index refresh failed`、`webhook analyze failed`、embedding 冷却按仓库聚合为巡检报告指标，
   便于判断「落后」是调度饥饿、归属错误还是 embedding 故障。
