# Neo4j 立即独立修复：设计决策

任务 ID：`neo4j-immediate-repair`

## 已确认边界

- **Neo4j repair admission**：只要 Neo4j 图、metadata 与 registry 已存在且检测到缺失或过期 embedding，repair 立即进入 embedding 队列；不得等待 stale structure analyze、全局 structure queue 或同仓库结构锁。
- **同仓库并发**：Neo4j repair 与同仓库 stale structure analyze 允许实际并发。repair 依赖 repo-scoped、基于 content hash 的幂等 upsert；结构写入或 repair 造成的节点/hash 变化由下一次 health-check、finalization 或 repair 自身的重新检查最终收敛。
- **LadybugDB 忽略范围**：Neo4j backend 启用时，忽略全部 LadybugDB 单库文件路径、完整性检查、数据库锁、local embedding pipeline 与 native database handle 操作。仍保留 `.gitnexus/gitnexus.json`、registry、parse cache、durable parsed-file store 及其他 metadata/finalization 状态。Ladybug backend 保持原有逻辑与锁语义。
- **结构分析**：stale structure analyze 仍独立调度，但不得以其队列状态阻塞 Neo4j repair。对于同一 health-check 轮次，两个任务可以并行入队。
- **重试**：每个 Neo4j repair round 最多 3 次总尝试；第一次与第二次失败后分别退避 1 秒、2 秒。第三次失败记录终态，下一次 startup 或 manual health-check 才可开启新的 round。
- **状态可见性**：health-check 的逐仓库摘要和本地诊断接口必须暴露 source、state、round、attempt、nextRetryAt，以及 skip/error reason；不增加公开的原始日志正文接口。

## 未采用方案

- 不让 Neo4j repair 等待同仓库结构锁释放：这会继续使 GPU 在大型结构分析期间空闲，违背“立即独立调度”。
- 不把 Neo4j repair 的协调锁复用为 LadybugDB 单库锁：Neo4j 不使用 local single-file database，保留此互斥会错误耦合两个后端。
- 不在 repair 完成前才排 stale analyze：这会继续放大 structure queue 对向量化的饥饿。
- 不在单轮内无限重试：endpoint 或 Neo4j 故障会无限占用 embedding 资源。
- 不修改 Neo4j 下必须保留的 registry、metadata、parse cache 和 parsed-file store：它们不是 LadybugDB 单库逻辑。

## CONTEXT.md / ADR 声明

不修改 `CONTEXT.md`：本轮处理的是后端调度和存储隔离语义，不新增业务领域术语。

不新增 ADR：Neo4j/Ladybug backend 条件分支、队列优先级和重试次数属于可调整的服务运行策略；本轮不引入新的持久化队列、跨服务协议或难以逆转的公开领域模型。

## 后续实现约束

1. 所有 Neo4j repair 触发（startup、manual health-check、结构 finalization）复用同一个 per-repo coordinator；active round 去重、source 合并、round 与 attempt 状态一致。
2. Neo4j coordinator 与 queue key 使用 canonical Neo4j repo identity；不得通过 `entry.storagePath` 的 LadybugDB single-file 路径作为锁、排队或互斥依据。
3. Neo4j 模式下 `runIndexHealthCheck()` 对 `stale && needsEmbeddings` 必须独立提交 repair 和 structure analyze，不能通过 `continue` 丢失任一任务。
4. Neo4j repair runner 不得调用 `withLbugDb`、`closeLbug`、`cleanupOldKuzuFiles`、`waitForSettledIndex` 或 Ladybug local file checks；Ladybug backend 的原有路径不回归。
5. 结构 finalization 在 Neo4j 下仍可作为补偿性 repair trigger，但不等待 repair，也不以 repair 失败改变 analyze job 的 completed 状态。
6. repair 在运行或结束时必须重新依据 Neo4j 当前节点/hash 判定工作量；禁止把与结构重建并发时的空结果误标为永久 complete。
7. 每次状态转移必须可投影到 health-check 和本地诊断摘要，且不得泄露完整路径、token、原始请求或敏感异常正文。
