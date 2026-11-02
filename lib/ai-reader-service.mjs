import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

export const AI_READER_URL = 'http://127.0.0.1:4318/';
export function aiReaderDataDir(root, env = process.env) {
  return (
    env.AI_READER_DATA_DIR ||
    (env.OFFICE_DATA_DIR && resolve(env.OFFICE_DATA_DIR) !== resolve(root, '.data')
      ? join(env.OFFICE_DATA_DIR, 'ai-reader')
      : join(root, 'services', 'ai-reader', '.data'))
  );
}
export function createAiReaderService({
  root,
  dataDir,
  fetcher = fetch,
  launcher = spawn,
  nodePath = process.execPath,
}) {
  let child = null,
    instance = null,
    busy = false;
  const entry = join(root, 'services', 'ai-reader', 'server.mjs');
  async function inspect() {
    try {
      const response = await fetcher(`${AI_READER_URL}health`, {
        signal: AbortSignal.timeout(1500),
        redirect: 'error',
      });
      const result = await response.json();
      if (
        response.ok &&
        result.serviceId === 'ai-reader' &&
        result.version === 1 &&
        typeof result.instance === 'string'
      )
        return {
          status: 'running',
          owned:
            !!child &&
            child.exitCode === null &&
            child.signalCode === null &&
            result.instance === instance,
          url: AI_READER_URL,
          checkedAt: new Date().toISOString(),
        };
      return {
        status: 'unknown',
        owned: false,
        url: AI_READER_URL,
        checkedAt: new Date().toISOString(),
        error: '4318番に別のサービスが応答しています',
      };
    } catch (error) {
      return {
        status: error.cause?.code === 'ECONNREFUSED' ? 'stopped' : 'unknown',
        owned: false,
        url: AI_READER_URL,
        checkedAt: new Date().toISOString(),
        error: error.cause?.code === 'ECONNREFUSED' ? null : '接続を確認できません',
      };
    }
  }
  async function stopOwned() {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      child = null;
      instance = null;
      return;
    }
    const target = child;
    async function waitForExit(ms) {
      if (target.exitCode !== null || target.signalCode !== null) return;
      let onExit;
      try {
        await Promise.race([
          new Promise((resolve) => {
            onExit = resolve;
            target.once('exit', onExit);
          }),
          pause(ms),
        ]);
      } finally {
        target.off('exit', onExit);
      }
    }
    target.kill('SIGTERM');
    await waitForExit(3000);
    if (target.exitCode === null && target.signalCode === null) {
      target.kill('SIGKILL');
      await waitForExit(1000);
    }
    if (target.exitCode === null && target.signalCode === null)
      throw Object.assign(new Error('サービスの停止を確認できません。再起動しません'), {
        status: 409,
      });
    if (child === target) {
      child = null;
      instance = null;
    }
  }
  async function operate(action) {
    if (busy) throw Object.assign(new Error('操作中です'), { status: 409 });
    if (!['start', 'stop', 'restart'].includes(action))
      throw Object.assign(new Error('未対応です'), { status: 404 });
    busy = true;
    try {
      const current = await inspect();
      if (action === 'stop' || action === 'restart') {
        if (!current.owned)
          throw Object.assign(new Error('Officeが起動したサービスだけ停止できます'), {
            status: 409,
          });
        await stopOwned();
        if (action === 'stop') return inspect();
      } else if (current.status === 'running') return current;
      else if (current.status !== 'stopped')
        throw Object.assign(new Error('4318番の状態を確認できないため起動しません'), {
          status: 409,
        });
      if (!existsSync(entry))
        throw new Error(
          'AI情報リーダーが見つかりません。別リポジトリを services/ai-reader に配置してください',
        );
      instance = randomBytes(16).toString('hex');
      const env = {
        ...process.env,
        AI_READER_INSTANCE_ID: instance,
        AI_READER_DATA_DIR: dataDir,
        ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE || '1',
      };
      delete env.PORT;
      child = launcher(nodePath, [entry], {
        cwd: dirname(entry),
        env,
        stdio: 'ignore',
        shell: false,
        windowsHide: true,
      });
      const spawned = child;
      let spawnError = null;
      spawned.on('error', (error) => {
        spawnError = error;
      });
      for (let i = 0; i < 30; i++) {
        await pause(100);
        if (spawnError || spawned.exitCode !== null || spawned.signalCode !== null) break;
        const state = await inspect();
        if (state.status === 'running' && state.owned) return state;
        if (state.status === 'running' && !state.owned) break;
      }
      await stopOwned();
      if (spawnError) throw new Error(`起動できません: ${spawnError.message}`);
      throw Object.assign(
        new Error('4318番の起動を確認できません。ポート競合や保存先を確認してください'),
        { status: 409 },
      );
    } finally {
      busy = false;
    }
  }
  return {
    inspect,
    operate,
    shutdown: () => {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    },
  };
}
