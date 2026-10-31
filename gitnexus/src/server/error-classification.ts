export const REPO_ALREADY_ACTIVE_MESSAGE = 'Another job is already active for this repository';

export const isRepoAlreadyActiveError = (err: unknown): boolean =>
  String(err instanceof Error ? err.message : err).includes(REPO_ALREADY_ACTIVE_MESSAGE);

export const isAnalysisAlreadyInProgressError = (err: unknown): boolean =>
  String(err instanceof Error ? err.message : err).includes('Analysis already in progress');

export const isJsonBodyParseError = (err: unknown): boolean => {
  if (!(err instanceof SyntaxError)) return false;
  const details = err as SyntaxError & {
    status?: number;
    statusCode?: number;
    type?: string;
    body?: unknown;
  };
  return (
    details.type === 'entity.parse.failed' &&
    (details.status === 400 || details.statusCode === 400) &&
    typeof details.body === 'string'
  );
};
