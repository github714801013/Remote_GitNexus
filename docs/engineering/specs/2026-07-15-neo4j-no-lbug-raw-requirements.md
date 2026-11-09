# Neo4j 模式移除本地 LadybugDB

## 原始需求

1. `GITNEXUS_STORAGE_BACKEND=neo4j` 时，分析任务不得初始化、写入或依赖本地 LadybugDB 文件。
2. 删除部署链路中的 `REMOTE_LBDB_PATH` 变量和 `/root/.lbdb` 挂载。
3. Neo4j 模式分析需要完成图写入、向量状态维护、元数据登记和现有解析缓存保存。
4. 清理远端历史 LadybugDB 文件以释放磁盘空间，并验证服务仍可用。

## 验收标准

- Neo4j 模式分析代码路径不调用 `initLbug`、`loadGraphToLbug` 或 WAL checkpoint。
- Neo4j 模式分析将图写入 Neo4j，已有向量可保留并与新图节点重新关联，变化节点可触发向量修复。
- `remote_deploy.sh`、`docker-compose.yml`、`.env.example` 和本地 `.env` 不再声明 `REMOTE_LBDB_PATH`。
- 远端旧 `.lbdb` 文件清理后，容器健康检查、Neo4j 图查询和向量统计通过。

## 范围与不适用项

- 仅修改 GitNexus CLI/服务端、Neo4j 适配层和 MCP Docker 部署文件。
- 非 Neo4j 模式继续保留 LadybugDB 分析路径。
- 不删除 `.gitnexus` 中的元数据、解析缓存或远端项目源代码。
