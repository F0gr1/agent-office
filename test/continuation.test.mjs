import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Office, ContinuationError } from '../orchestrator.mjs';

const pass = {
  summary: '確認済み',
  content: '成果',
  verdict: 'pass',
  issues: [],
  checks: ['確認済み'],
};

function officeFor(t, runner) {
  const dir = mkdtempSync(join(tmpdir(), 'office-continuation-'));
  const workspace = join(dir, 'project');
  mkdirSync(workspace);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new Office({
    dataDir: join(dir, 'data'),
    workspaceRoot: realpathSync(workspace),
    runtime: { available: true },
    runner,
  });
}

test('two consecutive continuations keep original and all user additions, with latest stage evidence', async (t) => {
  const seen = [];
  const office = officeFor(t, async ({ role, run, prompt }) => {
    seen.push({ role: role.id, run: run.id, prompt });
    return {
      ...pass,
      content: `${role.id}:${run.userAdditions.length}`,
      checks: [`check:${run.userAdditions.length}`],
    };
  });
  const first = office.start({
    instruction: '元の要件',
    workspace: office.workspaceRoot,
    specialists: [],
  });
  await first.promise;
  const firstSnapshot = JSON.stringify(first);
  const second = office.start({ continueFromRunId: first.id, instruction: '修正A' });
  await second.promise;
  const third = office.start({ continueFromRunId: second.id, instruction: '追加B' });
  await third.promise;
  assert.equal(third.status, 'completed');
  assert.equal(third.continueFromRunId, second.id);
  assert.equal(second.continueFromRunId, first.id);
  assert.equal(third.rootInstruction, '元の要件');
  assert.deepEqual(third.userAdditions, ['修正A', '追加B']);
  assert.equal(third.priorResults.planner.content, 'planner:1');
  assert.deepEqual(third.priorResults.planner.checks, ['check:1']);
  assert.match(seen.find((x) => x.run === third.id && x.role === 'builder').prompt, /元の要件/);
  assert.match(seen.find((x) => x.run === third.id && x.role === 'builder').prompt, /修正A/);
  assert.match(seen.find((x) => x.run === third.id && x.role === 'builder').prompt, /追加B/);
  assert.equal(JSON.stringify(first), firstSnapshot);
  assert.deepEqual(
    seen.filter((x) => x.run === third.id).map((x) => x.role),
    ['commander', 'planner', 'builder', 'reviewer', 'reviewer2', 'commander'],
  );
  assert.equal(office.state().capabilities.continuation, true);
});

test('a skipped stage retains the earlier result on the next continuation', async (t) => {
  const office = officeFor(t, async ({ role, run }) => ({
    ...pass,
    content: `${role.id}:${run.userAdditions.length}`,
    verdict: role.id === 'commander' && run.userAdditions.length === 1 ? 'blocked' : 'pass',
  }));
  const first = office.start({
    instruction: 'root',
    workspace: office.workspaceRoot,
    specialists: [],
  });
  await first.promise;
  const second = office.start({ continueFromRunId: first.id, instruction: 'fix' });
  await second.promise;
  assert.equal(second.status, 'needs_attention');
  assert.equal(second.agents.planner.result, undefined);
  const third = office.start({ continueFromRunId: second.id, instruction: 'more' });
  await third.promise;
  assert.equal(third.priorResults.planner.content, 'planner:0');
});

test('missing source, active source, changed destination, and unavailable folder are rejected', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const office = officeFor(t, async () => {
    await gate;
    return { ...pass };
  });
  assert.throws(
    () => office.start({ continueFromRunId: 'missing', instruction: 'more' }),
    (error) => error instanceof ContinuationError && error.status === 404,
  );
  const first = office.start({
    instruction: 'root',
    workspace: office.workspaceRoot,
    specialists: [],
  });
  assert.throws(() => office.start({ continueFromRunId: first.id, instruction: 'more' }), /実行中/);
  release();
  await first.promise;
  assert.throws(
    () => office.start({ continueFromRunId: first.id, instruction: 'more', workspace: tmpdir() }),
    /workspaceを変更/,
  );
  assert.throws(
    () => office.start({ continueFromRunId: first.id, instruction: 'more', mode: 'careful' }),
    /modeを変更/,
  );
  const originalWorkspace = first.workspace;
  first.workspace = join(tmpdir(), 'missing-office-continuation-folder');
  assert.throws(
    () => office.start({ continueFromRunId: first.id, instruction: 'more' }),
    /作業フォルダが見つかりません/,
  );
  first.workspace = originalWorkspace;
});

test('continuation retains review and revision gates', async (t) => {
  const calls = [];
  const office = officeFor(t, async ({ role, run }) => {
    if (run.continueFromRunId) calls.push({ role: role.id, round: run.round });
    return {
      ...pass,
      verdict:
        run.continueFromRunId && role.id === 'reviewer2' && run.round === 1 ? 'revise' : 'pass',
    };
  });
  const first = office.start({
    instruction: 'root',
    workspace: office.workspaceRoot,
    specialists: [],
  });
  await first.promise;
  const second = office.start({ continueFromRunId: first.id, instruction: 'follow up' });
  await second.promise;
  assert.equal(second.status, 'completed');
  assert.equal(second.round, 2);
  assert.equal(calls.filter((x) => x.role === 'builder').length, 2);
  assert.equal(calls.filter((x) => x.role === 'reviewer2').length, 2);
  assert.equal(calls.at(-1).role, 'commander');
});

test('oversized history is rejected without dropping user requirements', async (t) => {
  const office = officeFor(t, async () => ({ ...pass }));
  const first = office.start({
    instruction: 'root',
    workspace: office.workspaceRoot,
    specialists: [],
  });
  await first.promise;
  first.agents.planner.result.content = 'x'.repeat(160001);
  assert.throws(
    () => office.start({ continueFromRunId: first.id, instruction: 'important addition' }),
    (error) =>
      error instanceof ContinuationError && error.status === 413 && /上限/.test(error.message),
  );
  assert.equal(office.runs.length, 1);
});
