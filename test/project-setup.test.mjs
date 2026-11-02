import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
  existsSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { projectSetupInstruction } from '../public/project-setup.js';
import { Office } from '../orchestrator.mjs';
import { inspectSkillDrafts, skillDraftSnapshot } from '../lib/project-skill-drafts.mjs';

const reviewProof = (workspace) =>
  skillDraftSnapshot(inspectSkillDrafts(workspace)).map((draft) => ({
    status: 'verified',
    subject: `.office-preparation/skills/${draft.name}/SKILL.md`,
    evidence: `${draft.sha256} 内容と要件を照合しました。`,
  }));

test('RSS and unrelated CSV plans retain target and undecided technology without adding fixed skills', () => {
  const rss = projectSetupInstruction({
    purpose: 'RSSを始める',
    workspace: '/tmp/rss',
    undecidedTech: '',
  });
  const csv = projectSetupInstruction({
    purpose: 'CSV整理ツール',
    workspace: '/tmp/csv',
    undecidedTech: '言語は未決',
  });
  assert.match(rss, /対象フォルダー: \/tmp\/rss/);
  assert.match(rss, /未決（選定済みとして扱わない）/);
  assert.match(csv, /対象フォルダー: \/tmp\/csv/);
  assert.match(csv, /言語は未決/);
  assert.doesNotMatch(csv, /RSS/);
  assert.match(rss, /明確な不足がある場合だけ \.agents\/skills/);
  assert.match(rss, /取得不能の記事を読了扱いしません/);
  assert.throws(() => projectSetupInstruction({ purpose: 'RSS', workspace: '' }), /絶対パス/);
});

for (const [purpose, tech] of [
  ['RSSを始める', '技術は未決'],
  ['CSV整理ツール', 'Python標準ライブラリ'],
]) {
  test(`CLI sends one setup request with the selected target and context: ${purpose}`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'project-setup-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const target = join(dir, 'target');
    mkdirSync(target);
    const agents = join(target, 'AGENTS.md');
    writeFileSync(agents, 'existing instructions\n');
    const purposeFile = join(dir, 'purpose.txt');
    const techFile = join(dir, 'tech.txt');
    const contextFile = join(dir, 'context.txt');
    const context = '既存ルールとSkillsを保持してください。';
    writeFileSync(purposeFile, purpose, { mode: 0o600 });
    writeFileSync(techFile, tech, { mode: 0o600 });
    writeFileSync(contextFile, context, { mode: 0o600 });
    const posted = [];
    const server = createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/state')
        res.end(
          JSON.stringify({
            capabilities: { automaticDispatch: true, projectSetup: true },
            runs: [],
          }),
        );
      else if (req.url === '/api/session') res.end(JSON.stringify({ token: 'fixture-token' }));
      else if (req.url === '/api/runs') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        posted.push({
          body: JSON.parse(Buffer.concat(chunks).toString()),
          token: req.headers['x-office-token'],
        });
        res.writeHead(202);
        res.end(JSON.stringify({ id: '11111111-2222-4333-8444-555555555555' }));
      } else {
        res.writeHead(404);
        res.end('{}');
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const result = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          'scripts/office.mjs',
          '--workspace',
          target,
          '--project-purpose-file',
          purposeFile,
          '--undecided-tech-file',
          techFile,
          '--instruction-file',
          contextFile,
          '--port',
          String(server.address().port),
          '--no-open',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stderr = '';
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('error', reject);
      child.on('exit', (code) => resolve({ code, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].token, 'fixture-token');
    assert.equal(posted[0].body.workspace, target);
    assert.equal(posted[0].body.kind, 'project-setup');
    assert.equal(posted[0].body.specialists, undefined);
    assert.equal(
      posted[0].body.instruction,
      projectSetupInstruction({ purpose, workspace: target, undecidedTech: tech, context }),
    );
    assert.equal(readFileSync(agents, 'utf8'), 'existing instructions\n');
    assert.equal(existsSync(join(target, '.agents')), false);
  });
}

for (const content of [null, '   ', '# Existing project rules\n']) {
  test(`setup completion requires real nonempty guidance: ${JSON.stringify(content)}`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'setup-completion-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'project'));
    const workspace = realpathSync(join(dir, 'project'));
    if (content !== null) writeFileSync(join(workspace, 'AGENTS.md'), content);
    const office = new Office({
      dataDir: join(dir, 'state'),
      workspaceRoot: workspace,
      runtime: { available: true },
      runner: async () => ({
        summary: '完了と回答',
        content: '準備済み',
        verdict: 'pass',
        issues: [],
        checks: [],
        dispatch: { summary: '既存を再利用', assignments: [] },
      }),
    });
    const run = office.start({ kind: 'project-setup', instruction: '準備', workspace });
    await run.promise;
    assert.equal(run.status, content?.trim() ? 'completed' : 'needs_attention');
    assert.equal(run.preparationVerification.status, content?.trim() ? 'verified' : 'failed');
    if (content?.trim()) {
      const next = office.start({ instruction: '準備内容を再確認', continueFromRunId: run.id });
      await next.promise;
      assert.equal(next.kind, 'project-setup');
      assert.equal(next.status, 'completed');
      assert.equal(readFileSync(join(workspace, 'AGENTS.md'), 'utf8'), content);
    }
  });
}

