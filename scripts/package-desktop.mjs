import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readerSource = join(root, 'services', 'ai-reader');
if (
  !existsSync(join(readerSource, 'server.mjs')) ||
  !existsSync(join(readerSource, 'vendor', 'xmldom', 'package.json'))
)
  throw new Error(
    'AI情報リーダーが見つかりません。別リポジトリを services/ai-reader に配置してから梱包してください',
  );
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const buildRoot = join(root, '.desktop-build');
mkdirSync(buildRoot, { recursive: true });
const staging = mkdtempSync(join(buildRoot, 'package-'));
const app = join(staging, 'app'),
  backend = join(staging, 'backend');
mkdirSync(app, { recursive: true });
mkdirSync(backend, { recursive: true });
try {
  for (const file of [
    'public/index.html',
    'public/app.js',
    'public/styles.css',
    'public/theme-init.js',
  ])
    if (!existsSync(join(root, file))) throw new Error(`画面をビルドしてください：${file}`);
  mkdirSync(join(app, 'desktop', 'assets'), { recursive: true });
  for (const file of [
    'main.cjs',
    'navigation.cjs',
    'runtime.cjs',
    'entitlements.plist',
    'assets/AgentOffice.icns',
    'assets/trayTemplate.png',
    'assets/trayTemplate@2x.png',
  ])
    cpSync(join(root, 'desktop', file), join(app, 'desktop', file));
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify(
      {
        name: 'agent-office-desktop',
        productName: 'Agent Office',
        version: manifest.version,
        private: true,
        main: 'desktop/main.cjs',
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(app, 'desktop', 'config.json'),
    JSON.stringify({ sourceRoot: process.argv.includes('--local-source') ? root : null }, null, 2),
  );
  for (const file of readdirSync(root).filter(
    (file) => file.endsWith('.mjs') || file.endsWith('.schema.json'),
  ))
    cpSync(join(root, file), join(backend, file));
  mkdirSync(join(backend, 'lib'));
  for (const file of readdirSync(join(root, 'lib')).filter((file) => file.endsWith('.mjs')))
    cpSync(join(root, 'lib', file), join(backend, 'lib', file));
  const readerRoot = join(backend, 'services', 'ai-reader');
  mkdirSync(readerRoot, { recursive: true });
  for (const file of [
    'server.mjs',
    'reader.mjs',
    'discovery.mjs',
    'package.json',
    'package-lock.json',
    'AGENTS.md',
  ])
    cpSync(join(readerSource, file), join(readerRoot, file));
  mkdirSync(join(readerRoot, 'public'));
  for (const file of ['index.html', 'app.js', 'style.css'])
    cpSync(join(readerSource, 'public', file), join(readerRoot, 'public', file));
  mkdirSync(join(readerRoot, 'vendor', 'xmldom', 'lib'), { recursive: true });
  for (const file of ['LICENSE', 'package.json'])
    cpSync(
      join(readerSource, 'vendor', 'xmldom', file),
      join(readerRoot, 'vendor', 'xmldom', file),
    );
  for (const file of readdirSync(join(readerSource, 'vendor', 'xmldom', 'lib')).filter((file) =>
    file.endsWith('.js'),
  ))
    cpSync(
      join(readerSource, 'vendor', 'xmldom', 'lib', file),
      join(readerRoot, 'vendor', 'xmldom', 'lib', file),
    );
  const parserInstall = join(readerRoot, 'node_modules', '@xmldom', 'xmldom');
  mkdirSync(dirname(parserInstall), { recursive: true });
  cpSync(join(readerRoot, 'vendor', 'xmldom'), parserInstall, { recursive: true });
  mkdirSync(join(backend, 'public'));
  for (const file of [
    'index.html',
    'app.js',
    'styles.css',
    'theme-init.js',
    'roles.js',
    'avatars.js',
  ])
    cpSync(join(root, 'public', file), join(backend, 'public', file));
  // Never put the user's history, credentials or project catalog in a distributable.
  writeFileSync(
    join(backend, 'projects.json'),
    JSON.stringify({ syncedAt: null, source: 'Codex登録一覧は未接続です', projects: [] }),
  );
  writeFileSync(join(backend, 'codex-history.json'), JSON.stringify({ syncedAt: null, items: [] }));
  const result = await packager({
    dir: app,
    out: join(root, 'dist-desktop'),
    name: 'Agent Office',
    executableName: 'Agent Office',
    platform: 'darwin',
    arch: process.arch,
    electronVersion: manifest.devDependencies.electron,
    appBundleId: 'jp.agentoffice.local',
    appVersion: manifest.version,
    appCategoryType: 'public.app-category.developer-tools',
    icon: join(root, 'desktop', 'assets', 'AgentOffice.icns'),
    extraResource: [backend],
    overwrite: true,
    asar: false,
    prune: false,
    download: { cacheRoot: join(root, '.cache', 'electron') },
    osxSign: {
      identity: '-',
      identityValidation: false,
      hardenedRuntime: false,
      preEmbedProvisioningProfile: false,
      preAutoEntitlements: false,
      optionsForFile: () => ({
        entitlements: join(root, 'desktop', 'entitlements.plist'),
        hardenedRuntime: false,
      }),
    },
  });
  console.log(
    JSON.stringify(
      {
        app: join(result[0], 'Agent Office.app'),
        localSource: process.argv.includes('--local-source'),
        signedForDistribution: false,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(staging, { recursive: true, force: true });
}
