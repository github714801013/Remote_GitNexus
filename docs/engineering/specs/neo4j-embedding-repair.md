# Neo4j Embedding Repair 规格

## 1. 背景与问题定义

当前 Neo4j embedding repair 被结构分析、固定冷却时间和仓库级锁耦合：已有 Neo4j 图、metadata 与 registry 的仓库即使仅缺失或过期 embedding，也可能被结构分析队列阻塞；多个触发源没有统一的按仓库去重与 retry round 语义；健康检查和日志也无法完整呈现 repair 生命周期。

本规格只定义行为、状态、接口契约和验收标准，不修改 canonical YAML，也不负责后续编排。

## 2. 现有实现范围

| 模块 | 当前职责 | 规格约束 |
| --- | --- | --- |
| `gitnexus/src/server/search.ts` | `runNeo4jEmbeddingRepair`；hash 比较、批量生成/upsert、失败批次二分 | 复用 repair 逻辑，不再以固定 cooldown 隐藏调度状态 |
| `gitnexus/src/server/api.ts` | 启动检查、`POST /api/index-health-check`、状态更新 | 统一触发源、按仓库去重、retry round 和 API 输出 |
| `gitnexus/src/core/run-analyze.ts` | 结构分析及 finalization | finalization 独立触发 repair，不等待 repair 完成 |
| `gitnexus/src/server/webhook-analyze-queue.ts` | 队列去重、并发槽位与启动节流 | 可作队列基础，但 repair key 必须是 canonical repo identity |
| `gitnexus/src/server/resource-aware-concurrency.ts` | `structure` / `embedding` 资源上限 | repair 必须使用 `getConcurrency('embedding')` |
| `gitnexus/src/core/embeddings/embedding-pipeline.ts` | content hash 语义 | repair 必须沿用相同的 stale 判定 |
| `gitnexus/src/core/neo4j/embedding-adapter.ts` | embedding 的 Neo4j 读写边界 | repair 不复制 Cypher 状态逻辑 |

## 3. 目标行为

### 3.1 Repair 条件

当 registry 可解析仓库、metadata 或 Neo4j 图证明已有可 repair 结构数据，且至少一个可向量化节点缺失 embedding、content hash 过期或缺少必要 summary text 时，系统应标记为需要 repair。

repair 不要求重新运行结构分析，也不等待结构任务完成。图、registry、路径或 Neo4j 不可用，或节点数量为零时，必须记录明确 skip reason，而非伪造成功。

### 3.2 三个独立触发源

下列触发均调用同一个 per-repo 调度入口并携带结构化 source：

- `startup`：服务启动检查时为需要 repair 的仓库开启新 retry round；
- `manual`：`POST /api/index-health-check` 检查到需要 repair 时开启新 retry round；
- `finalization`：结构图已提交后的 finalization 检查到缺失/过期向量时独立提交 repair。

可保留 `scheduled` 内部 source，但必须使用同一套去重、round 与状态逻辑。source 只影响调度元数据和 round 行为，不得复制 repair 实现。

### 3.3 优先级、生命周期与并发

- repair 是独立于结构分析的 embedding 任务类型，使用独立生命周期和队列；
- finalization 在 repair `queued`、`running`、`retry_wait`、成功或失败时均可完成；其成功只表示结构和图已完成；
- 同仓库结构重建和 repair 允许并发；不得用会覆盖整个生命周期的 repo lock 串行化二者；
- repair 优先于非必要 embedding 工作，但不得突破 embedding 并发上限，也不抢占不可中断批次；
- 每个 canonical repo identity 任意时刻最多一个 active repair；重复触发合并为 pending/coalesced trigger，保留需要再次检查的事实与最新 source/time；
- 不同仓库可并行，实际并发受 `resourceController.getConcurrency('embedding')` 限制。

## 4. Retry round 与退避

