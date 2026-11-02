import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityTracker, commandCategory } from '../lib/activity.mjs';

test('command category is conservative for compound shell commands', () => {
  assert.equal(commandCategory('rg -n needle .'), 'search');
  assert.equal(commandCategory('git diff --check'), 'read');
  assert.equal(commandCategory('npm test'), 'test');
  assert.equal(commandCategory('apply_patch file'), 'edit');
  assert.equal(commandCategory("/bin/zsh -lc 'rg -n needle .'"), 'search');
  assert.equal(commandCategory('bash -c "npm test"'), 'test');
  assert.equal(commandCategory("/usr/bin/env bash -lc 'git diff --check'"), 'read');
  assert.equal(commandCategory("/bin/zsh -lc 'rg needle . | cat'"), 'command');
  assert.equal(commandCategory('bash -lc "rg $NEEDLE ."'), 'command');
  assert.equal(commandCategory('rg needle . | cat'), 'command');
  assert.equal(commandCategory('npm test && rm file'), 'command');
});

test('interleaved activity counts starts and completions without exposing item data', () => {
  let tick = 0;
  const events = [];
  const tracker = new ActivityTracker(
    (message, progress) => events.push({ message, progress }),
    () => new Date(Date.UTC(2026, 9, 27, 0, 0, tick++)).toISOString(),
  );
  tracker.ingest({ type: 'turn.started' });
  tracker.ingest({
    type: 'item.started',
    item: {
      id: 'a',
      type: 'command_execution',
      command: 'rg SECRET .',
      aggregated_output: 'SECRET',
    },
  });
  tracker.ingest({
    type: 'item.started',
    item: { id: 'b', type: 'command_execution', command: 'npm test', aggregated_output: 'SECRET' },
  });
  tracker.ingest({
    type: 'item.completed',
    item: { id: 'b', type: 'command_execution', command: 'npm test', aggregated_output: 'SECRET' },
  });
  tracker.ingest({
    type: 'item.completed',
    item: {
      id: 'a',
      type: 'command_execution',
      command: 'rg SECRET .',
      aggregated_output: 'SECRET',
    },
  });
  tracker.ingest({ type: 'item.completed', item: { id: 'a', type: 'command_execution' } });
  assert.deepEqual(
    events.map(({ progress }) => [
      progress.phase,
      progress.category,
      progress.activeCount,
      progress.completedSteps,
    ]),
    [
      ['starting', 'plan', 0, 0],
      ['executing', 'search', 1, 0],
      ['executing', 'test', 2, 0],
      ['executing', 'test', 1, 1],
      ['evaluating', 'search', 0, 2],
    ],
  );
  assert.ok(events[1].progress.activeSince);
  assert.equal(events.at(-1).progress.activeSince, null);
  assert.equal(events.at(-1).message, '検索処理が終了し、次の更新を待っています');
  assert.ok(!JSON.stringify(events).includes('SECRET'));
  assert.equal(tracker.completedSteps, 2);
});

test('completion without start remains accurate and reasoning text stays private', () => {
  const events = [];
  const tracker = new ActivityTracker((message, progress) => events.push({ message, progress }));
  tracker.ingest({
    type: 'item.completed',
    item: { id: 'unexpected', type: 'reasoning', text: 'hidden reasoning' },
  });
  assert.equal(events.at(-1).progress.phase, 'evaluating');
  assert.equal(events.at(-1).progress.activeCount, 0);
  assert.ok(!JSON.stringify(events).includes('hidden reasoning'));
});

test('anonymous command completion clears its start even with less detail', () => {
  const events = [];
  const tracker = new ActivityTracker((message, progress) => events.push(progress));
  tracker.ingest({
    type: 'item.started',
    item: { type: 'command_execution', command: 'rg needle .' },
  });
  tracker.ingest({ type: 'item.completed', item: { type: 'command_execution' } });
  assert.equal(events.at(-1).activeCount, 0);
  assert.equal(events.at(-1).phase, 'evaluating');
});
