# 缺失 webhook 仓库自动补克隆与索引 — 测试数据基线

- 任务：`missing-webhook-repo-reconcile`
- 依据：`missing-webhook-repo-reconcile-澄清定稿.md`、`missing-webhook-repo-reconcile-验收条件与必测场景清单.md`
- 说明：本文件同时是本次需求的验收用例清单。测试阶段逐条执行用例并回填「结论」，取值：通过 / 失败 / 不适用。

## 0. 数据形态说明

本任务不读写业务数据库，不存在业务 SQL 造数。测试数据形态为：

- **仓库配置**：`repos.json` 与 `repos.<env>.json`，字段沿用现有 `full_name`、`clone_url`、`branch` 等；测试中使用临时目录内的配置副本。
- **Git 仓库夹具**：临时 bare 仓库作为 `clone_url` 来源；临时 worktree 目录作为 env 目标路径；`git init` + 若干提交构造有效 `.git`。
- **文件系统状态**：目标 `repoPath` 不存在、空目录、非空且无 `.git`、有效 `.git` 四种形态。
- **测试桩**：`cloneOrResetToBranch`、`ensureLocalWorktree`、`enqueueWebhookAnalyze` 的调用计数与返回值；`WebhookAnalyzeQueue` 的 active/pending 状态。
- **远端观察数据**：远端 `repos.json` 中的 `JiuJi-JAVA/imservice`（`master`）与 `JiuJi-JAVA/SPA-management`（`saas`）仅作存量观察基线，不作为断言来源。
- **验证执行说明**：T01/T02/T05/T06/A-非空非 Git 的验收集成使用系统临时目录中的 bare 仓库与真实本地 git；因 `validateGitUrl` 只允许 http(s)，集成测试内仅 mock URL 校验，克隆/重置/worktree 逻辑仍走生产函数。未执行真实网络克隆；临时测试文件在验证后删除。

## 1. 调整点 A：缺失目标识别与入队

涉及库.表：无（文件系统 + Git 仓库 + JSON 配置）。

### 1.1 用例

| 用例 | 消费方 | 输入锚点 | 预期结果 | 结论 |
| --- | --- | --- | --- | --- |
| T01 缺失目录补克隆 | `runIndexHealthCheck` / `loadWebhookInspectionTargets` / `cloneOrResetToBranch` | 临时 `repos.json` 条目 `JiuJi-JAVA/imservice`；目标 `repoPath` 不存在 | `cloneOrResetToBranch` 调用 1 次；目标 `.git` 存在；分析入队 1 次；日志含目标路径 | 通过（临时 bare 仓库 + 真实本地 clone；`.git` 出现、入队/分析各 1 次、日志含 repoPath） |
| T02 空目录补克隆 | 同上 | 目标 `repoPath` 存在但为空目录 | 判定为缺失；`cloneOrResetToBranch` 调用 1 次；目标 `.git` 存在 | 通过（空目录判定缺失并完成克隆） |
| T04 无 `cloneUrl` 跳过 | `runIndexHealthCheck` / `loadWebhookInspectionTargets` | `repos.json` 条目只有 `full_name`，无 `clone_url`；目标目录不存在 | 记录跳过日志；`cloneOrResetToBranch` 调用 0 次；巡检正常结束 | 通过（告警跳过，enqueue 0 次） |
| A-非空非 Git 目录 | `runIndexHealthCheck` / `cloneOrResetToBranch` | 目标目录存在且含普通文件，无 `.git` | 尝试 clone；clone 失败并记录错误；原目录内容不被删除；巡检继续 | 通过（clone 失败记录错误，原文件保留，继续处理） |

### 1.2 五类内容

- **存量数据**：远端 `repos.json` 的 `JiuJi-JAVA/imservice` 与 `JiuJi-JAVA/SPA-management`；仅作观察，不作为断言来源。
- **新增数据**：临时 `repos.json` 条目（`full_name`、`clone_url`、`branch`）；临时 bare 仓库；目标目录四种形态。
- **边界数据**：目录不存在；空目录；非空且无 `.git`；`clone_url` 为空；`branch` 不存在（由 clone 失败路径覆盖）。
- **权限数据**：不适用。巡检对账为服务内部行为，无角色/权限分支；用例直接调用 handler。
- **清理方式**：临时 `projectsRoot`、bare 仓库与目标目录在 `finally` 中递归删除；测试桩调用计数在每个用例 `beforeEach` 重置。

