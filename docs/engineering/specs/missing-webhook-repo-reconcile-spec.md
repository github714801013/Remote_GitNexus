# 缺失 webhook 仓库自动补克隆与索引 — 规格

- 任务：`missing-webhook-repo-reconcile`
- 日期：2026-11-07
- 依据：`docs/engineering/plans/missing-webhook-repo-reconcile-澄清定稿.md`

## 问题陈述

webhook 配置写入 `repos.json` 后，克隆任务在内存队列中执行；进程重启、部署或队列任务丢失时，配置保留而项目目录没有创建。启动重放默认关闭，索引巡检又只发现已存在 `.git` 的目录，因此缺失仓库不会自动恢复，长期保持 0 节点，直到下一条 webhook 到达或人工克隆。

线上曾出现 `JiuJi-JAVA/imservice` 与 `JiuJi-JAVA/SPA-management` 已登记但目录缺失的现象；仓库本身可访问，分支存在，问题不在网络或鉴权，而在“配置期望”与“本地实际”之间没有对账。

## 解决方案

在既有索引巡检 `runIndexHealthCheck`（启动、每日 22:00、手动 `POST /api/index-health-check`）中增加缺失 webhook 目标对账：

1. 读取 `repos.json` 与 `repos.<env>.json` 的全部 webhook 目标。
2. 对每个目标检查 `repoPath/.git` 是否存在；不存在即判定为缺失。
3. 缺失且 `cloneUrl` 非空时，复用既有 clone/worktree 回调入队，由队列完成补克隆与后续分析。
4. 已有 `.git` 的目标不补克隆，沿用既有分析/注册/跳过逻辑。
5. 无 `cloneUrl` 的目标记录警告并跳过；非空且无 `.git` 的目录只记录 clone 失败，不删除已有内容。
6. clone 失败记录错误并继续；下一次巡检再次尝试。
7. 不改队列持久化、并发、JobManager 与启动重放默认值。

## 用户故事

1. 作为 GitNexus 运维者，我希望服务启动巡检时自动补克隆缺失的 webhook 仓库，以便部署或重启后不需要人工执行 clone。
2. 作为 GitNexus 运维者，我希望每日 22:00 巡检也能补克隆缺失仓库，以便运行期间目录被清理或丢失后能自动恢复。
3. 作为 GitNexus 运维者，我希望手动触发 `POST /api/index-health-check` 时也能补克隆，以便发现缺失后立即修复而不等到次日。
4. 作为 GitNexus 运维者，我希望已有 `.git` 的仓库不被重新克隆或 reset，以便不产生无意义的拉取和潜在的本地改动风险。
5. 作为 GitNexus 运维者，我希望空目录或克隆中断未生成 `.git` 的目录被判定为缺失，以便部分失败的 clone 能自动恢复。
6. 作为 GitNexus 运维者，我希望非空且无 `.git` 的目录不被删除或覆盖，只记录 clone 失败，以便不丢失人工放置的文件。
7. 作为 GitNexus 运维者，我希望没有 `cloneUrl` 的目标被跳过并记录原因，以便一条不完整配置不会中断整轮巡检。
8. 作为 GitNexus 运维者，我希望 env 目标在 worktree 缺失时先补主仓再重建 worktree，以便多环境仓库也能自动恢复。
9. 作为 GitNexus 运维者，我希望单个目标 clone 失败不阻塞其他目标，并在下一次巡检重试，以便临时网络或鉴权问题恢复后自动补上。
10. 作为 GitNexus 运维者，我希望 webhook、启动重放与巡检同时触发时同一路径只入队一次，以便不重复分析、不争抢分析槽。
11. 作为 GitNexus 运维者，我希望日志包含目标路径、缺失判定、入队/跳过与失败原因，以便审计和定位。
12. 作为 GitNexus 运维者，我希望本次改动不改变分析并发、队列持久化和单槽 JobManager，以便资源占用与既有部署配置保持稳定。
13. 作为 GitNexus 开发者，我希望对账逻辑放在可注入依赖的独立模块中，以便不启动服务就能覆盖缺失、存在、无 `cloneUrl`、env worktree 与失败分支。

## 实现决策

### 模块与接口

- 新增本地“webhook 仓库对账”模块，暴露一个编排函数：
  - `reconcileMissingWebhookTargets(targets, deps)`：遍历目标，决定跳过或入队，返回入队、跳过、缺失计数。
  - `deps` 至少包含 `pathExists(path)`、`enqueue(target)`、`logger`；`enqueue` 返回 `{ status, done }`，`status` 为 `accepted` 或 `deferred`（与 `WebhookAnalyzeQueue` 一致）。
- 同一模块提供 clone/worktree 回调构造器，供启动重放与巡检共用：
  - 普通目标：`cloneOrResetToBranch(cloneUrl, repoPath, branch)`。
  - env 目标：先 `cloneOrResetToBranch(cloneUrl, mainRepoPath, branch)`，再 `ensureLocalWorktree({ mainRepoPath, worktreePath: repoPath, branch: registryName, baseRef: origin/<branch>, resetToRef: origin/<branch> })`。
  - 构造器通过依赖注入接收 clone 与 worktree 函数，避免测试触碰真实 Git。
