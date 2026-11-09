# GitNexus 调研记录：oanew 索引显示"落后 1000+ 提交"

**task_id:** oanew-stale-index
**stage:** gitnexus-inquiry
**scope:** dynamic（只读，未修改任何源码/远端系统，未调用状态写入 CLI）
**工作区:** D:\\workplace\\typescript\\GitNexus（分支 neo4j-by-v1.6.10-rc.107，package version `1.6.10-rc.107`）

## 0. 问题陈述

远端 GitNexus 服务（10.1.14.158）上仓库 `oanew`（/projects/OA_CSharp/oanew，另有 `dev-oanew`）显示"落后 1000 多个提交"，怀疑是缺陷。需从源码定位 `staleness.status` / `commitsBehind` 的计算路径与相关日志事件，判定哪些路径会让 commitsBehind 虚高或与实际不符。

交叉核对的远端日志线索（非结论）：`git fetch --prune origin` → `fatal: couldn't find remote ref refs/heads/master`；`git rev-parse --abbrev-ref --symbolic-full-name @{upstream}` → `fatal: no upstream configured for branch 'release_9ji'`；一日内 `index project reset to remote upstream; scheduling reanalysis` 与 `Stale index analyze scheduled` 各 17 次；`analysis capabilities changed (missing:graph.class-framework-annotations); forcing a full rebuild` 反复出现。

## 1. 前置检查：spec 文档

`docs/engineering/specs/` 目录下**不存在**文件名前缀为 `oanew-stale-index` 的 spec。实际内容：
`2026-07-15-neo4j-no-lbug-raw-requirements.md`、`2026-07-19-embedding-fallback-raw-requirements.md`、`2026-07-25-mcp-headers-sync-and-policy-spec.md`、`2026-07-26-dynamic-mcp-project-env-scope-spec.md`、`2026-07-29-gitnexus-cross-host-migration-10-1-14-158-spec.md`、`neo4j-embedding-repair.md`、`neo4j-immediate-repair.md`。

## 2. 查询记录

| # | 工具 | 参数 | 结果 |
|---|---|---|---|
| 1 | `mcp__remote_gitnexus__list_repos` | （默认分页 limit=50） | **命中**：36 个仓库的真实 staleness 字段，见 §3.1 |
| 2 | `mcp__remote_gitnexus__query` | `repo=GitNexus`, `search_query="staleness commitsBehind remote version check"` | **失败**：`Error: Repository is not available through this MCP server.`（远端服务只索引业务仓，未索引 GitNexus 自身） |
| 3 | 本地 `gitnexus` MCP 服务器 | — | 会话启动即 `CONNECTION_CLOSED: Connection closed`（连接失败，非能力缺失） |

因 #2/#3，按节点 evidence_policy 降级为受限本地检索（`source=local_search`、`authority=non_gitnexus`）。本地检索记录：

| 工具 | 模式/路径 | 命中 |
|---|---|---|
| Grep | `remote version check\|reset to remote upstream\|Stale index analyze scheduled\|analysis capabilities changed\|forcing a full rebuild` → `gitnexus/src` | `core/run-analyze.ts:1295,1321-1322,1338,1350,1769-1770`；`server/api.ts:1624,1629,1665` |
| Grep | `commitsBehind\|staleness` → `gitnexus/src` | `core/git-staleness.ts`、`mcp/local/local-backend.ts`、`server/api.ts`、`mcp/resources.ts`、`core/group/service.ts` |
| Grep | `resolveAnalysisFeatureVersions\|findAnalysisFeatureMismatches\|class-framework-annotations` | `core/analysis-features.ts:16,22,53`、`core/run-analyze.ts:1308,1313,1756,1758` |
| Grep | `syncWithUpstream` | 仅 `core/git-staleness.ts:121`（定义）+ `server/api.ts:91,1620`（唯一调用方） |
| Grep | `--prune\|single-branch\|set-url` | `core/git-staleness.ts:150`、`server/git-clone.ts:504` |
| Grep | `analysisFeatures` | `run-analyze.ts:1314,1758,2674,2838`（写入仅 2674/2838 两处，均属 LadybugDB 路径） |
| Read | 上述文件相应区段 | 见 §4 证据 |
| Bash | `git log -S "analysisFeatures: currentAnalysisFeatures" -- run-analyze.ts` | 单一提交 `2cfbc4a2 feat(spring): build bean candidate inventory (#2494)` 引入 |
| Bash | `rg -l analysisFeatures test/unit` | `analysis-features.test.ts`、`incremental-orchestration.test.ts`、`run-analyze.test.ts`、`run-analyze-adopt-failure.test.ts` — 无 Neo4j 路径覆盖 |

