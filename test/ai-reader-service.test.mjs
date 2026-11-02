import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aiReaderDataDir, createAiReaderService } from '../lib/ai-reader-service.mjs';
test('AI Readerの保存先は専用指定、Office保存先、子の既定値の順に選ぶ', () => {
  assert.equal(aiReaderDataDir('/office', {}), '/office/services/ai-reader/.data');
  assert.equal(
    aiReaderDataDir('/office', { OFFICE_DATA_DIR: '/office/.data/' }),
    '/office/services/ai-reader/.data',
  );
  assert.equal(
    aiReaderDataDir('/office', { OFFICE_DATA_DIR: '/office/tmp/../.data' }),
    '/office/services/ai-reader/.data',
  );
  assert.equal(
    aiReaderDataDir('/office', { OFFICE_DATA_DIR: '/office-state' }),
    '/office-state/ai-reader',
  );
  assert.equal(
    aiReaderDataDir('/office', { AI_READER_DATA_DIR: '/reader-state' }),
    '/reader-state',
  );
  assert.equal(
    aiReaderDataDir('/office', {
      AI_READER_DATA_DIR: '/reader-state',
      OFFICE_DATA_DIR: '/office-state',
    }),
    '/reader-state',
  );
});
test('Office管理外の健康なサービスは開ける状態でも停止できない', async () => {
  const service = createAiReaderService({
    root: '.',
    dataDir: '/tmp/reader-test',
    fetcher: async () =>
      new Response(JSON.stringify({ serviceId: 'ai-reader', version: 1, instance: 'external' }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    launcher: () => {
      throw new Error('spawn禁止');
    },
  });
  assert.deepEqual((await service.inspect()).status, 'running');
  assert.equal((await service.inspect()).owned, false);
  await assert.rejects(service.operate('stop'), /Officeが起動したサービスだけ/);
  assert.equal((await service.operate('start')).owned, false);
});
test('不明な4318応答では起動しない', async () => {
  const service = createAiReaderService({
    root: '.',
    dataDir: '/tmp/reader-test',
    fetcher: async () => new Response('else'),
    launcher: () => {
      throw new Error('spawn禁止');
    },
  });
  assert.equal((await service.inspect()).status, 'unknown');
  await assert.rejects(service.operate('start'), /状態を確認できない/);
});
test('リーダー未配置なら取得方法を案内する', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'office-missing-reader-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const service = createAiReaderService({
    root,
    dataDir: join(root, '.data'),
    fetcher: async () => {
      throw Object.assign(new Error('接続拒否'), { cause: { code: 'ECONNREFUSED' } });
    },
    launcher: () => {
      throw new Error('起動されてはいけない');
    },
  });
  await assert.rejects(service.operate('start'), /別リポジトリを services\/ai-reader に配置/);
});
test('停止を確認できない子プロセスは所有情報を保持して再起動しない', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'office-reader-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'services', 'ai-reader'), { recursive: true });
  writeFileSync(join(root, 'services', 'ai-reader', 'server.mjs'), '');
  let launched = 0;
  let instance = null;
  const signals = [];
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    signals.push(signal);
    return true;
  };
  const service = createAiReaderService({
    root,
    dataDir: '/tmp/reader-test',
    fetcher: async () => {
      if (!instance)
        throw Object.assign(new Error('接続拒否'), { cause: { code: 'ECONNREFUSED' } });
      return new Response(JSON.stringify({ serviceId: 'ai-reader', version: 1, instance }));
    },
    launcher: (_path, _args, options) => {
      launched++;
      instance = options.env.AI_READER_INSTANCE_ID;
      return child;
    },
  });
  assert.equal((await service.operate('start')).owned, true);
  await assert.rejects(service.operate('restart'), /停止を確認できません/);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(launched, 1);
  assert.equal((await service.inspect()).owned, true);
  assert.equal(child.listenerCount('exit'), 0);
});
