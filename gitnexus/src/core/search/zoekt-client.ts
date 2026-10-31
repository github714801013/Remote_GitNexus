/**
 * Zoekt HTTP Client
 *
 * 封装对 Zoekt webserver REST API 的调用，支持多端点并发检索后合并去重。
 * 端点通过环境变量 ZOEKT_ENDPOINTS（逗号分隔）或 ZOEKT_URL 配置，
 * 默认回退到 http://localhost:6070。
 */

import { logger } from '../logger.js';

// ─── 配置 ────────────────────────────────────────────────────────────────────

export interface ZoektConfig {
  /** 是否启用 Zoekt */
  enabled: boolean;
  /** Zoekt webserver 端点列表，并发查询后合并结果 */
  endpoints: string[];
  /** 单次请求超时（毫秒），默认 10000 */
  timeoutMs?: number;
}

export function loadZoektConfig(): ZoektConfig {
  const enabled =
    process.env.ZOEKT_ENABLED === 'true' ||
    !!(process.env.ZOEKT_ENDPOINTS || process.env.ZOEKT_URL);
  const raw = process.env.ZOEKT_ENDPOINTS ?? process.env.ZOEKT_URL ?? '';
  const endpoints = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    enabled,
    endpoints: endpoints.length > 0 ? endpoints : ['http://localhost:6070'],
    timeoutMs: 10_000,
  };
}