## 3. 远端实证数据（来自 list_repos，source=mcp_remote）

`oanew`：`branch=master-new`、`indexedAt=2026-10-27T13:13:17Z`、`lastCommit=ef5b1f14`、`status=stale`、`commitsBehind=1143`、215867 节点 / 1486529 边。
`dev-oanew`：`branch=dev-oanew`、`commitsBehind=177`、同一 `remoteUrl`（siblings 关系）。

同一批数据中的规律（用于佐证"基线/分支"相关性，非因果结论）：

| 仓库 | branch | commitsBehind |
|---|---|---|
| oa-after | release_9ji | 3861 |
| oa-order | release_9ji | 3571 |
| huishou | release_9ji | 1181 |
| **oanew** | **master-new** | **1143** |
| oa-finance | release_9ji | 1023 |
| dev-nc-segments | dev-nc-segments | 114 |
| oa-stock / orginfo | release_9ji / dev | **null（status=unknown）** |
| jiuji-m / oa-pc / oa-api | master | 0（fresh） |

即：超大数值集中在 `release_9ji` / `master-new` 这类长生命周期分支持久化的条目上；`unknown`（`merge-base --is-ancestor` 失败）也出现在同一批条目。这与"跨分支基线"假设方向一致。

## 4. 代码证据（source=local_search, authority=non_gitnexus）

### 4.1 staleness / commitsBehind 的唯一算法

`gitnexus/src/core/git-staleness.ts:170-195`（同步版）与 `202-254`（异步版，list_repos 使用）：

```ts
// git-staleness.ts:232-241
await execFileAsync('git', ['merge-base', '--is-ancestor', lastCommit, 'HEAD'], { cwd: repoPath, ... });
const count = await execFileAsync('git', ['rev-list', '--count', `${lastCommit}..HEAD`], { cwd: repoPath, ... });
const commitsBehind = Number.parseInt(count.stdout.trim(), 10);
```

数据源是**索引仓库本地 checkout 的 HEAD**，全程不接触远端。`git-staleness.ts:15-29` 定义 `status/isStale/commitsBehind/upstreamRef/reason`；`:94-115` `resolvedStaleness` 生成 `stale + hint`，`:80-92` `unknownStaleness` 生成 `commitsBehind: null` + hint（对应 §3 的 oa-stock/orginfo）。

### 4.2 checkout 元信息读取的容错（失败即"静默缺字段"）

- 同步版 `git-staleness.ts:54-78`：`inspectCheckout` 内 `read()` 对 `git` 抛错一律 `return undefined`，包括第 72 行 `rev-parse --abbrev-ref --symbolic-full-name @{upstream}`。
- 异步版 `git-staleness.ts:213-222`：branch / upstream 两个子进程 `.catch(() => ({ stdout: '' }))`，`HEAD` 无 catch（失败 → 整体 catch → `unknown`）。

即：**upstream 缺失（日志线索 `no upstream configured for branch 'release_9ji'`）不影响 commitsBehind 的产出**，只影响是否做远端同步。

### 4.3 远端版本检查 syncWithUpstream 及其失败语义

`gitnexus/src/core/git-staleness.ts:121-167`（注释明确"不执行 git clean，失败时返回降级结果"），四步顺序：

```ts
:123  upstreamRef = git rev-parse --abbrev-ref --symbolic-full-name @{upstream}   // 抛错 → catch → checked:false
:128  非 <remote>/<branch> 形态 → {checked:false, reason:'upstream ref is unavailable'}
:136  git ls-remote <remote> refs/heads/<branch> → 非 40hex → {checked:false, reason:'remote branch was not found'}
:150  git fetch --prune <remote>      ← 日志线索 couldn't find remote ref refs/heads/master 的命令来源
:151  git reset --hard <upstreamRef>
:155  reset = (rev-parse HEAD === remoteHash)
:160-166 catch → {checked:false, reason: error.message}
```

