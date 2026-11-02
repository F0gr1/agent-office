import { spawnSync } from 'node:child_process';
import { findCodex, cliRunner } from './codex-runner.mjs';
import { claudeRunner } from './claude-runner.mjs';

const CLI_TIMEOUT = 5000;

function cliVersion(bin) {
  const result = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: CLI_TIMEOUT });
  if (result.status !== 0) return null;
  // Only a version number is surfaced to the browser, never arbitrary CLI output.
  return (result.stdout.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/) || [])[0] || '不明';
}

export function findClaude() {
  const candidates = [
    process.env.OFFICE_CLAUDE_BIN,
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    `${process.env.HOME || ''}/.local/bin/claude`,
    'claude',
  ].filter(Boolean);
  for (const bin of candidates) {
    const version = cliVersion(bin);
    if (version) return { bin, available: true, version };
  }
  return { bin: 'claude', available: false, version: '' };
}

function authStatus(bin, args) {
  const result = spawnSync(bin, args, { encoding: 'utf8', timeout: CLI_TIMEOUT });
  if (result.error) return null;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  return null;
}

export async function discoverProviders() {
  const codexRuntime = findCodex();
  const claudeRuntime = findClaude();
  const codexAuthenticated = codexRuntime.available
    ? authStatus(codexRuntime.bin, ['login', 'status'])
    : null;
  const claudeAuthenticated = claudeRuntime.available
    ? authStatus(claudeRuntime.bin, ['auth', 'status'])
    : null;
  return {
    codex: {
      id: 'codex',
      available: codexRuntime.available,
      authenticated: codexAuthenticated,
      version: codexRuntime.available ? cliVersion(codexRuntime.bin) || '不明' : '',
      message: !codexRuntime.available
        ? 'Codex CLIが見つかりません。Codexをインストールしてください。'
        : codexAuthenticated === false
          ? 'ターミナルで codex login を実行してください。'
          : codexAuthenticated === null
            ? 'Codexのログイン状態を確認できませんでした。ターミナルで codex login status を確認してください。'
            : '接続済み',
    },
    claude: {
      id: 'claude',
      available: claudeRuntime.available,
      authenticated: claudeAuthenticated,
      version: claudeRuntime.version,
      message: !claudeRuntime.available
        ? 'Claude Code CLIが見つかりません。Claude Codeをインストールしてください。'
        : claudeAuthenticated === false
          ? 'ターミナルで claude auth login を実行してください。'
          : claudeAuthenticated === null
            ? 'Claudeのログイン状態を確認できませんでした。ターミナルで claude auth status を確認してください。'
            : '接続済み',
    },
  };
}

export function providerRunner() {
  return (options) => {
    const provider = options.role.provider || 'codex';
    if (options.run.attachments?.length && provider !== 'codex')
      throw Error(
        '添付付き依頼の画像・資料入力はClaude Code接続で未確認です。Codex接続を利用してください。',
      );
    // Resolve on each task: a CLI installed after the settings view was opened
    // is available on the next dispatch without restarting the app.
    if (provider === 'codex') return cliRunner(findCodex())(options);
    if (provider === 'claude') return claudeRunner(findClaude())(options);
    throw Error('未対応のAIプロバイダーです');
  };
}
