import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AnalyzeJob } from '../../src/server/analyze-job.js';
import {
  isLocalDiagnosticsEnabled,
  toLocalDiagnosticJob,
} from '../../src/server/api.js';
import { isLoopbackPeerAddress, requireLoopbackPeer } from '../../src/server/middleware.js';

const repoRoot = resolve(__dirname, '../../..');
const enabledBeforeTest = process.env.GITNEXUS_LOCAL_DIAGNOSTICS_ENABLED;

afterEach(() => {
  if (enabledBeforeTest === undefined) delete process.env.GITNEXUS_LOCAL_DIAGNOSTICS_ENABLED;
  else process.env.GITNEXUS_LOCAL_DIAGNOSTICS_ENABLED = enabledBeforeTest;
});

describe('本地锁诊断接口安全边界', () => {
  it('仅接受直接回环地址，不信任可伪造的代理请求 IP', () => {
    expect(isLoopbackPeerAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackPeerAddress('::1')).toBe(true);
    expect(isLoopbackPeerAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackPeerAddress('10.1.14.177')).toBe(false);

    const next = vi.fn();
    const res = { status: vi.fn().mockReturnThis(), end: vi.fn() } as unknown as Response;
    requireLoopbackPeer(
      { socket: { remoteAddress: '10.1.14.177' } } as unknown as Request,
      res,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('默认关闭，只有显式配置才开启', () => {
    delete process.env.GITNEXUS_LOCAL_DIAGNOSTICS_ENABLED;
    expect(isLocalDiagnosticsEnabled()).toBe(false);

    process.env.GITNEXUS_LOCAL_DIAGNOSTICS_ENABLED = 'true';
    expect(isLocalDiagnosticsEnabled()).toBe(true);
  });

  it('任务诊断视图不泄露路径、仓库 URL 或异常内容', () => {
    const job: AnalyzeJob = {
      id: 'job-123',
      status: 'analyzing',
      repoName: 'dev-saasoanew',
      repoUrl: 'https://secret.example/repo.git',
      repoPath: '/projects/private/repo',
      error: 'secret endpoint failed',
      progress: { phase: 'embeddings', percent: 42, message: 'secret detail' },
      startedAt: 1_700_000_000_000,
      retryCount: 3,
    };

    const diagnostic = toLocalDiagnosticJob(job);
    expect(diagnostic).toEqual({
      id: 'job-123',
      status: 'analyzing',
      repoName: 'dev-saasoanew',
      progress: { phase: 'embeddings', percent: 42 },
      startedAt: 1_700_000_000_000,
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(/secret|private|https/i);
  });

  it('诊断接口经由对外 Web 代理时被拒绝', () => {
    const source = readFileSync(resolve(repoRoot, 'mcp_proxy_docker/proxy.js'), 'utf8');
    expect(source).toContain("const LOCAL_DIAGNOSTICS_PATH = '/api/internal/repo-locks';");
    expect(source).toContain("(?:/|%2f|$)");
    expect(source).toMatch(/isLocalDiagnosticsRequest\(req\.url\)[\s\S]{0,120}res\.statusCode = 404/);
  });
});