一个 retry round 最多运行三次 attempt，编号为 1 至 3。可重试 Neo4j、embedding endpoint 与基础设施错误进入下一 attempt；单节点错误继续沿用现有批次二分和跳过能力。第三次仍失败即标记 `failed`，同一 round 不得再自动尝试。

`startup`、`manual` 及允许开启新轮的 `scheduled` 在失败 round 已结束且没有 active task 时创建递增的新 round，并将 attempt 重置为 1。`finalization` 默认合并到 active/pending round；无 active round 时创建新 round。retry wait 期间的重复触发只合并/唤醒，不创建重复 round。

退避使用可注入时钟的确定性策略：

```text
backoff(attempt) = min(maxDelay, initialDelay * 2^(attempt - 1))
```

`initialDelay`、`maxDelay` 与可选 jitter 必须为命名配置；日志和健康检查必须给出实际 `nextRetryAt`。旧 fixed cooldown 若保留，只能映射为带 round、attempt、错误原因的 `nextRetryAt`，不能作为唯一状态模型。

## 5. 状态与 metadata/registry 契约

每个仓库维护可查询状态，至少保留以下语义：

```ts
interface EmbeddingRepairStatus {
  repoId: string;
  state: 'idle' | 'queued' | 'running' | 'retry_wait' | 'complete' | 'failed' | 'skipped';
  round: number;
  attempt: number;
  maxAttempts: 3;
  source: 'startup' | 'manual' | 'finalization' | 'scheduled';
  queuedAt?: string;
  startedAt?: string;
  completedAt?: string;
  nextRetryAt?: string;
  lastError?: string;
  skipReason?: string;
  embeddingCount?: number;
}
```

字段名可以适配既有类型，语义不可缺失。时间采用 ISO 8601 UTC；错误不得含凭据或完整敏感请求。

`embeddingStatus = running` 必须对应 active repair 状态；`complete` 必须记录本轮真实完成；`failed` 必须保留 round、attempt、source 与 lastError；`skipped` 绝不可写成 `complete`。状态更新应先落 queued/running，再落 complete/failed；metadata 更新失败不得掩盖 repair 的真实结果，必须单独记录 `metadata_update_failed`。

## 6. Health-check API 契约

`POST /api/index-health-check` 的 HTTP 成功仅表示检查已接收/执行，不表示异步 repair 已完成。每仓库摘要至少包括：

- `repoId`、`source`、`needsRepair`；
- `status`：`queued`、`deduplicated`、`running`、`retry_wait`、`complete`、`failed` 或 `skipped`；
- `skipReason` 或 dedup reason；
- `round`、`attempt`、`maxAttempts`；
- 适用时的 `nextRetryAt`、最后错误或完成时间。

当全局 health-check 已运行时可返回 `202`，但必须含 `skipReason = health_check_in_progress` 及已知 repair 状态，不得返回空结果。现有 `ok`、`skipped` 语义必须保持兼容。

## 7. 日志与可观测性

每次状态转换使用结构化日志，至少含 `repoId`、`source`、`round`、`attempt`、`maxAttempts`、状态/事件、重试时的 `nextRetryAt` 或 `retryAfterMs`、跳过/去重/失败的 `reason` 或安全错误信息，以及可用的 `embeddingCount`、`nodesProcessed`、`nodesEmbedded`、`nodesSkipped`。

必须记录：触发接受、去重/合并、条件跳过、attempt 开始、attempt 完成、失败和下一次重试、三次耗尽、最终完成、metadata/registry 更新失败。健康检查与日志应能通过 `repoId + round` 关联同一生命周期。

## 8. 并发与一致性

repair 队列必须使用 `resourceController.getConcurrency('embedding')` 和既有资源感知启动节流；结构队列仍使用 `structure` 并发，二者不得共享会相互阻塞的计数器。

repair 与 graph load 并发时，batch 必须处理一致的节点/hash 快照，或检测图版本变化后重新检查，将未覆盖节点留给下一触发；旧 embedding 不得错误标记 complete。embedding 删除、upsert 与 vector index 操作必须保持 repo scope 和幂等，不得污染其他仓库。finalization 仅在 graph load 已提交后触发 repair，但不等待其结束。

