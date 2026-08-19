# GitNexus MCP 访问控制上下文

本上下文定义 GitNexus MCP 请求中的项目、环境和仓库访问范围术语，避免配置同步与服务端授权使用不同含义。

## MCP 访问范围

**项目（Project）**：请求方希望访问的项目基础名，例如 `oanew`、`oa-stock` 或 `jiuji-m`。它不是固定枚举，也不是带环境前缀的仓库名。

**环境（Environment）**：项目所属的运行环境，目前包括 `dev` 和 `pro`。

**项目环境候选（Project Environment Candidate）**：根据项目基础名和环境动态生成的实际仓库名。`dev` 为 `dev-${project}`，`pro` 为 `${project}`。

**请求级仓库访问范围（Request Repository Scope）**：由 MCP 初始化请求声明并约束的可访问仓库集合；它只能缩小服务端已经允许的范围，不能扩大服务端权限。

**范围通配（Scope Wildcard）**：请求未声明项目或环境维度时，该维度不缩小访问范围；已声明的维度仍然生效。空字符串和 `*` 不是通配符。

**部分索引匹配（Partial Index Match）**：多环境或多项目组合中，存在的候选加入范围，不存在的候选忽略；至少一个候选匹配注册表及全局 allowlist 才建立会话。

**会话访问范围（Session Access Scope）**：MCP 会话初始化时确定的请求级仓库范围；会话中的后续工具调用、资源读取和仓库列表共享该范围。

**Header 值规范（Header Value Format）**：项目和环境值使用英文逗号分隔，逐项去除首尾空格并按不区分大小写进行匹配；空项、非法值和 `*` 拒绝。

**有效会话范围（Effective Session Scope）**：请求声明生成的候选仓库与服务端全局 allowlist 取交集后的实际可访问集合；集合为空时会话无效且不得建立。

**全量索引查看（isAll）**：`list_repos` 的显式查看模式，只返回所有项目的仓库索引状态，不扩大代码检索、影响分析、资源读取或其他工具的仓库访问范围。

## CC Switch 与 Codex Header

**同步源 Header（Sync Source Headers）**：CC Switch 统一配置中保存的 MCP Header 字段，字段名为 `headers`。

**Codex HTTP Header 配置（Codex HTTP Headers）**：Codex MCP 配置中承载远程 HTTP 请求头的字段，字段名为 `http_headers`。
