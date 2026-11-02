const { spawn } = require('node:child_process');
const {
  constants,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  fstatSync,
  ftruncateSync,
} = require('node:fs');
const { dirname, join, resolve } = require('node:path');
const { homedir } = require('node:os');
const { setTimeout: wait } = require('node:timers/promises');

function environment(input = process.env) {
  const home = input.HOME || homedir();
  let versions = [];
  try {
    versions = readdirSync(join(home, '.nvm', 'versions', 'node'))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((name) => join(home, '.nvm', 'versions', 'node', name, 'bin'))
      .filter(existsSync);
  } catch {
    /* Node may be installed by another manager. */
  }
  const extra = [
    join(home, '.local', 'bin'),
    ...versions,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  return {
    ...input,
    PATH: [...new Set([...(input.PATH || '').split(':').filter(Boolean), ...extra])].join(':'),
  };
}

async function inspect(origin, fetcher) {
  let response;
  try {
    response = await fetcher(`${origin}/api/state`, {
      signal: AbortSignal.timeout(2000),
      redirect: 'error',
    });
  } catch {
    return null;
  }
  let state;
  try {
    state = await response.json();
  } catch {
    throw new Error('4317番で別のサービスが応答しています。既存のサービスは停止しません。');
  }
  if (
    !response.ok ||
    !Array.isArray(state?.runs) ||
    state?.capabilities?.automaticDispatch !== true
  ) {
    throw new Error(
      'Agent Officeと互換性のないサービスが応答しています。4317の起動元を確認してください。',
    );
  }
  return state;
}

async function ensureServer({
  root,
  nodePath = process.execPath,
  env = process.env,
  port = 4317,
  dataDir,
  fetcher = fetch,
  launcher = spawn,
  pause = wait,
  attempts = 100,
  interval = 400,
  entry = 'server.mjs',
}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ポートが不正です');
  const origin = `http://127.0.0.1:${port}`;
  const current = await inspect(origin, fetcher);
  if (current) return { origin, owned: false, stop: async () => false };
  root = resolve(root);
  const serverFile = join(root, entry);
  if (!existsSync(serverFile)) throw new Error('Agent Officeのサーバーが見つかりません');
  dataDir = resolve(dataDir || join(root, '.data'));
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const log = join(dataDir, 'desktop-server.log');
  const fd = openSync(
    log,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW || 0),
    0o600,
  );
  if (fstatSync(fd).size > 1024 * 1024) ftruncateSync(fd, 0);
  let child;
  try {
    child = launcher(nodePath, [serverFile], {
      cwd: root,
      env: { ...environment(env), PORT: String(port), OFFICE_DATA_DIR: dataDir },
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      shell: false,
    });
  } finally {
    closeSync(fd);
  }
  let exited = false,
    failed = false;
  child.once('exit', () => {
    exited = true;
  });
  child.once('error', () => {
    failed = true;
    exited = true;
  });
  function untilExit(milliseconds) {
    if (exited) return Promise.resolve();
    return new Promise((done) => {
      const finish = () => {
        clearTimeout(timer);
        child.off('exit', finish);
        child.off('error', finish);
        done();
      };
      const timer = setTimeout(finish, milliseconds);
      child.once('exit', finish);
      child.once('error', finish);
    });
  }
  async function terminate() {
    if (exited) return false;
    const ended = untilExit(6000);
    child.kill('SIGTERM');
    await ended;
    if (!exited) {
      const killed = untilExit(1500);
      child.kill('SIGKILL');
      await killed;
    }
    if (!exited) throw new Error('終了を確認できませんでした。作業状態を確認してください。');
    return true;
  }
  const handle = {
    origin,
    owned: true,
    async stop({ force = false } = {}) {
      if (exited) return false;
      if (!force) {
        const state = await inspect(origin, fetcher);
        if (!state) throw new Error('作業状態を確認できないため停止していません。');
        if (
          state.activeRunId ||
          state.runs.some((run) => ['running', 'queued'].includes(run.status))
        ) {
          const error = new Error(
            '作業中のため終了できません。ウィンドウを閉じても処理は続きます。',
          );
          error.code = 'OFFICE_BUSY';
          throw error;
        }
      }
      return terminate();
    },
  };
  try {
    for (let i = 0; i < attempts; i++) {
      if (exited)
        throw new Error(
          failed
            ? '実行環境を起動できませんでした。'
            : 'サーバーが起動途中で終了しました。ログを確認してください。',
        );
      const state = await inspect(origin, fetcher);
      if (state && !exited) return handle;
      await pause(interval);
    }
    throw new Error(
      'Agent Officeの起動を確認できませんでした。しばらく待ってから開き直してください。',
    );
  } catch (error) {
    await terminate();
    throw error;
  }
}

module.exports = { ensureServer, environment };
