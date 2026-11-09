# GitNexus 调研记录：fix-oanew-repository-not

- 任务：修复 oanew 代码检索服务返回 `Repository is not available`
- 工作区：`D:\workplace\typescript\GitNexus`
- 分支：`xiexiongkun/source-customization-v1.6.13-rc.182`
- 调研时间：2026-11-03

## 1. GitNexus 检索（主查询）

- 服务：远端 `remote_gitnexus` MCP 连接失败（HTTP 500），按节点要求退避重试后仍不可用；本地 gitnexus MCP 服务未运行（CONNECTION_CLOSED）。
- 替代 GitNexus 通道：本地 CLI `node .gitnexus/run.cjs query storagePath --limit=5`，成功返回结果。
- 索引状态：`status=behind`，`commitsBehind=986`；`partial=true`（FTS 部分索引查询失败，3 个索引被跳过）。
- 查询命中（节选）：
  - `gitnexus/src/storage/parsedfile-store.ts`（storage 相关符号）
  - `gitnexus/test/unit/calltool-dispatch.test.ts`
  - 未直接命中 `RepoMeta.storagePath` 写入路径；按节点规则继续本地只读检索补充。

## 2. 本地补充检索（source=local_search, authority=non_gitnexus）

本地证据不能证明调用图、完整影响范围或跨项目关系；以下为文本检索与源码阅读结果。

| 位置 | 事实 |
|---|---|
| `gitnexus/src/core/run-analyze.ts:3339` | Neo4j 分析路径构造 `RepoMeta`，字段不含 `storagePath`，随后 `saveMeta(metaDir, meta)`（3371）与 `registerRepo(repoPath, meta, ...)`（3373）。 |
| `gitnexus/src/core/run-analyze.ts:5545` | LadybugDB 分析路径构造 `RepoMeta`，包含 `storagePath`（5547）。 |
| `gitnexus/src/core/shared-store-analyze.ts:241,286` | 共享存储播种/指针路径均显式写入 `storagePath`。 |
| `gitnexus/src/storage/storage-resolver.ts:557-572` | `repoMatches` 且外部存储（非仓库本地 `.gitnexus`）时，若 `metadata.storagePath === undefined` → `state='unowned'`，reason=`External storage metadata does not bind the index to this storage directory.` |
| `gitnexus/src/storage/storage-resolver.ts:577` | Neo4j 后端仅在 `state='owned'` 时把 `hasCodeIndexDB` 置为 true。 |
| `gitnexus/src/storage/repo-manager.ts:1759-1784` | `listRegisteredRepos({validate:true})` 对不满足 `LIST_STORAGE_REQUIREMENTS`（owned + requireCodeIndexDB）的条目跳过。 |
| `gitnexus/src/storage/storage-resolver.ts:58-64` | `ANALYZE_STORAGE_REQUIREMENTS` 仅允许 `missing/empty/owned`；`ANALYZE_FORCE_STORAGE_REQUIREMENTS` 才允许 `unowned/foreign`。 |
| `gitnexus/src/server/analyze-launch.ts:250-253` | 启动分析 worker 前 `requireStoragePath` 使用上述要求；unowned 直接抛 `StorageRequirementError`，重试分析无法启动。 |
| `gitnexus/src/mcp/repository-policy.ts:150-152,287-293` | `resolveRuntimeRepo` 在 registry 快照找不到仓库时抛 `Repository is not available through this MCP server.` |
| `gitnexus/src/server/mcp-http.ts:41` | `mountMCPEndpoints` 在 serve 启动时一次性创建 `McpRepositoryPolicy`（registry 快照）。 |

## 3. 远端只读证据（root@10.1.14.158）

- MCP 容器无 `GITNEXUS_MCP_ALLOWED_REPOS`，排除 allowlist 限制。
- `docker logs gitnexus-mcp-proxy` 反复出现：
  `Skipping registry entry during validation ... name=oanew ... state=unowned ... hasCodeIndexDB=false ... External storage metadata does not bind the index to this storage directory.`
- 同一时段出现 `StorageRequirementError`：`Storage path is in state "unowned" but requires one of: missing, empty, owned`，栈指向 `launchAnalysisWorker`。
- oanew 注册表条目：`storagePath=/root/.gitnexus/stores/oanew-95020886c164/checkouts/oanew-95020886c164`（外部共享存储槽），`indexedAt=2026-11-03T02:57:24.945Z`，stats 完整（files 9036、nodes 305373）。
- 该 storagePath 目录下 `meta.json` 顶层键无 `storagePath`（仅有 repoPath/indexedAt/stats 等）。

## 4. 根因结论

Neo4j 后端分析成功路径写入的 `meta.json` 缺少 `storagePath` 字段。对仓库本地 `.gitnexus` 存储，归属判定走 `repositoryLocal=true` 仍为 owned；但 oanew 使用外部共享存储槽，归属判定要求 `metadata.storagePath` 与当前槽一致，缺失即判 `unowned`。由此同时导致：

1. 注册表校验跳过 oanew → MCP 启动时 registry 快照不含 oanew → 调用报 `Repository is not available`。
2. `launchAnalysisWorker` 对 unowned 槽直接抛错 → 用户重试分析无法启动 → meta 不会被重写，形成无法自愈的循环。

## 5. 未确认项

- 远端 oanew 的 unowned 槽是否还有其它历史写入路径影响（当前仅确认 Neo4j 成功路径缺字段）。
- 远端其它使用共享存储槽的仓库是否同样受影响（尚未逐一枚举）。
- `remote_gitnexus` 500 的具体原因未定位（非本任务目标）。
