# 缺失 webhook 仓库自动补克隆与索引 — 二次开发改动面

- 任务：`missing-webhook-repo-reconcile`
- 日期：2026-11-07
- 仓库拓扑：`origin` = `github714801013/GitNexus`（fork），`upstream` = `abhigyanpatwari/GitNexus`
- 结论：属于 fork 二次开发；本次在既有巡检入口增加缺失目标对账，新增本地独立对账模块以缩小上游耦合面。

## 1. 上游基线

- 上游基线 SHA：`02101fdfed84059bb03c24081148f3e63ba092a0`（`git merge-base HEAD upstream/main`，即 `upstream/main` 当前提交）。
- 当前 HEAD：`9ca5849e85d6b034cacdb206b6dd7272fd5d64db`。
- 当前分支：`xiexiongkun/source-customization-v1.6.13-rc.182`，跟踪 `origin/xiexiongkun/source-customization-v1.6.13-rc.182`，未配置 upstream 跟踪分支。
- 同步策略：沿用仓库既有的 upstream 合并方式；本任务不改变同步策略。

## 2. 本地新增文件

- `docs/engineering/specs/missing-webhook-repo-reconcile-spec.md`（本任务规格）
- `docs/engineering/specs/missing-webhook-repo-reconcile-customization-points.md`（本文档）
- `docs/engineering/plans/missing-webhook-repo-reconcile-澄清定稿.md`（已落盘）
- `docs/engineering/plans/missing-webhook-repo-reconcile-验收条件与必测场景清单.md`（已落盘）
- `docs/engineering/plans/missing-webhook-repo-reconcile-测试数据.md`（已落盘）
- `gitnexus/src/server/webhook-repo-reconciler.ts`（计划新增：缺失判定、对账编排、clone/worktree 回调构造）
- `gitnexus/test/unit/webhook-repo-reconciler.test.ts`（计划新增：对账模块单测）

## 3. 触及的上游文件与符号

| 文件 | 符号 | 改动性质 |
| --- | --- | --- |
| `gitnexus/src/server/api.ts` | `runIndexHealthCheck` | 读取 webhook 目标后调用对账函数；既有目录发现、注册、staleness、embedding 逻辑不变 |
| `gitnexus/src/server/api.ts` | `scheduleStartupWebhookRepos` | 内联 clone/worktree 回调改为复用新模块的回调构造器，行为不变 |
| `gitnexus/src/server/api.ts` | import 区 | 新增引用本地对账模块 |

### 复用但未修改的上游符号

| 文件 | 符号 | 用途 |
| --- | --- | --- |
| `gitnexus/src/server/api.ts` | `loadWebhookInspectionTargets` | 读取普通与 env 目标 |
| `gitnexus/src/server/api.ts` | `enqueueWebhookAnalyze` | 按路径入队与 active/pending 去重 |
| `gitnexus/src/server/api.ts` | `discoverProjectRepoPaths` | 既有目录发现逻辑，保持不变 |
| `gitnexus/src/server/git-clone.ts` | `cloneOrResetToBranch` | 缺失 `.git` 时 clone，已有 `.git` 时 fetch/reset |
| `gitnexus/src/server/webhook-worktree.ts` | `ensureLocalWorktree` | env 目标 worktree 创建与分支校验 |

### 上游核心文件修改说明（`api.ts`）

- **扩展点不足的事实**：`runIndexHealthCheck` 没有用于“配置目标 vs 本地目录”对账的 hook、插件或配置入口；`scheduleStartupWebhookRepos` 受 `GITNEXUS_STARTUP_WEBHOOK_REPOS_ENABLED` 控制且默认关闭，无法覆盖运行期间目录丢失，也不能单独作为扩展点。
- **最小范围**：仅在 `runIndexHealthCheck` 读取 webhook 目标的位置增加一次对账调用；仅在 `scheduleStartupWebhookRepos` 中把内联回调替换为共享构造器；不改路由、响应结构、注册表结构、队列实现或公开导出。
- **受影响接口与调用方**：`runIndexHealthCheck` 为 `createServer` 内局部函数，无外部调用方；`POST /api/index-health-check` 的 202 响应与异步语义不变；`scheduleStartupWebhookRepos` 的调用条件、参数与失败日志不变。
- **兼容策略**：已有 `.git` 的仓库不进入补克隆；无 `cloneUrl` 只跳过；webhook 入口、启动重放、队列去重与并发模型均不改；env 回调参数与原实现逐项一致。
- **耦合方式**：对账规则与回调构造放入本地独立模块，`api.ts` 只做最小接线，属适配层接入；业务规则不嵌入上游核心流程。
- **升级时判断**：保留该补丁；上游若重构巡检循环或启动重放，按“读取目标 → 缺失判定 → 构造回调 → 入队”四段重新接线，对账模块可原样复用；上游若自身提供等价的缺失仓库对账，删除本地补丁与模块。

## 4. 升级时判断与验证入口

- **保留**：本地对账模块、单测、`api.ts` 的最小接线补丁。
- **重写条件**：`WebhookInspectionTarget` 字段、`enqueueWebhookAnalyze` 入队参数或 `ensureLocalWorktree` 参数变化时，重写回调构造器；对账选择逻辑不变。
- **删除条件**：上游自身实现“巡检发现配置目标缺失并补克隆/补 worktree”且行为等价时，删除本地补丁与模块。
- **验证入口**：
  - `git merge-base HEAD upstream/main` 确认基线仍为 `02101fdfed84059bb03c24081148f3e63ba092a0`（或更新后的新基线）。
  - `git diff --stat upstream/main...HEAD -- gitnexus/src/server/api.ts` 确认改动仍限于巡检与启动重放片段。
  - `cd gitnexus && npx tsc --noEmit -p tsconfig.json`
  - `cd gitnexus && npx vitest run test/unit/webhook-repo-reconciler.test.ts`
  - `cd gitnexus && npx vitest run test/unit/api-index-health-check-async.test.ts test/unit/startup-embedding-schedule.test.ts test/unit/webhook-analyze-queue.test.ts`

## 5. 复现测试

- 单元测试：`cd gitnexus && npx vitest run test/unit/webhook-repo-reconciler.test.ts`
- 回归测试：`cd gitnexus && npx vitest run test/unit/api-index-health-check-async.test.ts test/unit/startup-embedding-schedule.test.ts test/unit/webhook-analyze-queue.test.ts`
- 类型检查：`cd gitnexus && npx tsc --noEmit -p tsconfig.json`
- 场景复现：构造“目标目录缺失”“空目录”“已有 `.git`”“无 `cloneUrl`”“env worktree 缺失”“clone 失败”“队列已有同路径任务”七类夹具，断言对账函数的入队/跳过/失败分支；不启动服务、不触碰真实远端。