### 1.3 读取点覆盖

- `runIndexHealthCheck` 对 `repoPath/.git` 的缺失判定 → T01、T02、A-非空非 Git 目录。
- `loadWebhookInspectionTargets` 对 `cloneUrl` 的读取与空值跳过 → T04。
- `cloneOrResetToBranch` 的调用与失败记录 → T01、T02、A-非空非 Git 目录。

### 1.4 可重放只读 SQL

无。依据：本调整点只读取 JSON 配置、文件系统与 Git 仓库，不查询业务库。

## 2. 调整点 B：已有 `.git` 不补克隆

涉及库.表：无（文件系统 + Git 仓库）。

### 2.1 用例

| 用例 | 消费方 | 输入锚点 | 预期结果 | 结论 |
| --- | --- | --- | --- | --- |
| T03 已有 `.git` 跳过 | `runIndexHealthCheck` / `discoverProjectRepoPaths` | 目标 `repoPath` 为有效 Git 仓库；`repos.json` 条目存在 | `cloneOrResetToBranch` 调用 0 次；不出现 `reconcile missing webhook repo` 日志；既有注册/meta 逻辑不变 | 通过（missing 0、enqueue 0，无 reconcile 日志） |
| B-已注册仓库 | `discoverProjectRepoPaths` / 注册判定 | 目标已注册且有 meta | 沿用既有“已注册/有 meta”分支，不新增补克隆调用 | 不适用（本次未改动 discover/注册逻辑，既有路径未触碰） |
| B-非 webhook 目录 | `discoverProjectRepoPaths` | `projectsRoot` 下存在不在 `repos.json` 的 Git 目录 | 沿用既有“未注册且无 meta 则入队分析”的行为，不进入补克隆 | 不适用（本次未改动 discover 逻辑，既有路径未触碰） |

### 2.2 五类内容

- **存量数据**：远端已索引仓库目录与 registry/meta；仅作观察，不作为断言来源。
- **新增数据**：临时有效 Git 仓库；临时已注册/meta 夹具；临时非 webhook Git 目录。
- **边界数据**：有效 `.git`；已注册；有 meta；非 webhook 目录。
- **权限数据**：不适用。无角色/权限分支。
- **清理方式**：临时仓库与配置在 `finally` 中删除；注册/meta 夹具在每个用例重建。

### 2.3 读取点覆盖

- `runIndexHealthCheck` 对已有 `.git` 的跳过 → T03。
- `discoverProjectRepoPaths` 的既有发现逻辑 → B-已注册仓库、B-非 webhook 目录。
- 注册/meta 判定 → B-已注册仓库。

### 2.4 可重放只读 SQL

无。依据：本调整点只读取文件系统与 Git 元数据，不查询业务库。

## 3. 调整点 C：env worktree 补建

涉及库.表：无（文件系统 + Git worktree + JSON 配置）。

### 3.1 用例

| 用例 | 消费方 | 输入锚点 | 预期结果 | 结论 |
| --- | --- | --- | --- | --- |
| T05 env worktree 缺失 | `loadWebhookInspectionTargets` / `cloneOrResetToBranch` / `ensureLocalWorktree` | `repos.<env>.json` 条目；`mainRepoPath` 缺失；worktree `repoPath` 缺失 | 主仓被克隆；worktree 目录出现且含 `.git` 文件；分析入队 1 次 | 通过（真实本地 git：worktree 出现，分支 `dev-imservice`，入队 1 次） |
| C-主仓已存在 | 同上 | `mainRepoPath` 为有效 Git 仓库；worktree `repoPath` 缺失 | 主仓不重复克隆（计数 0）；worktree 被创建；分析入队 1 次 | 通过（主仓执行一次同步 fetch/reset，新建 clone 计数 0；worktree 创建、入队 1 次） |

### 3.2 五类内容

