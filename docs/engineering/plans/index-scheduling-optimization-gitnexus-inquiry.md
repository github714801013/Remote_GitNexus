# 索引落后与调度优化实现 — GitNexus 调研记录

- 任务：`index-scheduling-optimization`（标准开发）
- 阶段：`gitnexus-inquiry`
- 工作区：`D:\workplace\typescript\GitNexus`，分支 `xiexiongkun/source-customization-v1.6.13-rc.182`
- 调研时间：2026-11-07
- 背景：上一咨询任务 `index-staleness-scheduling` 已确认问题与优化方向，本记录聚焦实现落点。

## 1. 查询范围与工具记录

- GitNexus MCP 主查询 `repo=GitNexus`：返回 `Repository is not available through this MCP server.`；
  `list_repos` 36 个仓库均无 GitNexus 源码仓 → 目标仓未索引，按规范受限本地检索，
  证据标记 `source=local_search`、`authority=non_gitnexus`。
- 本地 `gitnexus` MCP 连接失败（`CONNECTION_CLOSED`），无法使用本地图查询。
- `docs/engineering/specs/` 下无 `index-scheduling-optimization` 前缀 spec（已检查，继续）。
- GitHub 同类实现（`gh search code`）：
  - `"reindex queue"` → `tubearchivist/tubearchivist`（backend/task/tasks.py、backend/appsettings/src/reindex.py）、
    `ankane/searchkick`、`zhayujie/CowAgent`；实现体已在上一调研读取（Redis 队列 + 单任务锁）。
  - `"nightly parallel indexing queue"` → 0 条（已执行、未命中）。

## 2. 代码事实：已存在的并行机制

- `ResourceAwareConcurrencyController` 已实现夜间资源感知并行：
  - 默认窗口 22:00–09:00、并行并发 2、入口错峰 5 分钟、最低空闲内存比 0.4，
    `gitnexus/src/server/resource-aware-concurrency.ts:6-10`；
  - 配置项 `GITNEXUS_NIGHTLY_PARALLEL_ENABLED`、`GITNEXUS_NIGHTLY_PARALLEL_START_HOUR/END_HOUR`、
    `GITNEXUS_STRUCTURE_PARALLEL_CONCURRENCY`、`GITNEXUS_EMBEDDING_PARALLEL_CONCURRENCY`、
    `GITNEXUS_STRUCTURE_PARALLEL_FREE_MEMORY_RATIO`、`GITNEXUS_PARALLEL_ENTRY_STAGGER_MS`，
    `resource-aware-concurrency.ts:66-97`；
  - `getConcurrency(kind)` 在窗口内且内存充足时返回并行并发，`resource-aware-concurrency.ts:117-164`。
- 队列已按资源感知并发构造：
  - 结构队列 `new WebhookAnalyzeQueue(() => resourceController.getConcurrency('structure'), {startGate})`，
    `gitnexus/src/server/api.ts:1392-1401`；
  - embedding 修复队列 `new WebhookAnalyzeQueue(() => resourceController.getConcurrency('embedding'))`，
    `api.ts:1402-1404`。
- `WebhookAnalyzeQueue` 本身支持并发与同 key 去重：`webhook-analyze-queue.ts:60-121`。

## 3. 代码事实：并行被抵消的位置

- `JobManager` 仍是全局单槽：存在任意占用槽位的 job 时抛出
  `Analysis already in progress (job ...)`，`gitnexus/src/server/analyze-job.ts:6, 128-168`（单槽守卫 :148-153）。
- `enqueueWebhookAnalyze` 在任务体内先 `await waitForJobManagerIdle(jobManager)` 再创建 job，
  `gitnexus/src/server/api.ts:1465-1514`（:1488）；`waitForJobManagerIdle` 等待所有非终态 job 结束，
  `gitnexus/src/server/analyze-job-wait.ts:5-11`。
