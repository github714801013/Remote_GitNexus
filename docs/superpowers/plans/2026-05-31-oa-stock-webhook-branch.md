# oa-stock webhook 分支索引修复计划

## 背景

`oa-stock` 的 Gitea webhook payload 为 `refs/heads/release_9ji`，但服务端索引清单仍显示 `branch=dev` 且 `stale 1 commit`。现场日志证明 webhook analyze 已触发并完成，说明问题不在队列未执行，而在 webhook 分支元数据没有完整传递到 analyze 注册链路。

## 假设

- `/webhook/gitea` 应将 payload 分支作为 registry/meta 分支持久化。
- `repos.json` startup 补跑也应使用该配置分支作为 registry/meta 分支。
- 不新增接口、不改 Neo4j 写入模型、不改队列并发。

## 任务

1. 定位 `/webhook/gitea` 与 startup `repos.json` 调度链路。
2. 修复 analyze 入队参数，传递 `registryName` 和 `registryBranch`。
3. 增加单测，覆盖 `release_9ji` 分支传入 analyze worker options。
4. 运行相关 vitest、TypeScript typecheck、diff 检查。

## 验收

- Gitea webhook payload 的 `release_9ji` 会进入 analyze options 的 `registryBranch`。
- startup `repos.json` 记录的 branch 会进入 analyze options 的 `registryBranch`。
- `/webhook/gitea` 既有响应结构不变。
