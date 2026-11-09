# oanew 索引落后 1000+ 提交：诊断记录

- task_id: oanew-stale-index
- 诊断日期: 2026-10-30
- 数据来源: root@10.1.14.158 只读检查（docker logs / git 只读命令 / MCP list_repos），未执行任何远端写操作

## 1. 问题

远端 GitNexus（10.1.14.158）上 `oanew` 显示 `staleness.status=stale`、`commitsBehind=1143`。用户怀疑是 bug。

## 2. 反馈回环（已执行，可红可绿）

只读命令（在远端执行）：

```
git -C /data1/gitnexus/projects/OA_CSharp/oanew merge-base --is-ancestor ef5b1f14... HEAD   # exit 0
git -C /data1/gitnexus/projects/OA_CSharp/oanew rev-list --count ef5b1f14...HEAD           # 1143
git -C /data1/gitnexus/projects/OA_CSharp/oanew rev-list --count HEAD..ef5b1f14...         # 0
```

- `ef5b1f14` 是索引元数据 `lastCommit`（.gitnexus/gitnexus.json）。
- 结果与 MCP `list_repos` 的 `commitsBehind=1143` 完全一致；
- 若二者不一致，则说明展示/计算路径有 bug——本回环会变红。

## 3. 事实

| 项 | 值 |
|---|---|
| 索引元数据 branch | `master-new` |
| 索引 `lastCommit` | `ef5b1f14`（2026-10-27 10:45 UTC，master-new 上的 merge） |
| 索引 `indexedAt` | `2026-10-27T13:13:17Z`（最后一次成功分析） |
| 当前 checkout 分支 | `test-new` |
| 当前 HEAD | `1bce3b60`（2026-10-30 14:54 +0800） |
| HEAD 与 upstream | `origin/test-new` |
| `rev-list --count lastCommit..HEAD` | **1143**（与展示值一致） |
| `HEAD..lastCommit` | 0 |

registry（/data1/gitnexus/.gitnexus/registry.json）与 webhook 配置（projects/repos.json）中 oanew 的 `branch` 仍为 `master-new`。

## 4. 时间线（UTC）

- 10-27 13:13 oanew 最后一次分析完成（branch=master-new）。
- 10-28 02:26 wiki generation failed（source commit changed）。
- 10-28 14:04 `Stale index analyze scheduled`（oanew，第 1 次调度）。
- 10-29 02:26:31 gitea webhook 触发 `cloneOrResetToBranch`：
  - `git reset` 报 `fatal: Could not write new index file.`（level 50）
  - `.gitnexus` 恢复失败：`EEXIST: file already exists, mkdir '/projects/OA_CSharp/oanew/.gitnexus'`（restoreGitNexusMetadata），备份保留在 /tmp/gitnexus-meta-MMqJgN
  - `gitea webhook analyze failed`，分析未执行
- 10-29 14:09:37 `Stale index analyze scheduled`（oanew，第 2 次调度，enqueue 成功）
- 10-29 14:00–14:09 健康检查批量调度 39 个仓库；到 10-30 07:36 实际 `Analyze worker started` 的仅约 19 次且多为重复触发（oa-pc ×5、small-oa ×4、orginfo ×2 等），调度队列前 28 位（Q00–Q27）与 oanew（Q34）均未执行。
- 10-30 07:36（当前）仍在跑 small-oa；oanew 自 10-27 起无任何 `Analyze worker started` 记录。

## 5. 结论

1. `commitsBehind=1143` **不是计算/展示 bug**：远端 git 实测完全一致。它是"索引提交 → 当前 checkout HEAD"的真实不可达提交数。
2. 数字之所以长期存在，是索引更新链路的问题：
   - 10-29 02:26 webhook 分支同步在 git reset 阶段失败，随后 .gitnexus 恢复失败（EEXIST），分析没有启动；
   - 10-28 与 10-29 两次 stale 调度均未执行到分析启动阶段；
   - 10-29 14:09 批量调度（39 仓库）后队列严重饥饿/丢弃：多数任务 19 小时内未执行，被反复触发的小仓库（oa-pc/small-oa）挤占；
   - 当前 oanew checkout 已被 webhook 切到 `test-new`，而索引与 registry 仍停留在 `master-new`，差距持续放大。
3. 可判定的系统缺陷（代码/运维层面）：
   - `restoreGitNexusMetadata` 在目标目录已存在时会 EEXIST（Node fs.cp 对已存在目录的 mkdir 行为），导致 webhook 分析失败且无重试；
   - webhook 同步失败后没有自动重新调度（只记录 error）；
   - stale 调度任务在队列长时间不被执行，且无排队状态/超时日志可观测。

## 6. 未确认项

- 10-30 14:55 CST 谁更新了 oanew 的 `.git/index` 与 `.gitnexus`（日志无记录；无远端写操作由本次诊断执行）。
- 队列前 28 个任务为何全部未 started 的直接内部状态（诊断端点 `GITNEXUS_LOCAL_DIAGNOSTICS_ENABLED=false` 关闭，无 debug 日志）。
- `git reset: Could not write new index file` 的确切诱因（当时磁盘/inode 充足；疑似并发写或 fs.cp 争用，未复现）。
