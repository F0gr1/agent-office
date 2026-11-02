import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { HostServices } from '../lib/host-services.mjs';

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'office-host-'));
  const workspace = join(root, 'project');
  const worklogDir = join(root, 'worklog');
  mkdirSync(workspace);
  const host = new HostServices({ worklogDir, ...options });
  t.after(async () => {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  });
  const run = {
    id: randomUUID(),
    workspace,
    instruction: 'secret prompt must not be logged',
    mode: 'standard',
    stage: 'builder',
    status: 'running',
  };
  return { root, workspace, worklogDir, host, run };
}

function requestRaw(url, path, { method = 'GET', host } = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port: target.port,
        path,
        method,
        headers: host ? { Host: host } : undefined,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('preview serves only dist files over isolated loopback origin', async (t) => {
  const { workspace, host, run } = fixture(t);
  const dist = join(workspace, 'dist');
  mkdirSync(dist);
  writeFileSync(join(dist, 'index.html'), '<!doctype html><script src="/app.js"></script>');
  writeFileSync(join(dist, 'app.js'), 'window.ready=true');
  writeFileSync(join(dist, 'app.css'), 'body{}');
  writeFileSync(join(dist, '.secret'), 'hidden');
  writeFileSync(join(dist, 'app.js.map'), 'source');
  const { preview, worklog } = await host.prepare(run);
  assert.equal(preview.status, 'ready');
  assert.match(preview.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(worklog.status, 'saved');
  const html = await requestRaw(preview.url, '/');
  assert.equal(html.status, 200);
  assert.match(html.body, /doctype html/);
  assert.match(html.headers['content-security-policy'], /connect-src 'self'/);
  assert.match(html.headers['cache-control'], /no-store/);
  const js = await requestRaw(preview.url, '/app.js');
  assert.equal(js.status, 200);
  assert.match(js.headers['content-type'], /text\/javascript/);
  assert.equal((await requestRaw(preview.url, '/app.css', { method: 'HEAD' })).body, '');
  assert.equal((await requestRaw(preview.url, '/app.css', { method: 'HEAD' })).status, 200);
  assert.equal((await requestRaw(preview.url, '/', { method: 'POST' })).status, 405);
  assert.equal(
    (await requestRaw(preview.url, '/', { host: 'localhost:' + new URL(preview.url).port })).status,
    403,
  );
  assert.equal((await requestRaw(preview.url, '/.secret')).status, 404);
  assert.equal((await requestRaw(preview.url, '/app.js.map')).status, 404);
  assert.equal((await requestRaw(preview.url, '/%2e%2e/private')).status, 404);
});

test('preview rejects symlink escapes and rechecks files on every read', async (t) => {
  const { root, workspace, host, run } = fixture(t);
  const dist = join(workspace, 'dist');
  mkdirSync(dist);
  writeFileSync(join(dist, 'index.html'), 'safe');
  writeFileSync(join(root, 'outside.txt'), 'outside');
  symlinkSync(join(root, 'outside.txt'), join(dist, 'outside.txt'));
  const first = await host.prepare(run);
  assert.equal(first.preview.status, 'ready');
  assert.equal((await requestRaw(first.preview.url, '/outside.txt')).status, 404);
  rmSync(join(dist, 'index.html'));
  symlinkSync(join(root, 'outside.txt'), join(dist, 'index.html'));
  assert.equal((await requestRaw(first.preview.url, '/')).status, 404);
  assert.equal((await host.prepare(run)).preview.status, 'unavailable');
});

test('dist outside canonical workspace is unavailable', async (t) => {
  const { root, workspace, host, run } = fixture(t);
  const outside = join(root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'index.html'), 'outside');
  symlinkSync(outside, join(workspace, 'dist'));
  const result = await host.prepare(run);
  assert.equal(result.preview.status, 'unavailable');
  assert.equal(result.worklog.status, 'saved');
});

test('preview URL is reused, and old server is evicted when capacity is reached', async (t) => {
  const { root, workspace, host, run } = fixture(t, { maxServers: 1 });
  const dist = join(workspace, 'dist');
  mkdirSync(dist);
  writeFileSync(join(dist, 'index.html'), 'first');
  const first = await host.prepare(run);
  const again = await host.prepare(run);
  assert.equal(first.preview.url, again.preview.url);
  const other = join(root, 'other');
  mkdirSync(join(other, 'dist'), { recursive: true });
  writeFileSync(join(other, 'dist', 'index.html'), 'second');
  const second = await host.prepare({ ...run, id: randomUUID(), workspace: other });
  assert.equal(second.preview.status, 'ready');
  assert.notEqual(second.preview.url, first.preview.url);
  assert.equal(host.servers.size, 1);
});

test('worklog writes one bounded entry and updates its outcome without raw prompt', async (t) => {
  const { host, run } = fixture(t);
  const first = await host.prepare(run);
  const second = await host.prepare(run);
  assert.equal(first.worklog.status, 'saved');
  assert.equal(second.worklog.path, first.worklog.path);
  const path = first.worklog.path;
  let body = readFileSync(path, 'utf8');
  assert.equal(body.match(new RegExp(`<!-- office-run:${run.id} -->`, 'g')).length, 1);
  assert.doesNotMatch(body, /secret prompt must not be logged/);
  writeFileSync(path, `Prior entry\n\n${body}`);
  run.status = 'completed';
  run.stage = 'commander';
  const finished = await host.finish(run);
  assert.equal(finished.status, 'saved');
  body = readFileSync(path, 'utf8');
  assert.match(body, /^Prior entry/);
  assert.equal(body.match(new RegExp(`<!-- office-run:${run.id} -->`, 'g')).length, 1);
  assert.match(body, /ゴールの達成状況: 達成/);
  assert.match(body, /最終工程 commander/);
  assert.doesNotMatch(body, /secret prompt must not be logged/);
});

test('worklog refuses linked destinations', async (t) => {
  const { root, worklogDir, host, run } = fixture(t);
  mkdirSync(worklogDir);
  const target = join(root, 'target.md');
  writeFileSync(target, 'unchanged');
  symlinkSync(target, host.logPath());
  const result = await host.prepare(run);
  assert.equal(result.worklog.status, 'failed');
  assert.equal(readFileSync(target, 'utf8'), 'unchanged');
});