`git fetch --prune origin`（不带 refspec）只有在 `remote.origin.fetch` 被限制成 master 单分支 refspec 时才会因"远端无 master"而 fatal；该前提需远端 `git config` 验证（§6）。

### 4.4 三条日志事件的确切触发条件

`gitnexus/src/server/api.ts:1608-1634`，`runIndexHealthCheck`（`source` 只取 `'startup'` 或 `'manual'`，`:1573`；`:1720` 启动调用，`:1724-1729` `POST /api/index-health-check`；**src 内无周期性定时器**）：

```ts
:1620  const remoteSync = await syncWithUpstream(entry.path);
:1621  if (!remoteSync.checked)  → logger.warn(..., 'index remote version check skipped; continuing local health check')
:1626  else if (remoteSync.reset) → logger.info(..., 'index project reset to remote upstream; scheduling reanalysis')
:1632  const staleness = remoteSync.reset
:1633    ? { isStale: true, commitsBehind: 1 }                     // 伪造值，仅用于调度门
:1634    : await checkStalenessAsync(entry.path, entry.lastCommit); // 真实本地基线
:1695  if (shouldScheduleStartupIncrementalAnalyze(staleness)) { scheduleStaleAnalyze(); continue; }
:1662  logger.info(..., 'Stale index analyze scheduled'); enqueueWebhookAnalyze(..., { force:false, deferEmbeddingRepair:true })
```

调度门：`api.ts:224-225` `(staleness) => staleness.isStale && staleness.commitsBehind > 0`。
跳过/失败抑制：`api.ts:1277`（`isRepoAlreadyActiveError` → return）、`api.ts:1675-1684`（`stale index refresh skipped: analysis already in progress` / `stale index refresh failed`）。

### 4.5 展示面：list_repos 与 Web /api/repos 同源

- `gitnexus/src/mcp/local/local-backend.ts:1771-1795`：`listRepos()` 每次 `refreshRepos()` 重读注册表（`:1171` `listRegisteredRepos({validate:true})`），随后 `handles.map(h => checkStalenessAsync(h.repoPath, h.lastCommit))`，`:1810-1814` 原样输出 `status/commitsBehind/hint`；分页仅在 `:1836+` 的 tool 包装层。
- `gitnexus/src/server/api.ts:1856-1890`：`GET /api/repos` 同样 `checkStalenessAsync(r.path, r.lastCommit)` → 前端"落后 N 个提交"即此值。
- `gitnexus/src/mcp/resources.ts:325-346`、`core/group/service.ts:583-585` 为同函数的其它消费面。

结论：commitsBehind **不落盘、不缓存**，每次调用重算；它能长期停留在 1143，只能是 `entry.lastCommit` 长期未推进。

### 4.6 lastCommit 的写入路径

- `run-analyze.ts:787` `const currentCommit = repoHasGit ? getCurrentCommit(repoPath) : ''`；`:805-806` `branchLabel = options.branch ?? checkedOutBranch`，`placement = options.branch ? resolveBranchPlacement(...) : {}`。
- Neo4j 路径 `run-analyze.ts:1644-1673` 构造全新 meta 字面量（`lastCommit: currentCommit`、`capabilities.graph.provider='neo4j'`），`:1676 saveMeta`、`:1678 registerRepo(..., { branch: placement.branch })`。
- `storage/repo-manager.ts:1198-1242`：带 `opts.branch` 的非主分支运行**只** upsert `branches[]` 摘要、保留旧顶层 `lastCommit`；主运行才刷新顶层（`:1236`）。
- `server/analyze-launch.ts:403` 把 `registryBranch` 发给 worker，但 `core/run-analyze.ts` 内**无 `registryBranch` 引用**（grep 命中为空），服务端 `options.branch` 未被设置 → 各 worktree 路径各自按主运行刷新顶层。

### 4.7 "analysis capabilities changed … forcing a full rebuild" 与 Neo4j 后端的缺 stamp

`gitnexus/src/core/analysis-features.ts:15-19`：

```ts
export const CLASS_FRAMEWORK_ANNOTATIONS_FEATURE: AnalysisFeatureDescriptor = {
  id: 'graph.class-framework-annotations', version: 1, appliesTo: () => true,
};
```

