import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Office } from '../orchestrator.mjs';
import { SettingsStore, defaultSettings, validateSettings, MAX_AGENTS } from '../lib/settings.mjs';

const pass = {
  summary: '確認済み',
  content: '成果',
  verdict: 'pass',
  issues: [],
  checks: ['確認'],
};
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'office-settings-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, store: new SettingsStore({ dataDir: dir }) };
}
function custom(id, stage = 'planning') {
  return {
    id,
    name: '追加担当',
    title: '追加検証',
    description: '仕様と実装を確認',
    instructions: '重要な境界条件を確認する',
    provider: 'codex',
    model: 'gpt-6-sol',
    effort: 'high',
    stage,
    enabled: true,
    useModeDefaults: false,
  };
}

test('settings persist atomically with private permissions and detached reads', (t) => {
  const { dir, store } = fixture(t);
  const value = store.get();
  value.agents[0].name = '新しい名前';
  assert.notEqual(store.get().agents[0].name, '新しい名前');
  store.save(value);
  assert.equal(statSync(join(dir, 'settings.json')).mode & 0o777, 0o600);
  assert.equal(new SettingsStore({ dataDir: dir }).get().agents[0].name, '新しい名前');
});

test('legacy history receives an original role snapshot independent of current settings', (t) => {
  const { dir, store } = fixture(t);
  const oldName = defaultSettings().agents.find((role) => role.id === 'planner').name;
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({
      runs: [
        {
          id: 'old-run',
          status: 'completed',
          mode: 'careful',
          agents: {
            planner: { status: 'done', model: 'gpt-6-sol', effort: 'xhigh' },
            commander: { status: 'done', model: 'gpt-6-astra', effort: 'high' },
          },
          events: [],
        },
      ],
    }),
  );
  const edited = store.get();
  const planner = edited.agents.find((role) => role.id === 'planner');
  planner.name = '現在の名前';
  planner.model = 'gpt-6-astra';
  store.save(edited);
  const office = new Office({
    dataDir: dir,
    workspaceRoot: dir,
    runtime: { available: true, version: 'test' },
    getSettings: () => store.get(),
    runner: async () => ({ ...pass }),
  });
  const oldPlanner = office.runs[0].roles.find((role) => role.id === 'planner');
  assert.equal(oldPlanner.name, oldName);
  assert.equal(oldPlanner.model, 'gpt-6-sol');
  assert.equal(oldPlanner.effort, 'xhigh');
  assert.equal(oldPlanner.provider, 'codex');
  assert.equal(office.state().roles.find((role) => role.id === 'planner').name, '現在の名前');
});

test('settings reject malformed core IDs, duplicate IDs, flags, and excessive agents', () => {
  const base = defaultSettings();
  const invalid = (edit) => {
    const value = structuredClone(base);
    edit(value);
    assert.throws(() => validateSettings(value));
  };
  invalid((v) => v.agents.pop());
  invalid((v) => v.agents.push({ ...v.agents[0] }));
  invalid((v) => (v.agents[0].model = '--danger'));
  invalid((v) => (v.agents[0].effort = 'extreme'));
  invalid((v) => (v.agents[0].enabled = false));
  invalid((v) => v.agents.push(custom('wrong-id')));
  invalid((v) => v.agents.push(custom('custom_x', 'other')));
  invalid((v) => {
    for (let i = 0; i <= MAX_AGENTS; i++) v.agents.push(custom(`custom_${i}`));
  });
});

test('run snapshots edited roles and uses custom planning before implementation', async (t) => {
  const { dir, store } = fixture(t);
  const value = store.get();
  value.agents.find((a) => a.id === 'planner').instructions = '個別の仕様指示';
  value.agents.find((a) => a.id === 'planner').model = 'gpt-6-astra';
  value.agents.find((a) => a.id === 'planner').useModeDefaults = false;
  value.agents.push(custom('custom_security'));
  store.save(value);
  const calls = [];
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  let first;
  const office = new Office({
    dataDir: dir,
    workspaceRoot: dir,
    runtime: { available: true, version: 'test' },
    getSettings: () => store.get(),
    runner: async ({ role, prompt }) => {
      calls.push(role.id);
      if (role.id === 'commander' && !first) {
        first = true;
        await wait;
      }
      if (role.id === 'planner') {
        assert.equal(role.model, 'gpt-6-astra');
        assert.match(prompt, /個別の仕様指示/);
      }
      return { ...pass };
    },
  });
  const run = office.start({ instruction: 'test', workspace: dir, specialists: [] });
  const changed = store.get();
  changed.agents.find((a) => a.id === 'planner').name = '後から変更';
  changed.agents = changed.agents.filter((a) => a.id !== 'custom_security');
  store.save(changed);
  release();
  await run.promise;
  assert.equal(run.status, 'completed');
  assert.equal(
    run.roles.find((a) => a.id === 'planner').name,
    value.agents.find((a) => a.id === 'planner').name,
  );
  assert.ok(calls.indexOf('planner') < calls.indexOf('custom_security'));
  assert.ok(calls.indexOf('custom_security') < calls.indexOf('builder'));
  assert.equal(
    office.state().roles.some((a) => a.id === 'custom_security'),
    false,
  );
});

test('custom review gates commander acceptance and returns revision to builder', async (t) => {
  const { dir, store } = fixture(t);
  const value = store.get();
  value.agents.push(custom('custom_audit', 'review'));
  store.save(value);
  const calls = [];
  const office = new Office({
    dataDir: dir,
    workspaceRoot: dir,
    runtime: { available: true, version: 'test' },
    getSettings: () => store.get(),
    runner: async ({ role, run }) => {
      calls.push(`${run.round}:${role.id}`);
      return {
        ...pass,
        verdict: role.id === 'custom_audit' && run.round === 1 ? 'revise' : 'pass',
      };
    },
  });
  const run = office.start({ instruction: 'test', workspace: dir, specialists: [] });
  await run.promise;
  assert.equal(run.status, 'completed');
  assert.equal(run.round, 2);
  assert.equal(calls.filter((call) => call.endsWith(':builder')).length, 2);
  assert.ok(calls.indexOf('1:custom_audit') > calls.indexOf('1:reviewer2'));
  assert.ok(calls.indexOf('2:custom_audit') < calls.lastIndexOf('2:commander'));
});

test('blocked custom review cannot reach final commander acceptance', async (t) => {
  const { dir, store } = fixture(t);
  const value = store.get();
  value.agents.push(custom('custom_audit', 'review'));
  store.save(value);
  const commanderAssignments = [];
  const office = new Office({
    dataDir: dir,
    workspaceRoot: dir,
    runtime: { available: true, version: 'test' },
    getSettings: () => store.get(),
    runner: async ({ role, run }) => {
      if (role.id === 'commander') commanderAssignments.push(run.agents.commander.assignment);
      return { ...pass, verdict: role.id === 'custom_audit' ? 'blocked' : 'pass' };
    },
  });
  const run = office.start({ instruction: 'test', workspace: dir, specialists: [] });
  await run.promise;
  assert.equal(run.status, 'needs_attention');
  assert.equal(run.round, 1);
  assert.equal(
    commanderAssignments.some((assignment) => assignment.includes('最終判定')),
    false,
  );
});
