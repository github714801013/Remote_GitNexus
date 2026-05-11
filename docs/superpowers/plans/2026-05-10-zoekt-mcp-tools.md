# Zoekt MCP Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 GitNexus MCP 服务器中新增 `zoekt_search`（全文/正则）和 `zoekt_symbol`（Symbol 精确搜索）两个工具，通过 Zoekt HTTP API 实现远程并发检索。

**Architecture:** 新建 `zoekt-client.ts` 封装 Zoekt REST API，支持多端点并发查询后合并去重；在 `tools.ts` 注册工具定义，在 `local-backend.ts` 实现调度逻辑，在 `server.ts` 补充 next-step hint。端点通过环境变量 `ZOEKT_ENDPOINTS`（逗号分隔）或 `ZOEKT_URL` 配置，默认 `http://localhost:6070`。

**Tech Stack:** TypeScript, Node.js fetch API, Zoekt webserver REST API (`POST /api/search`)

---

## 当前状态（已完成部分）

以下文件已在上一轮会话中写入，TypeScript 编译通过（`npx tsc --noEmit` 无报错）：

| 文件 | 状态 |
|------|------|
| `gitnexus/src/core/search/zoekt-client.ts` | ✅ 已创建 |
| `gitnexus/src/mcp/tools.ts` | ✅ 已追加 `zoekt_search` / `zoekt_symbol` 定义 |
| `gitnexus/src/mcp/server.ts` | ✅ 已追加 next-step hint |
| `gitnexus/src/mcp/local/local-backend.ts` | ✅ 已追加实现方法 + switch case |

**剩余工作：** 单元测试 + 集成验证。

---

## File Structure

```
gitnexus/src/core/search/zoekt-client.ts      ← 新建：Zoekt HTTP 客户端
gitnexus/src/mcp/tools.ts                      ← 修改：追加两个 ToolDefinition
gitnexus/src/mcp/server.ts                     ← 修改：追加 next-step hint
gitnexus/src/mcp/local/local-backend.ts        ← 修改：switch case + 实现方法
gitnexus/test/unit/zoekt-client.test.ts        ← 新建：单元测试
```

---

## Task 1: 验证已有代码的 TypeScript 编译

**Files:**
- Check: `gitnexus/src/core/search/zoekt-client.ts`
- Check: `gitnexus/src/mcp/tools.ts`
- Check: `gitnexus/src/mcp/server.ts`
- Check: `gitnexus/src/mcp/local/local-backend.ts`

- [ ] **Step 1: 运行 TypeScript 类型检查**

```bash
cd gitnexus && npx tsc --noEmit
```

Expected: 无输出（0 errors）

- [ ] **Step 2: 确认 zoekt-client.ts 存在且导出正确**

```bash
grep -n "export" gitnexus/src/core/search/zoekt-client.ts
```

Expected: 看到 `export interface ZoektConfig`, `export function loadZoektConfig`, `export class ZoektClient`

- [ ] **Step 3: 确认 tools.ts 包含新工具**

```bash
grep -n "zoekt" gitnexus/src/mcp/tools.ts
```

Expected: 看到 `zoekt_search` 和 `zoekt_symbol` 的 name 字段

- [ ] **Step 4: 确认 local-backend.ts switch case 正确**

```bash
grep -n "zoekt" gitnexus/src/mcp/local/local-backend.ts
```

Expected: 看到 `case 'zoekt_search'`, `case 'zoekt_symbol'`, `zoektSearch`, `zoektSymbol`, `formatZoektResult`

---

## Task 2: 为 ZoektClient 编写单元测试

**Files:**
- Create: `gitnexus/test/unit/zoekt-client.test.ts`

- [ ] **Step 1: 编写失败测试（RED）**

