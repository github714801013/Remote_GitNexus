# Neo4j 立即独立修复规格

- **任务 ID**：`neo4j-immediate-repair`
- **正式决策**：`docs/engineering/plans/neo4j-immediate-repair-design-decisions.md`
- **范围**：定义调度、状态、后端隔离与验收契约；不实现代码或修改编排。

## 背景

当前 Neo4j embedding repair 与 stale structure analyze、仓库锁及 LadybugDB 单库语义耦合：已有 Neo4j 图缺失/过期向量时，可能等待结构队列；Neo4j 路径也可能错误经过 LadybugDB 文件、锁和 native handle 生命周期。

目标是让 repair 在已有图需要修复时立即进入独立 embedding 队列，并与同仓库 stale structure analyze 实际并发；以 content hash、repo-scoped 幂等 upsert 和后续 health-check/finalization 收敛。

## 硬边界

### Repair admission

Neo4j registry/meta 或图表明已有可修复结构，且任一可向量化节点缺 embedding、content hash 过期或需要的 summary text 缺失时，repair 必须立即提交。它不得等待 stale analyze、全局 structure queue、同仓结构 job，或 LadybugDB 单库文件状态。

### 结构分析并发

同一 health-check 中，Neo4j repair 和 stale structure analyze 必须分别入队并实际并行：repair 遵守 embedding 资源上限，structure 遵守 structure 资源上限。两者不得共享会把 repair 延迟到 structure 完成后的互斥。structure completed 不等待 repair；repair 成败也不改变 structure completed。

### Neo4j/LadybugDB 隔离

Neo4j backend 的 repair 和 health-check 分支必须忽略全部 LadybugDB 单库逻辑：单库路径及存在性/类型/完整性检查、数据库锁、`withLbugDb`、`closeLbug`、`waitForSettledIndex`、local embedding pipeline、native handle、WAL/shadow/checkpoint 和旧 Kuzu 文件处理。

必须保留 `.gitnexus/gitnexus.json`、metadata、registry、parse cache、durable parsed-file store、finalization 状态及其他后端无关元数据。Ladybug backend 的文件、锁和完整性语义保持不变。

### Retry

每 round 最多 **3 次总尝试**：attempt 1 失败后 1 秒退避，attempt 2 失败后 2 秒退避，attempt 3 失败后终态 `failed`。下一次 startup/manual health-check 才可创建递增 round。单节点失败可沿用批次拆分/跳过；全部待修节点失败不得写 `complete`。旧 cooldown 若保留，必须投影为 round、attempt、原因和 `nextRetryAt`，不能作为唯一状态模型。

## 触发源与协调器

`startup`、`manual`、`finalization` 复用同一个 per-repo coordinator 和 runner：

- startup/manual 发现需要 repair 时创建或唤醒 round；
- finalization 在图已提交后补偿性请求 repair，不等待 repair；
- active round 由 canonical **Neo4j repo identity** 去重；同 repo 至多一个 active repair，重复触发合并 source/time 与再次检查意图；
- retry_wait 不允许绕过退避或建新 round；
- failed round 后 startup/manual 可新建 round；不同仓库独立，实际并发由 embedding controller 限制。

不得使用 `entry.storagePath` 的 LadybugDB single-file 路径作为 Neo4j 的锁、队列或互斥 identity。

## Repair 契约

runner 复用 `contentHashForNode`、summary 缺失判定、批量生成、批次拆分、repo-scoped 幂等 upsert、描述更新与 vector index 语义。并发 structure load 改变节点/hash 时，不得把未覆盖节点永久标记 complete；须重检或留给后续 health-check/finalization。Neo4j runner 不得调用任何 LadybugDB 本地数据库入口。

## 状态与可观测性

每个 canonical Neo4j repo identity 的 projection 至少包含：

```ts
interface Neo4jEmbeddingRepairStatus {
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

`complete` 只在重新检查确认无待修节点或完成 upsert 后使用；`retry_wait` 必含 `nextRetryAt`；`skipped` 必含原因。metadata 的 `embeddingStatus` 仍映射 running/complete/failed；metadata 更新失败不得掩盖真实 repair 状态，必须记录 `metadata_update_failed`。

`POST /api/index-health-check` 每仓库摘要至少包含 repoId、source、needsRepair、status、round、attempt、maxAttempts、skip/dedup reason，以及适用的 nextRetryAt、lastError、completedAt。health-check 运行中可返 202，但需含 `health_check_in_progress` 和已知状态。local diagnostics 同样暴露摘要；不得公开原始日志正文、token、请求或敏感路径。

日志必须包含 repoId、source、round、attempt、maxAttempts、事件/状态、retry 信息、安全 reason，以及可用的节点统计；覆盖接受、去重、跳过、开始、成功、失败、重试、耗尽、metadata 更新失败。

## 错误分类

| 场景 | 处理 | 结果 |
| --- | --- | --- |
| registry 无法解析 | 不入队 | skipped/registry_not_found |
| 图不可用 | round 重试 | retry_wait 或 failed |
| 无可向量化节点 | 空检查 | skipped/no_embeddable_nodes |
| 同仓 active | 合并触发 | deduplicated/coalesced |
| endpoint/Neo4j 临时错误 | 1s/2s，最多三次 | retry 信息，最终 failed |
| 单节点失败 | 拆分/跳过；全失败则失败 | 不得误报 complete |
| 并发 structure 改变节点 | 重检或留待下轮 | 不得永久误报 complete |
| 服务重启 | startup 按当前 hash 建/恢复 round | 不得卡 running |

## 非目标

不修改 Ladybug backend 调度与锁；不删除 metadata/registry/cache；不新增持久化队列、跨服务协议或公开原始 repair 日志；不让 finalization 同步等待 repair。

## 验收标准

1. 已有 Neo4j 图缺失/过期 embedding 时 startup/manual 立即入 embedding queue，不等待 stale analyze 或结构队列。
2. 同仓 repair 与 stale structure analyze 实际并行，各自遵守资源上限。
3. 三触发源共用 coordinator/runner；同仓最多一个 active round。
4. finalization 非阻塞，repair 成败不改变 structure job completed。
5. canonical Neo4j identity 去重；不同仓不误去重。
6. 一轮仅三次总 attempt，1s/2s 退避，第三次终态；新 round 规则正确。
7. Neo4j 分支不访问 Ladybug 文件、完整性、锁、local embedding 或 native handle；Ladybug 回归不变。
8. health-check、diagnostics、日志、metadata 的 source/state/round/attempt/retry/error 语义一致且安全。
9. 并发 graph load 时基于当前 hash 和 repo-scoped upsert 最终收敛。
10. repair 并发不超过 `getConcurrency('embedding')`，不改变 structure 并发。

## 验证计划

- 单元：coordinator 三 source/去重、round、1s/2s/第三次、canonical identity、状态投影、Neo4j 无 Ladybug 调用。
- 集成：已有图立即 repair；同仓 repair+stale structure 并发；finalization 补偿；多仓并发；health-check/diagnostics 摘要；Ladybug 原路径。
- 命令：

```bash
cd gitnexus && npm run test:unit
cd gitnexus && npx tsc --noEmit
```

另运行 Neo4j repair、health-check、finalization、resource-aware concurrency 定向测试，并在可用 Neo4j 环境核验 API、日志与并发。
