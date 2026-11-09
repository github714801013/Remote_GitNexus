# GitNexus MCP 会话失效时用新 session-id 重连 — 澄清定稿

- 任务：`gitnexus-mcp-session-reconnect`
- 工作区：`D:\workplace\typescript\GitNexus`
- 分支：`xiexiongkun/source-customization-v1.6.13-rc.182`
- 依据：用户原始选择 `B+C(优化dev-spec-gen的技能,提示要用新的session-id来重试)`；grill-with-docs 第 1–3 轮确认（Q1–Q7）。
- 配套产物：`gitnexus-mcp-session-reconnect-验收条件与必测场景清单.md`、`gitnexus-mcp-session-reconnect-测试数据.md`。

## 1. 背景与根因

远端 `remote_gitnexus` 持续返回 `Streaming HTTP error -32001 Session not found. Re-initialize.`，客户端按 1s/2s/4s/10s/30s 退避重试 5 次仍失败。

已核实的根因：

1. 服务端 MCP 会话保存在内存 Map，容器重启或 30 分钟闲置 TTL 到期即失效（`gitnexus/src/mcp/http-transport.ts`）。
2. 服务端对带未知 `mcp-session-id` 的任何请求一律返回 HTTP 404 + `-32001`，且该分支不写日志，线上无法从日志确认发生次数。
3. 客户端（QODER_CLI / 执行器运行时）持有旧 session-id 重试，从不重新 `initialize`；旧 id 永远不可能成功。

## 2. 本次范围

### 2.1 C：dev-spec-gen 技能重连规则（工作区外）

- `C:\Users\Administrator\.claude\skills\dev-spec-gen\SKILL.md`：在既有失败处理段落追加 MCP 会话失效规则（始终加载，覆盖所有 MCP 调用）。
- `C:\Users\Administrator\.claude\skills\dev-spec-gen\references\shared\general-specs.md` §2.5：明确 `-32001` 不参与普通退避。
- `C:\Users\Administrator\.claude\skills\dev-spec-gen\references\flow-catalog.yml` 的 `gitnexus-inquiry` 提示：同步同一语义，避免与 stage 提示冲突。
- `C:\Users\Administrator\.claude\skills\dev-spec-gen\references\research\gitnexus\gitnexus-code-inquiry.md` §1.7：同步同一例外。
- `C:\Users\Administrator\.claude\skills\dev-spec-gen\references\research\gitnexus\gitnexus-local-fallback.md`：同步同一例外。

### 2.2 B：GitNexus 服务端 404 日志（本工作区）

- `gitnexus/src/mcp/http-transport.ts`：`/mcp` 未知会话分支（约 288–296 行）与 `/sse` 未知会话分支（约 471–478 行）各加一条 `logger.warn`。
- `gitnexus/test/unit/mcp-http-transport.test.ts`：扩展现有两个 404 用例，断言 `logger.warn` 调用与字段。

### 2.3 不在范围

- 修改 QODER_CLI / 执行器客户端代码（不可达，改由技能规则兜底）。
- 方案 A：服务端对 `initialize` 忽略未知 session-id（需 SDK 兼容性评估，本次不做）。
- 会话跨重启持久化、运维重启执行器等缓解措施。
- 任何数据库、接口字段、缓存键、消息体或文件格式变更。

## 3. 关键决策（Q1–Q7）

| 编号 | 决策点 | 结论 |
| --- | --- | --- |
| Q1 | 收到 `-32001` 时 Agent 做到哪一步 | 能控制 MCP 会话的运行时：丢弃旧 id → 不带 id 重新 `initialize` → 取响应头新 id → 重试原请求；不能控制会话的运行时：不再原样退避重试，明确报告「MCP 会话已失效，需重建」，按当前节点既有失败处理继续 |
| Q2 | 规则投放位置 | `SKILL.md` 主文 + `references/shared/general-specs.md` §2.5 + `references/flow-catalog.yml` 的 `gitnexus-inquiry` 提示，三处一致（Q8 追加两处研究文档） |
| Q3 | 与现有「最多重试 3 次」如何计数 | 沿用三次退避上限；每次重试前都丢弃旧 id、重新 `initialize` 并换用新 session-id；重连本身不额外增加次数 |
| Q4 | B 的交付方式 | 本流程内一起做 B+C；B 的 TS 改动在 `skill-creator` 阶段完成并登记 `task_files`，由 `code-review` 覆盖 |
| Q5 | 日志覆盖分支 | `/mcp` 未知会话与 `/sse` 未知会话两条 404 分支都打 |
| Q6 | 日志级别与字段 | `warn`；字段 `method`、`path`、`sessionId` 前 8 位；不落完整 session-id |
| Q7 | B 的验证方式 | 扩展现有两个 404 单测，断言日志记录与字段；响应体断言保持不变 |
| Q8 | 重复退避规则同步范围 | 五处全部同步：`SKILL.md`、`general-specs.md` §2.5、`flow-catalog.yml` 的 `gitnexus-inquiry` 提示、`gitnexus-code-inquiry.md` §1.7、`gitnexus-local-fallback.md` |

