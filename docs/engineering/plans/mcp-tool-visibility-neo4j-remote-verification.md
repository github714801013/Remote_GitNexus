# 最终验证：远程 Neo4j MCP 工具可见性收敛

- `bash -n mcp_proxy_docker/remote_deploy.sh`：通过。
- 未设置变量的基础 Compose 渲染：`GITNEXUS_MCP_READ_ONLY: "0"`。
- 预设远端环境为 `0` 后，再以内联远端值 `1` 启动的 Compose 渲染：`GITNEXUS_MCP_READ_ONLY: "1"`。
- `cd gitnexus && npx vitest run test/unit/mcp-read-only.test.ts`：1 个文件、24 项测试全部通过。
- `cd gitnexus && npx tsc --noEmit`：通过。
- `git diff --check`：通过。

结论：远程部署可强制只读 MCP，本地基础 Compose 默认不启用只读策略；既有 MCP 发现隐藏与调用拒绝测试保持通过。
