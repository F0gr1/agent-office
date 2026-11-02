import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Office, validateResult, roles } from '../orchestrator.mjs';
const ok = {
  summary: '確認済み',
  content: 'spec',
  verdict: 'pass',
  issues: [],
  checks: ['実確認'],
};
function setup(t, runner) {
  const dir = mkdtempSync(join(tmpdir(), 'office-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new Office({
    dataDir: dir,
    workspaceRoot: dir,
    runtime: { available: true, version: 'test' },
    runner,
  });
}
for (let n = 1; n <= 3; n++)
  test(`success path ${n}: independent reviews before acceptance`, async (t) => {
    const calls = [];
    const office = setup(t, async (x) => {
      calls.push(x.role.id);
      return { ...ok };
    });
    const r = office.start({
      instruction: 'test',
      workspace: office.workspaceRoot,
      specialists: [],
    });
    await r.promise;
    assert.equal(r.status, 'completed');
    assert.deepEqual(calls, [
      'commander',
      'planner',
      'builder',
      'reviewer',
      'reviewer2',
      'commander',
    ]);
    assert.equal(r.agents.qa.status, 'skipped');
  });
test('one reviewer rejects: revise then rereview', async (t) => {
  let reviews = 0;
  const office = setup(t, async (x) => ({
    ...ok,
    verdict: x.role.id === 'reviewer2' && reviews++ === 0 ? 'revise' : 'pass',
  }));
  const r = office.start({ instruction: 'test', workspace: office.workspaceRoot, specialists: [] });
  await r.promise;
  assert.equal(r.status, 'completed');
  assert.equal(r.round, 2);
});
test('disagreement never completes and is bounded', async (t) => {
  const office = setup(t, async (x) => ({
    ...ok,
    verdict: x.role.id === 'reviewer2' ? 'revise' : 'pass',
  }));
  const r = office.start({ instruction: 'test', workspace: office.workspaceRoot, specialists: [] });
  await r.promise;
  assert.equal(r.status, 'needs_attention');
  assert.equal(r.round, 5);
  assert.equal(r.escalations.filter((entry) => entry.consulted).length, 2);
});
test('blocked review cannot be overruled', async (t) => {
  const office = setup(t, async (x) => ({
    ...ok,
    verdict: x.role.id === 'reviewer' ? 'blocked' : 'pass',
  }));
  const r = office.start({ instruction: 'test', workspace: office.workspaceRoot, specialists: [] });
  await r.promise;
  assert.equal(r.status, 'needs_attention');
  assert.equal(r.round, 1);
});
test('runner failure not success', async (t) => {
  const office = setup(t, async () => {
    throw Error('offline');
  });
  const r = office.start({ instruction: 'test', workspace: office.workspaceRoot, specialists: [] });
  await r.promise;
  assert.equal(r.status, 'failed');
});
test('cancel prevents new stages', async (t) => {
  let started;
  const ready = new Promise((r) => (started = r));
  let count = 0;
  const office = setup(
    t,
    ({ signal }) =>
      new Promise((resolve, reject) => {
        count++;
        started();
        signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true });
      }),
  );
  const r = office.start({ instruction: 'test', workspace: office.workspaceRoot, specialists: [] });
  await ready;
  office.cancel(r.id);
  await r.promise;
  assert.equal(r.status, 'cancelled');
  assert.equal(count, 1);
});
test('overlapping run rejected', async (t) => {
  const office = setup(t, async () => ({ ...ok }));
  const r = office.start({ instruction: 'test', workspace: office.workspaceRoot, specialists: [] });
  assert.throws(
    () => office.start({ instruction: 'second', workspace: office.workspaceRoot, specialists: [] }),
    /実行中/,
  );
  await r.promise;
});
test('malformed output rejected', () => {
  assert.throws(() => validateResult({ ...ok, verdict: 'success' }));
  assert.throws(() => validateResult({ ...ok, issues: [1] }));
});
test('restart marks interrupted work', (t) => {
  const office = setup(t, async () => ok);
  writeFileSync(
    join(office.dataDir, 'state.json'),
    JSON.stringify({ runs: [{ status: 'running', agents: { builder: { status: 'working' } } }] }),
  );
  const next = new Office({
    dataDir: office.dataDir,
    workspaceRoot: office.workspaceRoot,
    runtime: {},
    runner: async () => ok,
  });
  assert.equal(next.runs[0].status, 'needs_attention');
  assert.equal(next.runs[0].agents.builder.status, 'blocked');
});
test('commander revise cannot start planning', async (t) => {
  let count = 0;
  const office = setup(t, async () => {
    count++;
    return { ...ok, verdict: 'revise' };
  });
  const r = office.start({ instruction: 'test', workspace: office.workspaceRoot, specialists: [] });
  await r.promise;
  assert.equal(r.status, 'needs_attention');
  assert.equal(count, 1);
});
test('pass with unresolved issues is normalized to revise', () => {
  assert.equal(validateResult({ ...ok, issues: ['missing acceptance'] }).verdict, 'revise');
});
test('explicit legacy nine-person flow passes each specialist output downstream', async (t) => {
  const calls = [];
  const project = { id: 'registered-project', label: '社内基盤管理', path: '/registered/project' };
  const office = setup(t, async ({ role, prompt, run }) => {
    calls.push(role.id);
    assert.deepEqual(run.project, project);
    assert.match(prompt, /registered-project/);
    const predecessors = {
      researcher: ['brief'],
      planner: ['research'],
      architect: ['spec'],
      designer: ['architecture'],
      builder: ['design'],
      qa: ['implementation'],
      reviewer: ['qa'],
      reviewer2: ['qa'],
      commander: [],
    };
    for (const name of predecessors[role.id]) assert.match(prompt, new RegExp(`${name}\\":`));
    return { ...ok, content: role.id };
  });
  const r = office.start({
    instruction: 'test',
    workspace: office.workspaceRoot,
    project,
    specialists: ['researcher', 'architect', 'designer', 'qa'],
  });
  await r.promise;
  assert.equal(r.status, 'completed');
  assert.deepEqual(r.specialists, ['researcher', 'architect', 'designer', 'qa']);
  assert.deepEqual(calls, [
    'commander',
    'researcher',
    'planner',
    'architect',
    'designer',
    'builder',
    'qa',
    'reviewer',
    'reviewer2',
    'commander',
  ]);
  assert.equal(r.agents.qa.status, 'done');
});
for (const id of ['researcher', 'architect', 'designer'])
  test(`${id} non-pass stops before implementation`, async (t) => {
    const calls = [];
    const office = setup(t, async ({ role }) => {
      calls.push(role.id);
      return { ...ok, verdict: role.id === id ? 'revise' : 'pass' };
    });
    const r = office.start({
      instruction: 'test',
      workspace: office.workspaceRoot,
      specialists: ['researcher', 'architect', 'designer', 'qa'],
    });
    await r.promise;
    assert.equal(r.status, 'needs_attention');
    assert.equal(calls.at(-1), id);
    assert.equal(r.agents.builder.status, 'idle');
  });