创建 `gitnexus/test/unit/zoekt-client.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ZoektClient, loadZoektConfig, type ZoektConfig } from '../../src/core/search/zoekt-client.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeApiResponse(files: any[], stats?: any) {
  return {
    Result: {
      Files: files,
      Stats: stats ?? {
        FilesConsidered: files.length,
        FilesLoaded: files.length,
        MatchCount: files.reduce((n, f) => n + (f.LineMatches?.length ?? 0), 0),
        Duration: 1_000_000, // 1ms in nanoseconds
      },
    },
  };
}

describe('loadZoektConfig', () => {
  it('默认回退到 localhost:6070', () => {
    delete process.env.ZOEKT_ENDPOINTS;
    delete process.env.ZOEKT_URL;
    const cfg = loadZoektConfig();
    expect(cfg.endpoints).toEqual(['http://localhost:6070']);
  });

  it('从 ZOEKT_ENDPOINTS 读取多个端点', () => {
    process.env.ZOEKT_ENDPOINTS = 'http://a:6070,http://b:6070';
    const cfg = loadZoektConfig();
    expect(cfg.endpoints).toEqual(['http://a:6070', 'http://b:6070']);
    delete process.env.ZOEKT_ENDPOINTS;
  });

  it('从 ZOEKT_URL 读取单个端点', () => {
    delete process.env.ZOEKT_ENDPOINTS;
    process.env.ZOEKT_URL = 'http://remote:6070';
    const cfg = loadZoektConfig();
    expect(cfg.endpoints).toEqual(['http://remote:6070']);
    delete process.env.ZOEKT_URL;
  });
});

describe('ZoektClient.search', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('返回解析后的文件匹配', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () =>
        makeApiResponse([
          {
            Repository: 'my-repo',
            FileName: 'src/foo.ts',
            Branches: ['main'],
            Score: 1.5,
            LineMatches: [
              {
                Line: 'function handleError() {}',
                LineNumber: 42,
                LineFragments: [{ LineOffset: 9, MatchLength: 11 }],
              },
            ],
          },
        ]),
    });

    const client = new ZoektClient({ endpoints: ['http://localhost:6070'] });
    const result = await client.search('handleError');

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].repository).toBe('my-repo');
    expect(result.matches[0].fileName).toBe('src/foo.ts');
    expect(result.matches[0].lineMatches[0].lineNumber).toBe(42);
    expect(result.stats.durationMs).toBe(1);
  });

  it('空结果时返回空 matches', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => makeApiResponse([]),
    });

    const client = new ZoektClient({ endpoints: ['http://localhost:6070'] });
    const result = await client.search('nonexistent');
    expect(result.matches).toHaveLength(0);
  });

  it('单个端点失败时返回空结果（不抛出）', async () => {
    mockFetch.mockRejectedValueOnce(new Error('connection refused'));

    const client = new ZoektClient({ endpoints: ['http://dead:6070'] });
    const result = await client.search('anything');
    expect(result.matches).toHaveLength(0);
  });

  it('多端点并发查询并去重（保留 score 最高的）', async () => {
    const fileA = {
      Repository: 'repo',
      FileName: 'src/a.ts',
      Branches: ['main'],
      Score: 0.5,
      LineMatches: [],
    };
    const fileAHighScore = { ...fileA, Score: 2.0 };

    // 端点1 返回 score=0.5
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => makeApiResponse([fileA]),
    });
    // 端点2 返回同文件 score=2.0
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => makeApiResponse([fileAHighScore]),
    });

    const client = new ZoektClient({
      endpoints: ['http://ep1:6070', 'http://ep2:6070'],
    });
    const result = await client.search('test');

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].score).toBe(2.0);
  });
});

describe('ZoektClient.symbolSearch', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('自动添加 sym: 前缀', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => makeApiResponse([]),
    });

    const client = new ZoektClient({ endpoints: ['http://localhost:6070'] });
    await client.symbolSearch('MyClass');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.Q).toBe('sym:MyClass');
  });
});
```

- [ ] **Step 2: 运行测试确认 RED（测试文件存在但实现可能有问题）**

```bash
cd gitnexus && npx vitest run test/unit/zoekt-client.test.ts 2>&1
```

