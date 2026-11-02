import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ActivityTracker, commandCategory } from './activity.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function failedCommandFingerprint(item) {
  const code = item?.exit_code;
  const output =
    typeof item?.aggregated_output === 'string'
      ? item.aggregated_output
      : typeof item?.output === 'string'
        ? item.output
        : null;
  if (typeof item?.command !== 'string' || !Number.isInteger(code) || code === 0 || output === null)
    return null;
  if (code === 1 && commandCategory(item.command) === 'search') return null;
  return createHash('sha256')
    .update(JSON.stringify([item.command, code, output]))
    .digest('hex');
}

export function findCodex() {
  const candidates = [
    process.env.OFFICE_CODEX_BIN,
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    'codex',
  ].filter(Boolean);

  for (const bin of candidates) {
    const result = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000 });
    if (result.status === 0) {
      return { bin, available: true, version: result.stdout.trim() };
    }
  }
  return { bin: 'codex', available: false, version: 'Codex CLIが見つかりません' };
}

export function validateResult(value) {
  const valid =
    value &&
    typeof value.summary === 'string' &&
    typeof value.content === 'string' &&
    ['pass', 'revise', 'blocked'].includes(value.verdict) &&
    Array.isArray(value.issues) &&
    value.issues.every((issue) => typeof issue === 'string') &&
    Array.isArray(value.checks) &&
    value.checks.every((check) => typeof check === 'string') &&
    (value.verification === undefined ||
      (Array.isArray(value.verification) &&
        value.verification.every(
          (entry) =>
            entry &&
            ['verified', 'unverified', 'failed'].includes(entry.status) &&
            typeof entry.subject === 'string' &&
            entry.subject.trim() &&
            typeof entry.evidence === 'string' &&
            (entry.status !== 'verified' || entry.evidence.trim()),
        )));
  if (!valid) throw Error('担当の回答形式を確認できませんでした');
  return value.verdict === 'pass' && value.issues.length ? { ...value, verdict: 'revise' } : value;
}

export function cliArgs(run, role, schemaFile = 'result.schema.json') {
  return [
    'exec',
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    '--color',
    'never',
    '-C',
    run.workspace,
    '-m',
    role.model,
    '-c',
    `model_reasoning_effort="${role.effort}"`,
    '-c',
    'approval_policy="never"',
    '-s',
    role.id === 'builder' ? 'workspace-write' : 'read-only',
    '--output-schema',
    join(root, schemaFile),
    ...(run.imagePaths || []).flatMap((path) => ['--image', path]),
    '-',
  ];
}

export function cliRunner(runtime) {
  return ({ run, role, prompt, signal, onEvent, onUsage, schemaFile, imagePaths = [] }) =>
    new Promise((resolve, reject) => {
      const child = spawn(runtime.bin, cliArgs({ ...run, imagePaths }, role, schemaFile), {
        env: { ...process.env, AGENT_OFFICE_WORKER: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      let buffer = '';
      let lastMessage = '';
      let failure = '';
      let completed = false;
      let settled = false;
      let killTimer;
      const activity = new ActivityTracker(onEvent);
      let lastFailedCommand = null;
      let repeatedFailures = 0;
      let loopGuardTriggered = false;

      const kill = () => {
        if (!killTimer) {
          killTimer = setTimeout(() => {
            try {
              if (process.platform === 'win32') child.kill('SIGKILL');
              else process.kill(-child.pid, 'SIGKILL');
            } catch {}
          }, 1500);
        }
        try {
          if (process.platform === 'win32') child.kill('SIGTERM');
          else process.kill(-child.pid, 'SIGTERM');
        } catch {}
      };
      const abort = () => {
        failure = '実行を停止しました';
        kill();
      };
      const timer = setTimeout(
        () => {
          failure = '担当の実行が30分を超えたため停止しました';
          kill();
        },
        30 * 60 * 1000,
      );
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(value);
      };
      const processLine = (text) => {
        let event;
        try {
          event = JSON.parse(text);
        } catch {
          return;
        }
        if (event.type === 'turn.completed') {
          completed = true;
          if (typeof onUsage === 'function' && event.usage && typeof event.usage === 'object') {
            const usage = Object.fromEntries(
              ['input_tokens', 'cached_input_tokens', 'output_tokens']
                .filter((key) => Number.isSafeInteger(event.usage[key]) && event.usage[key] >= 0)
                .map((key) => [key, event.usage[key]]),
            );
            if (Object.keys(usage).length) onUsage(usage);
          }
        }
        if (event.type === 'turn.failed' || event.type === 'error') {
          // CLI error details may embed command output or tool arguments.
          if (!loopGuardTriggered) failure = 'Codex実行エラー';
        }
        const item = event.item;
        if (
          event.type === 'item.completed' &&
          item?.type === 'agent_message' &&
          !(item.id != null && activity.completed.has(String(item.id)))
        ) {
          try {
            validateResult(JSON.parse(item.text));
            lastMessage = item.text;
          } catch {}
        }
        // A completed item ID is counted once, even if the CLI repeats its event.
        const duplicate =
          event.type === 'item.completed' &&
          item?.id != null &&
          activity.completed.has(String(item.id));
        if (!duplicate && event.type === 'item.completed' && item?.type === 'file_change') {
          lastFailedCommand = null;
          repeatedFailures = 0;
        }
        if (!duplicate && event.type === 'item.completed' && item?.type === 'command_execution') {
          const fingerprint = failedCommandFingerprint(item);
          if (fingerprint) {
            repeatedFailures = fingerprint === lastFailedCommand ? repeatedFailures + 1 : 1;
            lastFailedCommand = fingerprint;
          } else {
            repeatedFailures = 0;
            lastFailedCommand = null;
          }
        }
        activity.setRepeatFailures(repeatedFailures);
        activity.ingest(event);
        if (!loopGuardTriggered && repeatedFailures >= 3) {
          loopGuardTriggered = true;
          failure = '同じコマンドの失敗が3回続いたため停止しました';
          activity.emit('同じ失敗が続いたため確認が必要です', 'blocked');
          kill();
        }
      };

      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        if (buffer.length > 2_000_000) {
          failure = 'イベントサイズの上限を超えました';
          kill();
          return;
        }
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          processLine(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
        }
      });
      // Keep stderr drained so the child cannot block on a full pipe.
      child.stderr.resume();
      child.on('error', (error) => finish(error));
      child.on('close', (code) => {
        if (buffer) processLine(buffer);
        if (signal.aborted || failure || code !== 0 || !completed) {
          const error = Error(
            failure ||
              `Codexが正常終了しませんでした (exit ${code})。ログインとモデル利用可否を確認してください。`,
          );
          if (loopGuardTriggered) error.code = 'OFFICE_LOOP_GUARD';
          finish(error);
          return;
        }
        try {
          finish(null, validateResult(JSON.parse(lastMessage)));
        } catch (error) {
          finish(error);
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });
}
