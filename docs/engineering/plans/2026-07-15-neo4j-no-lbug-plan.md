# Neo4j 模式移除本地 LadybugDB实施计划

## 状态

- [x] 接入 Neo4j 分析分支并补向量保留/修复逻辑
- [x] 移除 `REMOTE_LBDB_PATH` 部署配置
- [x] 增加定向回归测试并完成 TypeScript 验证
- [x] 清理远端旧 LadybugDB 文件并做线上验收

## 验证映射

| 需求 | 验证 |
| --- | --- |
| Neo4j 分析不触发本地库 | 定向单测、源码检索、线上日志无 WAL/LadybugDB 错误 |
| 图与向量落库 | Neo4j 节点/向量计数、健康接口 |
| 部署变量移除 | `rg REMOTE_LBDB_PATH`、Compose 配置检查 |
| 释放磁盘 | 远端清理前后目录占用与容器状态 |
