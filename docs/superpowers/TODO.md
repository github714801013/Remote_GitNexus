# Dev-Spec-Gen 本地工程规范达成看板

## Phase 1: Research & Setup (初始化)
- [x] 运行环境与版本确认：当前分支 codex/webhook-worktree-env-index，Node/TypeScript 项目，测试入口为 gitnexus/npm test
- [x] 租户隔离/路径前缀确认：目标为远端 /projects/OA_CSharp/oanew，通过 GitNexus 托管 env worktree/analyze worker 处理
- [x] 核心规范检索：已加载 dev-spec-gen 与 superpowers:writing-plans；GitNexus MCP 受限后使用本地源码读取兜底
- [x] 涉及技能识别：dev-spec-gen、superpowers:writing-plans、后续 code-reviewer/security-reviewer

## Phase 2: Design (文档先行)
- [x] API-First: 外部 HTTP API 不变；内部 analyze worker IPC 的 AnalyzeResult.pipelineResult 保持可选，server worker 默认不返回
- [x] DB-First: LadybugDB schema 不变；CSV/COPY 装载路径不改表结构
- [x] 性能优化要点：减少完整 pipelineResult IPC、parse worker result 全量聚合、CSV 文件内容缓存峰值
- [x] 编码规范要点：只做外科手术式 TypeScript 修改，不重构无关 analyzer 架构
- [x] 测试要点：RED-GREEN 覆盖 runFullAnalysis 返回形状、worker pool streaming、CSV cache size、回归现有 webhook/heap 测试

## Phase 3: Implementation (开发)
- [x] 业务逻辑实现：按 docs/superpowers/plans/2026-05-21-streaming-analyze-memory.md Task 1-3 执行；补充 runner 释放过期 phase output、C# scopeTreeCache 限流
- [x] 规范合规注释注入：不新增无必要注释；仅更新 scopeTreeCache 非显然内存约束说明

## Phase 4: Verification (验证)
- [x] Bug Reproduction：已先运行 pipeline-runner/parse-impl-fallback RED，确认旧实现失败
- [x] 项目构建/编译通过：cd gitnexus && npm run build 已通过
- [x] 单入口/集成测试验证：目标单测 run-analyze-result、worker-pool、csv、pipeline-runner、parse-impl-fallback 已通过；内存诊断已改为 progress/IPC 转发；远端 webhook/analyze 日志待重新部署闭环
- [x] 接口一致性比对：外部 webhook 响应不变；内部 worker complete result 不携带 pipelineResult

## Phase 5: Audit & Finish (审计与完结)
- [x] 本地工程合规审计表输出：code-reviewer + security-reviewer 已执行，已补充 retainResults 测试和 C# cache 注释修正
- [ ] 完结审计拦截：部署后持续抓日志直到 oanew analyze completed 或提供新失败阶段证据
