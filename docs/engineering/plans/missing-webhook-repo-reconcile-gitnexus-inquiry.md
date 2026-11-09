# 缺失 webhook 仓库自动补克隆与索引 — GitNexus 调研记录

- 任务：`missing-webhook-repo-reconcile`
- 分支：`xiexiongkun/source-customization-v1.6.13-rc.182`
- 调研时 HEAD：`9ca5849e85d6b034cacdb206b6dd7272fd5d64db`
- 调研范围：当前工作区 `D:\workplace\typescript\GitNexus`，不涉及跨项目调用或外部契约
- 调研时间：2026-11-07

## 1. 调研方法与降级记录

1. 先按节点配置调用远程 GitNexus MCP：
   - 工具：`mcp__remote_gitnexus__query`
   - `repo`：`GitNexus`
   - `search_query`：围绕“webhook 配置 repos.json 中存在但项目目录缺失的仓库为何不会被自动克隆与索引”，覆盖 `webhook` 路由、`scheduleStartupWebhookRepos`、`runIndexHealthCheck`、`discoverProjectRepoPaths`、`upsertWebhookRepoConfig`、`enqueueWebhookAnalyze`、`cloneOrResetToBranch`、`WebhookAnalyzeQueue`、`GITNEXUS_STARTUP_WEBHOOK_REPOS_ENABLED`、缺失目录跳过等入口、实现与条件分支。
   - 结果：`Error: Repository is not available through this MCP server.`
2. 为排除“仓库名不一致”，调用 `mcp__remote_gitnexus__list_repos`（limit=50）：返回 36 个已索引仓库，均为此前部署的业务仓库，不含本仓库 `GitNexus`。因此不是仓库名写错，而是当前 MCP 授权范围未收录本仓库。
3. 本机 `gitnexus` MCP 服务同时不可用（`CONNECTION_CLOSED`）。
4. 改用项目自带的本地 GitNexus 索引 CLI（`node .gitnexus/run.cjs`）执行同一主查询与符号复核：
   - CLI 版本：GitNexus 1.6.12；索引状态 `behind`，`commitsBehind=987`。
   - 查询期间出现 FTS 层 Binder 异常（`Table Protocol does not exist`、`Table Category does not exist`、`Cannot find property isDetail`），CLI 以 degraded 模式返回图结果。
   - 结论只用于调用关系；行号与函数体以当前 HEAD 源码核验为准，索引陈旧风险已披露。
5. 仅在上述 GitNexus 路径均不可用/索引陈旧且远程未收录本仓库后，才对当前工作区已跟踪源码做只读核验。以下“当前源码核验”标记为 `source: local_search`、`authority: non_gitnexus`。

## 2. GitNexus 图证据（本地 CLI，索引 987 commits behind）

| 关系 | 证据 |
| --- | --- |
| `createServer` → `scheduleStartupWebhookRepos`、`runIndexHealthCheck` | `context scheduleStartupWebhookRepos` / `context runIndexHealthCheck` 的 incoming.calls 均为 `createServer` |
| `scheduleStartupWebhookRepos` → `loadWebhookInspectionTargets`、`enqueueWebhookAnalyze` | `context scheduleStartupWebhookRepos` 的 outgoing.calls |
| `runIndexHealthCheck` → `discoverProjectRepoPaths`、`enqueueWebhookAnalyze`、`loadWebhookInspectionTargets` | `context runIndexHealthCheck` 的 outgoing.calls |
| `enqueueWebhookAnalyze` → `WebhookAnalyzeQueue.enqueue` | `context enqueueWebhookAnalyze` 的 outgoing.calls |
| `cloneOrResetToBranch` ← `createServer`、`queued` | `context cloneOrResetToBranch` 的 incoming.calls |
| `upsertWebhookRepoConfig` ← `createServer`、单测 | `context upsertWebhookRepoConfig` 的 incoming.calls |
| `discoverProjectRepoPaths` ← `runIndexHealthCheck` | `context discoverProjectRepoPaths` 的 incoming.calls |
| `loadWebhookInspectionTargets` ← `runIndexHealthCheck`、`scheduleStartupWebhookRepos` | `context loadWebhookInspectionTargets` 的 incoming.calls |

说明：本地索引为 1.6.12 且落后 987 个提交；上述调用关系可用，但图内行号（例如 `scheduleStartupWebhookRepos` 行 1323-1355、`runIndexHealthCheck` 行 1358-1478）已与当前源码不一致，不作为定位依据。

## 3. 当前源码核验（HEAD 9ca5849e，source=local_search / authority=non_gitnexus）

### 3.1 webhook 路由：先写配置，再异步克隆

