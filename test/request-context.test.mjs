import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Office, AcceptanceError, RequestContextError } from '../orchestrator.mjs';
import { validateRequestContext } from '../lib/request-context.mjs';

const pass = {
  summary: '確認済み',
  content: '成果',
  verdict: 'pass',
  issues: [],
  checks: ['確認済み'],
};

function setup(t, runner) {
  const dir = mkdtempSync(join(tmpdir(), 'office-request-context-'));
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new Office({
    dataDir: join(dir, 'data'),
    workspaceRoot: realpathSync(workspace),
    runtime: { available: true },
    runner,
  });
}

const context = {
  outcome: 'レビュー可能な画面を作る',
  done: '操作でき、完了条件を照合できる',
  scope: 'この作業フォルダ内のUI',
  historyRefs: [{ id: 'run-1', title: '前回の試作', cwd: '/workspace/example' }],
};

test('context validation accepts bounded metadata and rejects unknown or malformed fields', () => {
  assert.deepEqual(validateRequestContext(context), context);
  assert.equal(validateRequestContext(undefined), null);
  for (const invalid of [
    { ...context, extra: 'untrusted' },
    { ...context, done: null },
    { ...context, outcome: 10 },
    { ...context, scope: 'x'.repeat(4001) },
    { ...context, historyRefs: Array(11).fill(context.historyRefs[0]) },
    { ...context, historyRefs: [{ ...context.historyRefs[0], body: 'conversation text' }] },
    { ...context, historyRefs: [{ id: '1', title: 'title' }] },
  ]) {
    assert.throws(
      () => validateRequestContext(invalid),
      (error) => error instanceof RequestContextError && error.status === 400,
    );
  }
});

test('request context text fields are optional and normalize empty values', () => {
  assert.deepEqual(validateRequestContext({ outcome: '  目標だけ  ' }), {
    outcome: '目標だけ',
    done: '',
    scope: '',
  });
  assert.deepEqual(validateRequestContext({ outcome: '', done: '', scope: '' }), {
    outcome: '',
    done: '',
    scope: '',
  });
  assert.deepEqual(validateRequestContext({}), { outcome: '', done: '', scope: '' });
});

test('structured goals enter each model prompt and continuation retains original constraints', async (t) => {
  const prompts = [];
  const office = setup(t, async ({ run, prompt }) => {
    prompts.push({ run: run.id, prompt });
    return { ...pass };
  });
  const first = office.start({
    instruction: '元の依頼をそのまま残す',
    workspace: office.workspaceRoot,
    specialists: [],
    requestContext: context,
  });
  await first.promise;
  assert.equal(first.status, 'completed');
  assert.equal(first.rootInstruction, '元の依頼をそのまま残す');
  assert.deepEqual(first.requestContext, context);
  assert.equal(prompts.filter((entry) => entry.run === first.id).length, 6);
  for (const entry of prompts.filter((item) => item.run === first.id)) {
    assert.match(entry.prompt, /元の依頼をそのまま残す/);
    assert.match(entry.prompt, /レビュー可能な画面を作る/);
    assert.match(entry.prompt, /操作でき、完了条件を照合できる/);
    assert.match(entry.prompt, /この作業フォルダ内のUI/);
    assert.match(entry.prompt, /前回の試作/);
    assert.match(entry.prompt, /過去の会話本文を読んだことは意味しない/);
  }
  assert.throws(
    () =>
      office.start({
        continueFromRunId: first.id,
        instruction: '調整',
        requestContext: { ...context, scope: '別の場所' },
      }),
    (error) => error instanceof RequestContextError && error.status === 400,
  );
  const second = office.start({ continueFromRunId: first.id, instruction: '調整' });
  await second.promise;
  assert.deepEqual(second.requestContext, context);
  assert.equal(second.rootInstruction, first.instruction);
  assert.doesNotMatch(prompts.find((entry) => entry.run === second.id).prompt, /別の場所/);
  assert.match(prompts.find((entry) => entry.run === second.id).prompt, /この作業フォルダ内のUI/);
});

test('acceptance rejects absent and unfinished runs, is idempotent, and survives restart', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const office = setup(t, async () => {
    await gate;
    return { ...pass };
  });
  assert.throws(
    () => office.accept('missing'),
    (error) => error instanceof AcceptanceError && error.status === 404,
  );
  const run = office.start({
    instruction: '受け入れ対象',
    workspace: office.workspaceRoot,
    specialists: [],
    requestContext: context,
  });
  assert.throws(
    () => office.accept(run.id),
    (error) => error instanceof AcceptanceError && error.status === 409,
  );
  release();
  await run.promise;
  const first = office.accept(run.id);
  const second = office.accept(run.id);
  assert.deepEqual(second, first);
  assert.match(first.acceptedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(run.events.filter((event) => event.type === 'accepted').length, 1);
  const saved = JSON.parse(readFileSync(join(office.dataDir, 'state.json'), 'utf8')).runs[0];
  assert.deepEqual(saved.requestContext, context);
  assert.deepEqual(saved.acceptance, first);
  const restarted = new Office({
    dataDir: office.dataDir,
    workspaceRoot: office.workspaceRoot,
    runtime: { available: true },
    runner: async () => ({ ...pass }),
  });
  assert.deepEqual(restarted.state().runs[0].acceptance, first);
  assert.deepEqual(restarted.accept(run.id), first);
});