## 9. 错误分类与恢复

| 场景 | 处理 | 可见结果 |
| --- | --- | --- |
| registry 无仓库 | 不入队 | `skipped` / `registry_not_found` |
| 图或可向量化节点不存在 | 不入队或空 repair | 明确 skip reason，不得声称已有 embedding |
| 同仓库 active task | 合并触发 | `deduplicated`，保留 active round |
| Neo4j/endpoint 临时错误 | 指数退避，最多三次 | attempt 与 `nextRetryAt`，最终 `failed` |
| 单节点持续失败 | 跳过该节点并继续；全失败则 round 失败 | 不能误报 complete |
| metadata 更新失败 | 不改变 repair 真实状态 | `metadata_update_failed` 日志/告警 |
| 服务重启时 running/retry_wait | 根据 task、时间和 Neo4j hash 恢复 | 不得永久卡在 running |

## 10. 验收标准

1. **AC-1**：已有 Neo4j 图、metadata、registry 且 embedding 缺失/过期时，startup 或 health-check 直接进入 embedding 队列，不等待结构任务或结构队列空闲。
2. **AC-2**：startup、manual health-check、finalization 对同仓库均复用同一调度入口，使用相同判定、去重与状态更新逻辑。
3. **AC-3**：finalization 在 repair queued/running/retry_wait 时仍可完成，不同步等待 repair。
4. **AC-4**：同仓库结构任务与 repair 不因 shared repo lock 互相阻塞，各自遵从自己的资源上限。
5. **AC-5**：连续重复触发最多产生一个 active repair，额外请求被合并；不同仓库不互相去重。
6. **AC-6**：连续基础设施失败仅运行三次 attempt，间隔为指数退避，`nextRetryAt` 对日志和 API 可见；第三次后本轮停止。
7. **AC-7**：失败 round 后 startup/manual 创建递增的新 round、attempt 重置为 1；retry_wait 内重复触发不重复建 round。
8. **AC-8**：成功、失败与跳过在 metadata/registry、日志、health-check 间状态一致；metadata 写失败可见。
9. **AC-9**：repair 并发不超过 `getConcurrency('embedding')`，不改变 structure 并发。
10. **AC-10**：缺失、hash 变化、summary 缺失与 `contentHashForNode` / 既有 summary 语义一致，不重生成 fresh embedding，不遗漏 stale embedding。

## 11. 推荐验证计划

单元测试覆盖：round 状态机、三次退避（fake clock）、canonical identity 去重与 trigger 合并、三个 source、health-check 全部状态、hash/summary 判定、embedding 并发上限、metadata 成功/失败与重启恢复。

集成测试覆盖：Neo4j 缺失/过期/幂等 upsert；graph load 与 repair 并发；三个触发同仓库只产生一个 active task；多仓库隔离和 embedding 并发限制。

回归验证：

```bash
cd gitnexus && npm run test:unit
cd gitnexus && npx tsc --noEmit
```

并运行 Neo4j repair、startup scheduling、health-check、analyze finalization、resource-aware concurrency 相关定向测试；可用环境中执行完整 `npm test`，检查结构化日志和实际 `/api/index-health-check` 响应。

## 12. 未决实现决策

实现前需通过代码现状和测试确定以下非核心参数：

1. `initialDelay`、`maxDelay`、jitter 默认值；
2. retry 状态在 metadata/registry 与进程内状态之间的持久化边界；
3. graph load 和 embedding upsert 的最小写冲突协调范围；
4. health-check 返回全部 registry 摘要还是仅返回本轮检测仓库。

这些细节不得改变核心约束：repair 不依赖结构分析完成；三个独立触发源；按 repo 去重；指数退避且单轮最多三次；启动/health-check 可开新 round；全生命周期可观测；沿用 embedding 资源并发上限。
