# 修复 CC Switch Codex MCP Header 同步与 GitNexus Header 策略

## Problem Statement

当前远程 GitNexus MCP 服务能够访问仓库资源，但 CC Switch 到 Codex 的 MCP Header 同步存在格式不一致风险：CC Switch 统一配置使用 `headers`，而 Codex 需要 `http_headers`。现有 Codex 配置中出现了错误的 `[mcp_servers.remote_gitnexus.headers]`，后续同步可能再次覆盖为错误格式。

同时，GitNexus MCP 服务端目前只使用进程级仓库 allowlist，不消费请求 Header 中的 `projects` 与 `env`。这使调用方无法在一次 MCP 会话中声明项目和环境范围，也无法保证工具、资源和仓库列表使用同一套访问边界。

## Solution

实现一套与现有全局仓库 allowlist 叠加的 MCP 会话访问范围：

- 在 MCP 初始化阶段读取 `projects` 和 `env` Header，并将结果绑定到会话；
- 使用实际仓库命名规则进行显式环境映射：
  - `dev + oanew -> dev-oanew`；
  - `dev + oa-stock -> dev-oa-stock`；
  - `pro + oanew -> oanew`；
  - `pro + oa-stock -> oa-stock`；
- 两个 Header 都存在时按交集筛选；只存在一个时缺失维度按通配处理；两个都不存在时保持既有行为；
- Header 使用英文逗号分隔，逐项去首尾空格，项目名和环境名大小写不敏感；空项、未知值和隐式通配符失败关闭；
- 会话范围与服务端全局 allowlist 取交集，交集为空时拒绝建立会话；
- 将同一范围统一应用于仓库列表、代码工具和仓库资源；
- 为 `list_repos` 增加 `isAll=true` 索引查看模式，仅允许查看所有项目的仓库索引状态，不扩大代码工具或资源权限；
- CC Switch 数据库继续使用 `headers`，同步到 Codex 时生成 `http_headers`；优先通过现有 CC Switch 3.18.0 的正式同步流程修复和验证当前 Codex 配置，不先修改 CC Switch 源码。

## User Stories

1. 作为 MCP 调用方，我希望通过 `projects` 指定项目范围，以便一次会话只访问被授权的项目仓库。
2. 作为 MCP 调用方，我希望通过 `env=dev` 访问开发环境仓库，以便不会误查生产仓库。
3. 作为 MCP 调用方，我希望通过 `env=pro` 访问生产环境仓库，以便使用实际生产仓库名称而不被错误拼接为 `pro-*`。
4. 作为 MCP 调用方，我希望同时指定多个项目和多个环境，以便获得这些条件的组合范围。
5. 作为 MCP 调用方，我希望只指定 `projects` 时能访问该项目在支持环境中的仓库，以便不必重复声明所有环境。
6. 作为 MCP 调用方，我希望只指定 `env` 时能访问该环境下的全部项目，以便进行环境级检索。
7. 作为旧版 MCP 客户端，我希望不发送这两个 Header 时保持原有行为，以便现有集成不被强制升级。
8. 作为服务端管理员，我希望请求范围不能突破全局 allowlist，以便请求 Header 不能扩大服务器侧授权。
9. 作为服务端管理员，我希望未知项目、未知环境和非法 Header 值被拒绝，以便配置错误不会降级为无限制访问。
10. 作为服务端管理员，我希望请求范围在 MCP 初始化时绑定到会话，以便同一会话中途不能切换仓库权限。
11. 作为 MCP 调用方，我希望 `list_repos` 只展示当前会话范围内的仓库，以便仓库发现结果与后续工具权限一致。
12. 作为索引运维人员，我希望使用 `list_repos(isAll=true)` 查看所有项目的索引状态，以便进行索引健康检查。
13. 作为服务端管理员，我希望 `isAll=true` 只扩大索引状态查看，不扩大代码检索、影响分析和资源读取，以便保留最小权限边界。
14. 作为 MCP 调用方，我希望查询、上下文、影响分析、代码片段和其他仓库工具都遵循同一会话范围，以便不会通过不同工具绕过限制。
15. 作为 MCP 调用方，我希望 `gitnexus://repo/...` 资源与工具使用同一访问范围，以便资源读取不会泄露未授权仓库信息。
16. 作为 MCP 调用方，我希望 Header 在 MCP 会话后续请求中保持一致，以便权限边界稳定且行为可预测。
17. 作为 CC Switch 用户，我希望内部统一配置继续使用 `headers`，以便 Claude、Gemini 和 Codex 的同步不会互相破坏。
18. 作为 Codex 用户，我希望同步后的远程 MCP 配置使用 `http_headers`，以便 Codex 真正发送 `projects` 和 `env` 请求头。
19. 作为维护人员，我希望现有 CC Switch 已实现的字段映射优先通过同步流程验证，以便避免无必要地修改外部客户端源码。
20. 作为维护人员，如果重新同步仍然产生错误的 `headers` 字段，我希望该问题能够被明确识别为 CC Switch 同步缺陷，以便后续针对正确的同步入口修复。

