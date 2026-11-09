# GitNexus MCP 会话失效时用新 session-id 重连 — 验收条件与必测场景清单

- 任务：`gitnexus-mcp-session-reconnect`
- 依据：`gitnexus-mcp-session-reconnect-澄清定稿.md`
- 2026-11-09 调整（task_tune）：允许复用 session-id，新增验收 10、11。
- 编号规则：验收 1..11，不跳号；下游引用本编号。

## 验收条件

### 验收 1 — 收到 -32001 且运行时可控制会话时自动重连成功

- 现象：Agent 遇到 `-32001` 后丢弃旧 session-id，重新 initialize 取得新 id，原请求最终成功。
- 前置：模拟 MCP 服务端对带旧 session-id 的请求返回 404 `-32001`；不带 id 的 `initialize` 返回 200 且响应头 `mcp-session-id=new-id`；随后带 `new-id` 的请求成功；运行时允许 Agent 重建会话。
- 动作：调用一个 `remote_gitnexus` 工具（如 `list_repos`）。
- 可观测结果（换新 id 路径）：`initialize` 请求不携带旧 id（判定方式：`=` 请求头不存在旧 id）；重试原请求携带 `new-id`（判定方式：`=`）；工具最终成功（判定方式：`=` 成功结果）；重试次数为 1（判定方式：`=` 计数 1）。复用旧 id 的等价路径见验收 10。
- 维度：正向、一致性；覆盖层级：组件层（模拟运行时）/ 人工；覆盖用例：T01；数据可复用：是；数据准备：需造（模拟 MCP 服务端夹具）。

### 验收 2 — 运行时不可控制会话时停止重试并明确上报

- 现象：不再对同一旧 session-id 连续退避重试，输出明确的会话失效结论与恢复建议。
- 前置：运行时不允许 Agent 设置或重置 `mcp-session-id`；服务端对任何带旧 id 的请求固定返回 `-32001`。
- 动作：调用一个 `remote_gitnexus` 工具。
- 可观测结果：同一请求重试次数不超过 1（判定方式：`=` 计数 ≤1）；输出包含「MCP 会话已失效」或同等语义（判定方式：`⊇` 包含）；输出包含恢复建议（重启执行器 / 重开对话 / 等待服务恢复）（判定方式：`⊇` 包含）。
- 维度：逆向；覆盖层级：人工；覆盖用例：T02；数据可复用：是；数据准备：需造（模拟不可控运行时）。

### 验收 3 — 重连后仍 404 时三次内每次换新 id，达到上限停止

- 现象：每次重试都重新 initialize 并换用新 session-id；达到三次上限后停止，不无限循环。
- 前置：模拟服务端对任何请求都返回 404 `-32001`；每次 `initialize` 返回不同的新 id；运行时可控。
- 动作：调用一个工具。
- 可观测结果：`initialize` 次数为 3（判定方式：`=` 计数 3）；三次请求的 session-id 互不相同（判定方式：`=` 两两不等）；最终停止并输出失败原因（判定方式：`⊇` 包含会话失效）。
- 维度：边界、逆向；覆盖层级：组件层；覆盖用例：T03；数据可复用：是；数据准备：需造（恒 404 的模拟服务端）。

### 验收 4 — 普通超时或连接失败规则保持不变

- 现象：非 `-32001` 的失败仍按 1s、2s、4s 退避最多 3 次，且不触发重新 initialize。
- 前置：模拟服务端返回超时或连接拒绝（非 404）。
- 动作：调用一个工具。
- 可观测结果：`initialize` 次数为 0（判定方式：`=`）；总尝试次数为 4（首次 + 3 次重试，判定方式：`=`）；重试间隔为 1s、2s、4s（时序，不进 e2e 断言）。
- 维度：兼容回归；覆盖层级：组件层；覆盖用例：T04；数据可复用：是；数据准备：需造（超时模拟）。

### 验收 5 — 五处规则文本语义一致

- 现象：`SKILL.md`、`references/shared/general-specs.md` §2.5、`references/flow-catalog.yml` 的 `gitnexus-inquiry` 提示、`references/research/gitnexus/gitnexus-code-inquiry.md` §1.7、`references/research/gitnexus/gitnexus-local-fallback.md` 对 `-32001` 的语义一致。
- 前置：五个文件可读。
- 动作：对五处文本检索 `-32001` 与 `Session not found`。
- 可观测结果：五处均命中 `-32001`（判定方式：`⊇` 五处各命中）；五处均包含「复用旧 session-id」与「重新 initialize」语义（判定方式：`⊇`）；五处均不含「`-32001` 按 1s、2s、4s 普通退避」的表述（判定方式：`=` 不出现）。
- 维度：一致性；覆盖层级：人工；覆盖用例：T05；数据可复用：是；数据准备：现成（文件）。

### 验收 6 — /mcp 未知会话 404 记录 warn 且响应不变

