# 缺失 webhook 仓库自动补克隆与索引 — 验收条件与必测场景清单

- 任务：`missing-webhook-repo-reconcile`
- 依据：`missing-webhook-repo-reconcile-澄清定稿.md`
- 编号规则：验收 1..N，不跳号；下游引用本编号。

## 验收条件

### 验收 1 — 缺失目录自动补克隆并进入分析

- 现象：`repos.json` 中已登记、但 `projectsRoot` 下目录不存在的仓库，巡检后自动出现目录并进入分析队列。
- 前置：临时 `projectsRoot`；`repos.json` 含一条 `JiuJi-JAVA/imservice`，`clone_url` 指向可访问的本地 bare 仓库，`branch=master`；目标 `repoPath` 不存在。
- 动作：触发 `runIndexHealthCheck`（启动、手动 `POST /api/index-health-check` 或单元测试直接调用 handler）。
- 可观测结果：目标目录出现（判定方式：存在 =）；目标 `repoPath/.git` 出现（判定方式：存在 =）；`cloneOrResetToBranch` 被调用 1 次（判定方式：计数 = 1）；分析入队 1 次（判定方式：计数 = 1）；日志含目标路径与 `reconcile missing webhook repo`（判定方式：⊇ 包含）。
- 维度：正向、一致性；覆盖层级：接口 + 日志 / 组件层；覆盖用例：T01；数据可复用：是；数据准备：需造（临时 bare 仓库 + 临时 `repos.json`）。

### 验收 2 — 目录存在但 `.git` 缺失时补克隆

- 现象：目标目录存在但为空目录或缺少 `.git` 时，巡检仍判定为缺失并补克隆。
- 前置：目标 `repoPath` 存在但为空目录；`repos.json` 条目与验收 1 相同。
- 动作：触发一次巡检。
- 可观测结果：`cloneOrResetToBranch` 被调用 1 次（判定方式：计数 = 1）；目标 `.git` 出现（判定方式：存在 =）；日志含缺失判定与目标路径（判定方式：⊇ 包含 `repoPath`）。
- 维度：边界；覆盖层级：组件层；覆盖用例：T02；数据可复用：是；数据准备：需造（空目录 + 临时 `repos.json`）。

### 验收 3 — 已有 `.git` 的仓库不被补克隆或重置

- 现象：已存在有效 `.git` 的仓库不进入补克隆，不触发 fetch/reset/clean，原有分析/注册/跳过逻辑保持不变。
- 前置：目标 `repoPath` 已是有效 Git 仓库（含 `.git`）；`repos.json` 条目与验收 1 相同。
- 动作：触发一次巡检。
- 可观测结果：`cloneOrResetToBranch` 对该路径调用次数为 0（判定方式：计数 = 0）；不出现 `reconcile missing webhook repo` 日志（判定方式：不出现 =）；既有 `discoverProjectRepoPaths` 路径行为不变（判定方式：既有测试通过 =）。
- 维度：兼容回归；覆盖层级：组件层；覆盖用例：T03；数据可复用：是；数据准备：需造（有效 Git 仓库 + 临时 `repos.json`）。

### 验收 4 — 无 `cloneUrl` 的目标跳过且不报错

- 现象：配置中存在缺失目录但没有 `clone_url` 的目标时，巡检记录跳过原因并继续，不抛异常。
- 前置：`repos.json` 条目只含 `full_name`，无 `clone_url`；目标 `repoPath` 不存在。
- 动作：触发一次巡检。
- 可观测结果：巡检正常完成（判定方式：无异常 / HTTP 2xx =）；日志含目标路径与跳过原因（判定方式：⊇ 包含 `cloneUrl` 或 `skip`）；`cloneOrResetToBranch` 调用次数为 0（判定方式：计数 = 0）。
- 维度：逆向；覆盖层级：接口 + 日志 / 组件层；覆盖用例：T04；数据可复用：是；数据准备：需造（临时 `repos.json`）。

### 验收 5 — env worktree 缺失时补主仓并重建 worktree

