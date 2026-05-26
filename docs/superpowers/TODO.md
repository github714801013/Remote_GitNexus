# Dev-Spec-Gen 本地工程规范达成看板

## Phase 1: Research & Setup (初始化)
- [x] 运行环境与版本确认 (Runtime/Environment Check)：混合仓库，本次范围为 gitnexus Node/TypeScript 服务端；证据：package.json、gitnexus/package.json、gitnexus/src/server。
- [x] 租户隔离/路径前缀确认 (Tenant/Path Context)：不涉及业务租户；涉及远程 webhook 仓库路径锁。
- [x] 核心规范检索 (qmd Discovery)：已读取 dev-spec-gen references/general-specs.md；GitNexus MCP 无本仓库索引，降级本地检索。
- [x] 涉及技能识别：dev-spec-gen；不适用 Java/Spring AiAutoTestController。

## Phase 2: Design (文档先行)
- [x] API-First: 接口文档定义 (API Spec)：不改 HTTP 契约；只调整 webhook 后台 analyze 队列对仓库锁冲突的处理。
- [x] DB-First: 数据库变更脚本编写 (SQL/Schema Migration)：不涉及数据库。
- [x] 性能优化要点：批量/IN/循环查库/缓存/SQL/前端性能覆盖或不适用说明：不涉及。
- [x] 编码规范要点：Java/SQL/DTO/Mapper/热部署/引用规范覆盖或不适用说明：Node/TypeScript，Java 专用规则不适用。
- [x] 测试要点：补充单测覆盖仓库锁冲突识别、巡检 stale 触发增量 analyze；运行定向 vitest 与 tsc。

## Phase 3: Implementation (开发)
- [x] 业务逻辑实现 (Surgical Change)：仓库锁冲突降级为 webhook analyze skipped；巡检 stale index 时排队 force:false 增量 analyze。
- [x] 规范合规注释注入 (Spec Compliance Comments)：本次逻辑直观，无新增注释。

## Phase 4: Verification (验证)
- [x] Bug Reproduction (针对 Bug 修复)：新增单测先失败，错误为 isRepoAlreadyActiveError is not a function。
- [x] 项目构建/编译通过 (Build/Compilation Passed)：npx tsc --noEmit 通过。
- [x] 单入口/集成测试验证 (Single-Entry/Integration Test)：npm test -- test/unit/analyze-api.test.ts test/unit/webhook-analyze-queue.test.ts test/unit/webhook-worktree.test.ts 通过，20 tests。
- [x] 接口一致性比对 (Response Schema Check)：不改 HTTP 响应字段。

## Phase 5: Audit & Finish (审计与完结)
- [x] 本地工程合规审计表输出 (Compliance Audit Report)：红队指出锁外 clone/reset 风险，已修复。
- [x] 完结审计拦截 (Final Phase Check)：用户已要求提交并部署；提交前核对暂存区。
