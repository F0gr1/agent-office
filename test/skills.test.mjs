import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings, SettingsStore, validateSettings } from '../lib/settings.mjs';
import { prepareSkillApplication } from '../lib/skills.mjs';
import { Office } from '../orchestrator.mjs';
import { validateResult } from '../lib/codex-runner.mjs';
import { verificationGroups } from '../public/verification.js';
import { conversationEntries } from '../public/experience.js';

const result = { summary: '完了', content: '報告', verdict: 'pass', issues: [], checks: [] };
const skill = {
  id: 'skill_example',
  name: '仕様照合',
  description: '',
  instructions: '根拠を列挙する',
  revision: 1,
  enabled: true,
};

test('legacy settings migrate without losing agents; skill revision changes only on edits', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'office-skills-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const legacy = defaultSettings();
  legacy.version = 1;
  delete legacy.skills;
  for (const agent of legacy.agents) delete agent.skillIds;
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(legacy));
  const store = new SettingsStore({ dataDir: dir });
  assert.equal(store.get().version, 2);
  assert.deepEqual(store.get().skills, []);
  assert.deepEqual(store.get().agents[0].skillIds, []);
  const updated = store.get();
  updated.skills.push({ ...skill });
  updated.agents[0].skillIds.push(skill.id);
  assert.equal(store.save(updated).skills[0].revision, 1);
  assert.equal(store.save(store.get()).skills[0].revision, 1);
  const edit = store.get();
  edit.skills[0].instructions = '変更した指示';
  assert.equal(store.save(edit).skills[0].revision, 2);
  assert.equal(new SettingsStore({ dataDir: dir }).get().skills[0].revision, 2);
  assert.throws(() => store.save(legacy), /古い設定形式/);
  const incomplete = store.get();
  delete incomplete.agents[0].skillIds;
  assert.throws(() => store.save(incomplete), /古い設定形式/);
});

test('skill validation rejects duplicate definitions, assignments and malformed values', () => {
  const base = defaultSettings();
  base.skills = [{ ...skill }];
  base.agents[0].skillIds = [skill.id];
  assert.equal(validateSettings(base).agents[0].skillIds[0], skill.id);
  const invalid = (change) => {
    const value = structuredClone(base);
    change(value);
    assert.throws(() => validateSettings(value));
  };
  invalid((value) => value.skills.push({ ...skill }));
  invalid((value) => value.agents[0].skillIds.push(skill.id));
  invalid((value) => (value.skills[0].revision = 0));
  invalid((value) => (value.skills[0].instructions = ' '));
  invalid((value) => (value.skills[0].enabled = 'yes'));
});

test('application distinguishes assigned, disabled, missing, unassigned and old history', () => {
  const run = {
    skillSnapshot: { definitions: [{ ...skill }, { ...skill, id: 'skill_off', enabled: false }] },
  };
  const application = prepareSkillApplication(run, {
    skillIds: ['skill_example', 'skill_off', 'skill_lost'],
  });
  assert.deepEqual(
    application.entries.map((entry) => entry.status),
    ['injected', 'disabled', 'missing'],
  );
  assert.deepEqual(
    application.promptSkills.map((entry) => entry.id),
    [skill.id],
  );
  assert.equal(prepareSkillApplication(run, { skillIds: [] }).status, 'not_assigned');
  assert.equal(prepareSkillApplication({}, { skillIds: [] }).status, 'unrecorded');
});

test('run freezes skill version, records prompt injection and links invocation evidence', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'office-skill-run-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new SettingsStore({ dataDir: dir });
  const value = store.get();
  value.skills.push({ ...skill });
  value.agents.find((agent) => agent.id === 'planner').skillIds = [skill.id];
  store.save(value);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const prompts = [];
  const office = new Office({
    dataDir: dir,
    workspaceRoot: dir,
    runtime: { available: true, version: 'test' },
    getSettings: () => store.get(),
    runner: async ({ role, prompt }) => {
      if (role.id === 'commander' && !prompts.length) await gate;
      prompts.push({ id: role.id, prompt });
      return { ...result };
    },
  });
  const run = office.start({ instruction: '依頼', workspace: dir, specialists: [] });
  const edit = store.get();
  edit.skills[0].instructions = '後から変更';
  store.save(edit);
  release();
  await run.promise;
  const planner = run.tasks.find((task) => task.roleId === 'planner');
  assert.match(prompts.find((entry) => entry.id === 'planner').prompt, /根拠を列挙する/);
  assert.doesNotMatch(prompts.find((entry) => entry.id === 'planner').prompt, /後から変更/);
  assert.equal(planner.skillApplication.entries[0].revision, 1);
  assert.equal(planner.skillApplication.entries[0].status, 'injected');
  assert.ok(planner.inputRefs.some((ref) => ref.taskId === run.tasks[0].id));
  assert.ok(conversationEntries(run).some((entry) => entry.taskId === planner.id));
  assert.equal(run.skillSnapshot.definitions[0].instructions, '根拠を列挙する');
});

test('verification text remains unclassified and structured evidence is separate', () => {
  const groups = verificationGroups({
    ...result,
    checks: ['未確認'],
    verification: [{ status: 'verified', subject: 'ビルド', evidence: '終了コード0' }],
  });
  assert.deepEqual(groups.unclassified, ['未確認']);
  assert.equal(groups.verified[0].subject, 'ビルド');
  assert.throws(() =>
    validateResult({
      ...result,
      verification: [{ status: 'verified', subject: 'ビルド', evidence: '' }],
    }),
  );
  assert.equal(validateResult(result).verdict, 'pass');
});

test('prompt preparation failure is recorded separately from runner failure', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'office-skill-error-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const office = new Office({
    dataDir: dir,
    workspaceRoot: dir,
    runtime: { available: true, version: 'test' },
    runner: async () => {
      throw Error('runner failed');
    },
  });
  const role = defaultSettings().agents.find((item) => item.id === 'planner');
  role.skillIds = [skill.id];
  const run = {
    id: 'test',
    workspace: dir,
    instruction: '依頼',
    agents: { planner: {} },
    tasks: [],
    events: [],
    skillSnapshot: { definitions: null },
  };
  await assert.rejects(() =>
    office.task(run, [role], 'planner', '確認', {}, new AbortController().signal),
  );
  assert.equal(run.tasks[0].skillApplication.status, 'error');
  assert.equal(run.tasks[0].status, 'blocked');
  run.skillSnapshot.definitions = [{ ...skill }];
  await assert.rejects(
    () => office.task(run, [role], 'planner', '確認', {}, new AbortController().signal),
    /runner failed/,
  );
  assert.equal(run.tasks[1].skillApplication.entries[0].status, 'injected');
  assert.equal(run.tasks[1].status, 'blocked');
});