function escapeZoektRepoRegex(repo: string): string {
  return repo.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

// ─── 请求 / 响应类型 ──────────────────────────────────────────────────────────

export interface ZoektSearchOpts {
  /** 最多返回的文件匹配数，默认 50 */
  maxDocDisplayCount?: number;
  /** 每个匹配行前后的上下文行数，默认 2 */
  numContextLines?: number;
  /** 仅在指定仓库内搜索（Zoekt repo 名称） */
  repoFilter?: string;
}

export interface ZoektLineFragment {
  lineOffset: number;
  matchLength: number;
}

export interface ZoektLineMatch {
  line: string;
  lineNumber: number;
  lineFragments: ZoektLineFragment[];
  /** 是否为上下文行（非命中行） */
  isContext?: boolean;
}

export interface ZoektFileMatch {
  repository: string;
  fileName: string;
  branches: string[];
  lineMatches: ZoektLineMatch[];
  score: number;
}

export interface ZoektStats {
  filesConsidered: number;
  filesLoaded: number;
  matchCount: number;
  durationMs: number;
}

export interface ZoektSearchResult {
  matches: ZoektFileMatch[];
  stats: ZoektStats;
  warning?: string;
}

// ─── 内部 Zoekt API 响应结构 ──────────────────────────────────────────────────

interface ZoektApiLineFragment {
  LineOffset: number;
  MatchLength: number;
}

interface ZoektApiLineMatch {
  Line: string;
  LineNumber: number;
  LineFragments: ZoektApiLineFragment[];
}

interface ZoektApiFileMatch {
  Repository: string;
  FileName: string;
  Branches: string[];
  LineMatches: ZoektApiLineMatch[];
  Score: number;
}

interface ZoektApiStats {
  FilesConsidered: number;
  FilesLoaded: number;
  MatchCount: number;
  Duration: number; // nanoseconds
}

interface ZoektApiResponse {
  Result: ZoektApiStats & {
    Files: ZoektApiFileMatch[] | null;
    Stats?: ZoektApiStats;
  };
}

// ─── 客户端 ───────────────────────────────────────────────────────────────────

export class ZoektClient {
  private readonly config: Required<ZoektConfig>;

  constructor(config?: ZoektConfig) {
    const base = config ?? loadZoektConfig();
    this.config = {
      enabled: base.enabled,
      endpoints: base.endpoints,
      timeoutMs: base.timeoutMs ?? 10_000,
    };
  }

  /**
   * 全文 / 正则搜索。
   * query 支持 Zoekt 查询语法：
   *   - 普通关键词：`handleError`
   *   - 正则：`func\s+\w+Error`（需 regex:true 或在 query 中使用 `r:` 前缀）
   *   - 语言过滤：`lang:typescript handleError`
   *   - 文件过滤：`file:*.test.ts`
   *   - Symbol 搜索：`sym:MyClass`
   */
  async search(query: string, opts: ZoektSearchOpts = {}): Promise<ZoektSearchResult> {
    logger.debug({ query, opts }, '[zoekt] search');
    const results = await this.queryAllEndpoints(query, opts);
    return this.mergeResults(results);
  }

  /**
   * Symbol 精确搜索（函数名、类名、方法名等）。
   * 内部将 symbol 转换为 Zoekt `sym:` 前缀查询。
   * kind 可选 'function' | 'class' | 'method' | 'interface' | 'all'，
   * 当前 Zoekt 不区分 kind，kind 仅用于结果过滤提示。
   */
  async symbolSearch(
    symbol: string,
    _kind: string = 'all',
    opts: ZoektSearchOpts = {},
  ): Promise<ZoektSearchResult> {
    logger.debug({ symbol, kind: _kind, opts }, '[zoekt] symbolSearch');
    const q = `sym:${symbol}`;
    return this.search(q, opts);
  }

  // ─── 私有方法 ──────────────────────────────────────────────────────────────

  /** 并发查询所有端点，忽略单个端点的失败（记录警告后继续） */
  private async queryAllEndpoints(
    query: string,
    opts: ZoektSearchOpts,
  ): Promise<ZoektSearchResult[]> {
    const tasks = this.config.endpoints.map((endpoint) =>
      this.queryEndpoint(endpoint, query, opts).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ endpoint, err: msg }, '[zoekt] endpoint failed');
        return new Error(msg);
      }),
    );
    const settled = await Promise.all(tasks);

    const successes = settled.filter((r): r is ZoektSearchResult => !(r instanceof Error));
    return successes;
  }

  /** 向单个 Zoekt 端点发送搜索请求 */
  private async queryEndpoint(
    endpoint: string,
    query: string,
    opts: ZoektSearchOpts,
  ): Promise<ZoektSearchResult> {
    const url = `${endpoint.replace(/\/$/, '')}/api/search`;
    // repo 过滤通过查询语法实现；按完整仓库名或路径段后缀精确匹配，避免 jiuji-m 命中 jiuji-mp。
    const repoQuery = opts.repoFilter
      ? `repo:(^|/)${escapeZoektRepoRegex(opts.repoFilter)}$`
      : undefined;
    const q = repoQuery ? `${repoQuery} ${query}` : query;

    logger.debug({ endpoint, query: q }, '[zoekt] querying endpoint');

    const body = JSON.stringify({
      Q: q,
      Opts: {
        MaxDocDisplayCount: opts.maxDocDisplayCount ?? 50,
        NumContextLines: opts.numContextLines ?? 2,
      },
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      const detail = await this.readErrorBody(resp);
      throw new Error(`HTTP ${resp.status} from ${url}${detail ? `: ${detail}` : ''}`);
    }

    const json = (await resp.json()) as ZoektApiResponse;
    return this.parseApiResponse(json);
  }

  private async readErrorBody(resp: Response): Promise<string> {
    try {
      return (await resp.text()).trim();
    } catch {
      return '';
    }
  }

  /** 将 Zoekt API 原始响应转换为内部类型 */
  private parseApiResponse(json: ZoektApiResponse): ZoektSearchResult {
    const files = json.Result?.Files ?? [];
    const stats = json.Result?.Stats ?? json.Result;

    const matches: ZoektFileMatch[] = files.map((f) => ({
      repository: f.Repository,
      fileName: f.FileName,
      branches: f.Branches ?? [],
      score: f.Score ?? 0,
      lineMatches: (f.LineMatches ?? []).map((lm) => ({
        line: Buffer.from(lm.Line, 'base64').toString('utf8').trimEnd(),
        lineNumber: lm.LineNumber,
        lineFragments: (lm.LineFragments ?? []).map((frag) => ({
          lineOffset: frag.LineOffset,
          matchLength: frag.MatchLength,
        })),
        isContext: !lm.LineFragments?.length,
      })),
    }));

    return {
      matches,
      stats: {
        filesConsidered: stats?.FilesConsidered ?? 0,
        filesLoaded: stats?.FilesLoaded ?? 0,
        matchCount: stats?.MatchCount ?? 0,
        // Zoekt Duration 单位是纳秒
        durationMs: stats?.Duration ? Math.round(stats.Duration / 1_000_000) : 0,
      },
    };
  }

  /**
   * 合并多个端点的结果：
   * - 按 (repository, fileName) 去重，保留 score 最高的那份
   * - stats 累加
   */
  private mergeResults(results: ZoektSearchResult[]): ZoektSearchResult {
    if (results.length === 0) {
      return {
        matches: [],
        stats: { filesConsidered: 0, filesLoaded: 0, matchCount: 0, durationMs: 0 },
      };
    }
    if (results.length === 1) return results[0];

    const fileMap = new Map<string, ZoektFileMatch>();
    const mergedStats: ZoektStats = {
      filesConsidered: 0,
      filesLoaded: 0,
      matchCount: 0,
      durationMs: 0,
    };

    for (const result of results) {
      for (const match of result.matches) {
        const key = `${match.repository}::${match.fileName}`;
        const existing = fileMap.get(key);
        if (!existing || match.score > existing.score) {
          fileMap.set(key, match);
        }
      }
      mergedStats.filesConsidered += result.stats.filesConsidered;
      mergedStats.filesLoaded += result.stats.filesLoaded;
      mergedStats.matchCount += result.stats.matchCount;
      mergedStats.durationMs = Math.max(mergedStats.durationMs, result.stats.durationMs);
    }

    const matches = Array.from(fileMap.values()).sort((a, b) => b.score - a.score);
    return { matches, stats: mergedStats };
  }
}
