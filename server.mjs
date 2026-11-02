import http from 'node:http';
import { SettingsStore } from './lib/settings.mjs';
import { discoverProviders, providerRunner } from './lib/providers.mjs';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createHostServices } from './lib/host-services.mjs';
import { aiReaderDataDir, createAiReaderService } from './lib/ai-reader-service.mjs';
import { Office, ContinuationError } from './orchestrator.mjs';
import { codexGlobal, projectHistory } from './lib/codex-context.mjs';
import { readProjects, resolveProjectInput, resolveMode, InputError } from './projects.mjs';
import { attachmentPreview, AttachmentError } from './lib/attachments.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4317);
const origin = `http://127.0.0.1:${port}`;
const token = randomBytes(32).toString('hex');
const workspaceRoot = process.env.OFFICE_WORKSPACE_DIR || join(here, 'workspace');
const projectsFile = join(here, 'projects.json');
const staticFiles = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/app.js', 'app.js'],
  ['/theme-init.js', 'theme-init.js'],
  ['/roles.js', 'roles.js'],
  ['/avatars.js', 'avatars.js'],
  ['/styles.css', 'styles.css'],
  ['/style.css', 'style.css'],
]);

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

mkdirSync(workspaceRoot, { recursive: true });
const hostServices = createHostServices();
const aiReaderService = createAiReaderService({
  root: here,
  dataDir: aiReaderDataDir(here),
});
const settingsStore = new SettingsStore({
  dataDir: process.env.OFFICE_DATA_DIR || join(here, '.data'),
});
let providers = await discoverProviders();
function runtimeSummary() {
  return {
    available: Object.values(providers).some((p) => p.available && p.authenticated !== false),
    version: 'Codex / Claude Code',
  };
}
const office = new Office({
  dataDir: process.env.OFFICE_DATA_DIR || join(here, '.data'),
  workspaceRoot,
  runtime: runtimeSummary(),
  runner: providerRunner(),
  getSettings: () => settingsStore.get(),
  hostServices,
});

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
}

function isLocalRequest(req) {
  const host = req.headers.host;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function isAllowedOrigin(req) {
  const allowed = [origin, `http://localhost:${port}`];
  return (
    (!req.headers.origin || allowed.includes(req.headers.origin)) &&
    req.headers['sec-fetch-site'] !== 'cross-site'
  );
}

function hasValidToken(req) {
  const received = Buffer.from(String(req.headers['x-office-token'] || ''));
  const expected = Buffer.from(token);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

async function readJsonBody(req, limit = 750000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw new RequestError(413, '送信内容が大きすぎます');
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new RequestError(400, '入力形式が不正です');
  }
}

function subscribeToEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (state) => res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
  send(office.state());
  office.listeners.add(send);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    office.listeners.delete(send);
  });
}

function startRun(body, res) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json(res, 400, { error: '入力形式が不正です' });
  }
  if (body.continueFromRunId !== undefined) {
    if (typeof body.continueFromRunId !== 'string' || !body.continueFromRunId)
      return json(res, 400, { error: '継続元の依頼IDが不正です' });
    const source = office.runs.find((run) => run.id === body.continueFromRunId);
    if (!source) return json(res, 404, { error: '継続元の依頼が見つかりません' });
    if (['running', 'queued'].includes(source.status))
      return json(res, 409, { error: '実行中の依頼は停止または完了後に継続してください' });
  }
  if (!office.runtime.available) {
    return json(res, 503, { error: '設定画面でCodexまたはClaude Codeの接続を確認してください' });
  }
  if (
    typeof body.instruction !== 'string' ||
    !body.instruction.trim() ||
    body.instruction.length > 20000
  ) {
    return json(res, 400, { error: '指示を1〜20,000文字で入力してください' });
  }
  if (office.state().activeRunId) {
    return json(res, 409, { error: '実行中の依頼を完了または停止してください' });
  }
  const source = office.runs.find((run) => run.id === body.continueFromRunId);
  const automatic = source ? source.selectionMode === 'auto' : body.specialists === undefined;
  const selected = source?.specialists || body.specialists || [];
  const optional = ['researcher', 'architect', 'designer', 'qa'];
  const needed = settingsStore
    .get()
    .agents.filter(
      (agent) =>
        agent.enabled &&
        (automatic
          ? agent.id === 'commander'
          : !optional.includes(agent.id) || selected.includes(agent.id)),
    );
  for (const agent of needed) {
    const connection = providers[agent.provider];
    if (!connection?.available || connection.authenticated === false)
      return json(res, 503, {
        error: `${agent.name}の${agent.provider === 'claude' ? 'Claude Code' : 'Codex'}が未接続です。設定画面で接続を確認してください。`,
      });
  }
  if (
    ((source?.attachments?.length || 0) > 0 || (body.attachments?.length || 0) > 0) &&
    needed.some((agent) => agent.provider !== 'codex')
  )
    return json(res, 400, {
      error:
        '画像・資料付き依頼は現在Codex接続で利用できます。設定画面で担当の接続先を確認してください。',
    });
  if (body.continueFromRunId !== undefined) {
    if (
      ['workspace', 'projectId', 'mode', 'specialists', 'kind'].some((key) =>
        Object.hasOwn(body, key),
      )
    )
      return json(res, 400, {
        error:
          '継続時は元の作業フォルダ・プロジェクト・進め方・専門担当の選択を引き継ぎます。選択項目は送信しないでください',
      });
    const run = office.start({
      instruction: body.instruction.trim(),
      continueFromRunId: body.continueFromRunId,
      attachments: body.attachments,
    });
    return json(res, 202, { id: run.id });
  }
  const selection = resolveProjectInput(body, readProjects(projectsFile));
  if (body.kind !== undefined && !['ordinary', 'project-setup'].includes(body.kind))
    throw new InputError('依頼の種類を選び直してください');
  const mode = resolveMode(body.mode);
  const run = office.start({
    kind: body.kind,
    instruction: body.instruction.trim(),
    ...selection,
    mode,
    requestContext: body.requestContext,
    attachments: body.attachments,
  });
  return json(res, 202, { id: run.id });
}

