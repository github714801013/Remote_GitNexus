import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../../..');

describe('remote_deploy.sh', () => {
  const script = readFileSync(resolve(repoRoot, 'mcp_proxy_docker/remote_deploy.sh'), 'utf8');
  const dockerignore = readFileSync(resolve(repoRoot, '.dockerignore'), 'utf8');
  const compose = readFileSync(resolve(repoRoot, 'mcp_proxy_docker/docker-compose.yml'), 'utf8');

  it('defaults remote deployment to the migrated 158 server while allowing overrides', () => {
    expect(script).toContain('REMOTE_HOST="${REMOTE_HOST:-10.1.14.158}"');
    expect(script).toContain('REMOTE_USER="${REMOTE_USER:-root}"');
    expect(script).toContain('REMOTE_PATH="${REMOTE_PATH:-/data1/gitnexus/app}"');
    expect(script).toContain(
      'REMOTE_REPOS_PATH="${REMOTE_REPOS_PATH:-/data1/gitnexus/projects}"',
    );
    expect(script).toContain(
      'REMOTE_GITNEXUS_DATA_PATH="${REMOTE_GITNEXUS_DATA_PATH:-/data1/gitnexus/.gitnexus}"',
    );
    expect(script).toContain(
      'REMOTE_NEO4J_DATA_PATH="${REMOTE_NEO4J_DATA_PATH:-/data1/gitnexus/neo4j}"',
    );
  });

  it('configures the local deployment environment for the migrated 158 server', () => {
    const env = readFileSync(resolve(repoRoot, 'mcp_proxy_docker/.env'), 'utf8');
    expect(env).toContain('REMOTE_HOST=10.1.14.158');
    expect(env).toContain('REMOTE_USER=root');
    expect(env).toContain('REMOTE_PATH=/data1/gitnexus/app');
    expect(env).toContain('REMOTE_REPOS_PATH=/data1/gitnexus/projects');
    expect(env).toContain('REMOTE_GITNEXUS_DATA_PATH=/data1/gitnexus/.gitnexus');
    expect(env).toContain('REMOTE_NEO4J_DATA_PATH=/data1/gitnexus/neo4j');
  });
  it('requires a remote keyword summary URL by default', () => {
    expect(script).toContain(
      'KEYWORD_SUMMARY_EXTERNAL_URL="${GITNEXUS_KEYWORD_SUMMARY_DEPLOY_URL:-}"',
    );
    expect(script).toContain(
      ': "${KEYWORD_SUMMARY_EXTERNAL_URL:?GITNEXUS_KEYWORD_SUMMARY_DEPLOY_URL or remote GITNEXUS_KEYWORD_SUMMARY_URL environment variable is required}"',
    );
    expect(script).not.toContain('KEYWORD_SUMMARY_EXTERNAL_URL:-${LOCAL_KEYWORD_SUMMARY_URL}');
    expect(script).not.toContain(
      'docker compose --env-file .env -f docker-compose.yml up -d keyword-summary',
    );
    expect(script).not.toContain('启动 keyword summary');
    expect(script).toContain('使用远程 keyword summary 服务: ${GITNEXUS_KEYWORD_SUMMARY_URL}');
  });

  it('recreates Zoekt services when deploying the shared file-size configuration', () => {
    expect(script).toContain(
      'docker compose --env-file .env -f docker-compose.yml up -d --force-recreate zoekt-indexserver zoekt-webserver gitnexus-mcp-proxy',
    );
  });

  it('excludes local model and deploy temp directories from the Docker build context', () => {
    expect(dockerignore).toContain('mcp_proxy_docker/models');
    expect(dockerignore).toContain('.download-cache');
    expect(dockerignore).toContain('.docker_temp_*');
  });

  it('passes model pressure controls through deployment configuration', () => {
    expect(script).toContain('GITNEXUS_EMBEDDING_REPAIR_BATCH_SIZE=${GITNEXUS_EMBEDDING_REPAIR_BATCH_SIZE:-8}');
    expect(script).toContain('GITNEXUS_EMBEDDING_REPAIR_CONCURRENCY=${GITNEXUS_EMBEDDING_REPAIR_CONCURRENCY:-1}');
    expect(script).toContain('GITNEXUS_EMBEDDING_PARALLEL_CONCURRENCY=${GITNEXUS_EMBEDDING_PARALLEL_CONCURRENCY:-1}');
    expect(script).toContain('GITNEXUS_KEYWORD_SUMMARY_CONCURRENCY=${GITNEXUS_KEYWORD_SUMMARY_CONCURRENCY:-1}');
    expect(compose).toContain('GITNEXUS_EMBEDDING_REPAIR_BATCH_SIZE=${GITNEXUS_EMBEDDING_REPAIR_BATCH_SIZE:-8}');
    expect(compose).toContain('GITNEXUS_KEYWORD_SUMMARY_CONCURRENCY=${GITNEXUS_KEYWORD_SUMMARY_CONCURRENCY:-1}');
    expect(compose).toContain("'${KEYWORD_SUMMARY_PARALLEL_SLOTS:-1}'");
    expect(compose).toContain("'${KEYWORD_SUMMARY_PARALLEL_REQUESTS:-1}'");
  });
  it('passes local diagnostics enablement through to the recreated container', () => {
    expect(script).toContain(
      'GITNEXUS_LOCAL_DIAGNOSTICS_ENABLED=${GITNEXUS_LOCAL_DIAGNOSTICS_ENABLED:-false}',
    );
    expect(compose).toContain(
      'GITNEXUS_LOCAL_DIAGNOSTICS_ENABLED=${GITNEXUS_LOCAL_DIAGNOSTICS_ENABLED:-false}',
    );
  });


  it('uses one shared max-file-size variable for GitNexus and Zoekt', () => {
    expect(script).toContain(
      'GITNEXUS_MAX_FILE_SIZE=${GITNEXUS_MAX_FILE_SIZE:-5120}',
    );
    expect(compose).not.toContain('GITNEXUS_MAX_FILE_SIZE_BYTES');
    expect(compose).toContain(
      'GITNEXUS_MAX_FILE_SIZE=${GITNEXUS_MAX_FILE_SIZE:-5120}',
    );
    expect(compose).toContain(
      'zoekt-git-index -file_limit "$$((GITNEXUS_MAX_FILE_SIZE * 1024))"',
    );
  });
});