- **存量数据**：远端 `repos.<env>.json` 的 env 目标（如有）；仅作观察，不作为断言来源。
- **新增数据**：临时 `repos.<env>.json`；临时主仓 bare 仓库；临时 worktree 路径。
- **边界数据**：主仓缺失；主仓已存在；worktree 缺失；worktree 已存在（应跳过，不重复创建）。
- **权限数据**：不适用。无角色/权限分支。
- **清理方式**：worktree 与主仓临时目录在 `finally` 中删除；`git worktree prune` 由临时目录删除一并回收。

### 3.3 读取点覆盖

- `loadWebhookInspectionTargets` 对 `mainRepoPath` / `repoPath` 的 env 解析 → T05、C-主仓已存在。
- `cloneOrResetToBranch` 对主仓的补克隆 → T05、C-主仓已存在。
- `ensureLocalWorktree` 对 worktree 的创建 → T05、C-主仓已存在。

### 3.4 可重放只读 SQL

无。依据：本调整点只操作文件系统与 Git worktree，不查询业务库。

## 4. 调整点 D：clone 失败继续与下一轮重试

涉及库.表：无（Git 仓库 + 日志）。

### 4.1 用例

| 用例 | 消费方 | 输入锚点 | 预期结果 | 结论 |
| --- | --- | --- | --- | --- |
| T06 clone 失败继续 | `runIndexHealthCheck` / `cloneOrResetToBranch` | 目标 A `clone_url` 不可访问；目标 B 缺失且可访问 | A 记录失败日志；B 被成功克隆；巡检正常结束 | 通过（A 失败记录，B 克隆成功，巡检结束） |
| D-下一轮重试 | `runIndexHealthCheck` | 第一轮 A 失败；保留 A 的缺失状态 | 第二轮再次对 A 入队（每轮计数 1）；不新增失败隔离 | 通过（第二轮仅 A 再次入队 1 次） |
| D-单个目标不阻塞 | `runIndexHealthCheck` | 多个目标中仅 A 失败 | 其余目标全部处理；巡检总耗时不超过既有超时控制 | 通过（B 正常完成；无新增超时控制） |

### 4.2 五类内容

- **存量数据**：远端不存在的仓库或网络不可达样本；仅作失败来源参考。
- **新增数据**：无效 `clone_url`；有效 bare 仓库；两个目标的临时 `repos.json`。
- **边界数据**：单个失败；连续两轮失败；失败目标与成功目标混合。
- **权限数据**：不适用。无角色/权限分支；鉴权失败按 clone 失败路径覆盖。
- **清理方式**：临时目录在 `finally` 中删除；失败日志只存在于测试输出，不落盘。

### 4.3 读取点覆盖

- `runIndexHealthCheck` 对单目标失败的处理与继续 → T06、D-单个目标不阻塞。
- `cloneOrResetToBranch` 的错误返回/抛出 → T06。
- 下一轮巡检的重新入队 → D-下一轮重试。

### 4.4 可重放只读 SQL

无。依据：本调整点只触发 Git clone 并读取日志，不查询业务库。

## 5. 调整点 E：队列去重

涉及库.表：无（进程内队列）。

### 5.1 用例

| 用例 | 消费方 | 输入锚点 | 预期结果 | 结论 |
| --- | --- | --- | --- | --- |
| T07 并发送去重 | `enqueueWebhookAnalyze` / `WebhookAnalyzeQueue.enqueue` | 同一 `repoPath` 已有 active 或 pending 任务；巡检判定缺失 | `enqueue` 返回 `deferred`；巡检仅发起 1 次入队；同 key 最大 active 任务数 1；`deferred` 的后续运行按队列既有语义（pending 合并；active 且无 pending 时追加 1 次） | 通过（真实队列：deferred、巡检入队 1 次、maxActive 1、后续运行 2 次符合既有语义） |
| T07b 启动重放与巡检不重复 | `scheduleStartupWebhookRepos` / `runIndexHealthCheck` | 启动重放开启时同一缺失目标 | 巡检不对账，由重放覆盖并只入队 1 次；重放关闭（默认）时由巡检入队 1 次 | 通过（纯函数 3 项单测覆盖开/关与 manual；巡检接线源码断言通过） |
| E-不同路径不互斥 | `WebhookAnalyzeQueue.enqueue` | 两个不同 `repoPath` 同时缺失 | 两个路径分别入队；互不 `deferred` | 通过（T06 两路径均 accepted，无 deferred） |

