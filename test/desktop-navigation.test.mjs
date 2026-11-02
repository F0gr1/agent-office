import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  isAppUrl,
  isSafeExternalUrl,
  officeRunFromArgs,
  officeRunUrl,
  isOfficeRunOpen,
} = require('../desktop/navigation.cjs');
const origin = 'http://127.0.0.1:4317';
const runId = '5b114f37-c905-4f7b-a2f8-327b0d2d8431';

test('desktop keeps only its exact local origin in the app window', () => {
  assert.equal(isAppUrl(`${origin}/#activity`, origin), true);
  assert.equal(isAppUrl(`${origin}/index.html?run=123`, origin), true);
  for (const value of [
    'http://localhost:4317/',
    'http://127.0.0.1:4318/',
    'http://127.0.0.1:4317.evil.example/',
    'http://127.0.0.1:4317@evil.example/',
    'https://127.0.0.1:4317/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'bad url',
  ]) {
    assert.equal(isAppUrl(value, origin), false, value);
  }
});

test('external opening accepts web links and local previews only', () => {
  for (const value of [
    'https://learn.chatgpt.com/docs/cli',
    'https://code.claude.com/docs/en/setup',
    'http://127.0.0.1:5173/',
    'http://localhost:3000/',
  ]) {
    assert.equal(isSafeExternalUrl(value), true, value);
  }
  for (const value of [
    'http://example.com/',
    'https://user:password@example.com/',
    'file:///tmp/test',
    'javascript:alert(1)',
    'mailto:test@example.com',
    'bad url',
  ]) {
    assert.equal(isSafeExternalUrl(value), false, value);
  }
});

test('desktop accepts one canonical run ID from launch arguments', () => {
  assert.equal(officeRunFromArgs(['app', '--office-run', runId]), runId);
  assert.equal(
    officeRunFromArgs(['--some-electron-option', '--office-run', runId.toUpperCase()]),
    runId,
  );
  assert.equal(officeRunFromArgs(['app']), null);
  for (const argv of [
    ['app', '--office-run'],
    ['app', '--office-run', 'not-a-run'],
    ['app', `--office-run=${runId}`],
    ['app', '--office-run', `${runId}/../../settings`],
    ['app', '--office-run', runId, '--office-run', runId],
  ]) {
    assert.equal(officeRunFromArgs(argv), null, argv.join(' '));
  }
});

test('run selection builds only the local app URL and detects the current run', () => {
  assert.equal(officeRunUrl(origin, runId), `${origin}/?run=${runId}#office`);
  assert.equal(isOfficeRunOpen(`${origin}/?run=${runId}#activity`, origin, runId), true);
  assert.equal(isOfficeRunOpen(`${origin}/?run=${runId}&run=${runId}`, origin, runId), false);
  assert.equal(isOfficeRunOpen(`https://example.com/?run=${runId}`, origin, runId), false);
  assert.throws(() => officeRunUrl(origin, 'not-a-run'));
  assert.throws(() => officeRunUrl('https://example.com', runId));
});
