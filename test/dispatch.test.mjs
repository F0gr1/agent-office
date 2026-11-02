import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Office } from '../orchestrator.mjs';
import { defaultSettings } from '../lib/settings.mjs';
import { validateDispatch } from '../lib/dispatch.mjs';
const ok = { summary: '確認済み', content: '根拠', verdict: 'pass', issues: [], checks: ['確認'] };
const assignment = (roleId) => ({
  roleId,
  reason: `${roleId}が今回必要`,
  instruction: `${roleId}の完了条件`,
});
function setup(t, runner, settings) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'office-dispatch-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new Office({
    dataDir: dir,
    workspaceRoot: dir,
    runtime: {},
    runner,
    ...(settings ? { getSettings: () => settings } : {}),
  });
}
for (let n = 1; n <= 3; n++) {
  for (const ids of [[], ['researcher'], ['builder', 'qa']]) {
    test(`automatic ${ids.join('+') || 'commander-only'} ${n}`, async (t) => {
      const calls = [];
      const office = setup(t, async ({ role, schemaFile, prompt }) => {
        calls.push(role.id);
        if (calls.length === 1) {
          assert.equal(schemaFile, 'dispatch.schema.json');
          assert.match(prompt, /全員を定型的に呼ばない/);
          return {
            ...ok,
            dispatch: { summary: '今回必要な担当', assignments: ids.map(assignment) },
          };
        }
        return { ...ok, content: `${role.id}の根拠` };
      });
      const run = office.start({ instruction: '必要な仕事だけ', workspace: office.workspaceRoot });
      await run.promise;
      assert.equal(run.selectionMode, 'auto');
      assert.equal(run.status, 'completed');
      assert.deepEqual(calls, ['commander', ...ids, ...(ids.length ? ['commander'] : [])]);
      assert.equal(run.agents.planner.status, 'skipped');
      assert.equal(run.tasks.length, calls.length);
      assert.equal(run.tasks[0].instruction, '依頼を整理し、必要な担当と進め方を決めてください。');
      assert.ok(run.tasks.every((task) => task.result && task.finishedAt));
      const saved = JSON.parse(readFileSync(join(office.dataDir, 'state.json'))).runs[0];
      assert.equal(saved.tasks.length, calls.length);
      assert.deepEqual(
        saved.dispatch.assignments.map((a) => a.roleId),
        ids,
      );
    });
  }
}
test('invalid, disabled, duplicate, unsafe and out-of-order dispatches are rejected', () => {
  const roles = defaultSettings().agents;
  roles.find((r) => r.id === 'designer').enabled = false;
  for (const ids of [
    ['missing'],
    ['commander'],
    ['designer'],
    ['qa', 'qa'],
    ['builder'],
    ['qa', 'builder'],
    ['builder', 'qa', 'planner'],
  ]) {
    assert.throws(() =>
      validateDispatch({ summary: '選定', assignments: ids.map(assignment) }, roles),
    );
  }
  for (const value of [
    null,
    {},
    { summary: '選定', assignments: [{ roleId: 'qa', reason: '', instruction: '実行' }] },
  ])
    assert.throws(() => validateDispatch(value, roles));
});
test('missing model dispatch stops without a fallback team', async (t) => {
  const calls = [];
  const office = setup(t, async ({ role }) => {
    calls.push(role.id);
    return ok;
  });
  const run = office.start({ instruction: '確認', workspace: office.workspaceRoot });
  await run.promise;
  assert.equal(run.status, 'needs_attention');
  assert.deepEqual(calls, ['commander']);
});
test('repairs keep prior invocation results and selected reviewers only', async (t) => {
  let qa = 0;
  const office = setup(t, async ({ role, run }) => {
    if (run.tasks.length === 1)
      return {
        ...ok,
        dispatch: { summary: '実装と確認', assignments: ['builder', 'qa'].map(assignment) },
      };
    if (role.id === 'qa' && qa++ === 0)
      return { ...ok, verdict: 'revise', content: '修正根拠', issues: ['修正'] };
    return { ...ok, content: `${role.id}完了` };
  });
  const run = office.start({ instruction: '実装', workspace: office.workspaceRoot });
  await run.promise;
  assert.equal(run.status, 'completed');
  assert.equal(run.round, 2);
  const qas = run.tasks.filter((t) => t.roleId === 'qa');
  assert.deepEqual(
    qas.map((t) => t.result.verdict),
    ['revise', 'pass'],
  );
  assert.equal(run.agents.reviewer.status, 'skipped');
});
test('continuation chooses a fresh team while preserving prior evidence', async (t) => {
  let firstId;
  const office = setup(t, async ({ run, role, prompt }) => {
    if (run.tasks.length === 1) {
      if (run.continueFromRunId) {
        assert.equal(run.continueFromRunId, firstId);
        assert.match(prompt, /researcher完了/);
        return { ...ok, dispatch: { summary: '社長だけで回答', assignments: [] } };
      }
      return { ...ok, dispatch: { summary: '調査', assignments: [assignment('researcher')] } };
    }
    return { ...ok, content: `${role.id}完了` };
  });
  const first = office.start({ instruction: '調査', workspace: office.workspaceRoot });
  firstId = first.id;
  await first.promise;
  const second = office.start({ instruction: '説明して', continueFromRunId: first.id });
  await second.promise;
  assert.equal(second.selectionMode, 'auto');
  assert.equal(second.status, 'completed');
  assert.deepEqual(second.dispatch.assignments, []);
  assert.equal(second.tasks.length, 1);
});
test('selected custom roles run; enabled but unselected custom roles do not', async (t) => {
  const settings = defaultSettings();
  settings.agents.push({
    ...settings.agents[1],
    id: 'custom_domain',
    stage: 'planning',
    useModeDefaults: false,
  });
  settings.agents.push({
    ...settings.agents[1],
    id: 'custom_unused',
    stage: 'review',
    useModeDefaults: false,
  });
  const office = setup(
    t,
    async ({ run }) =>
      run.tasks.length === 1
        ? { ...ok, dispatch: { summary: '専門確認', assignments: [assignment('custom_domain')] } }
        : ok,
    settings,
  );
  const run = office.start({ instruction: '専門確認', workspace: office.workspaceRoot });
  await run.promise;
  assert.equal(run.status, 'completed');
  assert.equal(run.agents.custom_domain.status, 'done');
  assert.equal(run.agents.custom_unused.status, 'skipped');
});
test('automatic unresolved checks never complete and attempts are bounded', async (t) => {
  const office = setup(t, async ({ role, run }) =>
    run.tasks.length === 1
      ? {
          ...ok,
          dispatch: { summary: '実装と確認', assignments: ['builder', 'qa'].map(assignment) },
        }
      : { ...ok, verdict: role.id === 'qa' ? 'revise' : 'pass' },
  );
  const run = office.start({ instruction: '実装', workspace: office.workspaceRoot });
  await run.promise;
  assert.equal(run.status, 'needs_attention');
  assert.equal(run.tasks.filter((t) => t.roleId === 'builder').length, 3);
});