test('QA revision loops through builder and clears stale QA and reviews', async (t) => {
  let qaCalls = 0,
    reviewCalls = 0;
  const calls = [];
  const office = setup(t, async ({ run, role, prompt }) => {
    calls.push(role.id);
    if (role.id === 'builder' && run.round > 1) {
      for (const id of ['qa', 'reviewer', 'reviewer2']) {
        assert.equal(run.agents[id].status, 'idle');
        assert.equal(run.agents[id].output, '');
        assert.equal(run.agents[id].result, null);
      }
      if (run.round === 2) assert.match(prompt, /QAの指摘/);
    }
    if (role.id === 'qa')
      return { ...ok, verdict: qaCalls++ === 0 ? 'revise' : 'pass', content: 'QAの指摘' };
    if (role.id === 'reviewer2' && reviewCalls++ === 0) return { ...ok, verdict: 'revise' };
    return { ...ok };
  });
  const r = office.start({
    instruction: 'test',
    workspace: office.workspaceRoot,
    specialists: ['researcher', 'architect', 'designer', 'qa'],
  });
  await r.promise;
  assert.equal(r.status, 'completed');
  assert.equal(r.round, 3);
  assert.equal(calls.filter((id) => id === 'builder').length, 3);
  assert.equal(calls.filter((id) => id === 'qa').length, 3);
  assert.equal(calls.filter((id) => id === 'reviewer').length, 2);
});
test('blocked QA stops before reviews', async (t) => {
  const calls = [];
  const office = setup(t, async ({ role }) => {
    calls.push(role.id);
    return { ...ok, verdict: role.id === 'qa' ? 'blocked' : 'pass' };
  });
  const r = office.start({
    instruction: 'test',
    workspace: office.workspaceRoot,
    specialists: ['researcher', 'architect', 'designer', 'qa'],
  });
  await r.promise;
  assert.equal(r.status, 'needs_attention');
  assert.equal(calls.at(-1), 'qa');
  assert.equal(r.agents.reviewer.status, 'idle');
});
test('specialist IDs are validated and deduplicated', (t) => {
  const office = setup(t, async () => ({ ...ok }));
  for (const specialists of [['qa', 'qa'], ['unknown'], null, 'qa'])
    assert.throws(
      () => office.start({ instruction: 'test', workspace: office.workspaceRoot, specialists }),
      /担当の選択/,
    );
  assert.throws(
    () =>
      office.start({
        instruction: 'test',
        workspace: office.workspaceRoot,
        project: { id: 'x', label: 'x' },
      }),
    /プロジェクト情報/,
  );
});