## 4. 技能规则语义（C）

统一规则（三处文件表述可以不同，语义必须一致）：

1. **触发条件**：MCP 工具返回 `-32001 Session not found. Re-initialize.`（HTTP 404）。该错误表示服务端已丢弃该会话，继续携带同一 `mcp-session-id` 重试必然失败。
2. **可控制会话的运行时**：
   - 丢弃当前 `mcp-session-id`；
   - 发起新的 `initialize`（请求不得携带旧 `mcp-session-id`），从响应头 `mcp-session-id` 取得新会话 id；
   - 用新 id 重试原请求；
   - 该重试计入现有「最多重试 3 次」上限；第 2、3 次重试前同样必须重新初始化并换用新 id，不得复用上一次的 id。
3. **不可控制会话的运行时**（Agent 无法设置/重置 `mcp-session-id`）：不得继续原样退避重试；停止当前调用，明确报告「MCP 会话已失效，需重建」，并说明已尝试次数与恢复建议（重启执行器 / 重开对话 / 等待服务恢复），随后按当前节点既有失败处理继续。
4. **禁止**：把 `-32001` 当作普通「服务错误」放进 1s/2s/4s 退避桶；在未更换 session-id 的情况下重复重试。
5. **一致性的既有规则**：普通超时、连接失败、授权/能力错误仍按 1s、2s、4s 指数退避最多 3 次，行为不变。

## 5. 服务端日志语义（B）

1. `/mcp` 未知会话分支与 `/sse` 未知会话分支各记录一条 `warn`。
2. 日志字段：`method`（HTTP 方法）、`path`（请求路径）、`sessionId`（仅前 8 位，如 `550e8400`）。
3. 消息文本需能直接检索到「session not found / re-initialize」语义。
4. HTTP 响应体、状态码、JSON-RPC 错误码与消息保持原样，不得改变客户端可观察契约。
5. 已知会话的正常请求、401/400 等其它分支不得新增该 warn。

## 6. 数据流向与变动

**数据流**

- 规则 C：Agent → MCP 运行时（持有 `mcp-session-id`）→ `remote_gitnexus` `/api/mcp` → 服务端会话 Map → 404 `-32001` → 运行时重建会话（或停止上报）。
- 日志 B：HTTP 请求 → `http-transport` 未知会话分支 → `logger.warn` → stdout。

**变动清单**

- 日志输出：无 → 新增 `warn`（`method`、`path`、`sessionId` 前 8 位），仅输出到 stdout。
- 会话 id：运行时内存状态，不入库、不落盘；本次不改变其生命周期与 TTL。
- 表/字段、接口出入参、缓存键、消息体、文件格式：无变化。

**判定**：本次不涉及持久化数据变动。依据：不读写数据库、缓存或业务配置行；不改变任何接口出入参与响应契约；新增内容仅为 stdout 日志与技能提示文本。

**SQL**：无 DDL/DML。

**前端交互与显隐时机**：非前端任务，省略。

## 7. 产物与验证

| 产物 | 路径 |
| --- | --- |
| 澄清定稿 | `docs/engineering/plans/gitnexus-mcp-session-reconnect-澄清定稿.md` |
| 验收条件与必测场景清单 | `docs/engineering/plans/gitnexus-mcp-session-reconnect-验收条件与必测场景清单.md` |
| 测试数据基线 | `docs/engineering/plans/gitnexus-mcp-session-reconnect-测试数据.md` |

验证命令：

- `cd gitnexus && npx vitest run test/unit/mcp-http-transport.test.ts`（或仓库既有测试入口）。
- 技能侧：检索三处文件均含 `-32001` 分支语义，且不存在「`-32001` 按普通退避重试」的旧表述。
- 类型检查：对被改 TS 文件执行项目既有 typecheck 方式（避免全量 tsc 在本机 OOM）。

## 8. 风险与未确认项

1. **运行时能力未知**：QODER_CLI 是否允许 Agent 主动重建 MCP 会话尚未确认；规则已包含「不可控制会话则停止上报」分支，因此无论能力如何都可执行。
2. **技能文件在工作区外**：技能改动无法进入 `task_files` / `output_files`，只能以 evidence 记录，show-me 的 git diff 不会显示；需在交付说明中显式列出。
3. **规则三处同步**：任何一处遗漏都会产生冲突；验收清单包含一致性检查项。
4. **日志无法覆盖客户端本地决策**：服务端只能记录到达服务端的 404；客户端是否重连仍需运行时自身日志。