- 结构槽在 embeddings 进度 ≥90% 时释放（`releaseStructureSlot`），但 job 仍占用 JobManager 单槽，
  `api.ts:1493-1499`；因此队列即使并发为 2，第二个任务仍会阻塞在 `waitForJobManagerIdle`。
- 结论：夜间并行机制在代码层已具备，但被 JobManager 单槽与 `waitForJobManagerIdle` 串行化抵消。

## 4. 代码事实：远端部署配置关闭并行

- `mcp_proxy_docker/docker-compose.yml:183-188` 显式设置：
  `GITNEXUS_NIGHTLY_PARALLEL_ENABLED=false`、`GITNEXUS_STRUCTURE_PARALLEL_CONCURRENCY=1`、
  `GITNEXUS_EMBEDDING_PARALLEL_CONCURRENCY=1`、`GITNEXUS_PARALLEL_ENTRY_STAGGER_MS=60000`。
- `mcp_proxy_docker/remote_deploy.sh:101-103` 部署时同样以 1 为默认值写入环境。
- 远端日志（上一调研）：7 天内无 `[webhook] queue entered resource-aware parallel mode`，
  与 `GITNEXUS_NIGHTLY_PARALLEL_ENABLED=false` 一致。

## 5. 代码事实：巡检与失败面

- 每日 22:00 宿主机 crontab `POST /api/index-health-check`；入口 `api.ts:1927-1931`，
  巡检循环 `api.ts:1811-1913`（逐仓 `syncWithUpstream` → `checkStalenessAsync` → `enqueueWebhookAnalyze`）。
- `syncWithUpstream` 无条件 `git reset --hard <upstream>`，不校验索引分支，`git-staleness.ts:209-255`。
- MCP staleness 使用 `meta.lastCommit` 覆盖 registry：`local-backend.ts:2514-2517`。
- unowned storage metadata 会让 webhook/巡检分析在收尾校验阶段失败（上一调研日志 24 次）；
  当前工作区 `run-analyze.ts:3339` 的 `storagePath` 补写修改尚未提交、仅 oanew 已手工修复。
- 既有测试：`gitnexus/test/unit/webhook-analyze-queue.test.ts`、`analyze-job.test.ts`、
  `analyze-job-wait.test.ts`、`resource-aware-concurrency.test.ts`、
  `startup-embedding-schedule.test.ts`、`neo4j-embedding-repair.test.ts`。

## 6. 候选优化点（供 grill-with-docs 澄清，不代表已确认范围）

1. **放宽 JobManager 槽位**：允许不同仓库并行（同仓同分支仍去重），并把
   `waitForJobManagerIdle` 改为「等待可用槽位」或移除，使队列并发真正生效。
2. **开启夜间并行**：调整 `mcp_proxy_docker/docker-compose.yml` 与 `remote_deploy.sh` 默认值
   （`NIGHTLY_PARALLEL_ENABLED=true`、结构/嵌入并发 ≥2），并确认宿主机内存满足 0.4 空闲阈值。
3. **巡检入队治理**：巡检只入队不覆盖，按仓库变化量/等待时长排序；失败仓库（unowned）隔离，避免每轮重复入队。
4. **staleness 口径统一**：巡检前校验 registry.branch 与 checkout HEAD，跨分支索引单独标注，
   同步 registry.lastCommit 与 meta.lastCommit。
5. **存量归属修复**：一次性 force 重分析或迁移写回 `storagePath`，并让巡检失败可见。

## 7. 未确认项

- 远端宿主机与容器的内存/cgroup 限制，是否满足 `GITNEXUS_STRUCTURE_PARALLEL_FREE_MEMORY_RATIO=0.4`。
- Neo4j 多仓库并发写入的容量与锁行为。
- 多槽改造对现有 `JobManager` 事件、SSE 进度、取消/重试语义的影响范围。
- 巡检排序所需的「变化量」数据是否可从 meta/registry 直接获得。
