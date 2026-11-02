const { app, BrowserWindow, dialog, Menu, nativeImage, session, shell, Tray } = require('electron');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');
const { ensureServer } = require('./runtime.cjs');
const {
  isAppUrl,
  isSafeExternalUrl,
  officeRunFromArgs,
  officeRunUrl,
  isOfficeRunOpen,
} = require('./navigation.cjs');

const APP_NAME = 'Agent Office';
const PORT = 4317;
const SMOKE_TEST = process.argv.includes('--smoke-test');

app.setName(APP_NAME);

let window = null;
let tray = null;
let server = null;
let origin = null;
let quitting = false;
let quitInProgress = false;
let pageReady = false;
let navigationBusy = false;
let pendingRunId = officeRunFromArgs(process.argv);

function isBackendRoot(root) {
  return (
    typeof root === 'string' &&
    path.isAbsolute(root) &&
    existsSync(path.join(root, 'server.mjs')) &&
    existsSync(path.join(root, 'public', 'index.html'))
  );
}

function backendLocation() {
  const bundledRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'backend')
    : path.resolve(__dirname, '..');
  let sourceRoot;
  try {
    sourceRoot = JSON.parse(readFileSync(path.join(__dirname, 'config.json'), 'utf8')).sourceRoot;
  } catch {
    // A package still works when the development checkout is unavailable.
  }
  if (isBackendRoot(sourceRoot)) return { root: sourceRoot, preferred: true };
  if (isBackendRoot(bundledRoot)) return { root: bundledRoot, preferred: false };
  throw new Error('アプリの画面とサーバーが見つかりません。アプリを再配置してください。');
}

function showWindow() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  app.focus({ steal: true });
}

async function drainRunSelection() {
  if (!pageReady || navigationBusy || !origin || !window || window.isDestroyed()) return;
  navigationBusy = true;
  try {
    while (pendingRunId) {
      const runId = pendingRunId;
      pendingRunId = null;
      if (isOfficeRunOpen(window.webContents.getURL(), origin, runId)) continue;
      await window.loadURL(officeRunUrl(origin, runId));
    }
  } catch (error) {
    dialog.showErrorBox('実行結果を開けませんでした', error.message);
  } finally {
    navigationBusy = false;
    if (pendingRunId) void drainRunSelection();
  }
}

function selectRun(runId) {
  pendingRunId = runId;
  showWindow();
  void drainRunSelection();
}

function openExternal(url) {
  if (!isSafeExternalUrl(url)) return;
  void shell.openExternal(url).catch((error) => {
    dialog.showErrorBox('リンクを開けませんでした', error.message);
  });
}

function loginItemEnabled() {
  if (process.platform !== 'darwin' || !app.isPackaged) return false;
  const settings = app.getLoginItemSettings();
  return settings.openAtLogin && settings.status === 'enabled';
}

function toggleLoginItem() {
  const target = !loginItemEnabled();
  try {
    app.setLoginItemSettings({ openAtLogin: target });
    const actual = app.getLoginItemSettings();
    const succeeded = target
      ? actual.openAtLogin && actual.status === 'enabled'
      : !actual.openAtLogin && ['not-registered', 'not-found'].includes(actual.status);
    if (!succeeded) {
      dialog.showMessageBoxSync({
        type: 'warning',
        title: 'ログイン時の起動を確認できません',
        message: 'macOS のログイン項目で Agent Office の状態を確認してください。',
        detail:
          '署名・公証されていないアプリでは設定が反映されないことがあります。現在の状態: ' +
          (actual.status || '不明'),
        buttons: ['OK'],
      });
    }
  } catch (error) {
    dialog.showErrorBox('ログイン時の起動を設定できませんでした', error.message);
  }
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Agent Office を開く', click: showWindow },
      { label: 'ブラウザーで開く', enabled: Boolean(origin), click: () => openExternal(origin) },
      { label: '閉じてもバックグラウンドで動作', enabled: false },
      { type: 'separator' },
      {
        label: app.isPackaged ? 'ログイン時に起動' : 'ログイン時に起動（アプリ版のみ）',
        type: 'checkbox',
        checked: loginItemEnabled(),
        enabled: process.platform === 'darwin' && app.isPackaged,
        click: toggleLoginItem,
      },
      { type: 'separator' },
      { label: 'Agent Office を終了', click: () => void requestQuit() },
    ]),
  );
}

function createTray() {
  let icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
  if (icon.isEmpty()) icon = nativeImage.createFromNamedImage('square.grid.2x2');
  if (icon.isEmpty()) icon = nativeImage.createFromNamedImage('NSApplicationIcon');
  if (icon.isEmpty()) throw new Error('メニューバーのアイコンを作成できませんでした。');
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);
  tray.on('click', showWindow);
  refreshTrayMenu();
}

