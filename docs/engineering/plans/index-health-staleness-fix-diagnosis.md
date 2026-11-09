# 索引落后无法追平：诊断记录

- 任务：index-health-staleness-fix
- 诊断日期：2026-11-08
- 远端环境：10.1.14.158，容器 `gitnexus-mcp-proxy`，数据目录 `/data1/gitnexus`

## 1. 用户症状

68 个已索引仓库中，同分支真实落后（commitsBehind）分布为：≥100 共 5 个、50-99 共 8 个、10-49 共 14 个、1-9 共 13 个、0 共 21 个；另有 7 个跨分支假差异。落后的仓库不会自动追平。

## 2. 反馈回路（Phase 1）

命令：

```bash
cd gitnexus && npx vitest run test/unit/repro-index-health-worktree-branch.test.ts
```

首次运行结果（已实测）：

```
Test Files  1 failed (1)
     Tests  3 failed (3)
  Duration  1.00s
TypeError: buildWebhookBranchByPath is not a function
```

该回路秒级、确定性、可无人运行，断言的是"worktree 的索引分支不得被 webhook 源分支覆盖"，即 13 个 worktree 永久不追平的直接原因。备注：现有纯函数测试 `test/unit/stale-analyze-scheduler.test.ts`（8 项，1.25s）已先行验证测试基础设施可用。

## 3. 远端实测证据

### 3.1 巡检日志（`docker logs --since 72h`）

2026-11-08 08:44-08:46（容器启动巡检）共 20 条 `branch mismatch`，其中 13 条为 worktree：

| repo | indexBranch | checkoutBranch |
| --- | --- | --- |
| dev-OA | develop | dev-OA |
| dev-jiuCloud | develop | dev-jiuCloud |
| dev-huishou | test | dev-huishou |
| dev-autoTransfer | dev | dev-autoTransfer |
| dev-saasoanew | test | dev-saasoanew |
| iteng-saasoanew | master_depart_iteng | iteng-saasoanew |
| dev-oa-stock | dev | dev-oa-stock |
| dev-nc-segments | dev | dev-nc-segments |
| dev-oa-after | dev | dev-oa-after |
| dev-oa-finance | dev | dev-oa-finance |
| dev-oa-order | dev | dev-oa-order |
| dev-orginfo | dev | dev-orginfo |
| dev-oanew | test-new | dev-oanew |

另 7 条为主仓真跨分支（索引分支 ≠ 当前 checkout），跳过符合预期：autoTransfer、oa-order、oa-stock、saasoanew、data-service、oa-train、oa-salary。

同轮 `Stale index analyze scheduled` 恰好 10 条（08:47），等于每轮上限。

### 3.2 registry 实际登记值（`/root/.gitnexus/registry.json`）

- `dev-oa-order`：`branch=dev-oa-order`（worktree 自身分支，正确）
- `dev-oa-office`：`branch=dev`（该 worktree 被人为切到 dev）
- 主仓 `oa-order`：`branch=release_9ji`，checkout=dev（真跨分支）

### 3.3 宿主机定时任务

```
0 22 * * *  flock ... curl -X POST http://127.0.0.1:1347/api/index-health-check
```

`/var/log/gitnexus-index-health-check.log` 最后写入 11月7日 22:00，内容均为 `{"ok":true,"accepted":true}`（HTTP 202）。宿主机 uptime 13 天，`30 22 * * * shutdown` 一行已被注释，不存在关机中断。

### 3.4 代码事实

- `api.ts:1837`：`registryBranch = webhookBranchByPath.get(path.resolve(entry.path)) ?? entry.branch`——webhook（含 `repos.<env>.json`）的源分支覆盖了 registry 的真实索引分支。
- `api.ts:1900-1910`：`isKnownBranchMismatch(currentBranch, registryBranch)` 为真即 `continue`。
- `stale-analyze-scheduler.ts:2`：`STALE_ANALYZE_MAX_PER_ROUND = 10`，且候选按 `commitsBehind` 降序取前 10。
- `api.ts:1966`：`staleAnalyzeFailedRepoPaths.add(entry.path)` 是全文件唯一写入，无 delete/clear，隔离持续到进程退出。

## 4. 假设与验证（Phase 3-4）

| # | 假设 | 预测 | 结果 |
| --- | --- | --- | --- |
| H1 | worktree 的索引分支被 webhook 源分支覆盖，导致恒判 mismatch | 修复覆盖后 13 个 worktree 判定应为 false | **确认**：日志 13 条、registry 值、代码路径三方一致 |
| H2 | 应用内无周期巡检，所以索引只会停在启动那一刻 | 宿主机无定时触发 | **推翻**：crontab 每日 22:00 触发 + 启动时触发 |
| H3 | 每轮上限 10 且按落后数降序，尾部仓库长期轮不到 | 单轮 scheduled 恰为 10 | **确认**：08:47 日志恰 10 条 |
| H4 | 分析失败后进程级永久隔离，无重试 | 排障对象一旦失败就永不再入队 | **确认**：`:1966` 只增不减 |
| H5 | 22:30 关机中断夜间分析 | crontab 存在关机任务 | **推翻**：该行已注释，uptime 13 天 |

## 5. 结论

1. **主因**：`webhookBranchByPath` 把 worktree 的源分支当作索引分支，13 个 worktree 每轮巡检都被判为分支不匹配而跳过，永不追平。这是确定性缺陷。
2. **容量**：每日仅一次巡检（crontab）+ 每轮上限 10 + 按落后数降序，40 个真实落后仓库至少需要 4 天才能覆盖，且优先照顾最落后的仓库，尾部长期饥饿。
3. **恢复力**：分析失败即永久隔离，进程不重启就不再重试。
4. 7 个主仓属真正的跨分支索引，跳过是正确保护，不在本次缺陷范围。

## 6. 未确认项

- 22:00 巡检实际调度结果需等当晚执行后复核（当前容器 08:43 重建，历史日志已随容器消失）。
- `enqueueWebhookAnalyze` 的 `registryBranch` 在 worktree 场景传 `sourceBranch`（`api.ts:2929`），是否会把 worktree 索引写到错误分支 slot，尚未用实际分析验证；registry 现状显示 worktree slot 为自身分支，故按现状未列为缺陷。
- 队列并发上限与单仓分析耗时的实际值未在本轮量化，无法给出"多少仓/天"的准确吞吐。

## 7. 诊断产物

- `gitnexus/test/unit/repro-index-health-worktree-branch.test.ts`（反馈回路，当前红）
