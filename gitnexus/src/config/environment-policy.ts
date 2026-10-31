export const SHARED_ALLOWED_ENVIRONMENTS_KEY = 'GITNEXUS_WEBHOOK_ALLOWED_ENVS';
export const LEGACY_ALLOWED_ENVIRONMENTS_KEY = 'GITNEXUS_ALLOWED_WEBHOOK_ENVS';

const DEFAULT_ALLOWED_ENVIRONMENTS = ['dev', 'pro', 'iteng'];

export const parseAllowedEnvs = (raw: string | undefined): string[] => {
  const values = new Set(
    (raw ?? '')
      .split(',')
      .map((env) => env.trim().toLowerCase())
      .filter(Boolean),
  );
  return [...values];
};

export const getAllowedEnvironments = (env: NodeJS.ProcessEnv = process.env): string[] => {
  const configured = env[SHARED_ALLOWED_ENVIRONMENTS_KEY] ?? env[LEGACY_ALLOWED_ENVIRONMENTS_KEY];
  const allowed = parseAllowedEnvs(configured);
  return allowed.length > 0 ? allowed : DEFAULT_ALLOWED_ENVIRONMENTS;
};