for (const reviewed of [false, 'empty-proof', true])
  test(`new skill is published only after independent review: ${reviewed}`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'setup-skill-review-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const workspace = realpathSync(dir);
    writeFileSync(join(workspace, 'AGENTS.md'), '# Project rules\n');
    const folder = join(workspace, '.office-preparation/skills/feed-check');
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, 'SKILL.md'),
      '---\nname: feed-check\ndescription: "Check feed fixtures."\n---\n\nReport missing fields.\n',
    );
    const ok = { summary: '確認', content: '実績', verdict: 'pass', issues: [], checks: [] };
    const assignments = reviewed
      ? ['builder', 'reviewer'].map((roleId) => ({
          roleId,
          reason: '必要な工程',
          instruction: '確認してください',
        }))
      : [];
    const office = new Office({
      dataDir: join(workspace, 'state'),
      workspaceRoot: workspace,
      runtime: { available: true },
      runner: async ({ role }) => ({
        ...ok,
        verification: role.id === 'reviewer' && reviewed === true ? reviewProof(workspace) : [],
        dispatch: { summary: '必要な工程', assignments },
      }),
    });
    const run = office.start({ kind: 'project-setup', instruction: '準備', workspace });
    await run.promise;
    assert.equal(run.status, reviewed === true ? 'completed' : 'needs_attention');
    assert.equal(
      existsSync(join(workspace, '.agents/skills/feed-check/SKILL.md')),
      reviewed === true,
    );
    if (reviewed === true)
      assert.deepEqual(run.preparationVerification.skills, ['.agents/skills/feed-check/SKILL.md']);
  });

for (const change of ['content', 'added'])
  test(`does not publish drafts changed after review: ${change}`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'setup-stale-review-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const workspace = realpathSync(dir);
    writeFileSync(join(workspace, 'AGENTS.md'), '# Project\n');
    const draft = (name, body) => {
      const folder = join(workspace, '.office-preparation/skills', name);
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        join(folder, 'SKILL.md'),
        `---\nname: ${name}\ndescription: "Review fixtures."\n---\n\n${body}\n`,
      );
    };
    draft('feed-check', 'Original reviewed instructions');
    let commanders = 0;
    const ok = { summary: '確認', content: '実績', verdict: 'pass', issues: [], checks: [] };
    const assignments = ['builder', 'reviewer'].map((roleId) => ({
      roleId,
      reason: '必要',
      instruction: '確認',
    }));
    const office = new Office({
      dataDir: join(workspace, 'state'),
      workspaceRoot: workspace,
      runtime: { available: true },
      runner: async ({ role, prompt }) => {
        if (role.id === 'reviewer') assert.match(prompt, /配置対象のSkill草案を全件レビュー/);
        if (role.id === 'commander' && commanders++ === 1)
          draft(
            change === 'added' ? 'another-check' : 'feed-check',
            'Changed after independent review',
          );
        return {
          ...ok,
          verification: role.id === 'reviewer' ? reviewProof(workspace) : [],
          dispatch: { summary: '選定', assignments },
        };
      },
    });
    const run = office.start({ kind: 'project-setup', instruction: '準備', workspace });
    await run.promise;
    assert.equal(run.status, 'needs_attention');
    assert.equal(existsSync(join(workspace, '.agents/skills/feed-check/SKILL.md')), false);
  });

for (const append of [false, true])
  test(`existing AGENTS content is retained with recovery copy; append=${append}`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'setup-existing-agents-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const workspace = realpathSync(dir);
    const original = '# Existing project rules\n';
    writeFileSync(join(workspace, 'AGENTS.md'), original);
    const ok = {
      summary: '完了と回答',
      content: '確認',
      verdict: 'pass',
      issues: [],
      checks: [],
      dispatch: { summary: '確認', assignments: [] },
    };
    const office = new Office({
      dataDir: join(workspace, 'state'),
      workspaceRoot: workspace,
      runtime: { available: true },
      runner: async () => {
        writeFileSync(
          join(workspace, 'AGENTS.md'),
          append ? original + '\nNew project notes\n' : 'Replaced previous instructions',
        );
        return ok;
      },
    });
    const run = office.start({ kind: 'project-setup', instruction: '準備', workspace });
    await run.promise;
    assert.equal(run.status, append ? 'completed' : 'needs_attention');
    assert.equal(
      readFileSync(join(office.dataDir, run.preparationBaseline.backup), 'utf8'),
      original,
    );
    if (!append) {
      const next = office.start({ instruction: '確認を再開', continueFromRunId: run.id });
      await next.promise;
      assert.equal(next.status, 'needs_attention');
      assert.deepEqual(next.preparationBaseline, run.preparationBaseline);
    }
  });
