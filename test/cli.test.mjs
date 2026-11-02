import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliRunner, roles } from '../orchestrator.mjs';
function fixture(t, code) {
  const dir = mkdtempSync(join(tmpdir(), 'office-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'codex-fixture');
  writeFileSync(bin, `#!${process.execPath}\n${code}`);
  chmodSync(bin, 0o700);
  return { bin, dir };
}
const result = { summary: 'ok', content: 'ok', verdict: 'pass', issues: [], checks: [] };
const resultEvents = [
  {
    type: 'item.completed',
    item: { id: 'answer', type: 'agent_message', text: JSON.stringify(result) },
  },
  { type: 'turn.completed' },
];
function eventFixture(t, events, linger = false) {
  const code = `process.stdin.resume();process.stdin.on('end',()=>{for(const event of ${JSON.stringify(events)})console.log(JSON.stringify(event));${linger ? 'setInterval(()=>{},1000);' : ''}});`;
  return fixture(t, code);
}
async function runEvents(t, events, options = {}) {
  const { bin, dir } = eventFixture(t, events, options.linger);
  const progress = [];
  const usage = [];
  const promise = cliRunner({ bin })({
    run: { workspace: dir },
    role: roles[0],
    prompt: 'test',
    signal: new AbortController().signal,
    onEvent: (message, value) => progress.push({ message, value }),
    onUsage: (value) => usage.push(value),
  });
  return { promise, progress, usage };
}
test('CLI requires completed turn and valid result', async (t) => {
  const { bin, dir } = fixture(
    t,
    `process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(JSON.stringify(result))}}}));console.log(JSON.stringify({type:'turn.completed'}));});`,
  );
  const r = await cliRunner({ bin })({
    run: { workspace: dir },
    role: roles[0],
    prompt: 'test',
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  assert.equal(r.verdict, 'pass');
});
test('CLI exit zero without completed turn is failure', async (t) => {
  const { bin, dir } = fixture(
    t,
    "process.stdin.resume();process.stdin.on('end',()=>process.exit(0));",
  );
  await assert.rejects(
    cliRunner({ bin })({
      run: { workspace: dir },
      role: roles[0],
      prompt: 'test',
      signal: new AbortController().signal,
      onEvent: () => {},
    }),
    /正常終了/,
  );
});
test('cancel kills TERM-resistant child within bounded time', async (t) => {
  const { bin, dir } = fixture(
    t,
    "process.on('SIGTERM',()=>{});process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'item.started',item:{type:'command_execution'}}));setInterval(()=>{},1000);});",
  );
  const controller = new AbortController();
  const start = Date.now();
  await assert.rejects(
    cliRunner({ bin })({
      run: { workspace: dir },
      role: roles[0],
      prompt: 'test',
      signal: controller.signal,
      onEvent: () => controller.abort(),
    }),
    /停止/,
  );
  assert.ok(Date.now() - start < 5000);
});

test('CLI progress tracks interleaved items, ignores duplicate completion, and hides content', async (t) => {
  const secret = 'PRIVATE_COMMAND_OUTPUT_AND_REASONING';
  const { promise, progress } = await runEvents(t, [
    { type: 'turn.started' },
    {
      type: 'item.started',
      item: { id: 'one', type: 'command_execution', command: `rg ${secret} .` },
    },
    { type: 'item.started', item: { id: 'two', type: 'reasoning', text: secret } },
    { type: 'item.completed', item: { id: 'two', type: 'reasoning', text: secret } },
    {
      type: 'item.completed',
      item: {
        id: 'one',
        type: 'command_execution',
        command: `rg ${secret} .`,
        exit_code: 1,
        aggregated_output: secret,
      },
    },
    {
      type: 'item.completed',
      item: {
        id: 'one',
        type: 'command_execution',
        command: `rg ${secret} .`,
        exit_code: 1,
        aggregated_output: secret,
      },
    },
    ...resultEvents,
  ]);
  assert.equal((await promise).verdict, 'pass');
  assert.deepEqual(
    progress.slice(0, 5).map(({ value }) => [value.phase, value.activeCount, value.completedSteps]),
    [
      ['starting', 0, 0],
      ['executing', 1, 0],
      ['executing', 2, 0],
      ['executing', 1, 1],
      ['evaluating', 0, 2],
    ],
  );
  assert.equal(progress.at(-1).value.phase, 'finalizing');
  assert.ok(!JSON.stringify(progress).includes(secret));
});

test('three identical failed command completions stop with loop guard code', async (t) => {
  const command = {
    type: 'command_execution',
    command: 'npm test',
    exit_code: 2,
    aggregated_output: 'same failure',
  };
  const { promise, progress } = await runEvents(
    t,
    [
      { type: 'turn.started' },
      ...[1, 2, 3].map((id) => ({ type: 'item.completed', item: { ...command, id: String(id) } })),
    ],
    { linger: true },
  );
  await assert.rejects(promise, (error) => error.code === 'OFFICE_LOOP_GUARD');
  assert.equal(progress.at(-1).value.phase, 'blocked');
  assert.equal(progress.at(-1).value.repeatFailures, 3);
});

test('changed failure and file change reset repeat count', async (t) => {
  const failed = (id, output = 'same') => ({
    type: 'item.completed',
    item: {
      id,
      type: 'command_execution',
      command: 'npm test',
      exit_code: 2,
      aggregated_output: output,
    },
  });
  const { promise, progress } = await runEvents(t, [
    failed('a'),
    failed('b'),
    failed('c', 'different'),
    failed('d'),
    {
      type: 'item.completed',
      item: { id: 'edit', type: 'file_change', changes: [{ diff: 'PRIVATE' }] },
    },
    failed('e'),
    failed('f'),
    ...resultEvents,
  ]);
  assert.equal((await promise).verdict, 'pass');
  assert.ok(progress.every(({ value }) => value.repeatFailures < 3));
  assert.equal(progress.find(({ value }) => value.completedSteps === 5).value.repeatFailures, 0);
});

test('duplicate failure ID, successful tests, missing output, and search no-match never trip guard', async (t) => {
  const events = [];
  for (let i = 0; i < 4; i++)
    events.push({
      type: 'item.completed',
      item: {
        id: `pass-${i}`,
        type: 'command_execution',
        command: 'npm test',
        exit_code: 0,
        aggregated_output: 'ok',
      },
    });
  for (let i = 0; i < 4; i++)
    events.push({
      type: 'item.completed',
      item: {
        id: `rg-${i}`,
        type: 'command_execution',
        command: "/bin/zsh -lc 'rg missing .'",
        exit_code: 1,
        aggregated_output: '',
      },
    });
  for (let i = 0; i < 4; i++)
    events.push({
      type: 'item.completed',
      item: {
        id: `unknown-${i}`,
        type: 'command_execution',
        command: 'npm test',
        exit_code: 2,
      },
    });
  const same = {
    id: 'duplicate',
    type: 'command_execution',
    command: 'npm test',
    exit_code: 2,
    aggregated_output: 'fail',
  };
  events.push(
    { type: 'item.completed', item: same },
    { type: 'item.completed', item: same },
    { type: 'item.completed', item: { ...same, id: 'second' } },
    ...resultEvents,
  );
  const { promise, progress } = await runEvents(t, events);
  assert.equal((await promise).verdict, 'pass');
  assert.equal(progress.at(-2).value.repeatFailures, 2);
});

test('last valid structured message and measured usage survive later non-result message', async (t) => {
  const { promise, usage } = await runEvents(t, [
    {
      type: 'item.completed',
      item: { id: 'answer-1', type: 'agent_message', text: JSON.stringify(result) },
    },
    {
      type: 'item.completed',
      item: { id: 'comment', type: 'agent_message', text: 'unstructured text' },
    },
    {
      type: 'turn.completed',
      usage: { input_tokens: 10, cached_input_tokens: 3, output_tokens: 5, total_tokens: 999 },
    },
  ]);
  assert.equal((await promise).verdict, 'pass');
  assert.deepEqual(usage, [{ input_tokens: 10, cached_input_tokens: 3, output_tokens: 5 }]);
});

test('CLI error detail is not exposed in progress or rejection', async (t) => {
  const secret = 'PRIVATE_TOOL_ARGUMENT';
  const { promise, progress } = await runEvents(t, [
    { type: 'turn.started' },
    { type: 'turn.failed', error: { message: secret } },
  ]);
  await assert.rejects(promise, (error) => error.message === 'Codex実行エラー');
  assert.ok(!JSON.stringify(progress).includes(secret));
});
