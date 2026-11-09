# Embedding 服务异常时检索降级实施计划

## 状态

- [x] 读取项目规则、Dev-Spec-Gen 约束和现有检索实现
- [x] 确认故障点：HTTP Neo4j search 与通用 hybridSearch 的 semantic 异常未兜底
- [x] 为 Neo4j HTTP search 增加 fulltext / 结构化检索降级
- [x] 为通用 hybridSearch 增加 semantic 异常降级为 BM25
- [x] 增加单元测试覆盖异常与正常路径
- [x] 执行定向测试和 TypeScript 检查

## 实施边界

- 优先修改现有 search 入口，不调整 embedding 生成链路。
- Neo4j 降级优先复用已有 `FTS_INDEXES` 与 `escapeNeo4jFulltextQuery` 逻辑，保持与 MCP BM25 路径一致。
- 降级结果使用 `sources: ['bm25']`，保留 `score`、`rank`、`label`、`nodeId` 等兼容字段。
- embedding 失败只记录 warning，不把异常暴露为 `/api/search` 失败。

## 验证映射

| 需求 | 验证 |
| --- | --- |
| Neo4j embedding 异常自动降级 | mock `embedQuery` 抛错，断言返回 fulltext 结果 |
| Neo4j `mode=bm25` 有结果 | mock Neo4j fulltext 返回，断言不调用 embedding |
| semantic 正常时仍走语义结果 | mock `embedQuery` 与 `semanticSearch` 成功，断言结果 source 为 semantic |
| 非 Neo4j hybridSearch semantic 异常降级 | mock semantic 抛错，断言返回 BM25 结果 |
