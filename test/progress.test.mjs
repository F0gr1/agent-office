import test from 'node:test';
import assert from 'node:assert/strict';
import { progressView } from '../public/progress.js';
const now = Date.parse('2026-10-27T10:00:00Z');
const agent = {
  startedAt: '2026-10-27T09:58:00Z',
  activity: '検証処理を終了・次の更新待ち',
  progress: {
    phase: 'evaluating',
    lastEventAt: '2026-10-27T09:59:50Z',
    activeSince: null,
    activeCount: 0,
    completedSteps: 4,
  },
};
test('completed command waits for next event without claiming still executing', () => {
  const view = progressView(agent, now);
  assert.equal(view.active, null);
  assert.equal(view.completed, 4);
  assert.equal(view.stale, false);
  assert.equal(view.total, '2分00秒');
  assert.match(view.message, /検証処理を終了/);
});
test('missing events are uncertainty, not fabricated progress or automatic failure', () => {
  const view = progressView(
    { ...agent, progress: { ...agent.progress, lastEventAt: '2026-10-27T09:58:00Z' } },
    now,
  );
  assert.equal(view.stale, true);
  assert.match(view.message, /未確認/);
  assert.equal(progressView({ startedAt: agent.startedAt }, now).label, '詳細な進捗の受信待ち');
});
test('elapsed operation and stage time stay distinct', () => {
  const view = progressView(
    {
      ...agent,
      progress: {
        ...agent.progress,
        phase: 'executing',
        activeCount: 1,
        activeSince: '2026-10-27T09:59:40Z',
      },
    },
    now,
  );
  assert.equal(view.active, '20秒');
  assert.equal(view.total, '2分00秒');
});