## Implementation Decisions

- 将请求级仓库范围建模为会话访问范围，不把 `projects` 和 `env` 当作日志标签或普通透传字段。
- 在现有仓库策略之上增加请求范围解析与策略合并能力，最终可访问集合必须是请求范围与全局 allowlist 的交集。
- 环境映射使用显式规则，不使用统一的环境前缀拼接：开发环境使用 `dev-{project}`，生产环境直接使用 `{project}`。
- Header 缺失维度表示该维度通配，而两个 Header 同时缺失表示兼容旧客户端的既有行为。
- Header 解析采用英文逗号分隔、首尾空格忽略和不区分大小写匹配；空项、未知值、非法值和 `*` 等隐式通配符不放行。
- 请求范围在 MCP 初始化阶段确定并绑定到会话；后续工具调用、资源读取和仓库列表沿用该范围。会话中途改变 Header 时不得扩大或切换范围。
- `list_repos` 新增显式 `isAll` 参数。默认模式按会话范围返回仓库；`isAll=true` 仅返回全量仓库索引状态，不改变其他工具和资源的权限判断。
- group 路由不得绕过请求范围；存在受限会话范围时，group 工具和 group 资源不能用作跨仓库访问通道。
- 无 Header 请求的兼容行为保持不变，除非服务端已有全局仓库策略另行限制。
- CC Switch 统一数据库字段保持为 `headers`，Codex 目标格式使用 `http_headers`。本仓库不复制 CC Switch 的内部存储格式，也不直接修改 CC Switch 数据库字段。
- CC Switch 处理优先采用现有 3.18.0 正式同步流程验证当前配置；只有重新同步仍生成 `[mcp_servers.<name>.headers]` 时，才扩大范围修改 CC Switch 源码。

## Testing Decisions

- 测试应验证外部行为和授权结果，不绑定具体私有函数的实现细节。
- 复用现有 MCP 仓库策略单元测试 Seam，覆盖环境映射、Header 解析、缺失维度通配、非法值、全局 allowlist 交集和 `isAll` 的范围差异。
- 复用现有 MCP HTTP 传输测试 Seam，覆盖初始化 Header、会话绑定、后续请求、Header 变更、空交集失败和 MCP 错误响应。
- 在同一集成 Seam 中验证 `list_repos`、至少一个代码工具和至少一个仓库资源，证明三类入口使用同一会话范围。
- 验证 `isAll=true` 可以看到所有索引状态，但不能让受限会话对未授权仓库执行代码工具或读取仓库资源。
- 验证没有 Header 的旧客户端行为不回归。
- CC Switch 验收采用外部配置验证：检查 CC Switch 数据库仍是 `headers`，重新同步后 Codex 使用 `http_headers`，并确认错误的 `[mcp_servers.<name>.headers]` 不再生成。
- 运行 CLI/Core 单元测试和 TypeScript 类型检查；如涉及 HTTP 集成测试，优先执行对应 MCP 测试文件，再执行项目规定的完整验证命令。

## Out of Scope

- 不修改 CC Switch 数据库 schema 或把内部 `headers` 改成 `http_headers`。
- 在 CC Switch 3.18.0 正式同步仍正确时，不修改其外部源码或安装包。
- 不新增或替换 MCP 身份认证机制；继续使用现有认证边界。
- 不改变无 Header 请求的既有行为。
- 不让 `isAll=true` 访问未授权仓库的代码、调用链、资源正文或执行写操作。
- 不改变仓库索引生成、索引存储、Neo4j/LadybugDB 数据结构和部署架构。
- 不处理与本次 Header 策略无关的 MCP 工具重构、全局格式化或性能优化。
- 不在本规格阶段执行 commit、push、远程部署或生产配置写入。

## Further Notes

- 当前分支已经包含 `main` 分支最新提交；本规格不要求再次合并 `main`。
- 当前源码尚未提供 `list_repos.isAll` 参数，因此需要在规格执行阶段补充接口 schema、策略行为和测试。
- 当前任务工作区存在与本任务无关的未跟踪文件，实施和 Git 交付时必须使用明确文件 allowlist，不得使用 `git add .`。
- CC Switch 的本地配置修复和重新同步属于外部验收动作，应保留配置字段脱敏和结果证据，不提交用户本机真实配置或凭据。
