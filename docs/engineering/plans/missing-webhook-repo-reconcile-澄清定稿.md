# 缺失 webhook 仓库自动补克隆与索引 — 澄清定稿

- 任务：`missing-webhook-repo-reconcile`
- 工作区/分支：`D:\workplace\typescript\GitNexus` · `xiexiongkun/source-customization-v1.6.13-rc.182`
- 澄清时间：2026-11-07
- 结论：用户已确认「全部接受推荐」，以下为最终确认版。

## 1. 需求目标

当 webhook 已写入 `repos.json`（或 `repos.<env>.json`）但对应项目目录缺失时，巡检自动补克隆并触发索引分析，避免该仓库长期保持 0 节点，直到下一条 webhook 到达或人工克隆。

### 1.1 背景

调研记录 `missing-webhook-repo-reconcile-gitnexus-inquiry.md` 已确认根因链：

1. `POST /webhook/gitea` 先写 `repos.json`，再异步入队 clone。
2. `WebhookAnalyzeQueue` 是内存队列，进程重启/部署会丢失尚未执行的 clone 任务。
3. `scheduleStartupWebhookRepos` 具备 clone 能力，但只在 `GITNEXUS_STARTUP_WEBHOOK_REPOS_ENABLED=true` 时执行，默认关闭。
4. `runIndexHealthCheck` 只对 `discoverProjectRepoPaths` 发现的、已存在 `.git` 的目录做分析/注册；缺失目录不会被发现。
5. 因此“配置已写、clone 未执行”一旦发生，缺失仓库不会自动恢复。

## 2. 范围

**做：**

- 在 `runIndexHealthCheck`（启动、每日 22:00、手动 `POST /api/index-health-check`）中增加缺失 webhook 目标对账。
- 遍历 `loadWebhookInspectionTargets(projectsRoot)` 的全部目标。
- 以 `repoPath/.git` 不存在作为“缺失”判定：覆盖目录不存在、空目录、克隆中断未生成 `.git`。
- 缺失且 `cloneUrl` 非空时，复用 `scheduleStartupWebhookRepos` 中已有的 clone/worktree 回调入队。
- env 目标按 worktree 路径 `repoPath` 判定；回调先补主仓 `mainRepoPath`，再 `ensureLocalWorktree`。
- 无 `cloneUrl` 的目标记录警告并跳过。
- 新增最小日志：目标路径、缺失判定、入队/跳过、克隆失败原因。
- 单测覆盖缺失、存在、无 `cloneUrl`、env worktree、clone 失败与队列去重。

**不做：**

- 不改 `WebhookAnalyzeQueue` 的持久化、跨重启恢复或队列结构。
- 不改分析并发、`JobManager` 单槽、`waitForJobManagerIdle`。
- 不修改 `GITNEXUS_STARTUP_WEBHOOK_REPOS_ENABLED` 的默认值。
- 不新增配置开关、指标、HTTP 接口或管理页面。
- 不删除、不覆盖已有目录；非空且无 `.git` 的目录只记录 clone 失败，不做清理。
- 不做存量 unowned 数据修复、不做前端或数据库变更。

## 3. 术语

- **webhook 目标**：`repos.json` / `repos.<env>.json` 中登记、由 `loadWebhookInspectionTargets` 解析出的仓库目标。
- **缺失**：目标 `repoPath/.git` 不存在；不要求整个 `repoPath` 目录不存在。
- **补克隆**：对缺失目标调用 `cloneOrResetToBranch`；目录不存在时执行 `git clone --branch`，已有 `.git` 时走既有 fetch/reset 路径。
- **巡检**：`runIndexHealthCheck`，由启动、每日 22:00 crontab、手动 `POST /api/index-health-check` 三条路径触发。
- **对账**：配置期望（`repos.json`）与本地实际（`projectsRoot` 下目录）之间的一致性检查。
- **env 目标**：`repos.<env>.json` 中声明的环境仓库，使用主仓 `mainRepoPath` + worktree 路径 `repoPath`。
- **队列去重**：`enqueueWebhookAnalyze` 对同一路径的 active/pending 任务返回 `deferred`，不重复入队。

词表检查：仓库根无 `GLOSSARY.md` / `GLOSSARY-MAP.md`，未发现词表，不创建根词表。

## 4. 关键决策

