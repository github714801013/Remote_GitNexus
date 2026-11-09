# Embedding 服务异常时检索降级

## 原始需求

1. 当 embedding / vectorization 服务异常、超时或不可用时，GitNexus 查询不能因为向量化失败而中断。
2. 查询应自动降级为结构化/关键词检索路径，继续返回可用的图节点、文件、流程或符号结果。
3. 降级只影响语义向量召回，不应影响最终接口返回结构，也不应让默认 hybrid 查询变成 HTTP 500。

## 已确认事实

- MCP `query` 路径已经对 `semanticSearch` 失败做了兜底：向量结果返回空数组后继续合并 BM25 / 图结构结果。
- HTTP Neo4j `/api/search` 路径当前直接调用 `embedQuery` 和 Neo4j `semanticSearch`；embedding 服务异常会向上抛出，导致接口失败。
- 通用 `hybridSearch` 当前已处理 FTS 失败后走 semantic-only，但 semantic search 自身异常时仍会向上抛出。

## 验收标准

- Neo4j HTTP search 在 `mode=hybrid` 或默认模式下，embedding 查询失败时自动返回 Neo4j fulltext / 结构化结果。
- Neo4j HTTP search 在 `mode=bm25` 下返回 Neo4j fulltext / 结构化结果，而不是空数组。
- 非 Neo4j `hybridSearch` 在 semantic search 抛错时返回 BM25 结果，不抛出异常。
- 单测覆盖 embedding 失败降级路径和正常语义路径。
- 不修改 embedding 生成、索引保存、Neo4j 图写入和部署配置。

## 范围与不适用项

- 范围：HTTP search、通用 hybrid search、相关单元测试。
- 不适用：不改变 MCP `query` 的现有降级行为；不新增环境变量；不变更模型调用协议；不处理真实生产部署。