test('economy reduces only research, planning and UI effort', async (t) => {
  const calls = [];
  const office = setup(t, async ({ role, onUsage }) => {
    calls.push({ id: role.id, model: role.model, effort: role.effort });
    onUsage({ input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 });
    return { ...ok };
  });
  const run = office.start({
    instruction: 'test',
    workspace: office.workspaceRoot,
    mode: 'economy',
    specialists: ['researcher', 'architect', 'designer', 'qa'],
  });
  await run.promise;
  assert.equal(run.status, 'completed');
  assert.equal(calls.length, 10);
  for (const call of calls) {
    const base = roles.find((role) => role.id === call.id);
    assert.equal(call.model, base.model);
    assert.equal(
      call.effort,
      ['researcher', 'planner', 'designer'].includes(call.id) ? 'medium' : base.effort,
    );
  }
  assert.deepEqual(run.tokenUsage, {
    input_tokens: 100,
    cached_input_tokens: 20,
    output_tokens: 30,
  });
  assert.equal(run.agents.commander.effort, 'high');
  assert.deepEqual(office.state().supportedModes, ['economy', 'standard', 'careful']);
  assert.throws(
    () => office.start({ instruction: 'test', workspace: office.workspaceRoot, mode: 'unknown' }),
    /モデル設定/,
  );
});

test('final commander pass stops without another implementation', async (t) => {
  const calls = [];
  const office = setup(t, async ({ role }) => {
    calls.push(role.id);
    return { ...ok };
  });
  const run = office.start({
    instruction: 'test',
    workspace: office.workspaceRoot,
    specialists: [],
  });
  await run.promise;
  assert.equal(run.status, 'completed');
  assert.deepEqual(calls, [
    'commander',
    'planner',
    'builder',
    'reviewer',
    'reviewer2',
    'commander',
  ]);
  assert.equal(run.round, 1);
});

test('final commander revise returns to implementation, blocked requires attention', async (t) => {
  for (const finalVerdict of ['revise', 'blocked']) {
    let commanderCalls = 0;
    const calls = [];
    const office = setup(t, async ({ role }) => {
      calls.push(role.id);
      if (role.id === 'commander' && ++commanderCalls === 2)
        return { ...ok, verdict: finalVerdict };
      return { ...ok };
    });
    const run = office.start({
      instruction: 'test',
      workspace: office.workspaceRoot,
      specialists: [],
    });
    await run.promise;
    assert.equal(run.status, finalVerdict === 'blocked' ? 'needs_attention' : 'completed');
    assert.equal(run.round, finalVerdict === 'blocked' ? 1 : 2);
    assert.equal(calls.filter((id) => id === 'builder').length, finalVerdict === 'blocked' ? 1 : 2);
    assert.equal(commanderCalls, finalVerdict === 'blocked' ? 2 : 3);
  }
});

