import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../../..');

describe('remote_deploy.sh', () => {
  const script = readFileSync(resolve(repoRoot, 'mcp_proxy_docker/remote_deploy.sh'), 'utf8');
  const dockerignore = readFileSync(resolve(repoRoot, '.dockerignore'), 'utf8');

  it('requires a remote keyword summary URL by default', () => {
    expect(script).toContain(
      'KEYWORD_SUMMARY_EXTERNAL_URL="${GITNEXUS_KEYWORD_SUMMARY_DEPLOY_URL:-}"',
    );
    expect(script).toContain(
      ': "${KEYWORD_SUMMARY_EXTERNAL_URL:?GITNEXUS_KEYWORD_SUMMARY_DEPLOY_URL or remote GITNEXUS_KEYWORD_SUMMARY_URL environment variable is required}"',
    );
    expect(script).not.toContain('KEYWORD_SUMMARY_EXTERNAL_URL:-${LOCAL_KEYWORD_SUMMARY_URL}');
  });

  it('does not start the local keyword summary model during remote deployment', () => {
    expect(script).not.toContain(
      'docker compose --env-file .env -f docker-compose.yml up -d keyword-summary',
    );
    expect(script).not.toContain('启动 keyword summary');
    expect(script).toContain('使用远程 keyword summary 服务: ${GITNEXUS_KEYWORD_SUMMARY_URL}');
  });

  it('excludes local model and deploy temp directories from the Docker build context', () => {
    expect(dockerignore).toContain('mcp_proxy_docker/models');
    expect(dockerignore).toContain('.download-cache');
    expect(dockerignore).toContain('.docker_temp_*');
  });
});
