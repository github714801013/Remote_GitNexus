# 索引分支与克隆检出分支不一致（branch mismatch 跳过追平）— GitNexus 调研记录

- 任务：`branch-mismatch-gitnexus-inquiry`
- 分支：`xiexiongkun/source-customization-v1.6.13-rc.215`
- 调研时 HEAD：`ae2657d280f7d27ef964bdacd1d5cb22c5a39ca1`
- 调研时间：2026-11-09 11:10 – 11:26（本地时间，逐次命令均带时间戳执行）
- 调研范围：仅当前工作区源码只读核验 + 本地 GitNexus CLI 图谱查询 + GitHub 公开代码检索；不修改任何源码。
- 现象来源：远端生产服务 2026-11-09 日志（68 仓 45 落后；11 个仓库持续输出 `Stale index analyze skipped: branch mismatch`，indexBranch 与 checkoutBranch 成对错位，如 oa-stock indexBranch=release_9ji / checkoutBranch=dev）。

## 1. GitNexus 主查询与降级记录

1. 首选项目推荐入口 `node .gitnexus/run.cjs query --help`：
   - 失败：`ERR_MODULE_NOT_FOUND: ... npm-cache\_npx\e46929201c1128dd\node_modules\gitnexus\dist\cli\update-notice.js`（`.gitnexus/run.cjs` 自动选中的 npx 缓存安装不完整）。
2. 降级为本地构建产物 CLI（`node gitnexus/dist/cli/index.js`，版本即当前源码），`query --help` 正常。
3. 主查询（2026-11-09 11:10:12）：
   - 命令：`node gitnexus/dist/cli/index.js query "registry entry branch written updated vs clone checkout branch mismatch stale analyze" --repo GitNexus --limit 8`
   - 结果：`processes/definitions/matches` 全空；附带降级警告 `FTS extension failed to load`、`VECTOR extension unavailable`（load-only policy，本地库未装 fts/vector 扩展），bm25/vector 计时正常但无命中。
4. 符号复核 `context`（同一 CLI）：
   - `runIndexHealthCheck`：命中 `Function:gitnexus/src/server/api.ts:runIndexHealthCheck`，索引行号 1358-1478（工作树实际 1769-1962，索引陈旧，行号不作为定位依据）；incoming.calls=`createServer`。
   - `registerRepo`：歧义 2 候选，均指向 `gitnexus/src/storage/repo-manager.ts:915`（索引行号）。
   - `cloneOrResetToBranch`：命中 `gitnexus/src/server/git-clone.ts:503-541`（索引行号；工作树实际 1039）；incoming.calls=`createServer`、`queued`。
   - `ensureLocalWorktree`：命中 `gitnexus/src/server/webhook-worktree.ts:248`（工作树实际 269）。
   - `isKnownBranchMismatch`、`buildWebhookBranchByPath`、`syncWithUpstream`：`Symbol not found`——本地索引建于 2026-07-24（`main` 分支、`lastCommit=4d50bd7a`，见 `.gitnexus/gitnexus.json`），早于当前定制分支，未收录这些新增/改动符号。
5. `impact "cloneOrResetToBranch" --direction upstream`：impactedCount=3，risk=LOW，上游 `createServer`（api webhook 路由），与源码核验一致。
6. 结论：图谱仅用于调用关系佐证；所有行号与逻辑以当前 HEAD 源码为准（source: local_search / authority: non_gitnexus，已按索引陈旧风险披露）。

## 2. 关键代码事实（file:line + symbol，均为当前工作树）

### 2.1 registry / 巡检侧：branch 从哪里读

