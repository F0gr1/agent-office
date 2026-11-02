import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readProjects, resolveProjectInput, resolveMode } from '../projects.mjs';
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'office-project-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'repo'));
  mkdirSync(join(dir, 'other'));
  const f = join(dir, 'projects.json');
  writeFileSync(
    f,
    JSON.stringify({
      syncedAt: '2026-10-27T00:00:00Z',
      source: 'snapshot',
      projects: [
        { id: 'p1', label: 'Example', path: join(dir, 'repo') },
        { id: 'gone', label: 'Missing', path: join(dir, 'missing') },
      ],
    }),
  );
  return { dir, catalog: readProjects(f) };
}
for (let n = 1; n <= 3; n++)
  test(`registered project resolves correct root ${n}`, (t) => {
    const { dir, catalog } = setup(t);
    const r = resolveProjectInput({ workspace: join(dir, 'repo'), projectId: 'p1' }, catalog);
    assert.equal(r.project.label, 'Example');
    assert.equal(r.project.path, r.workspace);
    assert.equal(r.specialists, undefined);
  });
test('project folder mismatch rejected', (t) => {
  const { dir, catalog } = setup(t);
  assert.throws(
    () => resolveProjectInput({ workspace: join(dir, 'other'), projectId: 'p1' }, catalog),
    /一致/,
  );
});
test('missing and unknown projects rejected', (t) => {
  const { dir, catalog } = setup(t);
  assert.equal(catalog.projects[1].available, false);
  for (const projectId of ['gone', 'unknown'])
    assert.throws(
      () => resolveProjectInput({ workspace: join(dir, 'repo'), projectId }, catalog),
      /見つからない/,
    );
});
test('custom project and specialist validation', (t) => {
  const { dir, catalog } = setup(t);
  assert.deepEqual(
    resolveProjectInput({ workspace: join(dir, 'repo'), specialists: [] }, catalog).specialists,
    [],
  );
  assert.equal(
    resolveProjectInput({ workspace: join(dir, 'repo'), projectId: '__custom' }, catalog).project,
    null,
  );
  for (const specialists of ['qa', ['unknown'], [null]])
    assert.throws(() =>
      resolveProjectInput({ workspace: join(dir, 'repo'), specialists }, catalog),
    );
});
test('symlink root compared canonically', (t) => {
  const { dir, catalog } = setup(t);
  symlinkSync(join(dir, 'repo'), join(dir, 'alias'));
  assert.equal(
    resolveProjectInput({ workspace: join(dir, 'alias'), projectId: 'p1' }, catalog).workspace,
    realpathSync(join(dir, 'repo')),
  );
});
test('invalid bodies and paths rejected', (t) => {
  const { catalog } = setup(t);
  for (const body of [null, [], {}, { workspace: 'relative' }, { workspace: '/' }])
    assert.throws(() => resolveProjectInput(body, catalog));
});

test('run mode accepts economy and rejects unknown settings', () => {
  assert.equal(resolveMode('economy'), 'economy');
  assert.equal(resolveMode(undefined), 'standard');
  assert.throws(() => resolveMode('other'), /モデル設定/);
});

test('missing project catalog starts with an empty list', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'office-empty-projects-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const catalog = readProjects(join(dir, 'projects.json'));
  assert.deepEqual(catalog.projects, []);
  assert.equal(catalog.syncedAt, null);
  assert.equal(
    resolveProjectInput({ workspace: dir, projectId: '__custom' }, catalog).project,
    null,
  );
});
