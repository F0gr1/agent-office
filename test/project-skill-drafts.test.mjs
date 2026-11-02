import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectSkillDrafts, publishSkillDrafts } from '../lib/project-skill-drafts.mjs';
const content = (name) =>
  `---\nname: ${name}\ndescription: "Review test feed fixtures."\n---\n\nReport missing fields without changing source.\n`;
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'skill-drafts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function draft(root, name = 'feed-check', text = content(name)) {
  const dir = join(root, '.office-preparation', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), text);
  return dir;
}
test('publishes reviewed instruction drafts, and repeat publication preserves matching skills', (t) => {
  const root = fixture(t);
  draft(root);
  const drafts = inspectSkillDrafts(root);
  assert.throws(() => publishSkillDrafts(root, drafts), /独立レビュー/);
  assert.deepEqual(publishSkillDrafts(root, drafts, { reviewed: true }), [
    '.agents/skills/feed-check/SKILL.md',
  ]);
  assert.equal(
    readFileSync(join(root, '.agents/skills/feed-check/SKILL.md'), 'utf8'),
    content('feed-check'),
  );
  publishSkillDrafts(root, drafts);
});
test('a conflict prevents all writes and keeps existing skill content', (t) => {
  const root = fixture(t);
  draft(root, 'first');
  draft(root, 'second');
  mkdirSync(join(root, '.agents/skills/second'), { recursive: true });
  writeFileSync(join(root, '.agents/skills/second/SKILL.md'), 'original');
  assert.throws(() => publishSkillDrafts(root, inspectSkillDrafts(root)), /既存Skill/);
  assert.equal(existsSync(join(root, '.agents/skills/first/SKILL.md')), false);
  assert.equal(readFileSync(join(root, '.agents/skills/second/SKILL.md'), 'utf8'), 'original');
});
for (const part of ['.agents', '.office-preparation'])
  test(`rejects a symlinked ${part} without modifying its target`, (t) => {
    const root = fixture(t),
      external = fixture(t);
    if (part === '.agents') draft(root);
    symlinkSync(external, join(root, part), 'dir');
    assert.throws(() => publishSkillDrafts(root, inspectSkillDrafts(root)), /リンク/);
    assert.deepEqual(inspectSkillDrafts(external), []);
  });
test('rejects linked files, invalid metadata, and executable resources', (t) => {
  const root = fixture(t);
  const dir = draft(root);
  writeFileSync(join(dir, 'script.sh'), 'echo no');
  assert.throws(() => inspectSkillDrafts(root), /SKILL.mdだけ/);
  rmSync(join(dir, 'script.sh'));
  writeFileSync(join(dir, 'SKILL.md'), content('different-name'));
  assert.throws(() => inspectSkillDrafts(root), /name/);
  rmSync(join(dir, 'SKILL.md'));
  writeFileSync(join(root, 'outside.md'), content('feed-check'));
  symlinkSync(join(root, 'outside.md'), join(dir, 'SKILL.md'));
  assert.throws(() => inspectSkillDrafts(root));
});
