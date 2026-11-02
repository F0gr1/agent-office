import test from 'node:test';
import assert from 'node:assert/strict';
import { speechFor } from '../public/speech.js';
test('speech distinguishes stage completion, revision and final commander approval', () => {
  const base = {
    id: 'commander',
    status: 'done',
    message: '証拠確認',
    verdict: 'pass',
    runStatus: 'running',
  };
  assert.equal(speechFor(base).label, '担当工程を完了');
  assert.equal(speechFor({ ...base, runStatus: 'completed' }).label, '最終OK · 依頼完了');
  assert.equal(speechFor({ ...base, verdict: 'revise' }).tone, 'blocked');
  assert.equal(
    speechFor({ ...base, id: 'builder', runStatus: 'completed' }).label,
    '担当工程を完了',
  );
});
test('disconnection and cancellation never claim active work or approval', () => {
  for (const status of ['unknown', 'stopped']) {
    assert.equal(
      speechFor({ id: 'builder', status, message: '未確認', verdict: 'pass' }).tone,
      'unknown',
    );
  }
});
