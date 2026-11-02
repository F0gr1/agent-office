import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
export function desktopBundle(base = root, arch = process.arch) {
  return join(base, 'dist-desktop', `Agent Office-darwin-${arch}`, 'Agent Office.app');
}
function opened(args, launcher) {
  return new Promise((resolve, reject) => {
    const child = launcher('open', args, { stdio: 'ignore', shell: false });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error('専用アプリを開けませんでした。表示URLから確認してください。')),
    );
  });
}
export async function launchDesktop({
  runId,
  base = root,
  platform = process.platform,
  arch = process.arch,
  exists = existsSync,
  launcher = spawn,
} = {}) {
  if (platform !== 'darwin') return false;
  const path = desktopBundle(base, arch);
  if (!exists(path)) return false;
  if (runId !== undefined && !UUID.test(runId)) throw Error('依頼IDが不正です');
  const args =
    runId === undefined
      ? ['-a', path]
      : ['-n', '-a', path, '--args', '--office-run', runId.toLowerCase()];
  await opened(args, launcher);
  return true;
}
export async function openOfficeWindow({ runId, port = 4317, ...options }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !UUID.test(runId))
    throw Error('表示する依頼が不正です');
  const url = `http://127.0.0.1:${port}/?run=${encodeURIComponent(runId.toLowerCase())}#office`;
  if (port === 4317 && (await launchDesktop({ runId, ...options })))
    return { target: 'desktop', url };
  if ((options.platform || process.platform) === 'darwin') {
    await opened([url], options.launcher || spawn);
    return { target: 'browser', url };
  }
  return { target: 'url', url };
}