- `gitnexus/src/server/api.ts:1824` `runIndexHealthCheck` 内：`registryBranch = webhookBranchByPath.get(path.resolve(entry.path)) ?? entry.branch`——主仓路径优先取 webhook 配置分支，其次 registry entry.branch。
- `gitnexus/src/server/api.ts:1778-1779` → `loadWebhookInspectionTargets`（`api.ts:328-375`）：主仓分支只来自 `repos.json`（332 行），env 分支来自 `repos.<env>.json`（336-343 行，`ENV_REPOS_FILE_RE` 299 行）。
- `gitnexus/src/server/stale-analyze-scheduler.ts:22-31` `buildWebhookBranchByPath`：`if (target.env) continue`——env worktree 分支被有意排除，主仓路径的"索引分支"恒等于 `repos.json.branch`。
- `gitnexus/src/server/stale-analyze-scheduler.ts:34-37` `isKnownBranchMismatch`：`Boolean(indexBranch) && currentBranch !== indexBranch`——纯字符串比较，不做祖先/同步判断。
- `gitnexus/src/server/api.ts:1885-1897`：`shouldScheduleStartupIncrementalAnalyze(staleness)`（定义 293-296 行，`isStale && commitsBehind > 0`）为真时，取 `getCurrentBranchAsync(entry.path)`（`gitnexus/src/storage/git.ts:760-773`，`git rev-parse --abbrev-ref HEAD`，detached 返回 null → 日志打印 `detached`），与 registryBranch 不一致则打日志 `Stale index analyze skipped: branch mismatch` 并 `continue`——本进程生命周期内该仓不再获得任何追平机会（巡检只在启动与手动 POST /api/index-health-check 时运行，`api.ts:1969-1978`）。
- registry entry.branch 写入：`gitnexus/src/core/run-analyze.ts:1506` `branchLabel = options.branch ?? checkedOutBranch`（注释明确"调用方负责让分支处于检出状态"，另见 `gitnexus/src/server/analyze-launch.ts:70-82`）→ `run-analyze.ts:3958/6243` `branch: branchLabel ?? existingMeta?.branch` 写入 meta → `gitnexus/src/storage/repo-manager.ts:1156` `registerRepoUnlocked` 主槽刷新 `...(meta.branch ? { branch: meta.branch } : {})`。即 entry.branch = 上一次主仓 analyze 完成时实际检出的分支。

### 2.2 克隆检出侧：谁把主仓切到 dev/test/test-new

- `gitnexus/src/server/git-clone.ts:1039-1080` `cloneOrResetToBranch(url, targetDir, branch)`：对已存在克隆执行 `buildWebhookBranchSyncCommands`（`git-clone.ts:1082-1094`），其中第 1090 行 `['checkout', '-B', branch, remoteRef]` **强制把该目录的 HEAD 切到传入分支**（前面还有 fetch/reset --hard/clean，`.gitnexus` 目录被保留）。
- **路径 A（证据强度：强，代码确定）** `gitnexus/src/server/api.ts:2908-2934` `POST /webhook/:env/index`：
  - 2914 行 `sourceBranch = repo.branch || 'master'`（分支取自 push 事件 ref，`parseGiteaWebhookRepo` `webhook-worktree.ts:93-95` 截 `refs/heads/` 后缀）；
  - 2922-2926 行 `upsertWebhookRepoConfig(getWebhookEnvReposFile(projectsRoot, env), ...)`——只写 `repos.<env>.json`，**不写 `repos.json`**；
  - 2927 行 `await cloneOrResetToBranch(repo.cloneUrl, mainRepoPath, sourceBranch)`——**在主仓共享克隆上**检出 env push 分支（为后续 `ensureLocalWorktree` 提供 base，2928-2934 行）；
  - 2944-2949 行 analyze 只注册 worktreePath（registryName=`env-<project>`，`webhook-worktree.ts:51-55`），主仓路径的 registry entry 与 `repos.json` 均不被更新。
  - 净效果：一次 env 分支（dev/test/test-new）push 后，主仓检出=env 分支，索引分支=主 webhook 分支，且无任何代码把二者重新对齐。
