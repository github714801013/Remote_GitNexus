import { logger } from './logger.js';

/** Hosts that accept per-request GitHub PAT credentials. */
export const GITHUB_TOKEN_HOSTS: ReadonlySet<string> = new Set(['github.com', 'www.github.com']);
export const GITEA_TOKEN_HOSTS: ReadonlySet<string> = new Set(['code.9ji.com']);

/** Detect Azure DevOps URLs, including configured self-hosted instances. */
export function isAzureDevOpsUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
    const configuredBase = process.env.AZURE_DEVOPS_URL;
    if (configuredBase) {
      try {
        const baseHost = new URL(configuredBase).hostname.toLowerCase().replace(/\.$/, '');
        if (host === baseHost) return true;
      } catch {
        // Invalid optional configuration falls through to the cloud check.
      }
    }
    return host === 'dev.azure.com' || host.endsWith('.visualstudio.com');
  } catch {
    return false;
  }
}

function resolveGitCredential(options?: { token?: string; url?: string }): string | undefined {
  const url = options?.url;
  if (!url) return undefined;

  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }

  if (options.token && GITHUB_TOKEN_HOSTS.has(host)) {
    return Buffer.from(`x-access-token:${options.token}`).toString('base64');
  }

  if (process.env.GITEA_TOKEN && GITEA_TOKEN_HOSTS.has(host)) {
    return Buffer.from(`${process.env.GITEA_TOKEN}:`).toString('base64');
  }

  const azurePat = process.env.AZURE_DEVOPS_PAT;
  if (azurePat && isAzureDevOpsUrl(url)) {
    return Buffer.from(`:${azurePat}`).toString('base64');
  }

  return undefined;
}

function buildExtraHeaderKey(url: string): string | undefined {
  let scoped: string;
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    scoped = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return undefined;
  }
  scoped = scoped.replace(/[\r\n\0]/g, '');
  return `http.${scoped}.extraHeader`;
}

function warnIfCleartextCredential(url?: string): void {
  if (!url) return;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:') {
      logger.warn(
        `Sending a git credential over cleartext http:// (${parsed.host}) — base64 is not encryption. Prefer https:// where the host supports it.`,
      );
    }
  } catch {
    // URL validation is handled by the caller.
  }
}

/** Build a safe Git child-process environment with host-scoped credentials. */
export function buildGitEnv(
  baseEnv: NodeJS.ProcessEnv,
  options?: { token?: string; url?: string },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: process.platform === 'win32' ? 'echo' : '/bin/true',
    GIT_TRACE: undefined,
    GIT_TRACE_CURL: undefined,
    GIT_TRACE_PACKET: undefined,
    GIT_CURL_VERBOSE: undefined,
  };

  const credential = resolveGitCredential(options);
  const key = options?.url ? buildExtraHeaderKey(options.url) : undefined;
  if (credential && key) {
    const existing = Number.parseInt(env.GIT_CONFIG_COUNT ?? '', 10);
    const base = Number.isInteger(existing) && existing > 0 ? existing : 0;
    env.GIT_CONFIG_COUNT = String(base + 1);
    env[`GIT_CONFIG_KEY_${base}`] = key;
    env[`GIT_CONFIG_VALUE_${base}`] = `Authorization: Basic ${credential}`;
    warnIfCleartextCredential(options?.url);
  }

  return env;
}

/** One-time warning for an insecure configured Azure DevOps endpoint. */
export function warnIfInsecureAzureConfig(): void {
  const base = process.env.AZURE_DEVOPS_URL;
  if (!base) return;
  try {
    if (new URL(base).protocol === 'http:') {
      logger.warn(
        'AZURE_DEVOPS_URL is configured over cleartext http:// — the Azure DevOps PAT will be sent unencrypted. Prefer https:// where your instance supports it.',
      );
    }
  } catch {
    // Invalid optional configuration is handled by isAzureDevOpsUrl.
  }
}
