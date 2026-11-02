import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { cliRunner, roles } from '../orchestrator.mjs';
import { claudeRunner } from '../lib/claude-runner.mjs';
function fixture(t, type) {
  const dir = mkdtempSync(join(tmpdir(), 'office-worker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'model');
  const source = `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>{const answer={summary:'worker',content:process.env.AGENT_OFFICE_WORKER||'missing',verdict:'pass',issues:[],checks:[]};if(${JSON.stringify(type)}==='codex'){console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(answer)}}));console.log(JSON.stringify({type:'turn.completed'}));}else console.log(JSON.stringify({type:'result',structured_output:answer}));});`;
  writeFileSync(bin, source);
  chmodSync(bin, 0o700);
  return { dir, bin };
}
for (const type of ['codex', 'claude'])
  test(`${type} role inherits worker boundary in the actual child process`, async (t) => {
    const { dir, bin } = fixture(t, type);
    const runner = type === 'codex' ? cliRunner({ bin }) : claudeRunner({ bin, available: true });
    const role =
      type === 'codex' ? roles[0] : { id: 'researcher', model: 'claude-sonnet-5', effort: 'high' };
    const result = await runner({
      run: { workspace: dir },
      role,
      prompt: 'test',
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    assert.equal(result.content, '1');
  });
test('worker CLI cannot send a nested request or launch another server', async () => {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        'scripts/office.mjs',
        '--workspace',
        process.cwd(),
        '--instruction-file',
        '/nonexistent-file',
      ],
      { env: { ...process.env, AGENT_OFFICE_WORKER: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '',
      err = '';
    child.stdout.on('data', (data) => (out += data));
    child.stderr.on('data', (data) => (err += data));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, out, err }));
  });
  assert.equal(result.code, 1);
  assert.equal(result.out, '');
  assert.match(result.err, /再転送できません/);
});
