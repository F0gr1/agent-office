import test from 'node:test';
import assert from 'node:assert/strict';
import { escalationView } from '../public/escalation.js';

test('consultation moves the reporting role to the CEO room without implying completion', () => {
  const run = {
    status: 'running',
    escalation: { sourceRole: 'researcher', status: 'consulting', reason: 'write unavailable' },
  };
  assert.equal(escalationView(run).visitor, 'researcher');
  run.escalation.status = 'retrying';
  run.escalation.result = { verdict: 'pass', content: 'retry builder' };
  assert.equal(escalationView(run).visitor, null);
  assert.doesNotMatch(escalationView(run).title, /完了|最終OK/);
  run.escalation.status = 'awaiting_user';
  run.status = 'needs_attention';
  assert.equal(escalationView(run).waiting, true);
  assert.equal(escalationView(run).visitor, 'researcher');
  run.status = 'cancelled';
  assert.equal(escalationView(run).visitor, null);
  assert.match(escalationView(run).title, /中止/);
});