- 现象：`repos.<env>.json` 中的 env 目标 worktree 路径缺失时，巡检先补主仓，再创建 worktree，最后进入分析。
- 前置：`repos.<env>.json` 含一条 env 目标；`mainRepoPath` 存在或缺失；worktree `repoPath` 不存在。
- 动作：触发一次巡检。
- 可观测结果：`mainRepoPath` 存在且含 `.git`（判定方式：存在 =；若前置已存在则执行一次同步 fetch/reset，判定方式：新建 clone 计数 = 0）；worktree `repoPath` 存在且含 `.git` 文件（判定方式：存在 =）；分析入队 1 次（判定方式：计数 = 1）；日志含 worktree 路径（判定方式：⊇ 包含）。
- 维度：边界、一致性；覆盖层级：组件层；覆盖用例：T05；数据可复用：否（worktree 创建改变状态，需独立临时目录）；数据准备：需造（主仓 bare 仓库 + env 配置）。

### 验收 6 — 补克隆失败记录后继续，下一次巡检重试

- 现象：单个目标 clone 失败不会中断巡检；其他目标继续处理；下一次巡检会再次尝试失败目标。
- 前置：目标 A 的 `clone_url` 不可访问；目标 B 缺失且 `clone_url` 可访问；两个目标均在 `repos.json`。
- 动作：连续触发两次巡检。
- 可观测结果：第一次巡检中 A 出现失败日志且含错误原因（判定方式：⊇ 包含 `repoPath` + `error`/`failed`）；B 被成功克隆（判定方式：`.git` 存在 =）；巡检正常结束（判定方式：无异常 =）；第二次巡检再次对 A 入队（判定方式：入队计数 = 1/次）。
- 维度：逆向、状态；覆盖层级：组件层；覆盖用例：T06；数据可复用：否（失败状态影响后续轮次）；数据准备：需造（无效 URL + 有效 bare 仓库）。

### 验收 7 — 与 webhook/启动重放并发时按路径去重

- 现象：同一路径已有 active/pending 队列任务时，巡检不重复入队。
- 前置：`WebhookAnalyzeQueue` 中同一 `repoPath` 已有 active 或 pending 任务；巡检判定该路径缺失。
- 动作：触发巡检。
- 可观测结果：巡检对该路径仅调用 1 次入队（判定方式：计数 = 1）；`enqueueWebhookAnalyze` 返回 `deferred`（判定方式：值 = `deferred`）；同 key 最大 active 任务数为 1，不出现并行重复 job（判定方式：计数 = 1）；`deferred` 的后续运行为队列既有语义（pending 合并，active 且无 pending 时在当前任务结束后追加 1 次），本次不改队列。
- 维度：并发、一致性；覆盖层级：组件层；覆盖用例：T07；数据可复用：否（队列状态需重置）；数据准备：需造（队列测试桩 + 临时 `repos.json`）。

### 验收 8 — 既有巡检、队列与并发行为不回归

- 现象：本次改动不影响既有巡检、队列、启动分析调度与并发模型。
- 前置：既有测试文件与部署配置不变；`GITNEXUS_STARTUP_WEBHOOK_REPOS_ENABLED` 保持默认值。
- 动作：运行定向测试（`api-index-health-check-async`、`startup-embedding-schedule`、`webhook-analyze-queue` 及相关单测）。
- 可观测结果：定向测试全部通过（判定方式：exit code = 0）；并发/`JobManager`/队列持久化相关文件无改动（判定方式：diff 文件集 = 空）。
- 维度：兼容回归；覆盖层级：组件层；覆盖用例：T08；数据可复用：是；数据准备：现成（既有测试夹具）。

## 维度覆盖检查

| 维度 | 覆盖情况 |
| --- | --- |
| 正向 | 验收 1 |
| 逆向 | 验收 4、6 |
| 边界 | 验收 2、5 |
| 并发 | 验收 7 |
| 一致性 | 验收 1、5、7 |
| 权限 | 不适用：巡检对账为服务内部行为，无角色/权限差异 |
| 兼容回归 | 验收 3、8 |

## 数据属性汇总

- 可复用为「否」的场景（验收 5、6、7）必须在 e2e/TDD 中声明 `depends_on`，按串行执行，不可重跑。
- 覆盖用例编号 T01–T08 与测试数据基线文件对应。
- 验收 1 的“索引节点”由既有分析链路产生；单元测试以分析入队与回调调用为断言，接口级验证可选。