- **路径 B（证据强度：强，代码确定；触发条件依赖远端配置）** 启动重放/缺失对账：`gitnexus/src/server/api.ts:1739-1753` `enqueueWebhookTarget` 用 `createWebhookBeforeAnalyze(target, { cloneOrReset: cloneOrResetToBranch, ... })`；`gitnexus/src/server/webhook-repo-reconciler.ts:106-123` 对 env 目标执行 `cloneOrReset(cloneUrl, target.mainRepoPath, target.branch)`（115 行）——与路径 A 相同的主仓切分支副作用。`scheduleStartupWebhookRepos`（`api.ts:1755-1763`）按 `loadWebhookInspectionTargets` 顺序（repos.json 在前、`repos.<env>.json` 按文件名排序在后，`api.ts:331-343`）入队全部目标：主仓目标先被切回主分支，随后每个 env 目标又把主仓切到各自 env 分支，**重放结束后主仓稳定停留在最后一个 env 配置的分支**。开关 `shouldScheduleStartupWebhookRepos`（`api.ts:424-425`，默认 false）；2026-11-07 调研记录（`missing-webhook-repo-reconcile-gitnexus-inquiry.md` §3.2）核对远端 docker-compose 为 `${GITNEXUS_STARTUP_WEBHOOK_REPOS_ENABLED:-false}`。若该值仍为 false，路径 B 仅在缺失对账时对"目录不存在的目标"生效（`webhook-repo-reconciler.ts:56` 存在即 `continue`），已存在的主仓不会被它切换——此时错位完全由路径 A（活跃 env push）产生。
- **非生产者排除（证据强度：强）**：
  - `syncWithUpstream`（`gitnexus/src/core/git-staleness.ts:209-255`，巡检在 `api.ts:1835` 每个 entry 调用）：只解析 `@{upstream}`（当前检出分支的 upstream，211-221 行）并 `fetch` + `reset --hard @{upstream}`（238-239 行）——**不切换分支**，dev 检出就永远跟随 origin/dev，不会回到 release_9ji；它是"错位持续存在"的固化因素，不是错位的制造者。
  - `POST /webhook/gitea`（`api.ts:2853-2877`）：push 分支同时写 `repos.json`（2859-2863）并 `cloneOrResetToBranch(repoPath, branch)`（2875）并注册同一分支——三者一致，属自愈路径。生产日志 indexBranch≠checkoutBranch 恰说明最后一次切换不是它做的。
  - `cloneOrPull`（`git-clone.ts:544` 起，内部 `checkout -B` 497 行）：作用于 CLONE_ROOT（`~/.gitnexus/repos`，`getCloneDir`）——`POST /api/repo` 远程 URL 分析（`api.ts:3126`）与 auto-sync（`gitnexus/src/core/auto-sync/runner.ts:677-690` `syncFirstAvailableBranch`）的工作目录，与 PROJECTS_ROOT 下的 webhook 主仓是不同目录族，不参与本现象（前提：远端 auto-sync 未把 cloneRoot 配到 PROJECTS_ROOT，见未确认项）。
- 巡检补跑 analyze 也不修复：`api.ts:1937-1944` `enqueueWebhookAnalyze(entry.path, {..., registryBranch})` 未传 beforeAnalyze（`api.ts:1463-1484` 第三参可选）——即便没有分支闸门，它也是对"当前检出内容"重建索引；分支闸门（2.1）因此实际上是把这类跨分支索引永久挡在门外，同时把错位仓库永久排除在追平之外。

### 2.3 为什么 commitsBehind 异常巨大

- `api.ts:1847-1849`：`checkStalenessAsync(entry.path, entry.lastCommit)`（`git-staleness.ts:170-203`）执行 `git rev-list --left-right --count lastCommit...HEAD`——lastCommit 属 release_9ji，HEAD 属 dev，跨分支历史差计入 behind 侧，得到 6847 之类的巨大值；`/api/repos` 的 branch 字段与 staleness 因此相互矛盾（branch=索引分支，commitsBehind=与克隆 HEAD 的比较）。

## 3. 项目仓同类实现检索（本仓库内其他分支一致性处理）

- `ensureLocalWorktree`（`gitnexus/src/server/webhook-worktree.ts:269-315`）：对 **worktree 路径**有校验 `currentBranch !== params.branch → 409`（295-298 行），但对 **mainRepoPath** 只做 `git worktree add`（287-292 行，在 mainRepoPath 上执行但不改其 HEAD）。即代码库自身已意识到"分支应与槽位一致"，只是该校验没有覆盖"共享主仓克隆"这一角色。
- `copyBootstrapIndex`（`webhook-worktree.ts:330-355`）：写 meta.branch=worktree 分支并注册 worktreePath——同样不回写主仓 entry。
- auto-sync（`gitnexus/src/core/auto-sync/runner.ts:80-81/356-372`）：同步后按"实际检出分支"注册（`repoResult.branch`），并在注释（361-363 行）中承认"branch 回落会让 flat 槽位被打上 tick 同步到的分支"这一已知混乱；其目录族与本项目 webhook 克隆隔离，不构成同一现象的修复参照。

