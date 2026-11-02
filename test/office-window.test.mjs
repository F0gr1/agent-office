import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { desktopBundle, launchDesktop, openOfficeWindow } from '../lib/office-window.mjs';
import { assertOfficeIntake } from '../lib/office-boundary.mjs';
const id = '0b4b11d5-2cac-4df5-afff-707733e169ef';
function launcher(calls, code = 0) {
  return (bin, args, options) => {
    calls.push({ bin, args, options });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', code));
    return child;
  };
}
for (let attempt = 1; attempt <= 3; attempt++)
  test(`opens exact Office task in the desktop app ${attempt}`, async () => {
    const calls = [];
    const result = await openOfficeWindow({
      runId: id,
      platform: 'darwin',
      base: '/project',
      arch: 'arm64',
      exists: () => true,
      launcher: launcher(calls),
    });
    assert.equal(result.target, 'desktop');
    assert.equal(calls[0].bin, 'open');
    assert.deepEqual(calls[0].args, [
      '-n',
      '-a',
      desktopBundle('/project', 'arm64'),
      '--args',
      '--office-run',
      id,
    ]);
    assert.equal(calls[0].options.shell, false);
    assert.equal(calls.length, 1);
  });
test('missing app falls back to the exact local URL, alternative port stays in browser', async () => {
  for (const [port, exists] of [
    [4317, () => false],
    [4318, () => true],
  ]) {
    const calls = [];
    const result = await openOfficeWindow({
      runId: id,
      port,
      platform: 'darwin',
      exists,
      launcher: launcher(calls),
    });
    assert.equal(result.target, 'browser');
    assert.deepEqual(calls[0].args, [`http://127.0.0.1:${port}/?run=${id}#office`]);
  }
});
test('invalid IDs do not launch anything and a failed opener never claims success', async () => {
  const calls = [];
  for (const runId of ['x; echo bad', 'http://remote', '--args'])
    await assert.rejects(
      openOfficeWindow({
        runId,
        platform: 'darwin',
        exists: () => true,
        launcher: launcher(calls),
      }),
      /不正/,
    );
  assert.equal(calls.length, 0);
  await assert.rejects(
    launchDesktop({ platform: 'darwin', exists: () => true, launcher: launcher(calls, 1) }),
    /開けません/,
  );
});
test('worker boundary blocks nested task dispatch but allows the intake host', () => {
  assert.throws(
    () => assertOfficeIntake({ AGENT_OFFICE_WORKER: '1' }),
    (error) => error.code === 'OFFICE_RECURSIVE_DISPATCH',
  );
  assert.doesNotThrow(() => assertOfficeIntake({}));
});
