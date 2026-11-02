import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { launchDesktop } from './office-window.mjs';
import { assertOfficeIntake } from './office-boundary.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export function localOrigin(port = 4317) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('ポートが不正です');
  return `http://127.0.0.1:${port}`;
}
export async function readOffice(origin, fetcher = fetch) {
  const response = await fetcher(`${origin}/api/state`, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw Error('Agent Officeに接続できません');
  const state = await response.json();
  if (!state.capabilities?.automaticDispatch)
    throw Error('Agent Officeを更新して再起動してください');
  return state;
}
export async function ensureOffice(
  port,
  { fetcher = fetch, launch, wait = delay, preferDesktop = true } = {},
) {
  const origin = localOrigin(port);
  try {
    await readOffice(origin, fetcher);
    return origin;
  } catch (error) {
    if (error.message.includes('再起動')) throw error;
  }
  if (launch) await launch();
  else if (!(preferDesktop && port === 4317 && (await launchDesktop()))) {
    const child = spawn(process.execPath, [join(root, 'server.mjs')], {
      cwd: root,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, PORT: String(port) },
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
  }
  for (let attempt = 0; attempt < 60; attempt++) {
    await wait(500);
    try {
      await readOffice(origin, fetcher);
      return origin;
    } catch (error) {
      if (error.message.includes('再起動')) throw error;
    }
  }
  throw Error(
    'Agent Officeの起動を確認できませんでした。start.commandで起動状態を確認してください',
  );
}
export async function submitToOffice(origin, body, fetcher = fetch) {
  assertOfficeIntake();
  // Read capability before obtaining the local CSRF token. Never persist or print it.
  const state = await readOffice(origin, fetcher);
  if (body.kind === 'project-setup' && !state.capabilities.projectSetup)
    throw Error('新規プロジェクトの準備を使うにはAgent Officeを更新して再起動してください');
  const session = await fetcher(`${origin}/api/session`, { signal: AbortSignal.timeout(3000) });
  if (!session.ok) throw Error('Agent Officeの接続を確認してください');
  const { token } = await session.json();
  const response = await fetcher(`${origin}/api/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Office-Token': token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || '依頼を開始できませんでした');
  if (typeof result.id !== 'string' || !/^[a-f0-9-]+$/.test(result.id))
    throw Error('依頼IDを確認できません');
  return { id: result.id, url: `${origin}/?run=${encodeURIComponent(result.id)}` };
}
