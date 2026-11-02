import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeArgs, claudeRunner } from '../lib/claude-runner.mjs';
import { discoverProviders, providerRunner } from '../lib/providers.mjs';

const answer = { summary: '完了', content: '確認した', verdict: 'pass', issues: [], checks: [] };

function fixture(t, code) {
  const dir = mkdtempSync(join(tmpdir(), 'office-provider-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'cli');
  writeFileSync(bin, `#!${process.execPath}\n${code}`);
  chmodSync(bin, 0o700);
  return { bin, dir };
}

function invoke(bin, dir, options = {}) {
  return claudeRunner({ bin, available: true })({
    run: { workspace: dir },
    role: { id: options.role || 'researcher', model: 'claude-sonnet-5', effort: 'high' },
    prompt: 'private prompt',
    signal: options.signal || new AbortController().signal,
    onEvent: options.onEvent || (() => {}),
    onUsage: options.onUsage || (() => {}),
  });
}

test('Claude tool surface is bounded by role and never approves Bash', () => {
  for (const role of ['researcher', 'builder']) {
    const args = claudeArgs({ id: role, model: 'claude-sonnet-5', effort: 'medium' });
    const tools = args[args.indexOf('--tools') + 1];
    assert.equal(tools, role === 'builder' ? 'Read,Glob,Grep,Edit,Write' : 'Read,Glob,Grep');
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.ok(args.includes('--restricted'));
    assert.equal(args[args.indexOf('--disallowedTools') + 1], 'mcp__*');
    assert.equal(args[args.indexOf('--model') + 1], 'claude-sonnet-5');
    assert.equal(args[args.indexOf('--effort') + 1], 'medium');
    assert.ok(!args.join(' ').includes('Bash'));
  }
});

test('Claude rejects incompatible model and effort without silently changing them', () => {
  assert.throws(
    () => claudeArgs({ id: 'builder', model: 'gpt-6-sol', effort: 'high' }),
    /モデル設定/,
  );
  assert.throws(() => claudeArgs({ id: 'builder', model: 'sonnet', effort: 'ultra' }), /推論強度/);
  assert.equal(claudeArgs({ id: 'builder', model: 'opus', effort: 'max' }).includes('opus'), true);
});

test('Claude structured result and measured usage are accepted without exposing prompt', async (t) => {
  const { bin, dir } = fixture(
    t,
    `let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{if(input!=='private prompt')process.exit(2);console.log(JSON.stringify({type:'result',structured_output:${JSON.stringify(answer)},usage:{input_tokens:10,cache_read_input_tokens:3,output_tokens:4}}));});`,
  );
  const events = [];
  const usage = [];
  assert.deepEqual(
    await invoke(bin, dir, {
      onEvent: (message) => events.push(message),
      onUsage: (u) => usage.push(u),
    }),
    answer,
  );
  assert.deepEqual(usage, [{ input_tokens: 10, cached_input_tokens: 3, output_tokens: 4 }]);
  assert.equal(events.length, 2);
  assert.ok(!JSON.stringify(events).includes('private prompt'));
});

test('Claude errors, invalid output and absent structured output fail honestly', async (t) => {
  const invalid = fixture(
    t,
    `process.stdin.resume();process.stdin.on('end',()=>console.log('not json'));`,
  );
  await assert.rejects(invoke(invalid.bin, invalid.dir), /回答形式/);
  const denied = fixture(
    t,
    `process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'result',is_error:true,result:'PRIVATE SECRET'})));`,
  );
  await assert.rejects(
    invoke(denied.bin, denied.dir),
    (error) => !error.message.includes('PRIVATE SECRET') && /拒否/.test(error.message),
  );
  const failed = fixture(t, `process.stdin.resume();process.stdin.on('end',()=>process.exit(1));`);
  await assert.rejects(invoke(failed.bin, failed.dir), /正常終了/);
});

test('Claude cancellation terminates a resistant child', async (t) => {
  const { bin, dir } = fixture(
    t,
    `process.on('SIGTERM',()=>{});process.stdin.resume();process.stdin.on('end',()=>setInterval(()=>{},1000));`,
  );
  const controller = new AbortController();
  const started = Date.now();
  const promise = invoke(bin, dir, { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(promise, /停止/);
  assert.ok(Date.now() - started < 5000);
});

test('provider discovery reports only safe metadata and dispatches both CLIs', async (t) => {
  // The runner is created before the CLI path is supplied, like an app already open.
  const runner = providerRunner();
  const { bin, dir } = fixture(
    t,
    `const args=process.argv.slice(2);if(args[0]==='--version'){console.log('2.1.300 (Claude Code)');process.exit(0)}if(args[0]==='auth'&&args[1]==='status'){console.log(JSON.stringify({loggedIn:true,secret:'PRIVATE'}));process.exit(0)}if(args[0]==='login'&&args[1]==='status'){console.log('Logged in using PRIVATE');process.exit(0)}if(args[0]==='exec'){process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(JSON.stringify(answer))}}}));console.log(JSON.stringify({type:'turn.completed'}));});}else{process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'result',structured_output:${JSON.stringify(answer)}})));}`,
  );
  const before = [process.env.OFFICE_CODEX_BIN, process.env.OFFICE_CLAUDE_BIN];
  process.env.OFFICE_CODEX_BIN = bin;
  process.env.OFFICE_CLAUDE_BIN = bin;
  t.after(() => {
    if (before[0] === undefined) delete process.env.OFFICE_CODEX_BIN;
    else process.env.OFFICE_CODEX_BIN = before[0];
    if (before[1] === undefined) delete process.env.OFFICE_CLAUDE_BIN;
    else process.env.OFFICE_CLAUDE_BIN = before[1];
  });
  const providers = await discoverProviders();
  assert.equal(providers.codex.authenticated, true);
  assert.equal(providers.claude.authenticated, true);
  assert.equal(providers.claude.version, '2.1.300');
  assert.ok(!JSON.stringify(providers).includes('PRIVATE'));
  for (const provider of ['codex', 'claude']) {
    const result = await runner({
      run: { workspace: dir },
      role: {
        id: 'researcher',
        provider,
        model: provider === 'codex' ? 'gpt-6-sol' : 'sonnet',
        effort: 'high',
      },
      prompt: 'test',
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    assert.equal(result.verdict, 'pass');
  }
});

test('unauthenticated Claude is reported without exposing status output', async (t) => {
  const { bin } = fixture(
    t,
    `if(process.argv[2]==='--version'){console.log('2.1.300');process.exit(0)}if(process.argv[2]==='auth'){console.error('PRIVATE');process.exit(1)}`,
  );
  const before = process.env.OFFICE_CLAUDE_BIN;
  process.env.OFFICE_CLAUDE_BIN = bin;
  t.after(() => {
    if (before === undefined) delete process.env.OFFICE_CLAUDE_BIN;
    else process.env.OFFICE_CLAUDE_BIN = before;
  });
  const providers = await discoverProviders();
  assert.equal(providers.claude.authenticated, false);
  assert.match(providers.claude.message, /claude auth login/);
  assert.ok(!JSON.stringify(providers).includes('PRIVATE'));
});

test('Claude commander dispatch requests the structured selection schema', () => {
  const args = claudeArgs(
    { id: 'commander', model: 'sonnet', effort: 'high' },
    'dispatch.schema.json',
  );
  const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]);
  assert.ok(schema.required.includes('dispatch'));
  assert.ok(schema.properties.dispatch.required.includes('assignments'));
});
