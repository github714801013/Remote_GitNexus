import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';

const POD_INSTALL_ARGS = ['install', '--repo-update', '--allow-root', '--no-ansi'] as const;
const MAX_FAILURE_OUTPUT_CHARS = 12_000;

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  cwd: string,
) => Promise<CommandResult>;

export function formatPodInstallFailure(stdout: string, stderr: string): string {
  const sections = [
    ['stdout', stdout],
    ['stderr', stderr],
  ]
    .map(([label, output]) => [label, output.trim()] as const)
    .filter(([, output]) => output.length > 0)
    .map(([label, output]) => {
      const tail =
        output.length > MAX_FAILURE_OUTPUT_CHARS
          ? output.slice(output.length - MAX_FAILURE_OUTPUT_CHARS)
          : output;
      return `${label}:\n${tail}`;
    });
  return sections.join('\n\n') || 'no output';
}

export function buildCocoaPodsEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    LANG: baseEnv.LANG || 'C.UTF-8',
  };
  const token = baseEnv.GITEA_TOKEN;
  if (token) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = `url.https://${encodeURIComponent(token)}@code.9ji.com/.insteadOf`;
    env.GIT_CONFIG_VALUE_0 = 'https://code.9ji.com/';
  }
  return env;
}

export async function hasPodfile(repoPath: string): Promise<boolean> {
  return fs.access(path.join(repoPath, 'Podfile')).then(
    () => true,
    () => false,
  );
}

export async function ensureCocoaPodsDependencies(
  repoPath: string,
  runCommand: CommandRunner = runProcess,
): Promise<boolean> {
  if (!(await hasPodfile(repoPath))) {
    return false;
  }

  console.info(`[cocoapods] installing dependencies repoPath=${path.resolve(repoPath)}`);
  await runCommand('pod', [...POD_INSTALL_ARGS], repoPath);
  console.info(`[cocoapods] dependencies ready repoPath=${path.resolve(repoPath)}`);
  return true;
}

const runProcess: CommandRunner = (command, args, cwd) =>
  new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildCocoaPodsEnv(),
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('error', (err) => {
      reject(new Error(`pod install failed to start: ${err.message}`));
    });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `pod install failed (exit code ${code}): ${formatPodInstallFailure(stdout, stderr)}`,
        ),
      );
    });
  });
