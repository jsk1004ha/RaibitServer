import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommand, commandToString, type CommandSpec } from './command-runner.ts';
import { slugify } from './ids.ts';
import { normalizeTenantGitUrl } from './security.ts';

export function validateGitUrl(repoUrl: string) {
  const value = String(repoUrl || '').trim();
  if (!value) throw new Error('repoUrl is required for github/git source');
  return normalizeTenantGitUrl(value, { env: process.env });
}

export function redactGitUrl(url: string) {
  const value = String(url || '');
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      parsed.username = '****';
      parsed.password = '';
    }
    for (const key of [...parsed.searchParams.keys()]) {
      if (isCredentialQueryKey(key)) parsed.searchParams.set(key, '****');
    }
    return parsed.toString();
  } catch {
    return value
      .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/i, '$1****@')
      .replace(/([?&](?:access[_-]?token|token|api[_-]?key|password|credential|auth)=)[^&#\s]*/gi, '$1****');
  }
}

function withToken(repoUrl: string, token?: string) {
  // Tokens are intentionally not embedded in argv/URLs because process lists can leak them.
  // cloneRepository creates a temporary GIT_ASKPASS helper for actual authenticated clones.
  return { url: repoUrl, redactedUrl: token ? `${repoUrl} (auth via GIT_ASKPASS)` : repoUrl };
}

export function gitCloneCommand({ repoUrl, branch = 'main', destination, depth = 1, commitSha = null, token = undefined, extraArgs = [] }: Record<string, any>) {
  const validated = validateGitUrl(repoUrl);
  const auth = withToken(validated, token);
  const args = ['clone', '--depth', String(depth), '--branch', String(branch), auth.url, destination, ...extraArgs];
  const redactedArgs = ['clone', '--depth', String(depth), '--branch', String(branch), auth.redactedUrl, destination, ...extraArgs];
  if (commitSha) {
    // The checkout happens as a separate step so shallow clones can be deepened by callers if needed.
  }
  return {
    executable: 'git',
    args,
    env: { GIT_TERMINAL_PROMPT: '0' },
    redacted: ['git', ...redactedArgs].join(' '),
  } satisfies CommandSpec;
}

export async function cloneRepository(options: Record<string, any>) {
  const repoUrl = validateGitUrl(options.repoUrl);
  const branch = options.branch || 'main';
  const destination = options.destination || path.join(options.workspaceDir || '.raibitserver-work', slugify(options.name || path.basename(repoUrl, '.git')));
  const dryRun = options.dryRun !== false;
  if (!dryRun) await fs.mkdir(path.dirname(destination), { recursive: true });
  const clone: CommandSpec = gitCloneCommand({ ...options, repoUrl, branch, destination });
  const askPass = !dryRun && options.token ? await writeAskPassScript(String(options.token)) : null;
  if (askPass) clone.env = { ...(clone.env || {}), GIT_ASKPASS: askPass.scriptPath };
  const steps = [];
  try {
    steps.push(await runCommand(clone, { dryRun, timeoutMs: options.timeoutMs || 10 * 60 * 1000 }));
    if (options.commitSha) {
      steps.push(await runCommand({ executable: 'git', args: ['checkout', String(options.commitSha)], cwd: destination }, { dryRun, timeoutMs: options.timeoutMs || 10 * 60 * 1000 }));
    }
  } finally {
    if (askPass) {
      await fs.writeFile(askPass.scriptPath, '#!/bin/sh\nexit 1\n', { mode: 0o700 }).catch(() => undefined);
      await fs.rm(askPass.directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return {
    provider: repoUrl.includes('github.com') ? 'github' : 'git',
    repoUrl: redactGitUrl(repoUrl),
    branch,
    commitSha: options.commitSha || null,
    destination,
    dryRun,
    commands: steps.map((step) => step.command),
    steps: steps.map((step) => ({ command: step.command, cwd: step.cwd, dryRun: step.dryRun, exitCode: step.exitCode, stdout: step.stdout, stderr: step.stderr })),
  };
}


async function writeAskPassScript(token: string) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'raibitserver-git-askpass-'));
  try {
    await fs.chmod(directory, 0o700);
    const script = path.join(directory, 'askpass.sh');
    const body = `#!/bin/sh
case "$1" in
  *Username*) printf '%s\n' 'x-access-token' ;;
  *) printf '%s\n' ${shSingleQuote(token)} ;;
esac
`;
    await fs.writeFile(script, body, { mode: 0o700 });
    await fs.chmod(script, 0o700);
    return { directory, scriptPath: script };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function shSingleQuote(value: string) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function isCredentialQueryKey(key: string) {
  return /(?:secret|password|passwd|token|private.?key|credential|database.?url|api.?key|access.?key|auth)/i.test(key);
}

export function sourceCheckoutPlan(service: Record<string, any>, options: Record<string, any> = {}) {
  if (service.sourceType === 'image') {
    return { required: false, reason: 'prebuilt image source does not require source checkout' };
  }
  if (service.sourceType === 'local') {
    return { required: false, localPath: service.localPath || service.buildContext || '.', reason: 'local source path is already available' };
  }
  const repoUrl = service.repoUrl || service.repositoryUrl;
  if (!repoUrl) return { required: false, reason: 'no repository URL configured' };
  const destination = options.destination || path.join(options.workspaceDir || '.raibitserver-work', slugify(service.name || 'service'));
  const command = gitCloneCommand({ repoUrl, branch: service.branch || 'main', destination, depth: service.cloneDepth || 1, token: options.token });
  return {
    required: true,
    provider: repoUrl.includes('github.com') ? 'github' : 'git',
    repoUrl: redactGitUrl(repoUrl),
    branch: service.branch || 'main',
    commitSha: service.commitSha || service.commitHash || null,
    destination,
    command: commandToString(command),
  };
}