Expected: 若实现正确则全部 PASS；若有类型/逻辑问题则看到具体失败信息。

- [ ] **Step 3: 修复任何失败的测试**

根据失败信息修改 `src/core/search/zoekt-client.ts`，直到所有测试通过。

- [ ] **Step 4: 运行全量测试确认无回归**

```bash
cd gitnexus && npx vitest run 2>&1 | tail -20
```

Expected: 所有已有测试仍然通过。

- [ ] **Step 5: Commit**

```bash
git add gitnexus/src/core/search/zoekt-client.ts \
        gitnexus/src/mcp/tools.ts \
        gitnexus/src/mcp/server.ts \
        gitnexus/src/mcp/local/local-backend.ts \
        gitnexus/test/unit/zoekt-client.test.ts
git commit -m "feat: add zoekt_search and zoekt_symbol MCP tools with concurrent multi-endpoint support"
```

---

## Task 3: 集成验证（可选，需要运行中的 Zoekt 实例）

**Files:**
- Read: `gitnexus/src/mcp/local/local-backend.ts` (zoektSearch / zoektSymbol 方法)

- [ ] **Step 1: 启动 Zoekt webserver（若本地有）**

```bash
zoekt-webserver -listen :6070 -index /path/to/zoekt-index
```

或通过 Docker：

```bash
docker run -p 6070:6070 -v /path/to/index:/data sourcegraph/zoekt-webserver
```

- [ ] **Step 2: 设置端点环境变量**

```bash
export ZOEKT_ENDPOINTS=http://localhost:6070
```

- [ ] **Step 3: 通过 MCP 调用 zoekt_search**

启动 gitnexus MCP server 后，发送：

```json
{
  "method": "tools/call",
  "params": {
    "name": "zoekt_search",
    "arguments": {
      "query": "handleError",
      "max_results": 5,
      "context_lines": 2
    }
  }
}
```

Expected: 返回包含文件路径、行号、匹配行的 Markdown 字符串。

- [ ] **Step 4: 通过 MCP 调用 zoekt_symbol**

```json
{
  "method": "tools/call",
  "params": {
    "name": "zoekt_symbol",
    "arguments": {
      "symbol": "LocalBackend",
      "kind": "class"
    }
  }
}
```

Expected: 返回 `LocalBackend` 类定义所在文件和行号。

---

## 设计说明

### 多端点并发检索

```
ZOEKT_ENDPOINTS=http://shard1:6070,http://shard2:6070
```

`ZoektClient` 用 `Promise.all()` 并发查询所有端点，单个端点失败只记录 warning 不中断。结果按 `(repository, fileName)` 去重，保留 score 最高的版本，最终按 score 降序排列。

### 查询语法透传

`zoekt_search` 的 `query` 参数直接透传给 Zoekt，支持完整的 Zoekt 查询语法：
- `lang:typescript handleError` — 语言过滤
- `file:*.test.ts` — 文件名过滤
- `r:func\s+\w+` — 正则（或用 `regex: true` 参数自动加 `r:` 前缀）
- `case:yes MyFunc` — 大小写敏感（或用 `case_sensitive: true` 参数）

### Symbol 搜索

`zoekt_symbol` 内部将 `symbol` 转换为 `sym:<name>` 查询，利用 Zoekt 的 ctags 索引实现精确 symbol 定位，比全文搜索更快、噪音更少。

---

## 自检清单

- [x] `zoekt-client.ts` 导出 `ZoektConfig`, `loadZoektConfig`, `ZoektClient`
- [x] `tools.ts` 中 `zoekt_search` required: `['query']`，`zoekt_symbol` required: `['symbol']`
- [x] `local-backend.ts` switch case 正确路由到 `zoektSearch` / `zoektSymbol`
- [x] `server.ts` next-step hint 覆盖两个新工具
- [x] TypeScript 编译无错误
- [ ] 单元测试覆盖：config 加载、单端点搜索、空结果、端点失败容错、多端点去重、symbol 前缀
- [ ] 全量测试无回归