## 4. GitHub 公开代码检索（gh search code，均不含内部项目名/地址/凭据）

| 时间 | 查询词 | 结果 |
| --- | --- | --- |
| 2026-11-09 11:21:19 | `gitnexus branch mismatch staleness` | 无命中（`[]`） |
| 2026-11-09 11:21:28 | `repository index branch checkout mismatch` | 无命中（`[]`） |
| 2026-11-09 11:21:28 | `webhook worktree shared clone checkout -B index branch` | 无命中（`[]`） |
| 2026-11-09 11:21:52 | `shared clone worktree per environment webhook index` | 无命中（`[]`） |

公开检索未给出可直接对照的同类实现；结论完全依据本仓库代码事实。

## 5. 根因结论与证据链

**根因**：env 索引流程把主仓共享克隆同时当作 worktree 基座使用——每次 env push（`api.ts:2927`）以及开启时的启动重放（`webhook-repo-reconciler.ts:115`）都会 `git checkout -B <env分支>` 主仓（`git-clone.ts:1090`），但只更新 `repos.<env>.json` 和 env worktree 的注册信息，从不回写主仓 entry.branch / `repos.json`；而启动巡检以 `repos.json`（或 entry.branch）为"索引分支"、以 `getCurrentBranchAsync` 为"检出分支"做纯字符串比对（`api.ts:1824/1887`），两者从此必然错位，`isKnownBranchMismatch` 命中后该仓在本进程内永久跳过追平。`syncWithUpstream` 只跟随当前检出分支的 upstream（`git-staleness.ts:211-239`），既不切回索引分支也不消除错位，反而把"停在 dev/test"固化为常态；跨分支的 `rev-list lastCommit...HEAD` 则解释了 commitsBehind 的异常巨值。

**证据链摘要**（强=代码确定路径；中=依赖远端配置触发）：
1. 强：`api.ts:2908-2934` env 路由 → `git-clone.ts:1082-1094` `checkout -B` 主仓；配置只进 `repos.<env>.json`（`api.ts:2922`）。
2. 强：`webhook-repo-reconciler.ts:106-123` 重放/对账对 env 目标重复同一主仓切换；`api.ts:331-343` 入队顺序决定重放后主仓停在最后处理的 env 分支。
3. 强：`stale-analyze-scheduler.ts:22-37` 有意排除 env 分支映射 + 字符串比对闸门；`api.ts:1885-1897` 命中即跳过且无重试通路（`api.ts:1937` 不带 beforeAnalyze）。
4. 强：`git-staleness.ts:209-255` 仅同步当前分支 upstream，不恢复索引分支。
5. 中：远端 11 个错位仓各自的触发事件是"活跃 env push"还是"重放开启"取决于 `GITNEXUS_STARTUP_WEBHOOK_REPOS_ENABLED` 现值与各 `repos.<env>.json` 内容（2026-11-07 记录核对当时为 false，倾向路径 A 为主因）。

## 6. 未确认项与限制

1. 远端 `repos.json` / `repos.<env>.json` 实际内容未在本地验证（dev/test/test-new 各属于哪个 env、release_9ji 是否仍为主 webhook 分支）——需运维只读导出确认。
2. 远端 `GITNEXUS_STARTUP_WEBHOOK_REPOS_ENABLED` 当前值未复核（历史记录为 false）。
3. GitNexus 本地索引严重陈旧（2026-07-24 建、main 分支），定制符号（`isKnownBranchMismatch` 等）不在图中，图谱证据只覆盖官方基线符号；远端 45 落后仓的逐项错位对（index/checkout 之外的 34 个仓）未逐一定位，仅对日志给出的 11 仓模式做了归因。
4. 若远端 auto-sync 的 cloneRoot 被配置为 PROJECTS_ROOT（未发现证据），`syncFirstAvailableBranch` 的分支回落（`auto-sync/runner.ts:677-690`）会成为额外生产者；本次按默认隔离目录处理。
5. gh 公开检索无命中，不排除更精确的英文表述存在同类实现；未做命中内容的深挖。
