import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Office } from '../orchestrator.mjs';

const pass = {
  summary: '確認済み',
  content: '根拠と成果',
  verdict: 'pass',
  issues: [],
  checks: ['確認済み'],
};
const blocked = (summary = '未確認') => ({
  ...pass,
  summary,
  content: '障害の証拠',
  verdict: 'blocked',
});
function setup(t, runner, specialists = []) {
  const dir = mkdtempSync(join(tmpdir(), 'office-escalation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const office = new Office({
    dataDir: dir,
    workspaceRoot: dir,
    runtime: { available: true, version: 'test' },
    runner,
  });
  const run = office.start({ instruction: '元の依頼', workspace: dir, specialists });
  return { office, run };
}

test('blocked research reaches commander, then planning, implementation, both reviews and final gate', async (t) => {
  const calls = [];
  let researcherCalls = 0;
  const { run } = setup(
    t,
    async ({ role, prompt }) => {
      calls.push(role.id);
      if (role.id === 'researcher' && researcherCalls++ === 0) return blocked('資料の所在が不明');
      if (role.id === 'commander' && /今回の担当指示:\n障害対応:/.test(prompt)) {
        assert.match(prompt, /元の依頼/);
        assert.match(prompt, /資料の所在が不明/);
        assert.match(prompt, /read-only/);
        return { ...pass, content: '既存資料で確認できた範囲を明示して次工程に渡す' };
      }
      if (role.id === 'planner') assert.match(prompt, /escalationInstruction/);
      if (role.id === 'commander' && /今回の担当指示:\n元の依頼と完了条件/.test(prompt))
        assert.match(prompt, /unresolvedPreparation/);
      return pass;
    },
    ['researcher'],
  );
  await run.promise;
  assert.equal(run.status, 'completed');
  assert.deepEqual(calls, [
    'commander',
    'researcher',
    'commander',
    'planner',
    'builder',
    'reviewer',
    'reviewer2',
    'commander',
  ]);
  assert.equal(run.escalations.length, 1);
  assert.equal(run.escalations[0].sourceRole, 'researcher');
  assert.equal(run.escalation.status, 'resolved');
});

test('planner must produce a passing spec after commander instruction', async (t) => {
  let plannerCalls = 0;
  const calls = [];
  const { run } = setup(t, async ({ role, prompt }) => {
    calls.push(role.id);
    if (role.id === 'planner' && plannerCalls++ === 0) return blocked('仕様を確定できない');
    if (role.id === 'planner') assert.match(prompt, /指揮官の障害対応指示/);
    if (role.id === 'commander' && /今回の担当指示:\n障害対応:/.test(prompt))
      return { ...pass, content: '受入条件を整理して仕様を再作成する' };
    return pass;
  });
  await run.promise;
  assert.equal(run.status, 'completed');
  assert.equal(plannerCalls, 2);
  assert.ok(calls.indexOf('builder') > calls.lastIndexOf('planner'));
});

test('read-only preparation can hand off implementation permissions as evidence', async (t) => {
  const { run } = setup(
    t,
    async ({ role, prompt }) => {
      if (role.id === 'researcher') return blocked('書込権限がないため実装はbuilderへ引き継ぐ');
      if (role.id === 'commander' && /今回の担当指示:\n障害対応:/.test(prompt))
        return { ...pass, content: '調査内容を仕様担当へ渡し、実装はbuilderが行う' };
      return pass;
    },
    ['researcher'],
  );
  await run.promise;
  assert.equal(run.status, 'completed');
  assert.equal(run.escalation.status, 'resolved');
});

test('implementation permission block requires user action even if commander claims a plan', async (t) => {
  const calls = [];
  const { run } = setup(t, async ({ role, prompt }) => {
    calls.push(role.id);
    if (role.id === 'builder') return blocked('権限がなく変更できない');
    if (role.id === 'commander' && /今回の担当指示:\n障害対応:/.test(prompt))
      return { ...pass, content: '先へ進む' };
    return pass;
  });
  await run.promise;
  assert.equal(run.status, 'needs_attention');
  assert.deepEqual(calls, ['commander', 'planner', 'builder', 'commander']);
  assert.equal(run.escalation.status, 'awaiting_user');
  assert.equal(run.agents.reviewer.status, 'idle');
});

test('blocked builder retries within permissions and still needs QA, reviews and final acceptance', async (t) => {
  const calls = [];
  let builderCalls = 0;
  const { run } = setup(
    t,
    async ({ role, prompt }) => {
      calls.push(role.id);
      if (role.id === 'builder' && builderCalls++ === 0)
        return blocked('実装手順を確認する必要がある');
      if (role.id === 'builder') assert.match(prompt, /指揮官の障害対応指示/);
      if (role.id === 'commander' && /今回の担当指示:\n障害対応:/.test(prompt))
        return { ...pass, content: '既存の実装を確認して不足分のみ変更する' };
      return pass;
    },
    ['qa'],
  );
  await run.promise;
  assert.equal(run.status, 'completed');
  assert.deepEqual(calls, [
    'commander',
    'planner',
    'builder',
    'commander',
    'builder',
    'qa',
    'reviewer',
    'reviewer2',
    'commander',
  ]);
  assert.equal(run.escalation.status, 'resolved');
});