### 5.2 五类内容

- **存量数据**：现有队列状态；仅作测试桩初始化参考。
- **新增数据**：active/pending 测试桩；两个不同路径的临时目标。
- **边界数据**：active 状态；pending 状态；相同路径；不同路径。
- **权限数据**：不适用。队列为进程内结构，无角色/权限分支。
- **清理方式**：每个用例重建队列实例；测试桩 `mockRestore`。

### 5.3 读取点覆盖

- `enqueueWebhookAnalyze` / `WebhookAnalyzeQueue.enqueue` 的 active/pending 去重 → T07、T07b、E-不同路径不互斥。
- `scheduleStartupWebhookRepos` 与 `runIndexHealthCheck` 的并发来源 → T07b。

### 5.4 可重放只读 SQL

无。依据：本调整点只读取进程内队列状态，不查询业务库。

## 6. 调整点 F：既有巡检与队列回归

涉及库.表：无（测试套件）。

### 6.1 用例

| 用例 | 消费方 | 输入锚点 | 预期结果 | 结论 |
| --- | --- | --- | --- | --- |
| T08 定向回归 | `api-index-health-check-async` / `startup-embedding-schedule` / `webhook-analyze-queue` 等既有测试 | 既有测试夹具 | 全部通过（exit 0）；并发/`JobManager`/队列持久化文件无改动 | 通过（5 files / 40 tests + 3 files / 171 tests；tsc 通过；diff 无队列/JobManager/持久化改动） |

### 6.2 五类内容

- **存量数据**：既有测试夹具与部署配置；现成。
- **新增数据**：无（回归用例不新增数据）。
- **边界数据**：无新增；沿用既有测试覆盖。
- **权限数据**：不适用。
- **清理方式**：既有测试自带清理逻辑；不新增清理步骤。

### 6.3 读取点覆盖

- 既有巡检 handler、启动调度、队列 → T08。
- 并发/`JobManager`/队列持久化相关文件 → T08。

### 6.4 可重放只读 SQL

无。依据：本调整点为代码回归测试，不查询业务库。

## 7. 配置键

无新增或修改配置键。既有 `GITNEXUS_STARTUP_WEBHOOK_REPOS_ENABLED` 默认值保持 `false`，本次不修改其读取方、存储位置或变更前后行为。

## 8. 消费方汇总

- `gitnexus/src/server/api.ts#runIndexHealthCheck`
- `gitnexus/src/server/api.ts#loadWebhookInspectionTargets`
- `gitnexus/src/server/api.ts#scheduleStartupWebhookRepos`
- `gitnexus/src/server/api.ts#discoverProjectRepoPaths`
- `gitnexus/src/server/api.ts#enqueueWebhookAnalyze`
- `gitnexus/src/server/git-clone.ts#cloneOrResetToBranch`
- `gitnexus/src/server/webhook-worktree.ts#ensureLocalWorktree`
- `gitnexus/src/server/webhook-analyze-queue.ts#WebhookAnalyzeQueue.enqueue`

## 9. 无 SQL 依据

本任务仅读取 `repos.json` / `repos.<env>.json`、检查文件系统、调用 Git clone/worktree，并向既有内存队列入队；不新增表、不更新业务数据、不写 Neo4j。索引产物写回由既有 `run-analyze` 流程负责。因此不提供 SQL 造数与清理脚本。

## 10. 验证记录

- 澄清阶段：用例已覆盖缺失、存在、无 `cloneUrl`、env worktree、clone 失败、队列去重与回归；结论待实现后由测试阶段逐条回填。
- 类型检查与定向测试命令：待实现后补充并回填 exit code。
- 未覆盖：真实远端 clone 的网络抖动、Gitea token 失效后的鉴权恢复；由部署后验证与下一次巡检重试覆盖。
