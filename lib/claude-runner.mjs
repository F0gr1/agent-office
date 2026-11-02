import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateResult } from './codex-runner.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const schema = JSON.stringify(JSON.parse(readFileSync(join(root, 'result.schema.json'), 'utf8')));
const MAX_OUTPUT = 2_000_000;
const TIMEOUT = 30 * 60 * 1000;

function claudeModel(role) {
  const value = String(role.model || '');
  if (!/^(?:claude-[a-z0-9.-]+|sonnet|opus|haiku|fable)$/.test(value))
    throw Error('Claudeのモデル設定が無効です。Claude用のモデルを選択してください。');
  return value;
}

function claudeEffort(role) {
  const value = String(role.effort || '');
  if (!['low', 'medium', 'high', 'max'].includes(value))
    throw Error('Claudeの推論強度設定が無効です。');
  return value;
}

export function claudeArgs(role, schemaFile = 'result.schema.json') {
  const builder = role.id === 'builder';
  const tools = builder ? 'Read,Glob,Grep,Edit,Write' : 'Read,Glob,Grep';
  return [
    '-p',
    '--restricted',
    '--output-format',
    'json',
    '--json-schema',
    schemaFile === 'dispatch.schema.json' ? readFileSync(join(root, schemaFile), 'utf8') : schema,
    '--model',
    claudeModel(role),
    '--effort',
    claudeEffort(role),
    '--permission-mode',
    'dontAsk',
    '--tools',
    tools,
    '--allowedTools',
    tools,
    '--disallowedTools',
    'mcp__*',
    '--no-session-persistence',
  ];
}

export function claudeRunner(runtime) {
  return ({ run, role, prompt, signal, onEvent, onUsage, schemaFile }) =>
    new Promise((resolve, reject) => {
      if (!runtime?.available) {
        reject(Error('Claude Code CLIが見つかりません。ターミナルでインストールしてください。'));
        return;
      }
      if (signal.aborted) {
        reject(Error('実行を停止しました'));
        return;
      }
      const child = spawn(runtime.bin, claudeArgs(role, schemaFile), {
        env: { ...process.env, AGENT_OFFICE_WORKER: '1' },
        cwd: run.workspace,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      let output = '';
      let failure = '';
      let settled = false;
      let killTimer;
      const kill = () => {
        if (!killTimer)
          killTimer = setTimeout(() => {
            try {
              if (process.platform === 'win32') child.kill('SIGKILL');
              else process.kill(-child.pid, 'SIGKILL');
            } catch {}
          }, 1500);
        try {
          if (process.platform === 'win32') child.kill('SIGTERM');
          else process.kill(-child.pid, 'SIGTERM');
        } catch {}
      };
      const abort = () => {
        failure = '実行を停止しました';
        kill();
      };
      const timeout = setTimeout(() => {
        failure = '担当の実行が30分を超えたため停止しました';
        kill();
      }, TIMEOUT);
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(killTimer);
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(value);
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      if (typeof onEvent === 'function')
        onEvent('Claudeが作業中です', {
          phase: 'executing',
          completedSteps: 0,
          activeCount: 1,
          repeatFailures: 0,
        });
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
        if (output.length > MAX_OUTPUT) {
          failure = 'イベントサイズの上限を超えました';
          kill();
        }
      });
      // Error output may contain prompts or credentials. Drain it, but never surface it.
      child.stderr.resume();
      child.on('error', () => finish(Error('Claude Code CLIを起動できませんでした')));
      child.on('close', (code) => {
        if (failure || signal.aborted) return finish(Error(failure || '実行を停止しました'));
        if (code !== 0)
          return finish(
            Error('Claudeが正常終了しませんでした。ログインとモデル利用可否を確認してください。'),
          );
        let envelope;
        try {
          envelope = JSON.parse(output);
        } catch {
          return finish(Error('Claudeの回答形式を確認できませんでした'));
        }
        if (envelope.is_error || !envelope.structured_output)
          return finish(
            Error(
              'Claudeの実行または権限が拒否されました。ターミナルで認証・権限を確認してください。',
            ),
          );
        let value;
        try {
          value = validateResult(envelope.structured_output);
        } catch (error) {
          return finish(error);
        }
        const usage = envelope.usage;
        if (usage && typeof onUsage === 'function') {
          const measured = Object.fromEntries(
            [
              ['input_tokens', usage.input_tokens],
              ['cached_input_tokens', usage.cache_read_input_tokens],
              ['output_tokens', usage.output_tokens],
            ].filter(([, count]) => Number.isSafeInteger(count) && count >= 0),
          );
          if (Object.keys(measured).length) onUsage(measured);
        }
        if (typeof onEvent === 'function')
          onEvent('Claudeの作業が完了しました', {
            phase: 'finalizing',
            completedSteps: 1,
            activeCount: 0,
            repeatFailures: 0,
          });
        finish(null, value);
      });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });
}
