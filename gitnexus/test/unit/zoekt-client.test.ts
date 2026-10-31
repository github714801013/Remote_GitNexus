import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ZoektClient, loadZoektConfig } from '../../src/core/search/zoekt-client.js';

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
        MatchCount: files.reduce((n: number, f: any) => n + (f.LineMatches?.length ?? 0), 0),
        Duration: 1_000_000,
      },
    },
  };
}

describe('loadZoektConfig', () => {
  afterEach(() => {
    delete process.env.ZOEKT_ENABLED;
    delete process.env.ZOEKT_ENDPOINTS;
    delete process.env.ZOEKT_URL;
  });

  it('默认回退到 localhost:6070 且处于禁用状态（若无环境变量）', () => {
    delete process.env.ZOEKT_ENABLED;
    delete process.env.ZOEKT_ENDPOINTS;
    delete process.env.ZOEKT_URL;
    const cfg = loadZoektConfig();
    expect(cfg.endpoints).toEqual(['http://localhost:6070']);
    expect(cfg.enabled).toBe(false);
  });

  it('显式启用 Zoekt', () => {
    process.env.ZOEKT_ENABLED = 'true';
    const cfg = loadZoektConfig();
    expect(cfg.enabled).toBe(true);
  });

  it('提供端点时自动启用 Zoekt', () => {
    process.env.ZOEKT_ENDPOINTS = 'http://remote:6070';
    const cfg = loadZoektConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.endpoints).toEqual(['http://remote:6070']);
  });

  it('从 ZOEKT_ENDPOINTS 读取多个端点', () => {
    process.env.ZOEKT_ENDPOINTS = 'http://a:6070,http://b:6070';
    const cfg = loadZoektConfig();
    expect(cfg.endpoints).toEqual(['http://a:6070', 'http://b:6070']);
  });

  it('从 ZOEKT_URL 读取单个端点', () => {
    process.env.ZOEKT_URL = 'http://remote:6070';
    const cfg = loadZoektConfig();
    expect(cfg.endpoints).toEqual(['http://remote:6070']);
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

  it('搜索时不向 stdout 写日志，避免污染 MCP JSON 输出', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => makeApiResponse([]),
    });

    const client = new ZoektClient({ endpoints: ['http://localhost:6070'] });
    await client.search('handleError');

    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
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

  it('HTTP 非 2xx 响应时静默返回空结果', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const client = new ZoektClient({ endpoints: ['http://localhost:6070'] });
    const result = await client.search('anything');
    expect(result.matches).toHaveLength(0);
  });

  it('HTTP 非 2xx 响应时在 warning 中包含响应正文', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'JSON API requires -rpc',
    });

    const client = new ZoektClient({ endpoints: ['http://localhost:6070'] });
    const result = await client.search('anything');

    expect(result.matches).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'HTTP 400 from http://localhost:6070/api/search: JSON API requires -rpc',
      ),
    );
    warnSpy.mockRestore();
  });

  it('Result.Files 为 null 时返回空 matches', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        Result: {
          Files: null,
          Stats: { FilesConsidered: 0, FilesLoaded: 0, MatchCount: 0, Duration: 0 },
        },
      }),
    });

    const client = new ZoektClient({ endpoints: ['http://localhost:6070'] });
    const result = await client.search('anything');
    expect(result.matches).toHaveLength(0);
  });

  it('兼容 Zoekt JSON API 将统计字段直接放在 Result 下的响应', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        Result: {
          FilesConsidered: 12,
          FilesLoaded: 3,
          MatchCount: 7,
          Duration: 2_000_000,
          Files: [],
        },
      }),
    });

    const client = new ZoektClient({ endpoints: ['http://localhost:6070'] });
    const result = await client.search('anything');
    expect(result.stats).toEqual({
      filesConsidered: 12,
      filesLoaded: 3,
      matchCount: 7,
      durationMs: 2,
    });
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

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => makeApiResponse([fileA]),
    });
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

  it('repoFilter 使用路径段后缀精确匹配，避免 jiuji-m 命中 jiuji-mp', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => makeApiResponse([]),
    });

    const client = new ZoektClient({ endpoints: ['http://localhost:6070'] });
    await client.search('package.json', { repoFilter: 'jiuji-m' });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.Q).toBe('repo:(^|/)jiuji-m$ package.json');
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
