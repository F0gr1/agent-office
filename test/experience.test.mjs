import test from 'node:test';
import assert from 'node:assert/strict';
import {
  finalResult,
  conversationEntries,
  displayRunStatus,
  stoppingView,
  runServiceOperation,
} from '../public/experience.js';

test('サービス操作の失敗後も状態を取り直す', async () => {
  const calls = [];
  const failure = await runServiceOperation(
    'start',
    async (action) => {
      calls.push(action);
      throw new Error('起動失敗');
    },
    async () => calls.push('refresh'),
  );
  assert.equal(failure.message, '起動失敗');
  assert.deepEqual(calls, ['start', 'refresh']);
});

test('run detail uses unknown or stopping instead of stale working status', () => {
  const run = { status: 'running' };
  assert.equal(displayRunStatus(run, false, true, false), 'unknown');
  assert.equal(displayRunStatus(run, true, false, false), 'unknown');
  assert.equal(displayRunStatus(run, true, true, true), 'stopping');
  assert.equal(displayRunStatus(run, true, true, false), 'running');
  assert.equal(displayRunStatus({ status: 'cancelled' }, true, true, false), 'cancelled');
  assert.equal(displayRunStatus({ status: 'completed' }, false, false, false), 'completed');
});

test('stop request removes active animation cues without claiming confirmed cancellation', () => {
  const view = {
    headline: 'working',
    groups: [
      [
        { status: 'active', stateLabel: '現在ここ' },
        { status: 'done', stateLabel: '工程完了' },
      ],
    ],
    consulting: true,
  };
  const result = stoppingView(view, true);
  assert.equal(result.groups[0][0].stateLabel, '停止要求中');
  assert.match(result.headline, /未確認/);
  assert.equal(view.groups[0][0].status, 'active');
  assert.equal(result.groups[0][1].status, 'done');
});
test('opening results cannot turn an unfinished run into a final result', () => {
  const run = {
    status: 'running',
    tasks: [{ id: '1', roleId: 'commander', result: { verdict: 'pass', content: 'plan' } }],
  };
  const before = JSON.stringify(run);
  assert.equal(finalResult(run), null);
  assert.equal(JSON.stringify(run), before);
});
test('final result uses the last passed commander report only after completion', () => {
  const final = { verdict: 'pass', content: 'final', checks: ['verified'] };
  const run = {
    status: 'completed',
    tasks: [
      { roleId: 'commander', result: { verdict: 'pass', content: 'plan' } },
      { roleId: 'builder', result: { verdict: 'pass', content: 'build' } },
      { roleId: 'commander', result: final },
    ],
  };
  assert.equal(finalResult(run), final);
  assert.equal(finalResult({ status: 'completed', tasks: [] }), null);
});
test('talk keeps root input, additions and recorded reports without inventing messages', () => {
  const run = {
    instruction: 'latest',
    rootInstruction: 'original',
    userAdditions: ['add'],
    createdAt: 'now',
    tasks: [
      {
        id: '1',
        roleId: 'builder',
        instruction: 'do',
        result: { content: 'done' },
        startedAt: 'start',
        finishedAt: 'finish',
      },
      { id: '2', roleId: 'qa', error: 'failed' },
    ],
  };
  assert.deepEqual(
    conversationEntries(run, 'builder').map((x) => x.content),
    ['original', 'add', 'do', 'done'],
  );
  assert.deepEqual(
    conversationEntries(run, 'researcher').map((x) => x.content),
    ['original', 'add'],
  );
  assert.deepEqual(conversationEntries(null), []);
  assert.equal(conversationEntries(run).at(-1).kind, '実行エラー');
});