- 现象：请求 `/mcp` 携带未知 session-id 时，服务端记录 warn；客户端仍收到原有 404 响应。
- 前置：启动 `createStreamableHttpHandler`；会话表中不存在目标 id。
- 动作：发送 `GET /mcp`，携带 `mcp-session-id: non-existent-session-id`。
- 可观测结果：HTTP 状态 404（判定方式：`=`）；响应体 `error.code = -32001` 且 `error.message = "Session not found. Re-initialize."`（判定方式：`=`）；`logger.warn` 调用 1 次（判定方式：`=`）；字段含 `method`、`path`、`sessionId` 前 8 位（判定方式：`=`）；日志不含完整 session-id（判定方式：`=` 不出现）。
- 维度：正向、一致性；覆盖层级：组件层；覆盖用例：T06；数据可复用：是；数据准备：需造（现有单测夹具）。

### 验收 7 — /sse 未知会话 404 记录 warn 且响应不变

- 现象：`/messages` 携带未知 `sessionId` 时，服务端记录 warn；客户端仍收到原有 404 响应。
- 前置：SSE 会话表中不存在目标 id。
- 动作：发送 `POST /messages?sessionId=unknown`。
- 可观测结果：HTTP 状态 404（判定方式：`=`）；响应体 `error.code = -32001`（判定方式：`=`）；`logger.warn` 调用 1 次且字段同验收 6（判定方式：`=`）。
- 维度：正向；覆盖层级：组件层；覆盖用例：T07；数据可复用：是；数据准备：需造（现有单测夹具）。

### 验收 8 — 已知会话正常请求不产生 warn

- 现象：已知会话的请求行为与改动前一致，不新增 warn。
- 前置：已建立有效会话。
- 动作：使用该 session-id 发送请求。
- 可观测结果：不产生 `logger.warn`（判定方式：`=` 计数 0）；响应与改动前一致（判定方式：`=` 既有断言通过）。
- 维度：兼容回归；覆盖层级：组件层；覆盖用例：T08；数据可复用：是；数据准备：需造（现有单测夹具）。

### 验收 9 — 既有 MCP HTTP 传输单测全部通过

- 现象：本次改动不破坏既有传输层行为。
- 前置：依赖安装完成。
- 动作：运行 `gitnexus/test/unit/mcp-http-transport.test.ts`。
- 可观测结果：全部用例通过（判定方式：`=`）；无新增跳过（判定方式：`=`）。
- 维度：兼容回归；覆盖层级：组件层；覆盖用例：T01–T10；数据可复用：是；数据准备：现成。

### 验收 10 — 未知 session-id 的 initialize 自动重建并复用原 id

- 现象：服务端实例重启（或会话 TTL 过期）后，客户端携带旧 `mcp-session-id` 重新 `initialize`，服务端按旧 id 重建会话，后续请求可继续使用同一 id。
- 前置：第一个 `createStreamableHttpHandler` 实例完成一次 initialize 后销毁；第二个实例的会话表为空。
- 动作：向第二个实例发送 `POST /mcp`，携带 `mcp-session-id: <旧 id>` 与合法 initialize 请求体；随后携带同一 id 发送 `tools/list`。
- 可观测结果：initialize 返回 HTTP 200（判定方式：`=`）；响应头 `mcp-session-id` 等于旧 id（判定方式：`=`）；后续 `tools/list` 返回 200（判定方式：`=`）；记录一条 `info`「MCP session regenerated for reused session id」且 `sessionId` 为前 8 位（判定方式：`=`）。
- 维度：正向、边界；覆盖层级：组件层；覆盖用例：T09；数据可复用：是；数据准备：需造（临时真实 handler + HTTP 夹具）。

### 验收 11 — 非 initialize 请求携带未知 session-id 仍返回 404

- 现象：没有 initialize 握手时，服务端不强行重建会话，保持原有 `-32001` 响应。
- 前置：会话表中不存在目标 id。
- 动作：发送 `POST /mcp`，携带 `mcp-session-id: non-existent-session-id`，请求体为 `tools/list`。
- 可观测结果：HTTP 404（判定方式：`=`）；响应体 `error.code = -32001` 且 `error.message = "Session not found. Re-initialize."`（判定方式：`=`）；记录一条 404 `warn`（判定方式：`=`）。
- 维度：逆向、兼容回归；覆盖层级：组件层；覆盖用例：T10；数据可复用：是；数据准备：需造（现有单测夹具）。

## 维度覆盖检查

| 维度 | 覆盖情况 |
| --- | --- |
| 正向 | 验收 1、6、7、10 |
| 逆向 | 验收 2、3、11 |
| 边界 | 验收 3、10 |
| 并发 | 不适用 + 原因：本次不改会话 Map 的并发与 TTL 清理逻辑，不新增共享状态 |
| 一致性 | 验收 1、5、6 |
| 权限 | 不适用 + 原因：不改鉴权与 401 分支，无角色差异 |
| 兼容回归 | 验收 4、8、9、11 |

## 编号与下游映射

- 下游实现与评审引用本清单编号，不自造编号。
- 覆盖用例编号与 `gitnexus-mcp-session-reconnect-测试数据.md` 一一对应。