function serveStatic(pathname, res) {
  const filename = staticFiles.get(pathname);
  if (!filename) return json(res, 404, { error: '見つかりません' });
  const file = join(here, 'public', filename);
  if (!existsSync(file)) return json(res, 503, { error: '画面を準備しています' });
  const contentType = filename.endsWith('.js')
    ? 'text/javascript; charset=utf-8'
    : filename.endsWith('.css')
      ? 'text/css; charset=utf-8'
      : 'text/html; charset=utf-8';
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
  res.end(readFileSync(file));
}

const server = http.createServer(async (req, res) => {
  try {
    if (!isLocalRequest(req)) return json(res, 403, { error: 'このアプリはローカル専用です' });
    if (!isAllowedOrigin(req))
      return json(res, 403, { error: '別のサイトからの接続は許可されていません' });

    const url = new URL(req.url, origin);
    setSecurityHeaders(res);
    if (req.method === 'GET') {
      if (url.pathname === '/api/settings')
        return json(res, 200, { settings: settingsStore.get(), providers });
      if (url.pathname === '/api/projects') return json(res, 200, readProjects(projectsFile));
      if (url.pathname === '/api/codex/global') return json(res, 200, codexGlobal());
      if (url.pathname === '/api/codex/history') {
        const project = readProjects(projectsFile).projects.find(
          (item) => item.id === url.searchParams.get('projectId'),
        );
        return json(res, 200, projectHistory(join(here, 'codex-history.json'), project));
      }
      if (url.pathname === '/api/session') return json(res, 200, { token });
      if (url.pathname === '/api/services')
        return json(res, 200, {
          services: [
            {
              id: 'ai-reader',
              name: 'AI情報リーダー',
              purpose: 'AI関連記事を集めて読む',
              ...(await aiReaderService.inspect()),
            },
          ],
        });
      if (url.pathname === '/api/state') return json(res, 200, office.state());
      if (url.pathname === '/api/events') return subscribeToEvents(req, res);
      return serveStatic(url.pathname, res);
    }
    if (req.method !== 'POST') return json(res, 405, { error: '未対応の操作です' });
    if (!hasValidToken(req))
      return json(res, 403, { error: '画面を再読み込みしてから操作してください' });
    if (!String(req.headers['content-type']).includes('application/json')) {
      return json(res, 415, { error: 'JSONが必要です' });
    }

    const body = await readJsonBody(req, url.pathname === '/api/runs' ? 18 * 1024 * 1024 : 750000);
    const serviceAction = url.pathname.match(/^\/api\/services\/ai-reader\/(start|stop|restart)$/);
    if (serviceAction) {
      if (Object.keys(body).length) return json(res, 400, { error: '操作内容は指定できません' });
      return json(res, 200, { service: await aiReaderService.operate(serviceAction[1]) });
    }
    if (url.pathname === '/api/settings') {
      let settings;
      try {
        settings = settingsStore.save(body);
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
      office.persist();
      return json(res, 200, { settings });
    }
    if (url.pathname === '/api/providers/check') {
      providers = await discoverProviders();
      office.runtime = runtimeSummary();
      office.persist();
      return json(res, 200, { providers });
    }
    if (url.pathname === '/api/runs') return startRun(body, res);
    if (url.pathname === '/api/attachments/preview') {
      const run = office.runs.find((item) => item.id === body.runId);
      const attachment = run?.attachments?.find((item) => item.id === body.attachmentId);
      if (!attachment) return json(res, 404, { error: 'この依頼の添付が見つかりません' });
      return json(res, 200, attachmentPreview(office.dataDir, attachment));
    }
    const acceptance = url.pathname.match(/^\/api\/runs\/([a-f0-9-]+)\/accept$/);
    if (acceptance) return json(res, 200, { acceptance: office.accept(acceptance[1]) });
    const cancel = url.pathname.match(/^\/api\/runs\/([a-f0-9-]+)\/cancel$/);
    const environment = url.pathname.match(/^\/api\/runs\/([a-f0-9-]+)\/environment$/);
    if (environment) {
      const run = office.runs.find((item) => item.id === environment[1]);
      if (!run) return json(res, 404, { error: '依頼が見つかりません' });
      if (office.state().activeRunId)
        return json(res, 409, { error: '実行中は各工程で自動準備します。' });
      await office.prepareEnvironment(run);
      if (run.environment?.worklog?.status === 'saved') {
        run.environment.worklog = await hostServices.finish(run);
        office.persist();
      }
      return json(res, 200, run.environment);
    }
    if (cancel) {
      return json(res, office.cancel(cancel[1]) ? 200 : 404, { message: '停止を要求しました' });
    }
    return json(res, 405, { error: '未対応の操作です' });
  } catch (error) {
    const status =
      error instanceof RequestError ||
      error instanceof ContinuationError ||
      error instanceof AttachmentError
        ? error.status
        : error instanceof InputError
          ? 400
          : Number.isInteger(error.status) && [400, 404, 409, 413].includes(error.status)
            ? error.status
            : 500;
    json(res, status, { error: error.message });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Agent Office: ${origin}\nCodex: ${office.runtime.version}`);
});
server.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});

function shutdown() {
  aiReaderService.shutdown();
  for (const id of office.controllers.keys()) office.cancel(id);
  server.close();
  void hostServices.close();
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