test('repeated block has at most two commander incident calls and never reaches review', async (t) => {
  let incidentCalls = 0;
  const { run } = setup(t, async ({ role, prompt }) => {
    if (role.id === 'builder') return blocked('同じ未解決事項');
    if (role.id === 'commander' && /今回の担当指示:\n障害対応:/.test(prompt)) {
      incidentCalls++;
      return { ...pass, content: '条件を確認して再試行する' };
    }
    return pass;
  });
  await run.promise;
  assert.equal(run.status, 'needs_attention');
  assert.equal(incidentCalls, 2);
  assert.equal(run.escalations.length, 3);
  assert.equal(run.escalations.filter((incident) => incident.consulted).length, 2);
  assert.equal(run.escalation.status, 'exhausted');
  assert.equal(run.escalation.sourceRole, 'builder');
  assert.equal(run.escalation.reason, '同じ未解決事項');
  assert.equal(run.agents.reviewer.status, 'idle');
});

test('commander blocked or empty plan requires user action without retry', async (t) => {
  for (const decision of [
    { ...pass, verdict: 'blocked' },
    { ...pass, content: '   ' },
  ]) {
    let builderCalls = 0;
    const { run } = setup(t, async ({ role, prompt }) => {
      if (role.id === 'builder') {
        builderCalls++;
        return blocked();
      }
      if (role.id === 'commander' && /今回の担当指示:\n障害対応:/.test(prompt)) return decision;
      return pass;
    });
    await run.promise;
    assert.equal(run.status, 'needs_attention');
    assert.equal(run.escalation.status, 'awaiting_user');
    assert.equal(builderCalls, 1);
  }
});

test('runtime error is sanitized and diagnosed once; commander failure does not recurse', async (t) => {
  let incidentCalls = 0;
  const secret = 'secret-token-123';
  const { run } = setup(t, async ({ role, prompt }) => {
    if (role.id === 'builder') throw Error(secret);
    if (role.id === 'commander' && /今回の担当指示:\n障害対応:/.test(prompt)) {
      incidentCalls++;
      throw Error(secret);
    }
    return pass;
  });
  await run.promise;
  assert.equal(run.status, 'needs_attention');
  assert.equal(incidentCalls, 1);
  assert.equal(run.escalation.status, 'failed');
  assert.doesNotMatch(JSON.stringify(run), /secret-token-123/);
});

test('cancellation during commander consultation starts no further stage', async (t) => {
  let entered;
  const consulting = new Promise((resolve) => {
    entered = resolve;
  });
  const calls = [];
  const { office, run } = setup(t, async ({ role, prompt, signal }) => {
    calls.push(role.id);
    if (role.id === 'builder') return blocked();
    if (role.id === 'commander' && /今回の担当指示:\n障害対応:/.test(prompt)) {
      entered();
      return new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(Error('stopped')), { once: true }),
      );
    }
    return pass;
  });
  await consulting;
  office.cancel(run.id);
  await run.promise;
  assert.equal(run.status, 'cancelled');
  assert.equal(run.escalation.status, 'cancelled');
  assert.deepEqual(calls, ['commander', 'planner', 'builder', 'commander']);
});

test('review runtime failure is diagnosed and review runs again before final gate', async (t) => {
  let reviewCalls = 0;
  const calls = [];
  const { run } = setup(t, async ({ role, prompt }) => {
    calls.push(role.id);
    if (role.id === 'reviewer' && reviewCalls++ === 0) throw Error('transient');
    if (role.id === 'commander' && /今回の担当指示:\n障害対応:/.test(prompt))
      return { ...pass, content: '同じ仕様と実装を再照合する' };
    return pass;
  });
  await run.promise;
  assert.equal(run.status, 'completed');
  assert.equal(reviewCalls, 2);
  assert.equal(calls.at(-1), 'commander');
  assert.equal(run.escalation.status, 'resolved');
});

test('final commander block is visible as user action without consulting itself again', async (t) => {
  let commanderCalls = 0;
  const { run } = setup(t, async ({ role }) => {
    if (role.id === 'commander' && ++commanderCalls === 2) return blocked('受入条件が未確認');
    return pass;
  });
  await run.promise;
  assert.equal(run.status, 'needs_attention');
  assert.equal(commanderCalls, 2);
  assert.equal(run.escalation.sourceRole, 'commander');
  assert.equal(run.escalation.status, 'awaiting_user');
  assert.equal(run.escalation.result.summary, '受入条件が未確認');
});

test('user cancellation during review-loop consultation takes priority over loop failure', async (t) => {
  let entered;
  const consulting = new Promise((resolve) => {
    entered = resolve;
  });
  const { office, run } = setup(t, async ({ role, prompt, signal }) => {
    if (role.id === 'reviewer') throw Object.assign(Error('loop'), { code: 'OFFICE_LOOP_GUARD' });
    if (role.id === 'commander' && /今回の担当指示:\n障害対応:/.test(prompt)) {
      entered();
      return new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(Error('stopped')), { once: true }),
      );
    }
    return pass;
  });
  await consulting;
  office.cancel(run.id);
  await run.promise;
  assert.equal(run.status, 'cancelled');
  assert.equal(run.escalation.status, 'cancelled');
});
