import { createServer } from 'node:http';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  constants,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

const DEFAULT_WORKLOG_DIR = join(homedir(), 'Projects', '.ai-worklog');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
};

function inside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function checkRegularNoSymlinks(root, file) {
  if (!inside(root, file)) throw Error('配信範囲外のファイルです');
  const rel = relative(root, file);
  const parts = rel.split(sep);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    const info = lstatSync(current);
    if (info.isSymbolicLink()) throw Error('シンボリックリンクは配信できません');
  }
  if (!lstatSync(file).isFile()) throw Error('配信可能なファイルではありません');
  if (!inside(root, realpathSync.native(file))) throw Error('配信範囲外のファイルです');
}

function safePreviewPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\\') || decoded.includes('\0') || decoded.includes('//')) return null;
  const parts = decoded.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..' || part.startsWith('.'))) return null;
  if (parts.some((part) => part.toLowerCase().endsWith('.map'))) return null;
  if (parts.length === 0) return 'index.html';
  return parts.join('/');
}

function mimeFor(path) {
  const dot = path.lastIndexOf('.');
  return MIME[dot >= 0 ? path.slice(dot).toLowerCase() : ''] || 'application/octet-stream';
}

function previewHandler(dist, port) {
  return (request, response) => {
    const headers = {
      'Cache-Control': 'no-store, no-cache, max-age=0',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Security-Policy':
        "default-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; form-action 'self'; object-src 'none'; base-uri 'none'",
    };
    const send = (status, body = '') => {
      response.writeHead(status, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    if (request.headers.host !== `127.0.0.1:${port}`) return send(403, 'Forbidden');
    if (!['GET', 'HEAD'].includes(request.method)) return send(405, 'Method Not Allowed');
    let url;
    try {
      url = new URL(request.url, `http://127.0.0.1:${port}`);
    } catch {
      return send(400, 'Bad Request');
    }
    if (url.origin !== `http://127.0.0.1:${port}`) return send(403, 'Forbidden');
    const subpath = safePreviewPath(url.pathname);
    if (!subpath) return send(404, 'Not Found');
    const file = resolve(dist, subpath);
    if (!inside(dist, file)) return send(404, 'Not Found');
    let fd;
    try {
      checkRegularNoSymlinks(dist, file);
      fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw Error('配信可能なファイルではありません');
      const body = readFileSync(fd);
      response.writeHead(200, {
        ...headers,
        'Content-Type': mimeFor(file),
        'Content-Length': body.length,
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch {
      send(404, 'Not Found');
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
}

function jstParts(date = new Date()) {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, value]),
  );
  return {
    year: +values.year,
    month: +values.month,
    day: +values.day,
    hour: values.hour,
    minute: values.minute,
  };
}

function isoWeek(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const weekYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(weekYear, 0, 1));
  return `${weekYear}-${String(Math.ceil(((d - yearStart) / 86400000 + 1) / 7)).padStart(2, '0')}`;
}

function safeLabel(value) {
  return String(value || 'Global')
    .replace(/[\r\n<>]/g, ' ')
    .slice(0, 80);
}

function logEntry(run, marker, finished = false, originalTimestamp = null) {
  const { year, month, day, hour, minute } = jstParts();
  const timestamp =
    originalTimestamp ||
    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${hour}:${minute}`;
  const project = safeLabel(basename(resolve(run.workspace || '.')));
  const status = finished
    ? { completed: '達成', needs_attention: '未確認', failed: '未達', cancelled: '未確認' }[
        run.status
      ] || '未確認'
    : '未確認';
  const stage = safeLabel(run.stage || '未記録');
  const mode = ['economy', 'standard', 'careful'].includes(run.mode) ? run.mode : '未記録';
  return `<!-- ${marker} -->\n## ${timestamp} | Agent Office実行\n\n- プロジェクト: ${project}\n- ユーザー入力の要約: Agent Officeで${project}を対象とした依頼（本文は記録しない）\n- タスクの目標・ゴール: 選択した担当工程で依頼を進める\n- 完了条件: 各工程の判定と最終判定を確認する（依頼から整理）\n- AIの判断要約: ${finished ? '権限内の担当工程と確認結果に従って判定' : '担当工程を開始'}\n- AIの出力要約: ${finished ? `実行状態 ${safeLabel(run.status)}、最終工程 ${stage}` : `実行開始、モード ${mode}`}\n- ゴールの達成状況: ${status}\n- AIが出した案: 未記録\n- 採用しなかった案と理由: 未記録\n- 自分が修正・判断した点: 未記録\n- テスト結果: ${finished ? '個別工程の記録を参照。実サービス確認は未記録' : '未実施'}\n- GitHub PR・コミット: 未実施\n- 障害・不具合の原因: 未記録\n- 業務上の成果: ${finished ? `状態 ${safeLabel(run.status)}` : '未確認'}\n- 残課題: ${finished && run.status === 'completed' ? '該当なし' : '実行結果の確認'}\n<!-- /${marker} -->`;
}

function readExistingLog(path) {
  if (!existsSync(path)) return null;
  if (lstatSync(path).isSymbolicLink()) throw Error('作業ログはリンク先へ保存できません');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw Error('作業ログのファイルを確認できません');
    return { text: readFileSync(fd, 'utf8'), dev: stat.dev, ino: stat.ino };
  } finally {
    closeSync(fd);
  }
}

export class HostServices {
  constructor({ worklogDir = DEFAULT_WORKLOG_DIR, maxServers = 8 } = {}) {
    this.worklogDir = worklogDir;
    this.maxServers = Number.isInteger(maxServers) ? Math.max(1, Math.min(8, maxServers)) : 8;
    this.servers = new Map();
    this.runLogPaths = new Map();
    this.previewQueue = Promise.resolve();
  }

  logPath() {
    const { year, month, day } = jstParts();
    return join(this.worklogDir, `${isoWeek(year, month, day)}.md`);
  }

  writeLog(run, finished = false) {
    try {
      if (!/^[A-Za-z0-9-]{1,80}$/.test(String(run.id))) throw Error('実行IDを確認できません');
      if (!existsSync(this.worklogDir))
        mkdirSync(this.worklogDir, { recursive: true, mode: 0o700 });
      if (lstatSync(this.worklogDir).isSymbolicLink() || !lstatSync(this.worklogDir).isDirectory())
        throw Error('作業ログの保存先を確認できません');
      const path = this.runLogPaths.get(run.id) || this.logPath();
      const marker = `office-run:${run.id}`;
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = readExistingLog(path);
        const old = before?.text || '';
        const begin = `<!-- ${marker} -->`;
        const end = `<!-- /${marker} -->`;
        const start = old.indexOf(begin);
        let next;
        if (start >= 0) {
          if (!finished) {
            this.runLogPaths.set(run.id, path);
            return { status: 'saved', path };
          }
          const endAt = old.indexOf(end, start + begin.length);
          if (endAt < 0) throw Error('作業ログの記録境界を確認できません');
          const originalTimestamp =
            old
              .slice(start, endAt)
              .match(/^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) \| Agent Office実行/m)?.[1] || null;
          next =
            old.slice(0, start) +
            logEntry(run, marker, true, originalTimestamp) +
            old.slice(endAt + end.length);
        } else {
          next = `${old.trimEnd()}${old.trim() ? '\n\n' : ''}${logEntry(run, marker, finished)}\n`;
        }
        const temp = join(this.worklogDir, `.office-${randomUUID()}.tmp`);
        try {
          const fd = openSync(
            temp,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
            0o600,
          );
          try {
            writeFileSync(fd, next);
          } finally {
            closeSync(fd);
          }
          const current = readExistingLog(path);
          if (
            (before === null) !== (current === null) ||
            (before &&
              (before.dev !== current.dev ||
                before.ino !== current.ino ||
                before.text !== current.text))
          )
            continue;
          renameSync(temp, path);
          this.runLogPaths.set(run.id, path);
          return { status: 'saved', path };
        } finally {
          if (existsSync(temp)) unlinkSync(temp);
        }
      }
      return { status: 'failed', reason: '作業ログが同時に更新されたため保存できませんでした' };
    } catch {
      return { status: 'failed', reason: '作業ログを安全に保存できませんでした' };
    }
  }

  async preview(run) {
    const next = this.previewQueue.then(() => this.createPreview(run));
    this.previewQueue = next.catch(() => {});
    return next;
  }

  async createPreview(run) {
    let workspace, dist;
    try {
      workspace = realpathSync.native(run.workspace);
      dist = realpathSync.native(join(workspace, 'dist'));
      if (!inside(workspace, dist) || dist === workspace) throw Error('distが対象フォルダ外です');
      checkRegularNoSymlinks(dist, join(dist, 'index.html'));
    } catch {
      return { status: 'unavailable', reason: '確認できるdist/index.htmlがありません' };
    }
    const existing = this.servers.get(workspace);
    if (existing && existing.dist === dist) {
      this.servers.delete(workspace);
      this.servers.set(workspace, existing);
      return { status: 'ready', url: existing.url };
    }
    if (existing) await this.stop(workspace);
    while (this.servers.size >= this.maxServers) await this.stop(this.servers.keys().next().value);
    try {
      let port;
      const server = createServer((request, response) =>
        previewHandler(dist, port)(request, response),
      );
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      port = server.address().port;
      const url = `http://127.0.0.1:${port}/`;
      this.servers.set(workspace, { server, url, dist });
      return { status: 'ready', url };
    } catch {
      return { status: 'unavailable', reason: 'プレビューを起動できませんでした' };
    }
  }

  async stop(workspace) {
    const item = this.servers.get(workspace);
    if (!item) return;
    this.servers.delete(workspace);
    item.server.closeAllConnections();
    await new Promise((resolve) => item.server.close(resolve));
  }

  async prepare(run) {
    const worklog = this.writeLog(run);
    const preview = await this.preview(run);
    return { preview, worklog };
  }

  async finish(run) {
    return this.writeLog(run, true);
  }

  async close() {
    await this.previewQueue;
    for (const workspace of [...this.servers.keys()]) await this.stop(workspace);
  }
}

export function createHostServices(options) {
  return new HostServices(options);
}
