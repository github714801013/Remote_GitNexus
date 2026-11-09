# 索引落后与调度优化实现 — 测试数据基线

- 任务：`index-scheduling-optimization`
- 依据：`index-scheduling-optimization-澄清定稿.md`、`index-scheduling-optimization-验收条件与必测场景清单.md`
- 说明：本文件同时是本次需求的验收用例清单。测试阶段逐条执行用例并回填「结论」，取值：通过 / 失败 / 不适用。

## 0. 数据形态说明

本任务不读写业务数据库，不存在业务 SQL 造数。测试数据形态为：

- **registry 条目**（仓库注册表）：`{ repo, path, branch, lastCommit }`，通过既有注册入口或测试夹具构造。
- **Git 仓库夹具**：临时目录 + `git init` + 若干提交，用于 `checkStalenessAsync` 与分支判定。
- **进程内状态**：失败隔离集合、调度候选列表，通过工厂函数注入或在 `beforeEach` 重建。

## 1. 调整点 A：按差异降序 + 每轮最多 10 个

涉及库.表：无（内存调度 + Git 仓库）。

### 1.1 用例

| 用例 | 消费方 | 输入锚点 | 预期结果 | 结论 |
| --- | --- | --- | --- | --- |
| T01 差异降序 | `checkStalenessAsync` / `scheduleStaleAnalyze` | 夹具仓库 A 落后 340、B 落后 125 | A 的调度日志在 B 之前 | 通过 |
| T02 截断 10 | `scheduleStaleAnalyze` | 11 个 stale 仓库（落后数 110–200） | 本轮到日志 ≤ 10 条，按落后数取前 10 | 通过 |
| T05 阈值下行为 | `scheduleStaleAnalyze` | 夹具仓库 Y 落后 17 | Y 仍被调度 | 通过 |
| A-并列值 | `scheduleStaleAnalyze` | 两个仓库均落后 100 | 保持 registry 原相对顺序（稳定排序） | 通过 |
| A-零值与负值 | `checkStalenessAsync` | `commitsBehind = 0`、HEAD 领先 lastCommit | 不进入候选 | 通过 |

### 1.2 五类内容

- **存量数据**：远端 registry（10.1.14.158 容器内）dev-oanew、dev-nc-segments、9ji-admin 等 35–48 条；仅作观察基线，不作为断言来源。
- **新增数据**：夹具仓库落后 340 / 125 / 17 三种提交数；11 个仓库的批量候选集。
- **边界数据**：并列落后值；恰好 11 个候选；`commitsBehind = 0`；HEAD 领先 lastCommit。
- **权限数据**：不适用。巡检接口无角色分支，用例直接调用 handler。
- **清理方式**：临时 Git 仓库在 `finally` 中删除；候选列表随测试进程结束回收。

### 1.3 读取点覆盖

- `checkStalenessAsync` 的 `commitsBehind` 返回值 → T01、T02、T05、A-零值与负值。
- `scheduleStaleAnalyze` 的候选排序与截断 → T01、T02、A-并列值。

### 1.4 可重放只读 SQL

无。依据：本调整点只读取进程内 registry 与 Git 仓库，不查询业务库。

## 2. 调整点 B：跨分支假差异跳过

涉及库.表：无（registry 字段 + Git 分支）。

### 2.1 用例

| 用例 | 消费方 | 输入锚点 | 预期结果 | 结论 |
| --- | --- | --- | --- | --- |
| T03 跨分支跳过 | 巡检分支判定 | `oa-order` registry.branch=`release_9ji`，checkout 分支不同 | 日志含跳过记录（仓库名 + 两个分支值），不出现调度记录 | 通过 |
| B-一致分支 | 巡检分支判定 | 夹具仓库 A：checkout 与 registry.branch 均为 `main` | 不跳过，进入候选 | 通过 |
| B-detached HEAD | 巡检分支判定 | 夹具仓库 `git checkout <sha>` | 视为不一致并跳过，日志标注 `detached` | 通过 |
| B-空分支 | 巡检分支判定 | registry.branch 为空/未设置 | 保持原有调度行为（不跳过） | 通过 |

### 2.2 五类内容

- **存量数据**：远端真实条目 `oa-order`（registry 分支 `release_9ji`，checkout 分支不同）。
- **新增数据**：夹具仓库 A（一致分支）、detached HEAD 仓库。
- **边界数据**：detached HEAD；registry.branch 为空。
- **权限数据**：不适用。仅执行只读 Git 命令，无权限分支。
- **清理方式**：夹具仓库在 `finally` 中删除；分支切换随仓库删除回收。

