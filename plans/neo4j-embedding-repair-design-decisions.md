# Neo4j 独立向量化调度：设计决策

任务 ID：`neo4j-embedding-repair`

## 已确认边界

- **可修复索引**：Neo4j 图以及本地 `gitnexus.json` 与 registry entry 已存在，且检测到缺失或过期向量的仓库；它不依赖该仓库当前结构分析任务完成。
- **结构分析**：负责图结构的解析、写入 Neo4j 与后续增量变更；它不再作为 embedding repair 的队列前置条件。
- **Embedding repair**：独立于结构分析队列，使用现有 embedding 并发上限；同一仓库通过 repair 去重锁避免多个 repair 并发。
- **触发点**：服务启动、`POST /api/index-health-check`、以及结构任务完成 finalization 后均可检测并调度 repair。
- **并发策略**：repair 优先且独立；允许与同仓库结构重建并发，使用既有 Neo4j 内容/哈希校验达成最终一致。
- **失败策略**：单轮自动 repair 最多三次指数退避重试；达到上限后记录最终失败，下一次启动或 health-check 可以开启新一轮。

## 未采用方案

- 不等待全局结构分析队列清空：这会继续让缺失向量项目被大型结构任务饥饿。
- 不要求同仓库结构任务 finalization 后才 repair：已有完整 Neo4j 图的项目应能立即修复。
- 不暂停所有 repair 避让结构任务：这会把一个仓库的重建问题扩大为全局 GPU 空闲。
- 不持续无限重试：错误 embedding endpoint 会无限占用调度资源。
- 不把 repair 直接塞回 analyze worker：这会重新耦合结构内存/CPU 与 GPU 向量化生命周期。

## CONTEXT.md / ADR 声明

不修改 `CONTEXT.md`：本决策新增的是基础设施调度语义，不是代码库业务领域术语。

不新增 ADR：三触发点、独立队列和三次退避属于可调整的服务调度策略；现有代码已经具备 embedding repair 与 health-check 概念，本轮不引入难以逆转的新存储或公开领域模型。

## 后续实现约束

1. 保持结构分析、repair 与 registry/metadata 的职责边界；不得将 repair 再绑定到结构 worker terminal event。
2. repair admission 仅要求可修复索引存在；不得以 stale analyze、结构队列状态或全局 idle 状态阻塞。
3. 所有三类触发点必须复用同一个 per-repo repair coordinator，确保去重、退避计数与日志一致。
4. repair 状态必须在日志和 health-check 结果中可观测：触发源、跳过原因、attempt、下一次重试时间、完成/失败原因。
5. 同仓库图重建并发时，repair 的错误或无工作项不能错误标记结构任务失败；后续触发可收敛到最新图状态。
6. 保持现有 embedding 并发配置为系统资源上限，不通过结构分析锁或 repo lock 串行化 repair。
