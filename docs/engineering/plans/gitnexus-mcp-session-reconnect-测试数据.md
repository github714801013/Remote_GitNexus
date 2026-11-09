# GitNexus MCP 会话失效时用新 session-id 重连 — 测试数据基线

- 任务：`gitnexus-mcp-session-reconnect`
- 依据：`gitnexus-mcp-session-reconnect-澄清定稿.md`、`gitnexus-mcp-session-reconnect-验收条件与必测场景清单.md`
- 说明：本文件同时是本次需求的验收用例清单。测试阶段逐条执行用例并回填「结论」，取值：通过 / 失败 / 不适用。

## 0. 数据形态说明

本任务不读写业务数据库，不存在业务 SQL 造数。测试数据形态为：

- **模拟 MCP 服务端**：可配置的 HTTP 夹具，返回 404 `-32001`（`Session not found. Re-initialize.`）或 200 initialize（响应头 `mcp-session-id`）。
- **会话 id 字面量**：`old-session-id`、`non-existent-session-id`、`new-id-1`、`new-id-2`、`new-id-3`；只用于请求头与断言，不入库。
- **运行时能力夹具**：可控（允许 Agent 触发 initialize 并读取新 id）与不可控（工具调用始终携带内部旧 id）两种。
- **日志捕获**：`vi.spyOn(logger, 'warn')`；断言调用次数与字段，不落盘。
- **技能文本**：`SKILL.md`、`references/shared/general-specs.md`、`references/flow-catalog.yml` 三处规则片段，用文本检索核对。
- **验证执行说明**：C 的 Agent 行为无法完全自动化，采用模拟运行时 + 人工核对；B 使用现有单测夹具扩展，不连接真实远端。

## 1. 调整点 A：dev-spec-gen 技能 `-32001` 重连规则

涉及库.表：无（技能文本 + 模拟 MCP 交互）。

### 1.1 用例

| 用例 | 消费方 | 输入锚点 | 预期结果 | 结论 |
| --- | --- | --- | --- | --- |
| T01 可控运行时自动重连 | `SKILL.md` 规则、`general-specs.md` §2.5、`flow-catalog.yml` 提示 | 旧 id `old-session-id`；首次请求 404 `-32001`；initialize 返回 `new-id-1` | 丢弃旧 id；initialize 请求不带旧 id；原请求用 `new-id-1` 成功；重试 1 次 | 待执行 |
| T02 不可控运行时停止上报 | 同上 | 运行时不可控；服务端恒 404 `-32001` | 同一请求重试 ≤1 次；输出含「MCP 会话已失效」与恢复建议 | 待执行 |
| T03 连续 404 三次后停止 | 同上 | 服务端恒 404；initialize 依次返回 `new-id-1`、`new-id-2`、`new-id-3` | initialize 3 次；三次 id 互不相同；第 3 次后停止并输出失败原因 | 待执行 |
| T04 普通失败规则不变 | 同上 | 模拟超时/连接拒绝（非 404） | initialize 0 次；首次 + 3 次重试；间隔 1s/2s/4s | 待执行 |
| T05 五处规则一致 | 同上 | 五个文件文本 | 五处均含 `-32001` 与「重新 initialize / 新 session-id」；无「`-32001` 按普通退避」表述 | 通过 |

### 1.2 五类内容

- **存量数据**：无。依据：规则只读取技能文本与模拟 HTTP 响应，不读取数据库、缓存或既有业务配置行。
- **新增数据**：三处规则文本；模拟会话 id（`old-session-id`、`new-id-1/2/3`）；模拟服务端响应夹具；两种运行时能力夹具。
- **边界数据**：无 `-32001`（正常路径）；一次 `-32001` 后成功；连续三次 `-32001`；运行时不可控；非 404 的超时/连接失败；`initialize` 返回的新 id 每次不同。
- **权限数据**：不适用。依据：规则不涉及角色、租户或权限差异；鉴权分支未改。
- **清理方式**：无持久化写入；模拟服务端与运行时夹具在每个用例结束后销毁，日志 spy 在 `afterEach` 恢复。

### 1.3 读取点覆盖

- `SKILL.md` 的 MCP 会话失效规则 → T01、T02、T03、T04。
- `references/shared/general-specs.md` §2.5 的重试与兜底规则 → T04、T05。
- `references/flow-catalog.yml` 的 `gitnexus-inquiry` 提示 → T04、T05。
- `references/research/gitnexus/gitnexus-code-inquiry.md` §1.7 → T04、T05。
- `references/research/gitnexus/gitnexus-local-fallback.md` → T04、T05。
- 五处一致性 → T05。

### 1.4 可重放只读 SQL

无。依据：本调整点不查询任何数据库。

## 2. 调整点 B：服务端 404 `-32001` 日志

涉及库.表：无（内存会话表 + stdout 日志）。

### 2.1 用例

| 用例 | 消费方 | 输入锚点 | 预期结果 | 结论 |
| --- | --- | --- | --- | --- |
| T06 `/mcp` 未知会话 warn | `http-transport.ts` `/mcp` 未知会话分支 | `mcp-session-id: non-existent-session-id` | 404 与响应体不变；`logger.warn` 1 次；字段 method/path/sessionId 前 8 位；无完整 id | 通过 |
| T07 `/sse` 未知会话 warn | `http-transport.ts` `/sse` 未知会话分支 | `POST /messages?sessionId=unknown` | 404 与响应体不变；`logger.warn` 1 次；字段同 T06 | 通过 |
| T08 已知会话不产生 warn | 两个分支的既有正常路径 | 有效会话 id | `logger.warn` 0 次；响应与改动前一致 | 通过 |

### 2.2 五类内容

- **存量数据**：无。依据：只读取内存会话表与请求头，不读取数据库或持久化配置。
- **新增数据**：`logger.warn` 输出字段 `method`、`path`、`sessionId` 前 8 位。
- **边界数据**：未知 id；空 id（`/mcp` 走既有 400 分支，不在本次范围；`/sse` 空 id 与未知 id 共用 404 分支，会记录 `sessionId: null` 的 warn）；已知 id；`/mcp` 与 `/sse` 两条路径；session-id 长度小于 8 位时的截断。
- **权限数据**：不适用。依据：不改鉴权与 401 行为，无角色差异。
- **清理方式**：单测结束后 `cleanup()` 关闭 handler 与临时 server；内存会话表随 handler 销毁。

### 2.3 读取点覆盖

- `http-transport.ts` `/mcp` 未知会话分支 → T06、T08。
- `http-transport.ts` `/sse` 未知会话分支 → T07、T08。
- 既有 404 响应契约 → T06、T07。

### 2.4 可重放只读 SQL

无。依据：本调整点不查询任何数据库。
