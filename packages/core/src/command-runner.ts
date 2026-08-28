import { spawn } from 'node:child_process';
import { once } from 'node:events';

export interface CommandSpec {
  executable: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: string;
  redacted?: string;
}

export interface CommandRunResult {
  command: string;
  executable: string;
  args: string[];
  cwd?: string;
  dryRun: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function commandToString(command: CommandSpec) {
  if (command.redacted) return command.redacted;
  return [command.executable, ...(command.args || [])].map(shellQuote).join(' ');
}

export function shellQuote(value: string) {
  const text = String(value);
  if (/^[a-zA-Z0-9_@%+=:,./-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

export async function runCommand(command: CommandSpec, { dryRun = false, timeoutMs = 20 * 60 * 1000 } = {}) {
  const args = command.args || [];
  const printable = commandToString(command);
  if (dryRun) {
    return {
      command: printable,
      executable: command.executable,
      args,
      cwd: command.cwd,
      dryRun: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
    } satisfies CommandRunResult;
  }

  const child = spawn(command.executable, args, {
    detached: true,
    cwd: command.cwd,
    env: { ...process.env, ...(command.env || {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => terminateProcessGroup(child.pid), timeoutMs);
  child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  if (command.stdin) child.stdin?.write(command.stdin);
  child.stdin?.end();

  const [exitCodeRaw] = await once(child, 'close');
  clearTimeout(timer);
  const exitCode = Number(exitCodeRaw ?? 0);
  const safeStdout = redactCommandText(stdout);
  const safeStderr = redactCommandText(stderr);
  const result = { command: printable, executable: command.executable, args, cwd: command.cwd, dryRun: false, exitCode, stdout: safeStdout, stderr: safeStderr } satisfies CommandRunResult;
  if (exitCode !== 0) {
    const error = new Error(`command failed (${exitCode}): ${printable}\n${safeStderr || safeStdout}`);
    (error as any).result = result;
    throw error;
  }
  return result;
}

function terminateProcessGroup(pid: number | undefined) {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGTERM');
    const killTimer = setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Process group already exited.
      }
    }, 5000);
    if (typeof (killTimer as any).unref === 'function') (killTimer as any).unref();
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Process already exited.
    }
  }
}

export async function commandExists(executable: string) {
  try {
    await runCommand({ executable, args: ['--version'] }, { dryRun: false, timeoutMs: 5000 });
    return true;
  } catch {
    return false;
  }
}

function redactCommandText(value: string) {
  return String(value || '')
    .replace(/([A-Z0-9_]*(?:SECRET|PASSWORD|TOKEN|KEY|DATABASE_URL|MONGODB_URI|REDIS_URL)[A-Z0-9_]*=)([^\s]+)/gi, '$1****')
    .replace(/(gh[opusr]_|github_pat_|glpat-|sk-[A-Za-z0-9_-]*|xox[baprs]-)[A-Za-z0-9_\-]+/g, '$1****');
}
