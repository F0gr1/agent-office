import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = join(
  root,
  'dist-desktop',
  `Agent Office-darwin-${process.arch}`,
  'Agent Office.app',
  'Contents',
  'MacOS',
  'Agent Office',
);
if (!existsSync(binary)) throw new Error('先に npm run desktop:build でアプリを作成してください。');
const stateFile = join(root, '.data', 'state.json');
const snapshot = () => {
  if (!existsSync(stateFile)) return null;
  const runs = JSON.parse(readFileSync(stateFile, 'utf8')).runs;
  return {
    count: runs.length,
    hash: createHash('sha256').update(JSON.stringify(runs)).digest('hex'),
  };
};
const before = snapshot();
const results = [];
for (let attempt = 1; attempt <= 3; attempt++) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(binary, ['--smoke-test'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '',
      err = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('起動確認の時間上限です。アプリの状態を確認してください。'));
    }, 60000);
    child.stdout.on('data', (data) => (out += data));
    child.stderr.on('data', (data) => (err += data));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      const line = out.split('\n').find((text) => text.startsWith('{"ready"'));
      if (code !== 0 || !line)
        reject(
          new Error(
            '起動確認に失敗しました。常駐中のアプリを終了してから再試行してください。 ' +
              err.slice(-300),
          ),
        );
      else resolve({ attempt, exit: code, ...JSON.parse(line) });
    });
  });
  results.push(result);
  console.log(JSON.stringify(result));
}
const after = snapshot();
const report = {
  at: new Date().toISOString(),
  results,
  before,
  after,
  historyUnchanged: JSON.stringify(before) === JSON.stringify(after),
  nativeVisualInspection: false,
  loginAtStartupTested: false,
};
mkdirSync(join(root, 'outputs', 'desktop-20261028'), { recursive: true });
writeFileSync(
  join(root, 'outputs', 'desktop-20261028', 'smoke-results.json'),
  JSON.stringify(report, null, 2),
);
if (!report.historyUnchanged)
  throw new Error('検証中に履歴が変化しました。既存の作業記録を確認してください。');
