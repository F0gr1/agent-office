import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexGlobal, projectHistory } from '../lib/codex-context.mjs';
test('Global read only exposes allowlisted root defaults, never credentials or section overrides', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'office-global-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, 'config.toml'),
    `model = "root-model"\nmodel_reasoning_effort = 'high' # default\napi_key="secret"\n[mcp_servers.private]\nurl="private-url"\nmodel="wrong-section"\n[agents.checker]\n`,
  );
  const result = codexGlobal(dir);
  assert.equal(result.status, 'read');
  assert.deepEqual(result.fields, { model: 'root-model', model_reasoning_effort: 'high' });
  assert.deepEqual(result.agentRoleIds, ['checker']);
  assert.doesNotMatch(JSON.stringify(result), /secret|private-url|wrong-section/);
  assert.equal(codexGlobal(join(dir, 'missing')).status, 'unavailable');
});
test('history distinguishes explicit membership from folder matches and partial snapshots', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'office-history-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'history.json');
  writeFileSync(
    file,
    JSON.stringify({
      syncedAt: 'now',
      items: [
        { id: 'a', title: 'A', cwd: '/p', projectId: null },
        { id: 'b', title: 'B', cwd: '/other', projectId: 'p' },
        { id: 'c', title: 'Other', cwd: '/other', projectId: 'other' },
      ],
    }),
  );
  const result = projectHistory(file, { id: 'p', path: '/p' });
  assert.deepEqual(
    result.items.map((x) => x.match),
    ['folder', 'project'],
  );
  assert.equal(result.items.length, 2);
  assert.equal(projectHistory(file, null).items.length, 0);
  assert.equal(projectHistory('missing', null).available, false);
});
