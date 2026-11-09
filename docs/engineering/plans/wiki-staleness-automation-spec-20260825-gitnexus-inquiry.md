# GitNexus 调研记录

GitNexus MCP 调研因 LadybugDB 存储版本不兼容失败（数据库版本 42，当前构建版本 41）。按节点 fallback 规则改用当前工作区源码核验；本记录仅用于阶段交接。

## 证据

- gitnexus/src/core/git-staleness.ts:14-18,96-153：staleness 比较 lastCommit..HEAD；失败时返回 isStale=false、commitsBehind=0，无法表达 unknown。
- gitnexus/src/server/analyze-launch.ts:47-50,267-293：分析完成、backend reload 后更新 job 为 complete，再调用 onAnalysisFinalized，适合作为成功 analyze 触发点。
- gitnexus/src/server/api.ts:1842-1858：/api/repos 当前仅返回 name/path/repoPath/indexedAt/lastCommit/stats。
- gitnexus/src/storage/repo-manager.ts:484-505：registry entry 按路径保留 name、storagePath、indexedAt、lastCommit、remoteUrl、branch 等，不应按同名合并。
- gitnexus/src/server/webhook-analyze-queue.ts:59-173：已有按 key 去重及并发控制，但 Wiki 需求要求独立队列。
- gitnexus/src/core/wiki/generator.ts:80-86,254-274,1383-1405：Wiki meta.json.fromCommit 记录来源 commit；同 commit 返回 up-to-date；产物位于 storagePath/wiki。
- gitnexus/src/cli/wiki.ts:179-186：Wiki 依赖已有 index，自动化应复用 generator 与配置解析。
