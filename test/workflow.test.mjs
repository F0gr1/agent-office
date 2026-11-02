import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowView, resultEntries } from '../public/workflow.js';
const nodes = (run) => workflowView(run).groups.flat();
test('brief completion never implies final approval', () => {
  const run = {
    status: 'running',
    stage: 'planner',
    round: 0,
    agents: {
      commander: { status: 'done', result: { verdict: 'pass' } },
      planner: { status: 'working', startedAt: 'today' },
    },
    specialists: [],
  };
  assert.equal(nodes(run).find((n) => n.key === 'brief').status, 'done');
  assert.equal(nodes(run).find((n) => n.key === 'final').status, 'idle');
  assert.equal(nodes(run).find((n) => n.key === 'researcher').status, 'skipped');
});
test('both reviews are current, commander consultation is separate', () => {
  const run = {
    status: 'running',
    stage: 'reviewer2',
    round: 1,
    agents: {
      reviewer: { status: 'working' },
      reviewer2: { status: 'working' },
      commander: { status: 'done', result: { verdict: 'pass' } },
    },
  };
  assert.deepEqual(
    nodes(run)
      .filter((n) => n.status === 'active')
      .map((n) => n.key),
    ['reviewer', 'reviewer2'],
  );
  run.stage = 'commander';
  run.agents.commander.status = 'working';
  run.escalation = { status: 'consulting' };
  assert.equal(nodes(run).find((n) => n.key === 'final').status, 'idle');
  assert.match(workflowView(run).headline, /相談中/);
  assert.equal(workflowView(run, false).consulting, false);
  assert.equal(
    workflowView(run, false)
      .groups.flat()
      .filter((n) => n.status === 'active').length,
    0,
  );
});
test('only final completion marks final node done, cancellation shows no active nodes', () => {
  const run = {
    status: 'running',
    stage: 'commander',
    round: 1,
    agents: { commander: { status: 'working' } },
  };
  assert.equal(nodes(run).find((n) => n.key === 'final').status, 'active');
  run.status = 'cancelled';
  assert.equal(nodes(run).filter((n) => n.status === 'active').length, 0);
  run.status = 'completed';
  assert.equal(nodes(run).find((n) => n.key === 'final').status, 'done');
});
test('run role snapshots place custom planning and review work in execution order', () => {
  const run = {
    status: 'running',
    stage: 'custom_accessibility',
    round: 1,
    roles: [
      { id: 'custom_security', title: 'セキュリティ確認', stage: 'planning', enabled: true },
      { id: 'custom_accessibility', name: 'アクセシビリティ', stage: 'review', enabled: true },
      { id: 'custom_archived', title: '旧工程', stage: 'review', enabled: false },
    ],
    agents: {
      custom_security: { status: 'done' },
      custom_accessibility: { status: 'working' },
      custom_archived: { status: 'skipped' },
    },
  };
  const steps = nodes(run);
  const index = (key) => steps.findIndex((step) => step.key === key);
  assert.ok(index('designer') < index('custom_security'));
  assert.ok(index('custom_security') < index('builder'));
  assert.ok(index('reviewer2') < index('custom_accessibility'));
  assert.ok(index('custom_accessibility') < index('final'));
  assert.equal(steps[index('custom_security')].status, 'done');
  assert.equal(steps[index('custom_accessibility')].status, 'active');
  assert.equal(steps[index('custom_archived')].status, 'skipped');
  assert.match(workflowView(run).headline, /アクセシビリティ/);
});

test('automatic selection follows commander assignments and marks every other role skipped', () => {
  const run = {
    selectionMode: 'auto',
    status: 'running',
    stage: 'builder',
    roles: [
      { id: 'commander', title: '指揮官' },
      { id: 'planner', title: '仕様' },
      { id: 'builder', title: '実装' },
      { id: 'reviewer', title: '確認' },
      { id: 'custom_security', title: '安全性' },
    ],
    dispatch: {
      summary: '実装だけが必要',
      assignments: [{ roleId: 'builder', reason: '修正が必要', instruction: '編集する' }],
    },
    agents: {
      commander: { status: 'done' },
      builder: { status: 'working' },
      planner: { status: 'skipped', summary: '仕様変更がないため' },
      reviewer: { status: 'skipped', summary: '今回は確認不要' },
      custom_security: { status: 'skipped' },
    },
  };
  const view = workflowView(run);
  assert.equal(view.automatic, true);
  assert.deepEqual(
    view.groups.flat().map((item) => item.role),
    ['commander', 'builder'],
  );
  assert.equal(view.groups[1][0].reason, '修正が必要');
  assert.deepEqual(
    view.skipped.map((item) => item.role),
    ['planner', 'reviewer', 'custom_security'],
  );
  assert.equal(view.skipped[0].reason, '仕様変更がないため');
  assert.match(view.headline, /実装/);
});

test('automatic commander-only runs have no invented review or implementation stages', () => {
  const run = {
    selectionMode: 'auto',
    status: 'completed',
    roles: [{ id: 'commander' }, { id: 'builder' }, { id: 'reviewer' }],
    dispatch: { summary: '説明のみ', assignments: [] },
    agents: {
      commander: { status: 'done' },
      builder: { status: 'skipped' },
      reviewer: { status: 'skipped' },
    },
  };
  assert.deepEqual(
    workflowView(run)
      .groups.flat()
      .map((item) => item.role),
    ['commander'],
  );
  assert.match(workflowView(run).headline, /完了/);
  assert.deepEqual(
    workflowView(run).skipped.map((item) => item.role),
    ['builder', 'reviewer'],
  );
});

test('result entries retain all invocations and legacy agent results', () => {
  const first = { id: 'a', roleId: 'builder', status: 'done', result: { summary: '初回' } };
  const second = { id: 'b', roleId: 'builder', status: 'done', result: { summary: '修正後' } };
  assert.deepEqual(resultEntries({ tasks: [first, second] }), [first, second]);
  const old = resultEntries({
    agents: { planner: { status: 'done', assignment: '調査', output: '旧成果' } },
  });
  assert.equal(old.length, 1);
  assert.equal(old[0].result.content, '旧成果');
  assert.equal(old[0].instruction, '調査');
});

test('automatic repair shows reviewer waiting instead of its prior completed invocation', () => {
  const run = {
    selectionMode: 'auto',
    status: 'running',
    dispatch: { summary: '実装確認', assignments: [{ roleId: 'builder' }, { roleId: 'qa' }] },
    agents: {
      commander: { status: 'done' },
      builder: { status: 'working' },
      qa: { status: 'idle' },
    },
    tasks: [{ roleId: 'qa', status: 'done', result: { verdict: 'revise' } }],
  };
  assert.equal(
    workflowView(run)
      .groups.flat()
      .find((node) => node.role === 'qa').status,
    'idle',
  );
  run.agents.qa.status = 'done';
  assert.equal(
    workflowView(run)
      .groups.flat()
      .find((node) => node.role === 'qa').status,
    'revise',
  );
});