`appliesTo: () => true` ⇒ 任何仓库都期望该特性；`:53-58` `if (actual === undefined) return expectedKeys.map((id) => \`missing:${id}\`)` ⇒ 一旦 meta 无 `analysisFeatures`，输出恰为日志中的 `missing:graph.class-framework-annotations`。

消费点 `run-analyze.ts:1307-1326`（用 `existingMeta.fileHashes` 的键求期望集）与 `:1756-1773`（用 pipeline 实际文件列表二次校验）；两处都 `options = { ...options, force: true }`。相邻守卫：`:1291-1298` schema、`:1332-1342` runner identity（`analyzerRunnerIdentitiesEqual` 对 `undefined` 返回 false，`core/analyzer-identity.ts:2489-2496`）、`:1344-1354` CJK；`:1357-1361` already-up-to-date 快路径被 `!options.force` 拦住；`:1781-1789` `isIncremental` 要求 `currentAnalysisFeatureMismatches.length === 0`。

写入点对比（关键不对称）：

- LadybugDB 路径写入 `analysisFeatures` + `runnerIdentity`：`run-analyze.ts:2657-2687`（checkpoint，`...(existingMeta ?? {})` 展开）、`:2838`（最终 meta）、`:2792/:2864`（runnerIdentity）。
- **Neo4j 路径的 meta 字面量 `:1644-1673` 既无 `analysisFeatures` 也无 `runnerIdentity`，`:1732-1739` 直接 return**，不经过上述任何写入点。
- 单测只覆盖 LadybugDB/编排路径（`test/unit/analysis-features.test.ts`、`incremental-orchestration.test.ts`、`run-analyze.test.ts`、`run-analyze-adopt-failure.test.ts`），无 Neo4j meta 断言。

### 4.8 分支/基线的来源与"no upstream"可能成因

- `api.ts:284` `const branch = typeof entry.branch === 'string' ? entry.branch : 'master'` — repos.json 未写 branch 时**默认 master**。
- `server/git-clone.ts:455-498 cloneOrResetToBranch` → `:500-512 buildWebhookBranchSyncCommands`：`['fetch','origin',\`+refs/heads/${branch}:refs/remotes/origin/${branch}\`]`、`reset --hard`、`clean -fd`、`checkout -B branch remoteRef`、再 `reset --hard`；`:492` 首次 `clone --branch <branch>`。远端无该分支时同样报 `couldn't find remote ref refs/heads/master`。
- `server/webhook-worktree.ts:287-292`：`hasBranch` 为真时 `git worktree add <path> <branch>`（**复用已存在的本地分支，不建立 upstream**）；`:299-308` 再 `reset --hard FETCH_HEAD`（`origin/*` 走 `fetchOriginRef` + FETCH_HEAD）。`:330-354 copyBootstrapIndex`：把源仓库 `.gitnexus` 整体复制给新 worktree，并把 `lastCommit` 直接改写为该 worktree 当前 commit 后注册 —— 索引内容与 lastCommit 可以来自不同提交/分支。

## 5. 关键发现（要点）

