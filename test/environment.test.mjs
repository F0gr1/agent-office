import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Office } from '../orchestrator.mjs';
const pass = { summary: 'ok', content: 'ok', verdict: 'pass', issues: [], checks: [] };
test('host prepares preview and log before every role; builder output is available to later QA', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'office-env-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let built = false,
    finished = 0;
  const seen = [];
  const hostServices = {
    prepare: async () => ({
      preview: built
        ? { status: 'ready', url: 'http://127.0.0.1:12345/' }
        : { status: 'unavailable', reason: 'build first' },
      worklog: { status: 'saved' },
    }),
    finish: async () => {
      finished++;
      return { status: 'saved' };
    },
  };
  const office = new Office({
    dataDir: dir,
    workspaceRoot: dir,
    runtime: { available: true },
    hostServices,
    runner: async ({ role, prompt }) => {
      assert.match(prompt, /アプリ本体が管理する実行環境/);
      assert.match(prompt, /"worklog":\{"status":"saved"\}/);
      if (role.id === 'builder') built = true;
      if (['qa', 'reviewer', 'reviewer2'].includes(role.id))
        assert.match(prompt, /http:\/\/127.0.0.1:12345/);
      seen.push(role.id);
      return pass;
    },
  });
  const run = office.start({ instruction: 'test', workspace: dir, specialists: ['qa'] });
  await run.promise;
  assert.equal(run.status, 'completed');
  assert.equal(finished, 1);
  assert.equal(seen.at(-1), 'commander');
  assert.ok(seen.includes('qa'));
  const restored = new Office({
    dataDir: dir,
    workspaceRoot: dir,
    runtime: { available: true },
    hostServices,
    runner: async () => pass,
  });
  assert.equal(restored.runs[0].environment.preview.status, 'unavailable');
});
test('host log failure never reports fully completed', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'office-env-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const hostServices = {
    prepare: async () => ({ preview: { status: 'unavailable' }, worklog: { status: 'saved' } }),
    finish: async () => ({ status: 'failed' }),
  };
  const office = new Office({
    dataDir: dir,
    workspaceRoot: dir,
    runtime: { available: true },
    hostServices,
    runner: async () => pass,
  });
  const run = office.start({ instruction: 'test', workspace: dir, specialists: [] });
  await run.promise;
  assert.equal(run.status, 'needs_attention');
  assert.equal(run.environment.worklog.status, 'failed');
});