- `gitnexus/src/server/api.ts:2822-2872` `POST /webhook/gitea`
  - 先 `upsertWebhookRepoConfig(path.join(projectsRoot, 'repos.json'), ...)`（2828-2832）；
  - 再 `enqueueWebhookAnalyze(repoPath, ..., async () => cloneOrResetToBranch(repo.cloneUrl, repoPath, branch))`（2834-2846）；
  - 克隆发生在队列任务的 `beforeAnalyze` 回调内，不是请求内同步执行。
- `gitnexus/src/server/webhook-worktree.ts:148-175` `upsertWebhookRepoConfig`
  - 按 `full_name` 查找；存在则更新 `clone_url`/`branch`，不存在则追加（167-172），最后写回 `repos.json`（174）。
  - 该函数只写配置，不检查目录是否存在，也不触发克隆。

### 3.2 启动重放：默认关闭

- `gitnexus/src/server/api.ts:433-434` `shouldScheduleStartupWebhookRepos()`
  - 读取 `GITNEXUS_STARTUP_WEBHOOK_REPOS_ENABLED`，默认 `false`。
- `gitnexus/src/server/api.ts:1967-1969`
  - 只有该开关为真时才调用 `scheduleStartupWebhookRepos()`。
- 远端部署的 `docker-compose.yml` 以 `${GITNEXUS_STARTUP_WEBHOOK_REPOS_ENABLED:-false}` 传入；应用 `.env` 未设置该键，因此实际为 `false`（2026-11-07 只读核对）。

### 3.3 启动重放函数本身具备“缺失即克隆”能力

- `gitnexus/src/server/api.ts:1746-1778` `scheduleStartupWebhookRepos`
  - 遍历 `loadWebhookInspectionTargets(projectsRoot)`；
  - 对每个目标 `enqueueWebhookAnalyze(...)`；
  - 回调内 `cloneOrResetToBranch(target.cloneUrl, target.repoPath, target.branch)`（普通仓库）；
  - env 目标先克隆 `mainRepoPath`，再 `ensureLocalWorktree(...)` 创建工作树（1760-1772）。
- 该函数已经包含修复所需的克隆/worktree 逻辑，可复用；但它当前只在启动且开关为真时执行，且不区分目录是否缺失。

### 3.4 巡检：只发现“已存在目录”，不读配置补克隆

- `gitnexus/src/server/api.ts:1784-1811` `runIndexHealthCheck`
  - 开头确实加载了 webhook 目标，但只用于构建 `webhookBranchByPath` 分支映射（1789-1792），没有克隆动作；
  - 随后 `for (const repoPath of await discoverProjectRepoPaths(projectsRoot))`（1797）；
  - 对已注册/有 meta 的仓库注册或跳过；对未注册且无 meta 的仓库 `enqueueWebhookAnalyze(resolvedRepoPath, { repoName })`（1807）。
  - 缺失目录的仓库不会出现在 `discoverProjectRepoPaths` 的结果中，因此不会被入队、也不会触发克隆。
- `gitnexus/src/server/api.ts:399-424` `discoverProjectRepoPaths`
  - 递归遍历 `projectsRoot`，只有 `pathExists(path.join(dir, '.git'))` 为真才把该目录加入结果（406-408）；
  - 目录不存在或没有 `.git` 的仓库不会被发现。
- `gitnexus/src/server/api.ts:337-391` `loadWebhookInspectionTargets`
  - 读取 `repos.json` 与 `repos.<env>.json`，计算 `mainRepoPath`/`repoPath`/`cloneUrl`/`branch`；
  - 不检查目标目录是否存在，也不执行克隆。

### 3.5 队列在内存中，重启会丢失待执行任务

- `gitnexus/src/server/webhook-analyze-queue.ts:60-99`
  - `WebhookAnalyzeQueue` 用 `activeKeys`、`pendingByKey`、`queue` 维护任务；
  - `enqueue` 在相同 key 已 active/pending 时返回 `deferred`，否则 push 并 `drain()`；
  - 没有任何持久化写入。
- `gitnexus/src/server/webhook-analyze-queue.ts:101-150`
  - `drain()` 受 `concurrency` 与 `startGate` 控制，逐个 `run(pending)`；
  - 进程退出时 `queue`/`pendingByKey` 随内存消失。
- 因此存在明确窗口：webhook 已写 `repos.json`（api.ts:2828-2832），但克隆任务尚未执行时进程重启/部署，配置保留而克隆丢失。

### 3.6 克隆函数本身支持“目录缺失则 clone”

- `gitnexus/src/server/git-clone.ts:1039-1080` `cloneOrResetToBranch`
  - 先检查 `targetDir/.git` 是否存在（1048-1051）；
  - 存在：`fetch`/`reset --hard`/`clean`/`checkout -B`（1053-1072）；
  - 不存在：`fs.mkdir(path.dirname(safeTarget), { recursive: true })` 后 `git clone --branch <branch> -- <url> <targetDir>`（1073-1077）。
- 结论：只要巡检在目标缺失时调用该函数，就能安全补克隆；不需要新增克隆实现。