1. **commitsBehind 的真实语义**：`rev-list --count lastCommit..HEAD`，即"本地 checkout 的 HEAD 相对已索引提交有多少个不可达提交"。它既不测远端、也不是时间意义上的"落后"，字段名与 hint（`behind HEAD`）容易被读成"落后 origin N 个提交"。
2. **虚高来源一：跨分支/合并的分叉计数。** 只要 `lastCommit` 仍是 HEAD 的祖先（`merge-base --is-ancestor` 通过），`lastCommit..HEAD` 就把经由 merge 引入的整条分支历史全部计入；worktree/镜像换了分支（`master-new`、`release_9ji`）或经历一次大分支同步，一次就能得到上千的数字。若换了分支导致 `lastCommit` 不再是祖先，则退化为 `status=unknown / commitsBehind=null`（§3 的 oa-stock、orginfo 即此类）。代码里**没有任何"注册分支 vs 当前 checkout 分支一致性"校验**（`checkStaleness*` 仅把 branch 作为附加字段返回）。
3. **虚高来源二：`lastCommit` 长期不推进。** commitsBehind 每次实时重算，所以大数持续存在 ⟺ analyze 从未在当前 HEAD 成功收尾（`run-analyze.ts:1646/1678` 才刷新）。`§4.7` 给出一个自驱动原因：**Neo4j 后端的 meta 从不 stamp `analysisFeatures`/`runnerIdentity`**，于是每轮都判定 `missing:graph.class-framework-annotations`（并触发 runner identity 分支）→ `force:true` → 放弃 already-up-to-date 快路径与增量写回 → 对 oanew 这种 215867 节点/1486529 边的库做整图重载；任务被并发锁/队列抑制（`api.ts:1277`、`:1675-1684`）或超时失败时，`lastCommit` 原地不动，下轮健康检查再次调度 → 与"每日 17 次"的循环观测一致（循环触发源仍需确认，见 §6）。
4. **fetch 失败 / upstream 缺失不会让数字变错，但会让镜像永不自我纠正。** 两条日志线索都走 `api.ts:1621` 的 `checked:false` 分支：仅记 warn、**继续用本地基线算 staleness**，远端同步与 `reset --hard` 全部跳过。此后 HEAD 只会被 webhook 路径（`cloneOrResetToBranch` / `ensureLocalWorktree`）推动；一旦推动发生，就是"批量提交数"级别的跃迁（对应发现 2）。
5. **`reset` 分支的 commitsBehind 是伪造的 1。** `api.ts:1632-1633` 在 `remoteSync.reset` 时直接给 `{isStale:true, commitsBehind:1}`，只为过调度门（`:224-225`），不参与展示；展示值仍由 `checkStalenessAsync` 计算。故"reset to remote upstream 与 Stale index analyze scheduled 同日各 17 次"是同一因果链的两个面：reset 判定 → 伪 stale → 调度；或真实 stale（如 1143）→ 调度。
6. **`index project reset to remote upstream` 的严格触发条件**：upstream 解析成功且形如 `<remote>/<branch>` → `ls-remote` 命中 40 位 hash → `HEAD != remoteHash` → `fetch --prune` + `reset --hard` 未抛错 → 复位后 `HEAD == remoteHash`（`git-staleness.ts:123-159`）。任一环节抛错即变成 warn-skip。
7. **`dev-oanew` 一类的 bootstrap 风险**：`copyBootstrapIndex`（`webhook-worktree.ts:330-354`）复制他仓索引后把 `lastCommit` 改成本仓当前 commit 再注册，可能显示"新鲜/小幅落后"而图内容实际来自另一提交；与 `oanew` 的高数字不属同一机制，但会污染同 remoteUrl 的 siblings 对比。

## 6. 未确认项（不得当作事实）

- **远端部署版本**：本工作区为 `1.6.10-rc.107`；10.1.14.158 实际运行的 dist 是否含 §4.7 的 Neo4j meta 字面量，未取证。需远端 `node_modules/gitnexus/package.json` 与 `/projects/OA_CSharp/oanew/.gitnexus/meta.json`（看是否缺 `analysisFeatures`/`runnerIdentity`）。
- **17 次/日的驱动源**：`runIndexHealthCheck` 只有 `startup` 与 `POST /api/index-health-check` 两个入口，src 内无定时器。周期性来源（外部调度/容器重启/webhook）未确认。
- **`git fetch --prune origin` 报 refs/heads/master 的前提**：需 `git config --get-all remote.origin.fetch`（是否被限制为单分支 refspec）。也可能来自 `buildWebhookBranchSyncCommands` 的带 refspec fetch（`+refs/heads/master:...`），二者命令文本不同，需按原始日志区分。
- **oanew 的实际 analyze 结果**：是否存在 `stale index refresh failed` / `analysis already in progress` / worker retry exhaustion（`analyze-launch.ts:370-387`）等记录，以及 HEAD 与 `lastCommit` 的真实 `rev-list` 差值（本地无法访问远端仓库）。
- **各 worktree 的 upstream 配置**：`release_9ji`/`master-new` 是否由 `worktree add <path> <branch>` 复用无跟踪分支（§4.8）所致，未在远端验证。
- **图证据缺口**：因远端 MCP 未索引 GitNexus 本仓、本地 `gitnexus` MCP 连接关闭，本报告未使用 `context`/`impact`/`trace` 的调用图与影响面结论；`syncWithUpstream` 唯一调用方等结论基于源码文本 grep，不能排除动态调用或他处复用。
