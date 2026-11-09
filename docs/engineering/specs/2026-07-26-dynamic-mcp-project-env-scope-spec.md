# GitNexus MCP 动态 projects/env 范围规格

## 1. 目标

修复 GitNexus MCP 对请求头 `projects`、`env` 的范围解析，使其支持索引注册表中的动态项目，并保持 CC Switch 到 Codex 的 Header 同步契约。

## 2. 输入契约

```ts
interface McpRequestScopeHeaders {
  projects?: string | readonly string[];
  env?: string | readonly string[];
}
```

- 字符串和数组元素都可包含英文逗号分隔值。
- 每个值 trim 后按小写比较。
- 任一维度缺失时，该维度按通配处理。
- 空项和 `*` 拒绝。
- `env` 仅接受 `dev`、`pro`。
- `projects` 不使用固定枚举；项目值由实际注册表匹配判定。

## 3. 仓库候选生成

对每个项目和环境组合生成一个候选名称：

| 环境 | 候选仓库名 |
| --- | --- |
| `dev` | `dev-${project}` |
| `pro` | `${project}` |

当 `projects` 缺失时，从注册表按环境命名规则筛选：`dev` 匹配 `dev-` 前缀仓库，`pro` 匹配不带 `dev-` 前缀的项目仓库。实现不得把请求中的项目值直接当作允许仓库名绕过环境规则。

当 `env` 缺失且 `projects` 已提供时，生成该项目的 `dev` 和 `pro` 两类候选。

## 4. 部分索引策略

- 候选不存在：忽略该候选。
- 候选存在但不在全局 allowlist：不加入有效范围。
- 生成候选中至少有一个最终匹配全局 allowlist 的注册仓库：创建受限会话。
- 所有候选都不存在或与全局 allowlist 交集为空：抛出范围不匹配错误，不建立空范围会话。

示例：`projects: jiuji-m`, `env: pro,dev` 在仅有 `jiuji-m` 索引时，范围为 `jiuji-m`；在仅有 `dev-jiuji-m` 索引时，范围为 `dev-jiuji-m`。

## 5. 会话和工具行为

范围在 HTTP MCP 初始化时由 `forRequestScope` 计算并绑定。后续工具调用、资源读取、`list_repos` 普通模式共享该范围。

`list_repos(isAll=true)` 仍可以返回所有索引状态，供调用方确认仓库是否已索引；该模式不能使 `query`、`context`、`impact`、Zoekt 检索或资源读取访问未授权仓库。

未设置 `projects` 和 `env` 时返回既有策略对象，不改变无 Header 行为。

## 6. CC Switch 同步

CC Switch 内部继续保存通用字段 `headers`；同步到 Codex 时输出 `http_headers`。本规格不修改 CC Switch 数据库字段，不把真实用户配置或凭据写入仓库。

## 7. 验收场景

1. `jiuji-m + pro` 匹配 `jiuji-m`。
2. `jiuji-m + dev` 匹配 `dev-jiuji-m`。
3. `projects: jiuji-m`, `env: pro,dev` 允许任一存在的候选，禁止因另一候选缺失而失败。
4. 多项目、多环境生成笛卡尔组合并去重。
5. 缺少 `projects` 或 `env` 时按对应维度通配。
6. 未知环境、空项和 `*` 拒绝。
7. 未知项目只有在其生成候选全部不存在时才报范围不匹配。
8. 请求范围与全局 allowlist 取交集。
9. 全局 allowlist 交集为空时初始化失败。
10. `isAll=true` 可查看索引状态但不能扩大代码查询权限。
11. 无 Header 行为不回归。
