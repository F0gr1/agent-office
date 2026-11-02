import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const id = '0b4b11d5-2cac-4df5-afff-707733e169ef';
async function fixture(t) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ method: req.method, path: req.url, body, token: req.headers['x-office-token'] });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/state')
      res.end(
        JSON.stringify({
          capabilities: { automaticDispatch: true },
          activeRunId: null,
          runs: [{ id, status: 'completed', stage: 'commander', instruction: 'fixture' }],
        }),
      );
    else if (req.url === '/api/session') res.end(JSON.stringify({ token: 'fixture-token' }));
    else if (req.url === '/api/runs') {
      res.writeHead(202);
      res.end(JSON.stringify({ id }));
    } else {
      res.writeHead(404);
      res.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { port: server.address().port, calls };
}
async function cli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/office.mjs', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '',
      err = '';
    child.stdout.on('data', (data) => (out += data));
    child.stderr.on('data', (data) => (err += data));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, out, err }));
  });
}
for (let attempt = 1; attempt <= 3; attempt++)
  test(`intake forwards exactly once, preserving literal input and automatic selection ${attempt}`, async (t) => {
    const { port, calls } = await fixture(t);
    const dir = mkdtempSync(join(tmpdir(), 'office-intake-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const instruction = "literal ' $(not-a-command) ; request";
    const file = join(dir, 'request.txt');
    writeFileSync(file, instruction, { mode: 0o600 });
    const result = await cli([
      '--workspace',
      dir,
      '--instruction-file',
      file,
      '--port',
      String(port),
      '--no-open',
    ]);
    assert.equal(result.code, 0, result.err);
    assert.equal(JSON.parse(result.out).id, id);
    const posts = calls.filter((c) => c.method === 'POST');
    assert.equal(posts.length, 1);
    const body = JSON.parse(posts[0].body);
    assert.equal(body.instruction, instruction);
    assert.equal(body.workspace, dir);
    assert.equal(body.specialists, undefined);
    assert.equal(posts[0].token, 'fixture-token');
    assert.doesNotMatch(result.out, /fixture-token/);
  });
test('whole-office status is a read-only operation and does not create a job', async (t) => {
  const { port, calls } = await fixture(t);
  const result = await cli(['--state', '--port', String(port)]);
  assert.equal(result.code, 0, result.err);
  assert.equal(JSON.parse(result.out).runs[0].id, id);
  assert.deepEqual(
    calls.map((c) => [c.method, c.path]),
    [['GET', '/api/state']],
  );
});
