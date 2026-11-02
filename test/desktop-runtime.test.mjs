import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { ensureServer, environment } from '../desktop/runtime.cjs';
const root = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const ready = { capabilities: { automaticDispatch: true }, runs: [] };
async function unusedPort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}
test('desktop reuses compatible Office without starting or terminating another owner', async () => {
  let launches = 0;
  const handle = await ensureServer({
    root,
    fetcher: async () => response(ready),
    launcher: () => {
      launches++;
    },
  });
  assert.equal(handle.owned, false);
  assert.equal(launches, 0);
  assert.equal(await handle.stop({ force: true }), false);
});
test('occupied incompatible port is never treated as an invitation to replace the service', async () => {
  let launches = 0;
  await assert.rejects(
    ensureServer({
      root,
      fetcher: async () => response({ message: 'unrelated' }),
      launcher: () => {
        launches++;
      },
    }),
    /互換性/,
  );
  assert.equal(launches, 0);
});
for (let attempt = 1; attempt <= 3; attempt++)
  test(`desktop cold start, warm reuse and owned stop ${attempt}`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'office-desktop-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const port = await unusedPort();
    let handle;
    t.after(async () => {
      if (handle) await handle.stop({ force: true });
    });
    handle = await ensureServer({
      root,
      nodePath: process.execPath,
      port,
      dataDir: dir,
      entry: 'desktop-server.cjs',
      interval: 20,
    });
    assert.equal(handle.owned, true);
    assert.equal((await (await fetch(handle.origin + '/api/state')).json()).runs.length, 0);
    assert.ok(existsSync(join(dir, 'desktop-server.log')));
    const reused = await ensureServer({ root, port, fetcher: fetch });
    assert.equal(reused.owned, false);
    await reused.stop();
    assert.equal((await fetch(handle.origin + '/api/state')).status, 200);
    await handle.stop();
    await assert.rejects(fetch(handle.origin + '/api/state'));
  });
test('active run refuses normal quit but an explicit forced quit stops the owned server', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'office-desktop-busy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const port = await unusedPort();
  const handle = await ensureServer({
    root,
    nodePath: process.execPath,
    port,
    dataDir: dir,
    entry: 'desktop-server.cjs',
    env: { ...process.env, DESKTOP_TEST_BUSY: '1' },
    interval: 20,
  });
  t.after(() => handle.stop({ force: true }));
  await assert.rejects(handle.stop(), (e) => e.code === 'OFFICE_BUSY');
  assert.equal((await fetch(handle.origin + '/api/state')).status, 200);
  await handle.stop({ force: true });
  await assert.rejects(fetch(handle.origin + '/api/state'));
});
test('missing runtime fails honestly without pretending to be running', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'office-desktop-missing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(
    ensureServer({
      root,
      nodePath: '/missing/agent-office-node',
      port: await unusedPort(),
      dataDir: dir,
      entry: 'desktop-server.cjs',
      interval: 10,
    }),
    /実行環境/,
  );
});
test('desktop validates port and augments Finder PATH without replacing other preferences', async () => {
  for (const port of [0, -1, 65536, NaN])
    await assert.rejects(ensureServer({ root, port }), /ポート/);
  const env = environment({ HOME: '/nonexistent-user', PATH: '/my/tools', KEEP: 'value' });
  assert.equal(env.KEEP, 'value');
  assert.ok(env.PATH.startsWith('/my/tools:'));
  assert.ok(env.PATH.includes('/usr/bin'));
});