| 编号 | 决策 | 结论 |
| --- | --- | --- |
| Q1 | 改动范围 | 只改巡检对账；不改队列持久化、并发、`JobManager`、前端与 DB |
| Q2 | 触发时机 | 放在 `runIndexHealthCheck`；不改为默认开启启动重放 |
| Q3 | “缺失”判定 | `repoPath/.git` 不存在即缺失；非空非 Git 目录 clone 失败并记录，不删除 |
| Q4 | 对账目标与跳过 | 遍历全部 webhook 目标；无 `cloneUrl` 跳过；env 目标按 worktree 路径判定并先补主仓 |
| Q5 | 失败与重试 | 记录错误并继续；下一次巡检再试；不立即重试、不做进程内失败隔离 |
| Q6 | 开关与观测 | 不新增开关；不改启动重放默认值；新增最小日志；不新增指标/接口/页面 |
| Q7 | 验收口径 | 缺失补克隆并索引、已有目录不重置、无 `cloneUrl` 跳过、并发送去重、单测覆盖 |

## 5. 数据流向与变动

### 数据流

- webhook：Gitea push → `POST /webhook/gitea` → `upsertWebhookRepoConfig` → `projectsRoot/repos.json` → `enqueueWebhookAnalyze` → `WebhookAnalyzeQueue` → `cloneOrResetToBranch` → 分析 → 索引。
- 巡检对账：启动 / 每日 22:00 / 手动 → `runIndexHealthCheck` → `loadWebhookInspectionTargets` → 逐个检查 `repoPath/.git` → 缺失且 `cloneUrl` 非空 → `enqueueWebhookAnalyze`（复用 clone/worktree 回调）→ 队列 → `cloneOrResetToBranch`（env 目标再 `ensureLocalWorktree`）→ 分析 → 索引。
- 已有 `.git`：不进入补克隆；沿用 `discoverProjectRepoPaths`、注册/meta 判定与既有分析/跳过逻辑。
- 失败：clone 失败 → 记录错误 → 继续处理下一个目标 → 下一次巡检重试。

### 变动清单

- `repos.json` / `repos.<env>.json`：只读，格式与字段不变。
- `projectsRoot`：缺失目标可能新增目录；已有目录不删除、不覆盖。
- `WebhookAnalyzeQueue`：无结构、并发或持久化变更；仅新增巡检来源的入队调用。
- HTTP API：路径、出入参、错误码均不变。
- 数据库、消息、缓存：无。
- 日志：新增对账目标、缺失判定、入队/跳过、克隆失败原因。

### SQL

本次无 DDL/DML。依据：不读写业务数据库；仅读取文件配置、文件系统与 Git 仓库。

### 伪代码

```text
onIndexHealthCheck():
  targets = loadWebhookInspectionTargets(projectsRoot)
  for target in targets:
    if not target.cloneUrl:
      logWarn("skip missing webhook target: no cloneUrl", target.repoPath)
      continue
    if pathExists(join(target.repoPath, ".git")):
      continue
    logInfo("reconcile missing webhook repo", target.repoPath)
    enqueueWebhookAnalyze(target.repoPath, { repoName: target.registryName },
      beforeAnalyze: reuse scheduleStartupWebhookRepos callback(target))
  // existing discoverProjectRepoPaths / registration / meta logic unchanged
```

## 6. 前端交互与显隐时机

非前端任务，省略。

## 7. 验收与数据基线

- 验收条件与必测场景：`docs/engineering/plans/missing-webhook-repo-reconcile-验收条件与必测场景清单.md`
- 测试数据基线：`docs/engineering/plans/missing-webhook-repo-reconcile-测试数据.md`
- 测试阶段逐条执行测试数据基线中的用例并回填结论，取值为通过、失败或不适用；原标未覆盖的用例先补齐数据再回填。

## 8. 待确认项

无。用户已明确确认全部推荐项。

## 9. 参考与证据

- GitNexus 调研记录：`docs/engineering/plans/missing-webhook-repo-reconcile-gitnexus-inquiry.md`
- 远程 GitNexus MCP 未收录本仓库、本机 MCP 连接关闭；调研采用本地 CLI + 当前 HEAD 源码核验，索引落后 987 个提交的风险已在该记录中披露。
- GitHub 同类实现参考：`wikimedia/mediawiki-tools-cli` 的 `repoDir/.git` 缺失补克隆、`oisin-ee/dogsled` 的 clone missing checkout 且不覆盖已有路径。