### 2.3 读取点覆盖

- `git rev-parse --abbrev-ref HEAD` 与 `registry.branch` 比较 → T03、B-一致分支、B-detached HEAD、B-空分支。

### 2.4 可重放只读 SQL

无。依据：本调整点只读取 registry 字段与 Git 分支名，不查询业务库。

## 3. 调整点 C：失败隔离

涉及库.表：无（进程内集合）。

### 3.1 用例

| 用例 | 消费方 | 输入锚点 | 预期结果 | 结论 |
| --- | --- | --- | --- | --- |
| T04 失败隔离 | 巡检失败回调 + 下一轮候选过滤 | 测试桩令仓库 X 分析失败一次 | 第二轮 X 不出现调度日志，出现隔离跳过记录 | 通过 |
| T06 webhook 不受影响 | webhook 入口 | X 已在隔离集合中，发送 X 的 push 事件 | webhook 返回 2xx，队列出现 X 的 job | 通过 |
| T08 重启清空 | 调度器实例重建 | X 在进程 A 中被隔离，重建实例 | X 重新进入候选判断 | 通过 |
| C-重复失败 | 隔离集合 | 同一仓库连续失败两次 | 集合幂等，不重复记录 | 通过 |

### 3.2 五类内容

- **存量数据**：远端 7 天日志中 unowned storage 失败样本（oanew 等 24 次），仅作失败来源参考。
- **新增数据**：`enqueueWebhookAnalyze` 失败测试桩；初始为空的隔离集合。
- **边界数据**：同一仓库重复失败；进程重启后的空集合。
- **权限数据**：不适用。失败隔离为服务内部状态，无角色差异。
- **清理方式**：每个用例 `beforeEach` 重建调度器实例；失败桩 `mockRestore`。

### 3.3 读取点覆盖

- `enqueueWebhookAnalyze` 失败回调 → T04、C-重复失败。
- 巡检候选过滤对隔离集合的读取 → T04、T08。
- webhook 入口不读取隔离集合 → T06。

### 3.4 可重放只读 SQL

无。依据：本调整点只维护进程内集合，不写业务库。

## 4. 消费方汇总

- `checkStalenessAsync`（`gitnexus/src/core/git-staleness.ts`）
- `scheduleStaleAnalyze` / `enqueueWebhookAnalyze`（`gitnexus/src/server/api.ts`）
- 巡检分支判定（`git rev-parse --abbrev-ref HEAD` + `registry.branch`）
- webhook 入口（`POST /api/webhook/...`）

## 5. 无 SQL 依据

本任务仅调整内存调度顺序、截断数量、跳过条件与进程内失败集合，不新增表、不更新 registry 持久化文件、不写 Neo4j；索引产物写回由既有 `run-analyze` 流程负责。因此不提供 SQL 造数与清理脚本。

## 6. 验证记录

- 环境：Node v22.22.1、vitest 5.0.5、win32-x64
- 类型检查：`cd gitnexus && npx tsc --noEmit -p tsconfig.json` → exit 0
- 定向测试：`cd gitnexus && npx vitest run test/unit/stale-analyze-scheduler.test.ts test/unit/api-readonly-wiring.test.ts test/unit/api-index-health-check-async.test.ts test/unit/startup-embedding-schedule.test.ts test/unit/webhook-analyze-queue.test.ts test/unit/resource-aware-concurrency.test.ts` → 6 files / 40 tests passed，exit 0
- 自动化单测覆盖：T01、T02、T05、A-并列值、A-零值与负值、T03 的分支判定逻辑、B-一致分支、B-detached HEAD、B-空分支、T04 的失败过滤、T08 的新失败集合
- 静态核对覆盖：T03 跳过日志字段（repo/indexBranch/checkoutBranch）、T04 隔离日志与失败集合写入、T06 webhook 入口不引用隔离集合或选择器、T07 并发与单槽相关文件无改动、C-重复失败依赖 `Set` 幂等语义
- 未执行项：无。全量测试按阶段规范不执行，不计入验收用例。
- 备注：T06 的 HTTP 2xx 运行时链路未单独启动服务验证，以“webhook 路径不读取新增状态 + 既有队列测试通过”作为结构证据。