test('progress events do not overwrite the stage assignment', async (t) => {
  const office = setup(t, async ({ run, role, onEvent }) => {
    const assignment = run.agents[role.id].summary;
    onEvent('資料を検索中', { phase: 'executing', completedSteps: 1, activeCount: 1 });
    assert.equal(run.agents[role.id].summary, assignment);
    assert.equal(run.agents[role.id].assignment, assignment);
    assert.equal(run.agents[role.id].activity, '資料を検索中');
    assert.equal(run.agents[role.id].progress.completedSteps, 1);
    return { ...ok };
  });
  const run = office.start({
    instruction: 'test',
    workspace: office.workspaceRoot,
    specialists: [],
  });
  await run.promise;
  assert.equal(run.status, 'completed');
});
test('loop guard requests attention and never invokes further stages', async (t) => {
  const calls = [];
  const office = setup(t, async ({ role }) => {
    calls.push(role.id);
    if (role.id === 'builder')
      throw Object.assign(new Error('反復を停止しました'), { code: 'OFFICE_LOOP_GUARD' });
    return { ...ok };
  });
  const run = office.start({
    instruction: 'test',
    workspace: office.workspaceRoot,
    specialists: [],
  });
  await run.promise;
  assert.equal(run.status, 'needs_attention');
  assert.deepEqual(calls, ['commander', 'planner', 'builder', 'commander']);
  assert.equal(run.agents.builder.status, 'blocked');
});

test('parallel review loop failure cancels the peer and remains needs_attention', async (t) => {
  let peerCancelled = false;
  const office = setup(t, async ({ role, signal }) => {
    if (role.id === 'reviewer') {
      await new Promise((resolve) => setImmediate(resolve));
      throw Object.assign(new Error('反復を停止しました'), { code: 'OFFICE_LOOP_GUARD' });
    }
    if (role.id === 'reviewer2')
      return new Promise((resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            peerCancelled = true;
            reject(Error('cancelled peer'));
          },
          { once: true },
        );
      });
    return { ...ok };
  });
  const run = office.start({
    instruction: 'test',
    workspace: office.workspaceRoot,
    specialists: [],
  });
  await run.promise;
  assert.equal(peerCancelled, true);
  assert.equal(run.status, 'needs_attention');
});

for (let n = 1; n <= 3; n++)
  test(`QA revision limit consults commander and rechecks before acceptance ${n}`, async (t) => {
    const calls = [];
    const office = setup(t, async ({ role, run, prompt }) => {
      calls.push(role.id);
      if (role.id === 'qa' && run.round <= 3)
        return { ...ok, verdict: 'revise', content: '継続依頼の接続失敗理由が表示されない' };
      if (role.id === 'commander' && run.escalation?.status === 'consulting') {
        assert.match(prompt, /継続依頼の接続失敗理由/);
        assert.match(prompt, /将来の実装条件/);
        return { ...ok, content: '画面案の失敗理由と次の操作を修正する' };
      }
      if (role.id === 'builder' && run.round === 4)
        assert.match(prompt, /画面案の失敗理由と次の操作を修正する/);
      return { ...ok };
    });
    const run = office.start({
      instruction: '画面案のみ',
      workspace: office.workspaceRoot,
      specialists: ['qa'],
    });
    await run.promise;
    assert.equal(run.status, 'completed');
    assert.equal(run.round, 4);
    assert.equal(run.escalations.length, 1);
    assert.equal(run.escalations[0].status, 'resolved');
    assert.deepEqual(calls.slice(-6), [
      'commander',
      'builder',
      'qa',
      'reviewer',
      'reviewer2',
      'commander',
    ]);
  });

for (const outcome of ['blocked', 'revise', 'error', 'cancel'])
  test(`revision consultation ${outcome} prevents another implementation`, async (t) => {
    let builds = 0;
    let office;
    office = setup(t, async ({ role, run }) => {
      if (role.id === 'builder') builds++;
      if (role.id === 'qa') return { ...ok, verdict: 'revise' };
      if (role.id === 'commander' && run.escalation?.status === 'consulting') {
        if (outcome === 'error') throw Error('offline');
        if (outcome === 'cancel') {
          office.cancel(run.id);
          throw Error('cancelled');
        }
        return { ...ok, verdict: outcome };
      }
      return { ...ok };
    });
    const run = office.start({
      instruction: 'test',
      workspace: office.workspaceRoot,
      specialists: ['qa'],
    });
    await run.promise;
    assert.equal(builds, 3);
    assert.equal(run.status, outcome === 'cancel' ? 'cancelled' : 'needs_attention');
    assert.equal(run.escalations.length, 1);
  });