## 4. 根因链

1. `repos.json` 是“期望仓库”配置，`projectsRoot` 下的目录是“实际仓库”；两者之间没有对账。
2. 唯一的自动克隆入口是收到 webhook 时的内存队列任务（api.ts:2834-2846）。
3. 队列不持久化（webhook-analyze-queue.ts:60-99），部署/重启会丢失尚未执行的克隆任务。
4. 启动重放默认关闭（api.ts:433-434、1967-1969），因此重启后不会从 `repos.json` 恢复。
5. 每日/启动巡检只发现已存在的 `.git` 目录（api.ts:1797、399-424），不会为配置里缺失的仓库补克隆。
6. 结果：任何一次“配置已写、克隆未执行”的中断，都会让该仓库长期保持 0 节点，直到下一条 webhook 到达或人工克隆。

## 5. 线上现象（2026-11-07 只读核对）

- 远端 `repos.json` 含 `JiuJi-JAVA/imservice`（branch `master`）与 `JiuJi-JAVA/SPA-management`（branch `saas`）；
- 远端 `/data1/gitnexus/projects/JiuJi-JAVA/` 下不存在这两个目录；
- 当前容器自 18:09 启动后无这两个仓库的 webhook 日志；
- 宿主机与容器（注入 `GITEA_TOKEN`）对两个仓库执行 `git ls-remote` 均成功，两个配置分支也存在。
- 因此本次现象与“网络/鉴权失败”无关，符合“配置存在、克隆任务丢失、巡检不回补”的代码路径。旧容器日志已被重建清除，无法还原当时具体中断点。

## 6. GitHub 同类型实现（source=github_search / authority=external_reference）

检索工具：`gh` 2.88.1，已登录；查询词不包含内部项目名、内部代码、业务数据、内网地址或凭据。

| 查询词 | 命中与实现方式 | 适用边界 |
| --- | --- | --- |
| `reconcile repositories` | `argoproj-labs/argocd-agent` `principal/callbacks.go`：按项目规则变更后 reconcile 引用该项目的仓库 | 配置驱动的期望状态对账思路；与本任务“配置 vs 目录”同构 |
| `clone missing repository` | `wikimedia/mediawiki-tools-cli` `internal/mediawiki/gerrit.go`：检查 `repoDir/.git`，缺失时在 `--clone-missing` 下补克隆；dry-run 输出 “Would clone missing repository” | 与本任务最接近：以 `.git` 存在性判定缺失，缺失才克隆 |
| `clone missing repository` | `oisin-ee/dogsled` CHANGELOG：“Clone missing repository checkouts from the caller's origin before prepare or launch. Reject origin conflicts without overwriting paths.” | 启动/prepare 前补克隆，且不覆盖已有路径；可借鉴“只补缺失、不覆盖” |
| `clone missing repository` | `lareferencia/lareferencia-platform`：`githelper init` 对缺失仓库执行 clone，已有模块保持既有 checkout | 初始化阶段补全，已有路径不重复克隆 |

复用判断：外部实现共同模式是“期望清单 vs 本地 checkout 对账，缺失才 clone，已有不覆盖”。本仓库已有 `cloneOrResetToBranch` 的“缺失 clone / 存在同步”语义，直接复用即可，不需要引入新依赖或通用对账框架。

## 7. 修复建议（供后续规格与 ticket 使用）

- 在 `runIndexHealthCheck`（启动 + 每日 22:00 已执行）中增加“缺失 webhook 目标对账”：
  - 复用 `loadWebhookInspectionTargets` 与 `scheduleStartupWebhookRepos` 中已有的 clone/worktree 回调；
  - 只对 `repoPath` 不存在且 `cloneUrl` 存在的目标入队；
  - env 目标以 worktree 路径 `repoPath` 是否存在为判定，回调仍负责主仓 clone 与 worktree 创建；
  - 复用 `enqueueWebhookAnalyze` 的按路径去重，避免与正在执行/已排队的任务重复。
- 不改变并发、队列持久化、单槽 JobManager 语义；不改变已有目录的日常行为。
- 测试关注：缺失→入队、存在→跳过、无 `cloneUrl`→跳过、env worktree 缺失→入队；并回归 `api-index-health-check-async.test.ts`、`startup-embedding-schedule.test.ts`、`webhook-analyze-queue.test.ts`。

## 8. 事实、推断与未确认

- 代码事实：3.1–3.6 所列文件、行号与条件分支。
- 推断：线上两个仓库的缺失与“webhook 已写配置、克隆任务未执行”一致；无法排除当时 clone 失败的其它原因。
- 未确认：旧容器中该 webhook 的具体到达时间、队列状态与失败日志（容器已重建，日志不可得）；因此不把“具体中断点”写成确定事实。
- 未覆盖：跨项目调用、路由契约、前端行为；本任务不涉及。