function protectWindow(contents) {
  contents.on('will-navigate', (event, url) => {
    if (!origin || !isAppUrl(url, origin)) event.preventDefault();
  });
  contents.on('will-redirect', (event, url) => {
    if (!origin || !isAppUrl(url, origin)) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) setImmediate(() => openExternal(url));
    return { action: 'deny' };
  });
}

async function createWindow() {
  window = new BrowserWindow({
    title: APP_NAME,
    width: 1450,
    height: 940,
    minWidth: 920,
    minHeight: 680,
    show: !SMOKE_TEST,
    backgroundColor: '#f7f5ed',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });
  protectWindow(window.webContents);
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on('closed', () => {
    window = null;
  });
  if (!SMOKE_TEST) {
    const html =
      '<!doctype html><html lang="ja"><meta charset="utf-8"><title>Agent Office</title>' +
      '<body style="font:16px system-ui;background:#f7f5ed;color:#30343a;' +
      'display:grid;place-items:center;min-height:90vh">Agent Office を起動しています…</body></html>';
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  }
}

async function activeRunCount() {
  if (!origin) return 0;
  const response = await fetch(`${origin}/api/state`, {
    signal: AbortSignal.timeout(3000),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`作業状態を確認できません (${response.status})`);
  const state = await response.json();
  return Array.isArray(state.runs)
    ? state.runs.filter((run) => ['running', 'queued'].includes(run.status)).length
    : Number(Boolean(state.activeRunId));
}

async function requestQuit() {
  if (quitInProgress || quitting) return;
  quitInProgress = true;
  try {
    let force = false;
    if (server?.owned) {
      let count = 0;
      try {
        count = await activeRunCount();
      } catch {
        // stop() determines whether the owned process has already exited.
      }
      if (count > 0) {
        if (SMOKE_TEST)
          throw new Error('作業中のため起動検証では停止しません。サーバーと作業を残しています。');
        const choice = dialog.showMessageBoxSync({
          type: 'warning',
          title: '実行中の作業があります',
          message: `${count} 件の作業が進行中です。終了すると中断されます。`,
          buttons: ['作業を続ける', '中断して終了'],
          defaultId: 0,
          cancelId: 0,
        });
        if (choice !== 1) return;
        force = true;
      }
      await server.stop(force ? { force: true } : undefined);
    }
    quitting = true;
    app.quit();
  } catch (error) {
    if (SMOKE_TEST) {
      process.stderr.write(`Agent Office smoke test: ${error.message}\n`);
      app.exit(1);
    } else {
      dialog.showErrorBox('Agent Office を終了できませんでした', error.message);
    }
  } finally {
    quitInProgress = false;
  }
}

app.on('before-quit', (event) => {
  if (!quitting) {
    event.preventDefault();
    void requestQuit();
  }
});
app.on('window-all-closed', () => {});
app.on('activate', showWindow);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const runId = officeRunFromArgs(argv);
    if (runId) selectRun(runId);
    else showWindow();
  });
  app.whenReady().then(async () => {
    try {
      session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
        const ownPage = origin && isAppUrl(contents.getURL(), origin);
        callback(Boolean(ownPage && permission === 'clipboard-sanitized-write'));
      });
      await createWindow();
      if (!SMOKE_TEST) createTray();
      const { root, preferred } = backendLocation();
      const userData = app.getPath('userData');
      const env = {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ...(preferred ? {} : { OFFICE_WORKSPACE_DIR: path.join(userData, 'workspace') }),
      };
      server = await ensureServer({
        root,
        nodePath: process.execPath,
        env,
        port: PORT,
        dataDir: preferred ? path.join(root, '.data') : path.join(userData, 'data'),
      });
      origin = server.origin;
      refreshTrayMenu();
      const initialRunId = pendingRunId;
      pendingRunId = null;
      await window.loadURL(initialRunId ? officeRunUrl(origin, initialRunId) : origin);
      pageReady = true;
      void drainRunSelection();
      if (SMOKE_TEST) {
        window.close();
        if (window.isDestroyed()) throw new Error('ウィンドウを閉じたときにアプリが終了しました。');
        const response = await fetch(`${origin}/api/state`, { signal: AbortSignal.timeout(3000) });
        if (!response.ok) throw new Error('ウィンドウを閉じた後のサーバーを確認できません。');
        process.stdout.write(
          JSON.stringify({
            ready: true,
            origin,
            owned: server.owned,
            preferredRoot: preferred,
            closeKeepsServer: true,
            selectedUrl: window.webContents.getURL(),
          }) + '\n',
        );
        await requestQuit();
      }
    } catch (error) {
      if (server?.owned) {
        try {
          await server.stop();
        } catch {
          // Keep a running task alive if the server refuses a normal stop.
        }
      }
      if (SMOKE_TEST) {
        process.stderr.write(`Agent Office smoke test: ${error.message}\n`);
        app.exit(1);
        return;
      }
      dialog.showErrorBox('Agent Office を起動できませんでした', error.message);
      quitting = true;
      app.quit();
    }
  });
}