- `runIndexHealthCheck` 只做最小接线：读取目标一次，构建既有分支映射，调用对账函数，然后继续既有目录发现、注册、staleness 与 embedding 逻辑。
- `scheduleStartupWebhookRepos` 改用同一回调构造器，消除重复的 clone/worktree 分支。

### 行为规则

- 缺失判定：`repoPath/.git` 不存在。目录不存在、空目录、克隆中断未生成 `.git` 都命中；已有 `.git`（目录或 worktree 的 `.git` 文件）不命中。
- 对账顺序：读取 webhook 目标后、`discoverProjectRepoPaths` 之前执行；缺失目标先入队，既有目录仍由后续发现逻辑处理。
- 无 `cloneUrl`：记录警告，计入跳过，不调用 `enqueue`。
- 入队去重：沿用 `enqueueWebhookAnalyze` 的 active/pending 去重；返回 `deferred` 时记录日志，不视为错误。
- 失败处理：`done` 拒绝或入队同步抛错时记录错误（目标、错误），继续下一个目标；不新增失败隔离、不立即重试。
- env 目标：以 worktree `repoPath/.git` 判定；worktree 路径存在但无 `.git` 时按缺失入队，`ensureLocalWorktree` 失败则记录错误并保留目录。
- 并发：巡检自身的 `indexHealthCheckRunning` 守卫不变；对账不新增共享状态。启动重放开启时，启动巡检跳过对账，由重放覆盖全部目标；手动/每日巡检始终对账。
- 日志：入队记录目标路径与 `accepted/deferred`；跳过记录无 `cloneUrl`；失败记录目标与错误原因。

### 异常与边界

- 目标目录不存在：入队 clone。
- 空目录：入队 clone。
- 非空且无 `.git`：入队 clone；clone 因目标非空失败，记录错误，保留原内容。
- 已有有效 `.git`：跳过，不 clone/reset。
- 无 `cloneUrl`：跳过，不抛错。
- 分支不存在或远端不可达：clone 失败，记录错误，下一次巡检重试。
- env 主仓缺失 / 已存在：缺失则 clone，已存在则复用；worktree 缺失则创建。
- 队列已有同路径 active/pending：返回 `deferred`，不重复入队。
- 启动重放与巡检并发：同一路径只入队一次。
- 进程重启：对账不维护新状态，重启后按配置重新判断。

### 非目标

- 不修改 `WebhookAnalyzeQueue` 的结构、并发或持久化。
- 不修改 `JobManager` 单槽、`waitForJobManagerIdle`。
- 不修改 `GITNEXUS_STARTUP_WEBHOOK_REPOS_ENABLED` 默认值。
- 不新增配置开关、指标、HTTP 接口或管理页面。
- 不删除、不覆盖已有目录；不做存量 unowned 修复。
- 不做前端、数据库或跨项目契约变更。

## 测试决策

- 测试 seam：新增对账模块的导出函数（单一 seam）。用假目标、假 `pathExists`、假 `enqueue` 与假 clone/worktree 依赖覆盖目标选择、跳过、入队与回调构造；不启动服务，不触碰真实 Git。
- 既有 seam：`api-index-health-check-async` 的源码断言继续验证手动巡检仍为“入队后 202 返回”；新增一条断言确认巡检调用对账函数。`startup-embedding-schedule`、`webhook-analyze-queue` 回归不变。
- 先例：`gitnexus/test/unit/stale-analyze-scheduler.test.ts` 的纯函数测试组织；`gitnexus/test/unit/webhook-analyze-queue.test.ts` 的组件级队列测试。
- 覆盖映射：T01 缺失目录、T02 空目录、T03 已有 `.git`、T04 无 `cloneUrl`、T05 env worktree、T06 clone 失败继续、T07 队列去重、T08 回归。
- 验证命令：`cd gitnexus && npx vitest run test/unit/webhook-repo-reconciler.test.ts`；回归 `npx vitest run test/unit/api-index-health-check-async.test.ts test/unit/startup-embedding-schedule.test.ts test/unit/webhook-analyze-queue.test.ts`；类型检查 `npx tsc --noEmit -p tsconfig.json`。

## 范围之外

- 队列持久化、跨重启恢复、失败任务重放。
- 分析并发、资源感知并行、单槽 JobManager 的调整。
- 启动重放默认开关的变更。
- 索引分析器性能优化、`commitsBehind` 调度优化（由既有任务覆盖）。
- 缺失仓库的告警、可视化或管理界面。
- 存量 unowned 数据批量修复。

## 补充说明

- 领域词表：仓库根未发现 `GLOSSARY.md` / `GLOSSARY-MAP.md`，本规格沿用澄清定稿中的术语定义。
- 二次开发改动面见 `docs/engineering/specs/missing-webhook-repo-reconcile-customization-points.md`。
- 参考文档读取：本阶段 17 个挂载文档中 15 个已读正文；`delivery/shared/workitem-materials.md` 与 `shared/matt-pocock-skills-integration.md` 标记为 `not_relevant`，理由见上一阶段 handoff。
