import { mountSettings } from './settings.js';
import { createOfficeScene } from './office-scene.js';
import { speechFor } from './speech.js';
import { escalationView } from './escalation.js';
import { workflowView, resultEntries } from './workflow.js';
import { progressView } from './progress.js';
import { roleOrder as baseRoleOrder, optionalRoles, roleDefaults } from './roles.js';
import { avatars } from './avatars.js';
import { createExperience, displayRunStatus, stoppingView } from './experience.js';
import { verificationGroups } from './verification.js';
import { projectSetupInstruction } from './project-setup.js';

// DOM references and local UI state.
const $ = (id) => document.getElementById(id);
const ui = {
  rooms: $('agent-rooms'),
  detail: $('agent-detail'),
  history: $('run-history'),
  historyCount: $('history-count'),
  runSummary: $('current-run-summary'),
  results: $('run-results'),
  activity: $('activity-list'),
  activityRunLabel: $('activity-run-label'),
  runStatus: $('run-status-pill'),
  cancel: $('cancel-run'),
  form: $('task-form'),
  taskKind: $('task-kind'),
  instruction: $('task-instruction'),
  workspace: $('task-workspace'),
  project: $('task-project'),
  projectPath: $('project-path'),
  projectSource: $('project-source'),
  refreshProjects: $('refresh-projects'),
  mode: $('task-mode'),
  submit: $('submit-task'),
  formMessage: $('form-message'),
  connectionDot: $('connection-dot'),
  connectionLabel: $('connection-label'),
  floorLiveStatus: $('floor-live-status'),
  motionToggle: $('motion-toggle'),
  themeToggle: $('theme-toggle'),
};
let state = {
  runs: [],
  roles: [],
  activeRunId: null,
  runtime: { available: false },
  workspaceRoot: '',
};
let roleOrder = [...baseRoleOrder];
let sceneSignature = '';
let renderMode = 'auto';
let showingCurrentTeam = false;
const linkedRunId = new URLSearchParams(window.location.search).get('run');
let selectedRunId = linkedRunId;
let selectedRoleId = 'commander';
let manuallySelectedRun = Boolean(linkedRunId);
let requestInFlight = false;
let submitting = false;
let cancelling = false;
const stoppingRuns = new Set();
let followupSubmitting = false;
let followupSourceId = null;
const followupDrafts = new Map();
const followupAttachmentDrafts = new Map();
let token = null;
let workspaceEdited = false;
let connected = false;
let formMessageSource = 'default';
let projects = [];
const roomNodes = new Map();
let officeScene = null;
let experience = null;
let approvedRequest = null;
const attachmentDrafts = { task: [], followup: [] };
const attachmentLoading = { task: 0, followup: 0 };
let projectHistoryItems = [];
let historyGeneration = 0;
const rendered = { detail: '', history: '', run: '', activity: '', results: '' };
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
let motionPreference = 'on';
try {
  motionPreference = localStorage.getItem('agent-office-motion') === 'off' ? 'off' : 'on';
} catch {
  /* Private storage may be unavailable. */
}
ui.renderMode = $('office-render-mode');
ui.renderMode.addEventListener('change', () => {
  renderMode = ui.renderMode.value;
  renderOfficeScene();
});
function updateThemeToggle() {
  const dark = document.documentElement.dataset.theme === 'dark';
  ui.themeToggle.setAttribute('aria-pressed', String(dark));
  ui.themeToggle.textContent = dark ? '☾ ダークモード: オン' : '☾ ダークモード: オフ';
  document.querySelector('meta[name="theme-color"]').content = dark ? '#171e1a' : '#f7f5ed';
}
updateThemeToggle();
ui.themeToggle.addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme !== 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  try {
    localStorage.setItem('agent-office-theme', dark ? 'dark' : 'light');
  } catch {
    /* The toggle still works this session. */
  }
  updateThemeToggle();
});

const dateFormatter = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  month: 'long',
  day: 'numeric',
  weekday: 'short',
});
const timeFormatter = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  hour: '2-digit',
  minute: '2-digit',
});
$('today-label').textContent = dateFormatter.format(new Date());
ui.workspace.addEventListener('input', () => {
  workspaceEdited = true;
});
ui.project.addEventListener('change', syncProjectChoice);
let ordinaryProjectChoice = null;
ui.taskKind.addEventListener('change', () => {
  const setup = ui.taskKind.value === 'project-setup';
  $('project-setup-fields').hidden = !setup;
  document.querySelector('label[for="task-instruction"]').textContent = setup
    ? '補足すること（任意）'
    : '何をしてほしいですか？';
  ui.instruction.required = !setup;
  if (setup && ui.project.value === '') {
    ordinaryProjectChoice = { project: ui.project.value, workspace: ui.workspace.value };
    ui.project.value = '__custom';
    syncProjectChoice();
  } else if (!setup && ordinaryProjectChoice) {
    if (ui.project.value === '__custom' && !ui.workspace.value.trim()) {
      ui.project.value = ordinaryProjectChoice.project;
      syncProjectChoice();
      ui.workspace.value = ordinaryProjectChoice.workspace;
    }
    ordinaryProjectChoice = null;
  }
});
ui.refreshProjects.addEventListener('click', loadProjects);
ui.motionToggle.addEventListener('click', () => {
  motionPreference = motionPreference === 'off' ? 'on' : 'off';
  try {
    localStorage.setItem('agent-office-motion', motionPreference);
  } catch {
    /* The toggle still works this session. */
  }
  updateMotionSetting();
});
reducedMotion?.addEventListener?.('change', updateMotionSetting);

function updateMotionSetting() {
  const systemReduced = Boolean(reducedMotion?.matches);
  document.documentElement.dataset.motion =
    motionPreference === 'off' || systemReduced ? 'off' : 'on';
  renderOfficeScene();
  ui.motionToggle.disabled = systemReduced;
  ui.motionToggle.setAttribute('aria-pressed', String(motionPreference === 'off' || systemReduced));
  ui.motionToggle.textContent = systemReduced
    ? 'OS設定で動きを停止中'
    : motionPreference === 'off'
      ? '動きを再開'
      : '動きを止める';
}

// Normalize server data before displaying it.
function text(tag, value, className) {
  const node = document.createElement(tag);
  node.textContent = value == null ? '' : String(value);
  if (className) node.className = className;
  return node;
}
function role(id) {
  const fallback = roleDefaults[id] || roleDefaults.commander;
  const fromApi =
    (selectedRun()?.roles || (Array.isArray(state.roles) ? state.roles : [])).find(
      (item) => item && item.id === id,
    ) || {};
  return { ...fallback, ...fromApi, id };
}
function runs() {
  return (Array.isArray(state.runs) ? state.runs : [])
    .filter(Boolean)
    .slice()
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}
function selectedRun() {
  if (showingCurrentTeam) return null;
  return runs().find((item) => item.id === selectedRunId) || null;
}
function agent(run, id) {
  return (run && run.agents && run.agents[id]) || null;
}
function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}
function displayDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? timeFormatter.format(date) : '—';
}
function statusText(value) {
  return (
    {
      queued: '開始待ち',
      running: '作業中',
      completed: 'AI確認完了',
      failed: 'エラー',
      cancelled: '中止',
      needs_attention: '確認が必要',
      idle: '待機中',
      working: '作業中',
      done: '工程完了',
      stopping: '停止要求中',
      blocked: '確認が必要',
      skipped: '今回は参加なし',
      legacy: 'この依頼には未参加',
      unknown: '状況を確認中',
      stopped: '作業停止',
    }[value] || '待機中'
  );
}
function agentStatus(run, id) {
  if (!run) return 'idle';
  if (id === 'commander' && escalationView(run)?.waiting && run.status !== 'cancelled')
    return connected ? 'blocked' : 'unknown';
  const current = agent(run, id);
  if (current?.status === 'skipped') return 'skipped';
  if (run.selectionMode === 'auto' && id !== 'commander' && run.dispatch?.assignments) {
    if (!run.dispatch.assignments.some((item) => item?.roleId === id)) return 'skipped';
  }
  if (optionalRoles.has(id) && !current) {
    if (!Array.isArray(run.specialists)) return 'legacy';
    if (!run.specialists.includes(id)) return 'skipped';
  }
  if (current?.status === 'working') {
    if (stoppingRuns.has(run.id) && ['running', 'queued'].includes(run.status)) return 'stopping';
    if (!connected || state.runtime?.available === false) return 'unknown';
    if (run.status !== 'running') return 'stopped';
  }
  return current?.status || 'idle';
}
function safeOutput(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
function latestTask(run, id) {
  return resultEntries(run)
    .filter((task) => task.roleId === id)
    .at(-1);
}
function latestAgentEvent(run, id) {
  const events = Array.isArray(run?.events) ? run.events : [];
  return events
    .slice()
    .reverse()
    .find((event) => event && event.role === id && clean(event.message));
}
function projectLabel(id) {
  if (!clean(id)) return '';
  if (id === '__custom') return '別のフォルダ';
  return clean(projects.find((project) => project.id === id)?.label);
}
function runProjectLabel(run) {
  const named = clean(run.projectLabel) || clean(run.project?.label) || projectLabel(run.projectId);
  if (named) return named;
  return clean(run.workspace) && clean(run.workspace) === clean(state.workspaceRoot)
    ? 'この作業室の専用フォルダ'
    : '別のフォルダ';
}
function syncProjectChoice() {
  const id = ui.project.value;
  const selected = projects.find((project) => project.id === id);
  ui.workspace.readOnly = id !== '__custom';
  if (id === '__custom') {
    ui.workspace.value = '';
    ui.workspace.placeholder = '/absolute/path/to/project';
    ui.projectPath.textContent = 'ローカルの絶対パスを入力してください。';
    workspaceEdited = true;
  } else {
    ui.workspace.value = selected ? selected.path : clean(state.workspaceRoot);
    ui.projectPath.textContent = selected
      ? `選択中：${selected.label} · ${selected.path}`
      : `専用フォルダ：${ui.workspace.value || '読み込み中'}`;
    workspaceEdited = Boolean(selected);
  }
  loadProjectHistory();
}
async function loadProjectHistory() {
  const generation = ++historyGeneration;
  const host = $('project-history');
  projectHistoryItems = [];
  host.replaceChildren(text('p', '関連履歴を確認しています…'));
  if (!ui.project.value || ui.project.value === '__custom') {
    host.replaceChildren(
      text('p', 'Codex登録プロジェクトを選ぶと、取得済みの履歴候補を表示します。'),
    );
    return;
  }
  try {
    const response = await fetch(
      `/api/codex/history?projectId=${encodeURIComponent(ui.project.value)}`,
      { cache: 'no-store' },
    );
    if (!response.ok) throw Error();
    const data = await response.json();
    if (generation !== historyGeneration) return;
    projectHistoryItems = Array.isArray(data.items) ? data.items : [];
    host.replaceChildren(text('h3', 'Codexの関連履歴'));
    if (!projectHistoryItems.length)
      host.append(
        text('p', '取得済みの履歴候補はありません。履歴が存在しないという意味ではありません。'),
      );
    for (const item of projectHistoryItems) {
      const details = text('details');
      details.append(text('summary', item.title));
      details.append(
        text(
          'p',
          item.match === 'project'
            ? 'Codex登録上の所属が一致しています。'
            : '登録上の所属は一致していません。作業フォルダー一致で見つかった候補です。',
        ),
      );
      details.append(text('p', `履歴ID：${item.id}`));
      const label = text('label', null, 'history-include');
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.dataset.historyId = item.id;
      label.append(
        check,
        document.createTextNode('タイトル・ID・フォルダーを今回の依頼に添付する'),
      );
      details.append(label, text('p', '会話本文は未取得です。過去の指示を自動で再実行しません。'));
      host.append(details);
    }
    host.append(
      text(
        'small',
        `${data.source || '取得時点の参照情報'} · ${data.syncedAt ? new Date(data.syncedAt).toLocaleString('ja-JP') : '取得日時なし'}。再読み込みは保存済み情報の取得です。`,
      ),
    );
  } catch {
    if (generation === historyGeneration)
      host.replaceChildren(
        text('p', '履歴候補を取得できませんでした。履歴を添付せず依頼できます。'),
      );
  }
}
async function loadProjects() {
  ui.refreshProjects.disabled = true;
  ui.projectSource.textContent = '保存済み一覧を読み込み中…';
  try {
    const response = await fetch('/api/projects', { cache: 'no-store' });
    if (!response.ok) throw new Error(`一覧を取得できませんでした (${response.status})`);
    const data = await response.json();
    if (!Array.isArray(data.projects)) throw new Error('一覧の形式が正しくありません。');
    const selectedId = ui.project.value;
    projects = data.projects.filter(
      (project) =>
        project &&
        typeof project.id === 'string' &&
        typeof project.label === 'string' &&
        typeof project.path === 'string',
    );
    const options = [
      new Option('この作業室の専用フォルダ', ''),
      ...projects.map((project) => {
        const option = new Option(
          `${project.label}${project.available === false ? '（現在利用不可）' : ''}`,
          project.id,
        );
        option.disabled = project.available === false;
        return option;
      }),
      new Option('別のフォルダを指定', '__custom'),
    ];
    ui.project.replaceChildren(...options);
    ui.project.value = options.some((option) => option.value === selectedId && !option.disabled)
      ? selectedId
      : '';
    if (ui.project.value !== '__custom') syncProjectChoice();
    const date = new Date(data.syncedAt);
    const stamp = Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat('ja-JP', {
          timeZone: 'Asia/Tokyo',
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(date)
      : '日時不明';
    ui.projectSource.textContent = `${clean(data.source) || 'Codex登録プロジェクトの取得時点の一覧'} · 登録一覧の取得日時 ${stamp}。再読み込みは保存済み一覧の取得です。`;
    renderHistory();
    renderRun();
  } catch (error) {
    ui.projectSource.textContent = `保存済み一覧を取得できませんでした。${error.message || ''} 専用フォルダや別のフォルダは選べます。`;
  } finally {
    ui.refreshProjects.disabled = false;
  }
}
function agentMessage(run, id) {
  const consultation = escalationView(run);
  if (id === 'commander' && consultation?.waiting && run.status !== 'cancelled' && connected)
    return consultation.summary || consultation.reason;
  const status = agentStatus(run, id);
  if (status === 'unknown') return '接続が確認できないため、現在の作業状況は不明です。';
  if (status === 'stopping') return '停止を要求しました。処理の終了はまだ確認できていません。';
  if (status === 'stopped')
    return 'この依頼は実行中ではありません。前回の作業内容は記録をご覧ください。';
  const info = agent(run, id);
  if (status === 'working') return progressView(info).message;
  const summary = clean(info?.summary);
  if (summary) return summary;
  const invocationSummary = clean(latestTask(run, id)?.result?.summary);
  if (invocationSummary) return invocationSummary;
  const event = latestAgentEvent(run, id);
  if (event) return clean(event.message);
  if (status === 'working') return '依頼に取り組んでいます。';
  if (status === 'blocked') return '確認が必要です。作業ログをご覧ください。';
  if (status === 'done') return '担当の作業が完了しました。';
  if (status === 'skipped') return '今回は参加していません。';
  if (status === 'legacy') return 'この依頼には未参加です。';
  return run ? '担当の順番を待っています。' : '次の依頼を待っています。';
}
function setConnection(online) {
  const ready = online && state.runtime?.available !== false;
  ui.connectionDot.className = `connection-dot ${ready ? 'online' : 'offline'}`;
  ui.connectionLabel.textContent = !online
    ? '接続できません'
    : ready
      ? 'ローカルに接続中'
      : '実行環境を確認してください';
}

function liveWorkingRoles(run) {
  if (!connected || state.runtime?.available === false || run?.status !== 'running') return [];
  return roleOrder.filter((id) => agentStatus(run, id) === 'working');
}

function renderFloorStatus() {
  const run = selectedRun();
  const working = liveWorkingRoles(run);
  ui.floorLiveStatus.classList.toggle('is-working', working.length > 0);
  if (!connected)
    ui.floorLiveStatus.textContent = '接続が確認できないため、現在の作業状況は不明です。';
  else if (state.runtime?.available === false)
    ui.floorLiveStatus.textContent = '実行環境に接続できません。現在の作業状況を確認できません。';
  else if (stoppingRuns.has(run?.id) && ['running', 'queued'].includes(run?.status))
    ui.floorLiveStatus.textContent = '停止を要求しました。作業の終了はまだ確認できていません。';
  else if (working.length)
    ui.floorLiveStatus.textContent = `いま作業中：${working.map((id) => role(id).name).join('・')}`;
  else if (run?.status === 'running')
    ui.floorLiveStatus.textContent = '依頼は実行中です。担当の更新を待っています。';
  else if (run)
    ui.floorLiveStatus.textContent = `選択中の依頼：${statusText(run.status)}。作業中の担当はいません。`;
  else ui.floorLiveStatus.textContent = '依頼を待っています。作業中の担当はいません。';
}

// Create each room once so polling never restarts its animation or steals focus.
function createRoom(id, index) {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.role = id;
  button.className = 'agent-room';
  const accent = text('span', '', 'room-accent');
  accent.setAttribute('aria-hidden', 'true');
  const copy = text('div', '', 'room-copy');
  const label = text('div', '', 'room-label');
  label.append(
    text('span', String(index + 1)),
    document.createTextNode(` ROOM ${String(index + 1).padStart(2, '0')}`),
  );
  const name = text('h3', '', 'room-name');
  const title = text('p', '', 'room-title');
  const current = text('p', '', 'room-current');
  const bubble = text('div', '', 'room-speech');
  const status = text('div', '', 'room-agent-status');
  status.append(text('span', '', 'agent-dot'), text('span', '', 'status-label'));
  copy.append(label, name, title, current, bubble, status);
  const art = text('div', '', 'room-art');
  const scene = text('span', '', 'room-scene');
  scene.setAttribute('aria-hidden', 'true');
  scene.append(
    text('span', '', 'scene-window'),
    text('span', '', 'scene-desk'),
    text('span', '', 'scene-screen'),
    text('span', '', 'scene-plant'),
  );
  const avatar = text('span', '', 'room-avatar');
  const keyboard = text('span', '', 'work-keyboard');
  const leftHand = text('span', '', 'work-hand left');
  const rightHand = text('span', '', 'work-hand right');
  const signal = text('span', '', 'work-signal');
  signal.append(text('i'), text('i'), text('i'));
  art.append(scene, avatar, keyboard, leftHand, rightHand, signal);
  button.append(accent, copy, art);
  button.addEventListener('click', () => {
    selectedRoleId = id;
    experience?.navigate('work');
    renderRooms();
    renderOfficeScene();
    renderDetail();
    renderResults();
    if (window.innerWidth <= 1050) ui.detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  return button;
}

function renderRooms() {
  const run = selectedRun();
  for (const [id, button] of roomNodes) {
    if (!roleOrder.includes(id)) {
      button.remove();
      roomNodes.delete(id);
    }
  }
  roleOrder.forEach((id, index) => {
    let button = roomNodes.get(id);
    if (!button) {
      button = createRoom(id, index);
      roomNodes.set(id, button);
      ui.rooms.append(button);
    }
    const info = role(id);
    const status = agentStatus(run, id);
    const selected = selectedRoleId === id;
    button.className = `agent-room ${status} ${selected ? 'selected' : ''}`;
    button.style.setProperty('--room-accent', info.accent);
    button.style.setProperty('--room-halo', info.halo);
    button.setAttribute('aria-pressed', String(selected));
    button.setAttribute('aria-label', `${info.name}、${statusText(status)}。詳細を表示`);
    button.querySelector('.room-name').textContent = info.name;
    button.querySelector('.room-title').textContent = info.title;
    button.querySelector('.room-current').textContent = agentMessage(run, id);
    const speech = officeSpeech(run, {
      id,
      status,
      message: agentMessage(run, id),
      verdict: agent(run, id)?.result?.verdict,
      runStatus: run?.status,
    });
    const bubble = button.querySelector('.room-speech');
    bubble.textContent = `${speech.label}：${speech.message}`;
    bubble.dataset.tone = speech.tone;
    bubble.hidden = !['working', 'done', 'blocked'].includes(speech.tone);
    button.querySelector('.status-label').textContent = statusText(status);
    const avatar = button.querySelector('.room-avatar');
    if (avatar.dataset.species !== info.species) {
      avatar.innerHTML = avatars[info.species] || avatars.momo;
      avatar.dataset.species = info.species;
    }
  });
}

function resultCopyText(task) {
  const result = task.result || {};
  return [
    `${role(task.roleId).name} · ${statusText(task.status)}`,
    clean(task.instruction),
    clean(task.reason),
    clean(result.summary),
    safeOutput(result.content),
    clean(result.verdict) && `判定：${result.verdict}`,
    ...(Array.isArray(result.issues)
      ? result.issues.map((issue) => `指摘：${safeOutput(issue)}`)
      : []),
    ...(Array.isArray(result.checks)
      ? result.checks.map((check) => `確認：${safeOutput(check)}`)
      : []),
    clean(task.error) && `エラー：${task.error}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function renderResults() {
  const run = selectedRun();
  const entries = resultEntries(run);
  const signature = JSON.stringify([run?.id, entries, selectedRoleId]);
  if (rendered.results === signature) return;
  rendered.results = signature;
  const openIds = new Set(
    [...ui.results.querySelectorAll('details[open]')].map((item) => item.dataset.taskId),
  );
  const focusedTask = document.activeElement?.closest?.('.result-task');
  const focusedTaskId = focusedTask?.dataset.taskId;
  const focusedControl =
    focusedTask && document.activeElement?.classList.contains('result-copy') ? 'copy' : 'summary';
  if (!run) {
    ui.results.replaceChildren(
      text('p', '依頼が始まると、ここに担当の結果が届きます。', 'results-empty'),
    );
    return;
  }
  if (!entries.length) {
    ui.results.replaceChildren(text('p', '担当の結果を待っています。', 'results-empty'));
    return;
  }
  const content = document.createDocumentFragment();
  const byRole = new Map();
  entries.forEach((task) => {
    const id = task.roleId || 'unknown';
    if (!byRole.has(id)) byRole.set(id, []);
    byRole.get(id).push(task);
  });
  for (const [id, tasks] of byRole) {
    const section = text(
      'section',
      '',
      `result-role${selectedRoleId === id ? ' is-selected' : ''}`,
    );
    section.dataset.roleId = id;
    const heading = text('div', '', 'result-role-heading');
    const name = text('h3', role(id).name);
    const select = text('button', '担当の詳細を見る', 'text-button');
    select.type = 'button';
    select.addEventListener('click', () => {
      selectedRoleId = id;
      experience?.navigate('work');
      render();
      ui.detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    heading.append(name, select);
    section.append(heading);
    tasks.forEach((task, index) => {
      const result = task.result || {};
      const details = text('details', '', 'result-task');
      details.dataset.taskId = String(task.id || `${id}-${index}`);
      details.open = openIds.has(details.dataset.taskId) || (entries.length === 1 && !openIds.size);
      const summary = text('summary', '', 'result-task-summary');
      summary.append(
        text('strong', `${index + 1}回目 · ${statusText(task.status)}`),
        text(
          'span',
          clean(result.summary) ||
            clean(task.error) ||
            clean(task.instruction) ||
            '結果の記録を確認',
          'result-task-preview',
        ),
      );
      details.append(summary);
      const body = text('div', '', 'result-task-body');
      if (task.startedAt || task.finishedAt)
        body.append(
          text(
            'p',
            `${task.startedAt ? `${displayDate(task.startedAt)} 開始` : '開始時刻不明'}${task.finishedAt ? ` · ${displayDate(task.finishedAt)} 終了` : ''}`,
            'result-task-meta',
          ),
        );
      if (clean(task.reason))
        body.append(text('p', `選定理由：${task.reason}`, 'result-task-meta'));
      body.append(text('p', `呼び出しID：${task.id || '旧履歴・記録なし'}`, 'result-task-meta'));
      const application = task.skillApplication;
      body.append(text('h4', 'Officeスキルの適用'));
      body.append(
        text(
          'p',
          !application
            ? '適用記録なし（旧履歴）'
            : application.status === 'pending'
              ? '適用準備中'
              : application.status === 'not_assigned'
                ? '未割当'
                : application.status === 'error'
                  ? '適用エラー'
                  : application.entries.length
                    ? application.entries
                        .map(
                          (entry) =>
                            `${entry.name} · 版${entry.revision ?? '不明'}：${entry.reason}`,
                        )
                        .join(' ／ ')
                    : '適用記録なし',
          'result-task-meta',
        ),
      );
      if (clean(task.instruction)) {
        const assignment = text('details', '', 'result-assignment');
        assignment.append(text('summary', '担当への依頼を確認'));
        assignment.append(text('p', task.instruction, 'result-task-text'));
        body.append(assignment);
      }
      if (clean(result.summary)) {
        body.append(text('h4', '結果の要約'));
        body.append(text('p', result.summary, 'result-task-text'));
      }
      if (result.content != null && safeOutput(result.content)) {
        body.append(text('h4', '結果の全文'));
        body.append(text('pre', safeOutput(result.content), 'result-task-content'));
      }
      if (clean(result.verdict))
        body.append(text('p', `判定：${result.verdict}`, 'result-task-meta'));
      const verification = verificationGroups(result);
      for (const [key, label] of [
        ['verified', '確認済み（担当報告）'],
        ['unverified', '未確認'],
        ['failed', '確認失敗'],
        ['unclassified', '確認報告（区分未記録）'],
        ['issues', '残る指摘'],
      ]) {
        if (!verification[key].length) continue;
        body.append(text('h4', label));
        const list = text('ul', '', 'result-task-list');
        verification[key].forEach((item) =>
          list.append(
            text(
              'li',
              safeOutput(typeof item === 'string' ? item : `${item.subject}：${item.evidence}`),
            ),
          ),
        );
        body.append(list);
      }
      if (task.id && !String(task.id).startsWith('legacy-')) {
        const talk = text('button', 'この呼び出しのトークを見る', 'text-button');
        talk.type = 'button';
        talk.addEventListener('click', () => experience?.selectTalkTask(task.id));
        body.append(talk);
      }
      if (clean(task.error)) body.append(text('p', task.error, 'run-error'));
      const meta = [task.provider, task.model, task.effort].filter(Boolean).join(' · ');
      if (meta) body.append(text('p', meta, 'result-task-meta'));
      const copy = text('button', 'この結果をコピー', 'result-copy');
      copy.type = 'button';
      const feedback = text('span', '', 'result-copy-feedback');
      feedback.setAttribute('role', 'status');
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(resultCopyText(task));
          feedback.textContent = 'コピーしました';
        } catch {
          feedback.textContent = 'コピーできませんでした。結果の全文を選択してコピーしてください。';
        }
      });
      body.append(copy, feedback);
      details.append(body);
      section.append(details);
    });
    content.append(section);
  }
  ui.results.replaceChildren(content);
  if (focusedTaskId) {
    const matching = [...ui.results.querySelectorAll('.result-task')].find(
      (item) => item.dataset.taskId === focusedTaskId,
    );
    matching?.querySelector(focusedControl === 'copy' ? '.result-copy' : 'summary')?.focus();
  }
}

// Draw the selected agent and the run's supporting views only when changed.
function renderDetail() {
  const run = selectedRun();
  const info = role(selectedRoleId);
  const current = agent(run, selectedRoleId);
  const invocation = latestTask(run, selectedRoleId);
  const status = agentStatus(run, selectedRoleId);
  ui.detail.dataset.status = status;
  const signature = JSON.stringify([
    selectedRoleId,
    info,
    current,
    invocation,
    status,
    latestAgentEvent(run, selectedRoleId),
    run?.mode,
    run?.escalation,
    status === 'working' ? Math.floor(Date.now() / 2000) : null,
  ]);
  if (rendered.detail === signature) return;
  rendered.detail = signature;
  const fragment = document.createDocumentFragment();
  const avatar = text('div', '', 'detail-avatar-wrap');
  avatar.innerHTML = avatars[info.species] || avatars.momo;
  avatar.append(text('span', '✳', 'avatar-sparkle'));
  fragment.append(avatar);
  fragment.append(
    text(
      'p',
      `担当 ${String(roleOrder.indexOf(selectedRoleId) + 1).padStart(2, '0')}`,
      'detail-role-index',
    ),
  );
  fragment.append(text('h2', info.name, 'detail-name'), text('p', info.title, 'detail-title'));
  const badge = text('div', '', `detail-status ${status}`);
  badge.append(text('span', '', 'agent-dot'), document.createTextNode(statusText(status)));
  fragment.append(badge);
  fragment.append(text('p', info.description, 'detail-description'));
  if (run) {
    const handoffs = text('section', '', 'detail-handoffs');
    handoffs.append(text('h3', '担当間の受け渡し', 'detail-mini-heading'));
    const tasks = (run.tasks || []).filter((task) => task.roleId === selectedRoleId);
    if (!tasks.length) handoffs.append(text('p', '今回は未参加、または呼び出し前です。'));
    for (const task of tasks) {
      const card = text('article', '', 'handoff-card');
      card.dataset.taskId = task.id;
      const instructions = text('details', '', 'result-assignment');
      instructions.append(
        text('summary', '担当へ渡した指示を読む'),
        text('p', task.promptInstruction || task.instruction || '指示の記録なし'),
        text('small', `呼び出しID ${task.id} · ${task.round ?? '旧記録'}ラウンド`),
      );
      card.append(instructions);
      card.append(
        text('h4', '状態'),
        text(
          'p',
          `${statusText(task.status)} · 開始 ${task.startedAt ? displayDate(task.startedAt) : '時刻不明'} · 最終受信 ${task.lastEventAt ? displayDate(task.lastEventAt) : '記録なし'}`,
        ),
      );
      card.append(text('h4', '報告'), text('p', task.result?.summary || task.error || '報告待ち'));
      const inbound = (task.inputRefs || []).map(
        (ref) => run.tasks.find((entry) => entry.id === ref.taskId)?.roleId || ref.taskId,
      );
      const outgoing = run.tasks
        .filter((entry) =>
          entry.inputRefs?.some((ref) => ref.runId === run.id && ref.taskId === task.id),
        )
        .map((entry) => entry.roleId);
      card.append(
        text(
          'p',
          `入力元：${inbound.length ? inbound.join('、') : '記録なし'} ／ 報告を渡した先：${outgoing.length ? outgoing.join('、') : '記録なし'}`,
        ),
      );
      for (const [label, fn] of [
        ['トークへ', () => experience?.selectTalkTask(task.id)],
        ['成果へ', () => experience?.selectResultsTask(task.id)],
      ]) {
        const button = text('button', label, 'text-button');
        button.type = 'button';
        button.addEventListener('click', fn);
        card.append(button);
      }
      handoffs.append(card);
    }
    fragment.append(handoffs);
  }
  fragment.append(
    text('p', 'いまの仕事', 'detail-mini-heading'),
    text('div', agentMessage(run, selectedRoleId), 'detail-work'),
  );
  if (invocation?.instruction || current?.assignment) {
    fragment.append(text('p', 'この担当のゴール', 'detail-mini-heading'));
    fragment.append(text('p', invocation?.instruction || current.assignment, 'detail-assignment'));
  }
  if (status === 'working' || current?.progress) {
    const view = progressView(
      current,
      current?.finishedAt ? Date.parse(current.finishedAt) : Date.now(),
    );
    const panel = text(
      'section',
      '',
      `execution-progress${view.stale && status === 'working' ? ' is-stale' : ''}`,
    );
    panel.append(
      text('h3', status === 'working' ? view.label : 'この工程の実行記録', 'detail-mini-heading'),
    );
    const stats = text('div', '', 'execution-stats');
    stats.append(
      text('span', `処理完了 ${view.completed}件`),
      text('span', `担当時間 ${view.total}`),
    );
    if (status === 'working' && view.active !== null)
      stats.append(text('span', `実行中 ${view.activeCount}件 · ${view.active}`));
    panel.append(stats);
    if (status === 'working') panel.append(text('p', `最終イベント受信：${view.silence}前`));
    if (view.repeatFailures)
      panel.append(text('p', `同じ失敗の連続：${view.repeatFailures}回`, 'progress-warning'));
    if (view.stale && status === 'working')
      panel.append(
        text(
          'p',
          '更新が届いていません。長い処理・モデルの応答待ち・停止のどれかは、この表示だけでは判定できません。',
          'progress-warning',
        ),
      );
    fragment.append(panel);
  }
  const inactive = status === 'skipped' || status === 'legacy';
  const model = inactive
    ? '—'
    : clean(invocation?.model) ||
      clean(current?.model) ||
      (run?.mode === 'careful' && selectedRoleId === 'commander' ? 'gpt-6-astra' : '') ||
      clean(info.model) ||
      'gpt-6-sol';
  const effort = inactive
    ? '—'
    : clean(invocation?.effort) || clean(current?.effort) || clean(info.effort) || 'high';
  const providerRow = text('div', '', 'model-row');
  providerRow.append(
    text('span', '利用するAI'),
    text(
      'strong',
      (invocation?.provider || current?.provider || info.provider) === 'claude'
        ? 'Claude Code'
        : 'Codex',
    ),
  );
  fragment.append(providerRow);
  const modelRow = text('div', '', 'model-row');
  modelRow.append(text('span', 'モデル'), text('strong', model));
  fragment.append(modelRow);
  const effortRow = text('div', '', 'model-row');
  effortRow.append(text('span', '推論強度'), text('strong', effort));
  fragment.append(effortRow);
  const result = invocation ? invocation.result : current?.result;
  if (result && Array.isArray(result.issues) && result.issues.length) {
    const section = text('section', '', 'detail-findings');
    section.append(text('h3', '指摘・未解決事項', 'detail-mini-heading'));
    const list = text('ul', '', 'detail-list issues');
    result.issues.forEach((issue) => list.append(text('li', safeOutput(issue))));
    section.append(list);
    fragment.append(section);
  }
  if (result && Array.isArray(result.checks) && result.checks.length) {
    const section = text('section', '', 'detail-findings');
    section.append(text('h3', '検証結果・未確認事項', 'detail-mini-heading'));
    const list = text('ul', '', 'detail-list checks');
    result.checks.forEach((check) => list.append(text('li', safeOutput(check))));
    section.append(list);
    fragment.append(section);
  }
  const output = safeOutput(invocation ? result?.content : result?.content || current?.output);
  if (output) {
    const section = text('div', '', 'detail-output');
    section.append(text('p', '担当からの出力', 'detail-mini-heading'), text('pre', output));
    fragment.append(section);
  }
  if (run) {
    const context = text('details', null, 'detail-input-context');
    context.append(
      text('summary', '対応するユーザー入力'),
      text('p', run.rootInstruction || run.instruction),
    );
    if (run.userAdditions?.length)
      context.append(text('h4', '追加の指示'), text('p', run.userAdditions.join('\n')));
    fragment.append(context);
    const links = text('div', null, 'detail-view-actions');
    for (const [label, callback] of [
      ['この担当のトークを見る', () => experience?.selectTalk(selectedRoleId)],
      ['この担当の結果を見る', () => experience?.selectResults(selectedRoleId)],
    ]) {
      const button = text('button', label, 'secondary-button');
      button.type = 'button';
      button.addEventListener('click', callback);
      links.append(button);
    }
    fragment.append(links);
  }
  ui.detail.replaceChildren(fragment);
}

function officeSpeech(run, input) {
  const view = escalationView(run);
  if (
    view &&
    input.id === 'commander' &&
    connected &&
    ['consulting', 'awaiting_user', 'failed', 'exhausted'].includes(run.escalation.status) &&
    run.status !== 'cancelled'
  ) {
    return {
      label: view.title,
      message: view.summary || view.reason,
      tone: view.consulting ? 'working' : 'blocked',
    };
  }
  return speechFor(input);
}

function renderConsultation() {
  const host = $('ceo-consultation');
  const run = selectedRun();
  const view = escalationView(run);
  const legacy = !view && ['needs_attention', 'failed'].includes(run?.status);
  host.hidden = !view && !legacy;
  if (host.hidden) return;
  const signature = JSON.stringify([
    run?.id,
    run?.escalation,
    run?.status,
    run?.error,
    connected,
    state.activeRunId,
    followupSubmitting,
  ]);
  if (host.dataset.signature === signature) return;
  host.dataset.signature = signature;
  const content = document.createDocumentFragment();
  content.append(text('p', '指揮官への相談', 'eyebrow small'));
  content.append(text('h1', 'この入力について、判断・対応が必要です'));
  const input = text('section', null, 'consultation-input');
  const originalInput = run.rootInstruction || run.instruction || '';
  input.append(
    text('h3', '対象の依頼'),
    text('p', originalInput.length > 260 ? `${originalInput.slice(0, 260)}…` : originalInput),
  );
  if (originalInput.length > 260) {
    const full = text('details');
    full.append(text('summary', '元の入力をすべて読む'), text('p', originalInput));
    input.append(full);
  }
  if (run.userAdditions?.length)
    input.append(text('h4', '今回の追加指示'), text('p', run.userAdditions.at(-1)));
  if (run.requestContext?.done)
    input.append(text('h4', '元の完了条件'), text('p', run.requestContext.done));
  content.append(input);
  content.append(text('h2', view?.title || '止まっている依頼を指揮官へ相談'));
  const source = run.escalation?.sourceRole || run.stage;
  content.append(text('p', `相談元：${role(source).name} · ${role(source).title}`, 'run-meta'));
  content.append(
    text('p', view?.reason || run.error || '担当の記録を確認してください。', 'consultation-reason'),
  );
  if (view?.instruction) {
    content.append(text('h3', '指揮官からの対応指示'));
    content.append(text('pre', view.instruction, 'consultation-instruction'));
  } else {
    content.append(
      text(
        'p',
        legacy
          ? 'この履歴にはまだ指揮官の相談結果がありません。前の成果を引き継いで相談できます。'
          : view?.consulting
            ? '原因・担当・必要な確認を整理しています。相談の判定は、依頼全体の完了判定とは別です。'
            : '対応指示を取得できていません。元の記録を残して停止しています。',
      ),
    );
  }
  const incident = run.escalation;
  const sourceReport = latestTask(run, source)?.result || agent(run, source)?.result;
  const unresolved = Array.isArray(sourceReport?.issues) ? sourceReport.issues : [];
  const context = text('section', null, 'consultation-context-grid');
  for (const [label, value] of [
    ['進めない理由', view?.reason || run.error || '理由の記録を取得できていません。'],
    [
      '指揮官が確認・試行したこと',
      incident?.result?.summary ||
        (view?.consulting
          ? '指揮官が対応を確認しています。'
          : '相談結果の記録がありません。試行済みとは判断できません。'),
    ],
    [
      'あなたに必要な判断・操作',
      incident?.result?.issues?.length
        ? incident.result.issues.map(safeOutput).join('\n')
        : view?.instruction ||
          (unresolved.length
            ? `担当からの未解決事項について、修正条件や必要な情報・環境を追加指示で伝えてください。\n${unresolved.map(safeOutput).join('\n')}`
            : '') ||
          '相談元の記録を確認し、足りない情報や許可範囲を追加指示で伝えてください。具体的な要求はまだ記録されていません。',
    ],
  ]) {
    const item = text('div');
    item.append(text('h3', label), text('p', value));
    context.append(item);
  }
  content.append(
    context,
    text(
      'p',
      '途中の回答による同一処理の再開には未対応です。元の入力と成果を引き継ぐ、新しい依頼として送信します。',
      'followup-note',
    ),
  );
  if (view?.waiting)
    content.append(
      text(
        'p',
        '必要な情報・権限・環境を確認してから、修正・追加指示で続きを依頼してください。同じ条件での再送だけでは解消しない場合があります。',
      ),
    );
  const show = text('button', 'モカの詳細を見る', 'followup-close');
  show.type = 'button';
  show.addEventListener('click', () => {
    selectedRoleId = 'commander';
    render();
    ui.detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  content.append(show);
  if (legacy || view?.waiting) {
    const follow = text(
      'button',
      legacy ? '社長室への相談を入力する' : '対応・追加指示を入力する',
      'followup-button',
    );
    follow.type = 'button';
    follow.disabled =
      !connected ||
      !state.capabilities?.continuation ||
      Boolean(state.activeRunId) ||
      followupSubmitting;
    follow.addEventListener('click', () => {
      $('open-followup').click();
      if (!$('followup-instruction').value)
        $('followup-instruction').value =
          'モカへ。前回の未解決事項について、今の権限で担当へ渡せる作業と、私が準備する必要のある情報・権限・環境を分けてください。実行可能な解決手順を担当に指示し、未検証の項目は完了扱いにしないでください。';
      $('followup-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
      $('followup-instruction').focus();
    });
    content.append(follow);
  }
  host.replaceChildren(content);
}

function renderWorkflow() {
  const run = selectedRun();
  const view = stoppingView(
    workflowView(run, connected && state.runtime?.available !== false),
    stoppingRuns.has(run?.id) && ['running', 'queued'].includes(run?.status),
  );
  const host = $('workflow');
  const signature = JSON.stringify([run?.id, view, run?.escalation, selectedRoleId, run?.error]);
  if (host.dataset.signature === signature) return;
  host.dataset.signature = signature;
  const content = document.createDocumentFragment();
  host.classList.toggle('is-auto', Boolean(view.automatic));
  content.append(text('p', view.automatic ? '担当の選定' : '仕事の流れ', 'eyebrow small'));
  content.append(text('h2', view.headline, 'workflow-headline'));
  if (view.automatic && view.summary) content.append(text('p', view.summary, 'dispatch-summary'));
  content.append(
    text(
      'p',
      view.automatic
        ? run?.dispatch
          ? '指揮官が今回必要な担当を選びました。担当を押すと詳しい記録が開きます。'
          : '指揮官が依頼を確認しています。担当が決まると理由と依頼内容を表示します。'
        : `工程を押すと担当の詳細が開きます。${view.round ? ` 実装・修正 ${view.round} / 3回` : ''}`,
      'workflow-note',
    ),
  );
  if (!run) {
    host.replaceChildren(content);
    return;
  }
  const current = view.groups.flat().find((node) => node.status === 'active');
  if (current) {
    const focus = text('div', '', 'workflow-current');
    focus.append(
      text('small', '現在の工程'),
      text('strong', `${role(current.role).name} · ${current.label}`),
    );
    if (current.reason) focus.append(text('p', `選定理由：${current.reason}`));
    content.append(focus);
  }
  const path = text('ol', '', 'workflow-path');
  view.groups.forEach((group, index) => {
    const step = text('li', '', 'workflow-step');
    if (!view.automatic && index === 7)
      step.append(text('span', '2名で並行確認', 'workflow-parallel'));
    group.forEach((node) => {
      const button = text('button', '', `workflow-node is-${node.status}`);
      button.type = 'button';
      button.setAttribute(
        'aria-label',
        `${node.label}、${role(node.role).name}、${node.stateLabel}。詳細を表示`,
      );
      if (node.status === 'active') button.setAttribute('aria-current', 'step');
      button.append(
        text('strong', node.label),
        text('span', role(node.role).name),
        text('small', node.stateLabel),
      );
      if (view.automatic && node.reason)
        button.append(text('span', node.reason, 'workflow-reason'));
      button.addEventListener('click', () => {
        selectedRoleId = node.role;
        render();
        ui.detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      step.append(button);
    });
    path.append(step);
  });
  content.append(path);
  if (view.automatic) {
    if (view.skipped.length) {
      const skipped = text('details', '', 'dispatch-skipped');
      skipped.append(text('summary', '今回は選ばれなかった担当を見る'));
      const list = text('ul');
      view.skipped.forEach((item) => {
        const line = text('li');
        line.append(text('strong', role(item.role).name));
        if (item.reason) line.append(document.createTextNode(`：${item.reason}`));
        list.append(line);
      });
      skipped.append(list);
      content.append(skipped);
    }
    host.replaceChildren(content);
    return;
  }
  const branch = text('div', '', `workflow-branch${view.consulting ? ' is-active' : ''}`);
  branch.append(text('p', '不明・エラー → 社長室で相談 → 対応指示 → 対象工程へ戻る'));
  branch.append(
    text('p', 'レビューで修正が必要 → 実装・修正へ ↩　／　権限・情報不足 → あなたの対応待ち'),
  );
  if (run?.escalation) {
    const button = text(
      'button',
      escalationView(run)?.title || '社長室の相談を見る',
      'followup-close',
    );
    button.type = 'button';
    button.addEventListener('click', () => {
      experience?.navigate('consultation');
      $('ceo-consultation').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    branch.append(button);
  } else if (run?.error) branch.append(text('p', run.error, 'workflow-error'));
  content.append(branch);
  host.replaceChildren(content);
}

function renderHistory() {
  const all = runs();
  const signature = JSON.stringify([
    selectedRunId,
    all
      .slice(0, 25)
      .map((run) => [
        run.id,
        run.instruction,
        displayRunStatus(
          run,
          connected,
          state.runtime?.available !== false,
          stoppingRuns.has(run.id),
        ),
        run.createdAt,
        run.projectId,
        run.projectLabel,
        run.workspace,
      ]),
    projects,
  ]);
  if (rendered.history === signature) return;
  rendered.history = signature;
  ui.historyCount.textContent = String(all.length);
  if (!all.length) {
    ui.history.replaceChildren(text('p', 'まだ依頼はありません。', 'history-empty'));
    return;
  }
  const fragment = document.createDocumentFragment();
  all.slice(0, 25).forEach((run) => {
    const displayStatus = displayRunStatus(
      run,
      connected,
      state.runtime?.available !== false,
      stoppingRuns.has(run.id),
    );
    const button = text('button', '', `history-item ${selectedRunId === run.id ? 'selected' : ''}`);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(selectedRunId === run.id));
    button.append(text('span', clean(run.instruction) || '無題の依頼', 'history-item-title'));
    const meta = text('span', '', 'history-item-meta');
    meta.append(
      text('span', '', `mini-status ${displayStatus}`),
      document.createTextNode(
        `${displayDate(run.createdAt)} · ${runProjectLabel(run)} · ${statusText(displayStatus)}`,
      ),
    );
    button.append(meta);
    button.addEventListener('click', () => {
      showingCurrentTeam = false;
      selectedRunId = run.id;
      manuallySelectedRun = true;
      render();
      document
        .querySelector('.office-section')
        .scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    fragment.append(button);
  });
  ui.history.replaceChildren(fragment);
}

function renderRun() {
  const run = selectedRun();
  const displayStatus = displayRunStatus(
    run,
    connected,
    state.runtime?.available !== false,
    stoppingRuns.has(run?.id),
  );
  const signature = JSON.stringify([run, displayStatus, cancelling, projects]);
  if (rendered.run === signature) return;
  rendered.run = signature;
  ui.runStatus.className = `run-status-pill ${displayStatus}`;
  ui.runStatus.lastElementChild.textContent =
    displayStatus === 'unknown'
      ? '接続を確認中'
      : run
        ? statusText(displayStatus)
        : '依頼を待っています';
  if (!run) {
    ui.runSummary.replaceChildren(
      text('p', 'まだ依頼はありません。下のフォームからチームへ仕事を届けられます。'),
    );
    ui.cancel.hidden = true;
    return;
  }
  const fragment = document.createDocumentFragment();
  fragment.append(text('p', clean(run.instruction) || '無題の依頼', 'run-text'));
  fragment.append(
    text('p', `${statusText(displayStatus)} · ${displayDate(run.createdAt)} 開始`, 'run-meta'),
  );
  fragment.append(text('p', `プロジェクト：${runProjectLabel(run)}`, 'run-meta'));
  if (clean(run.workspace)) fragment.append(text('p', run.workspace, 'run-meta'));
  if (run.preparationVerification) {
    const checked = run.preparationVerification;
    fragment.append(
      text(
        'p',
        checked.status === 'verified'
          ? `準備ファイル確認済み：AGENTS.md${checked.skills?.length ? ` ／ Skill配置済み ${checked.skills.length}件：${checked.skills.join('、')}` : ' ／ 新しいSkillの配置なし'}`
          : '準備ファイルの確認・配置が必要です。依頼のエラーと担当の結果を確認してください。',
        'run-meta',
      ),
    );
  }
  if (run.attachments?.length) {
    const attachments = text('section', null, 'run-attachments');
    attachments.append(text('h3', `添付 ${run.attachments.length}件`, 'detail-mini-heading'));
    for (const item of run.attachments) {
      const row = text('div', null, 'run-attachment-row');
      row.append(text('span', attachmentLabel(item)));
      const show = text(
        'button',
        item.kind === 'stored' ? '保存情報を見る' : '内容を見る',
        'text-button',
      );
      show.type = 'button';
      show.addEventListener('click', async () => {
        try {
          const result = await mutate('/api/attachments/preview', 'POST', {
            runId: run.id,
            attachmentId: item.id,
          });
          const preview = text('div', null, 'run-attachment-preview');
          if (result.dataUrl) {
            const image = document.createElement('img');
            image.src = result.dataUrl;
            image.alt = `${item.name}の内容`;
            preview.append(image);
          } else preview.append(text('pre', result.note || result.text || '内容はありません'));
          row.querySelector('.run-attachment-preview')?.remove();
          row.append(preview);
        } catch (error) {
          row.append(text('p', error.message, 'form-message error'));
        }
      });
      row.append(show);
      attachments.append(row);
    }
    fragment.append(attachments);
  }
  if (run.environment) {
    const environment = text('section', '', 'execution-progress');
    environment.append(text('h3', 'アプリが管理する確認環境', 'detail-mini-heading'));
    const preview = run.environment.preview;
    if (preview?.status === 'ready' && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(preview.url || '')) {
      const link = text('a', '確認用ページを開く', 'followup-close');
      link.href = preview.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      environment.append(
        link,
        text('p', 'ビルド済みの画面を配信中。表示・操作の合格判定は担当が行います。', 'run-meta'),
      );
    } else environment.append(text('p', preview?.reason || 'プレビューは未準備です。', 'run-meta'));
    const log = run.environment.worklog;
    environment.append(
      text(
        'p',
        log?.status === 'saved'
          ? '共通ログ：アプリが保存済み'
          : `共通ログ：${log?.reason || '未確認'}`,
        'run-meta',
      ),
    );
    fragment.append(environment);
  }
  if (run.continueFromRunId) {
    fragment.append(text('p', '前の依頼を引き継いだ修正・追加です。', 'run-meta'));
    const sourceLink = text('button', '引き継ぎ元の依頼を見る', 'followup-close');
    sourceLink.type = 'button';
    sourceLink.addEventListener('click', () => {
      if (!runs().some((item) => item.id === run.continueFromRunId)) return;
      showingCurrentTeam = false;
      selectedRunId = run.continueFromRunId;
      manuallySelectedRun = true;
      render();
    });
    sourceLink.disabled = !runs().some((item) => item.id === run.continueFromRunId);
    fragment.append(sourceLink);
  }
  if (run.tokenUsage) {
    const usage = run.tokenUsage;
    fragment.append(
      text(
        'p',
        `報告済みトークン：入力 ${usage.input_tokens?.toLocaleString() ?? '未取得'} / 出力 ${usage.output_tokens?.toLocaleString() ?? '未取得'}（完了した工程のみ・キャッシュ入力は入力の内数）`,
        'run-meta',
      ),
    );
  }
  fragment.append(text('p', '費用：未取得。トークン数を実測費用として表示しません。', 'run-meta'));
  if (run.round != null && run.selectionMode !== 'auto')
    fragment.append(
      text('p', run.round ? `実装・修正 ${run.round} / 3回` : '仕様・準備の工程', 'run-meta'),
    );
  if (run.status === 'completed') {
    fragment.append(
      text(
        'p',
        run.selectionMode === 'auto'
          ? '指揮官が担当の結果をまとめ、この依頼を完了しました。'
          : '指揮官が最終承認しました。この依頼の追加実行はありません。',
        'run-meta',
      ),
    );
  }
  if (clean(run.error)) fragment.append(text('p', run.error, 'run-error'));
  ui.runSummary.replaceChildren(fragment);
  ui.cancel.hidden =
    !['queued', 'running'].includes(run.status) || !connected || state.runtime?.available === false;
  ui.cancel.disabled = cancelling || stoppingRuns.has(run.id);
  ui.cancel.textContent =
    cancelling || stoppingRuns.has(run.id) ? '停止完了を確認しています…' : 'この実行を中止する';
}

function renderActivity() {
  const run = selectedRun();
  const events = Array.isArray(run?.events) ? run.events.slice().reverse().slice(0, 12) : [];
  const signature = JSON.stringify([run?.id, run?.instruction, events]);
  if (rendered.activity === signature) return;
  rendered.activity = signature;
  ui.activityRunLabel.textContent = run
    ? clean(run.instruction) || '無題の依頼'
    : 'まだ記録はありません';
  if (!events.length) {
    ui.activity.replaceChildren(
      text(
        'li',
        run ? '作業の記録を待っています。' : '依頼が始まると、ここに進み具合が届きます。',
        'activity-empty',
      ),
    );
    return;
  }
  const fragment = document.createDocumentFragment();
  events.forEach((event) => {
    const item = text('li', '');
    item.append(
      text('span', displayDate(event.at), 'event-time'),
      text(
        'span',
        event.role && roleOrder.includes(event.role) ? role(event.role).name : 'チーム',
        'event-agent',
      ),
      text('span', clean(event.message) || event.type || '更新', 'event-message'),
    );
    fragment.append(item);
  });
  ui.activity.replaceChildren(fragment);
}

function render() {
  $('mode-explainer').textContent =
    '各担当のAI・モデル・追加指示は設定画面で変更できます。モード自動調整が有効なCodex担当のみ、選択した進め方に合わせて調整します。';

  const displayRoles = selectedRun()?.roles || state.roles;
  roleOrder = displayRoles?.length ? displayRoles.map((item) => item.id) : [...baseRoleOrder];
  if (!roleOrder.includes(selectedRoleId)) selectedRoleId = 'commander';
  $('team-size-label').textContent = `${roleOrder.length}人のエージェント`;
  $('office-scene-title').textContent = roleOrder.length > 9 ? '4つの部屋と登録担当' : '4つの部屋';
  $('room-count').textContent =
    `${roleOrder.length > 9 ? 5 : 4} rooms · ${roleOrder.length} members`;
  $('hero-intro').textContent =
    `登録担当 ${roleOrder.length}人。依頼ごとに指揮官が参加者を選びます。`;
  document
    .querySelector('.office-floor')
    .setAttribute('aria-label', `${roleOrder.length}人のエージェントの作業状況`);
  renderFloorStatus();
  renderOfficeScene();
  renderRooms();
  renderDetail();
  renderResults();
  renderHistory();
  renderRun();
  renderActivity();
  renderFollowup();
  renderConsultation();
  renderWorkflow();
  experience?.update();
}
function acceptState(next) {
  const economySupported = next.supportedModes?.includes('economy');
  const economyOption = ui.mode.querySelector('option[value="economy"]');
  economyOption.disabled = !economySupported;
  if (!economySupported && ui.mode.value === 'economy') ui.mode.value = 'standard';
  $('runtime-update-note').hidden = Boolean(economySupported);
  if (!next || typeof next !== 'object') throw new Error('状態を読み取れませんでした。');
  const previousStatus = selectedRun()?.status;
  const previousEscalation = selectedRun()?.escalation?.createdAt;
  state = { ...state, ...next };
  const all = runs();
  const previousRunId = selectedRunId;
  if (!manuallySelectedRun || !all.some((run) => run.id === selectedRunId))
    selectedRunId = next.activeRunId || all[0]?.id || null;
  if (previousRunId !== selectedRunId) {
    selectedRoleId =
      roleOrder.find((id) => agentStatus(selectedRun(), id) === 'working') || 'commander';
  }
  if (selectedRun()?.status === 'completed' && previousStatus !== 'completed')
    selectedRoleId = 'commander';
  if (
    selectedRun()?.escalation?.createdAt &&
    selectedRun().escalation.createdAt !== previousEscalation
  )
    selectedRoleId = 'commander';
  if (!workspaceEdited && ui.project.value === '' && clean(next.workspaceRoot)) syncProjectChoice();
  render();
}
async function loadState() {
  if (requestInFlight) return;
  requestInFlight = true;
  try {
    const response = await fetch('/api/state', { cache: 'no-store' });
    if (!response.ok) throw new Error(`状態取得に失敗しました (${response.status})`);
    const next = await response.json();
    if (!connected) token = null;
    connected = true;
    acceptState(next);
    setConnection(true);
    if (formMessageSource === 'connection')
      setMessage('接続が戻りました。依頼を送れます。', 'success', 'default');
  } catch (error) {
    connected = false;
    setConnection(false);
    render();
    if (formMessageSource !== 'submit')
      setMessage(`接続を確認してください。${error.message || ''}`, 'error', 'connection');
  } finally {
    requestInFlight = false;
  }
}
// Mutations keep the existing session-token and retry behavior.
async function getToken() {
  if (token) return token;
  const response = await fetch('/api/session', { cache: 'no-store' });
  if (!response.ok) throw new Error('操作用セッションを取得できませんでした。');
  const data = await response.json();
  if (!clean(data?.token)) throw new Error('操作用セッションがありません。');
  token = data.token;
  return token;
}
async function mutate(url, method, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const officeToken = await getToken();
    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Office-Token': officeToken },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok) return data;
    if (response.status === 401 || response.status === 403) {
      token = null;
      if (attempt === 0) continue;
    }
    throw new Error(
      clean(data.error) || clean(data.message) || `操作に失敗しました (${response.status})`,
    );
  }
}
function setMessage(message, type, source = 'submit') {
  formMessageSource = source;
  ui.formMessage.textContent = message;
  ui.formMessage.className = `form-message ${type || ''}`;
}
const attachmentKinds = {
  png: '画像入力',
  jpg: '画像入力',
  jpeg: '画像入力',
  webp: '画像入力',
  txt: '本文を解析',
  md: '本文を解析',
  csv: '本文を解析',
  tsv: '本文を解析',
  json: '本文を解析',
  log: '本文を解析',
  pdf: '保存・参照のみ（内容解析なし）',
};
function attachmentLabel(item) {
  const ext = item.name.split('.').at(-1).toLowerCase();
  return `${item.name} · ${ext.toUpperCase()} · ${(item.size / 1024).toFixed(1)} KB · ${attachmentKinds[ext] || '未対応'}`;
}
function uploadPayload(which) {
  return attachmentDrafts[which].map(({ name, dataBase64 }) => ({ name, dataBase64 }));
}
function renderAttachmentDraft(which) {
  const list = $(`${which}-attachment-list`);
  list.replaceChildren();
  attachmentDrafts[which].forEach((item, index) => {
    const li = text('li', null, 'attachment-item');
    if (item.preview) {
      const img = document.createElement('img');
      img.src = item.preview;
      img.alt = `${item.name}のプレビュー`;
      li.append(img);
    }
    li.append(text('span', attachmentLabel(item)));
    const remove = text('button', '削除', 'text-button');
    remove.type = 'button';
    remove.disabled = which === 'task' ? submitting : followupSubmitting;
    remove.addEventListener('click', () => {
      attachmentDrafts[which].splice(index, 1);
      if (which === 'task') {
        approvedRequest = null;
        $('request-review').hidden = true;
      } else {
        approvedFollowup = null;
        $('followup-review')?.remove();
      }
      renderAttachmentDraft(which);
    });
    li.append(remove);
    list.append(li);
  });
}
function readFileData(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('ファイルを読み込めませんでした'));
    reader.readAsDataURL(file);
  });
}
function setupAttachments(which) {
  const input = $(`${which}-attachments`),
    zone = $(`${which}-dropzone`);
  async function add(files) {
    if (submitting || followupSubmitting) return;
    attachmentLoading[which]++;
    try {
      const inherited =
        which === 'followup'
          ? runs().find((r) => r.id === followupSourceId)?.attachments?.length || 0
          : 0;
      if (attachmentDrafts[which].length + files.length + inherited > 5)
        throw new Error('継承分を含む添付は5件までです');
      const total =
        attachmentDrafts[which].reduce((n, x) => n + x.size, 0) +
        files.reduce((n, x) => n + x.size, 0);
      if (total > 12 * 1024 * 1024) throw new Error('添付の合計は12MiBまでです');
      const prepared = [];
      for (const file of files) {
        const ext = file.name.split('.').at(-1).toLowerCase();
        if (!attachmentKinds[ext]) throw new Error(`${file.name}は未対応の形式です`);
        const max = attachmentKinds[ext] === '本文を解析' ? 100 * 1024 : 5 * 1024 * 1024;
        if (!file.size || file.size > max) throw new Error(`${file.name}の容量を確認してください`);
        const dataBase64 = await readFileData(file);
        prepared.push({
          name: file.name,
          size: file.size,
          dataBase64,
          preview:
            attachmentKinds[ext] === '画像入力'
              ? `data:${file.type || 'image/png'};base64,${dataBase64}`
              : null,
        });
      }
      attachmentDrafts[which].push(...prepared);
      renderAttachmentDraft(which);
      if (which === 'task') {
        approvedRequest = null;
        $('request-review').hidden = true;
      } else {
        approvedFollowup = null;
        $('followup-review')?.remove();
      }
    } finally {
      attachmentLoading[which]--;
    }
  }
  input.addEventListener('change', async () => {
    try {
      await add([...input.files]);
    } catch (error) {
      (which === 'task' ? setMessage : (msg) => ($('followup-message').textContent = msg))(
        error.message,
        'error',
      );
    }
    input.value = '';
  });
  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    zone.classList.add('is-dragging');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('is-dragging'));
  zone.addEventListener('drop', async (event) => {
    event.preventDefault();
    zone.classList.remove('is-dragging');
    try {
      await add([...event.dataTransfer.files]);
    } catch (error) {
      (which === 'task' ? setMessage : (msg) => ($('followup-message').textContent = msg))(
        error.message,
        'error',
      );
    }
  });
}
setupAttachments('task');
setupAttachments('followup');
function lockForm(form, locked) {
  form.querySelectorAll('input, select, textarea, button').forEach((control) => {
    control.disabled = locked;
  });
  renderAttachmentDraft(form.id === 'task-form' ? 'task' : 'followup');
}
function requestPayload() {
  const refs = [...$('project-history').querySelectorAll('input[data-history-id]:checked')]
    .map((check) => projectHistoryItems.find((item) => item.id === check.dataset.historyId))
    .filter(Boolean)
    .map(({ id, title, cwd }) => ({ id, title, cwd }));
  const setup = ui.taskKind.value === 'project-setup';
  return {
    kind: setup ? 'project-setup' : 'ordinary',
    instruction: setup
      ? projectSetupInstruction({
          purpose: $('project-purpose').value,
          workspace: ui.workspace.value,
          undecidedTech: $('project-undecided-tech').value,
          context: ui.instruction.value,
        })
      : clean(ui.instruction.value),
    workspace: clean(ui.workspace.value),
    projectId: ui.project.value === '__custom' ? '' : ui.project.value,
    mode: ui.mode.value,
    attachments: uploadPayload('task'),
    requestContext: {
      outcome: clean($('task-outcome').value),
      done: clean($('task-done').value),
      scope: clean($('task-scope').value),
      historyRefs: refs,
    },
  };
}
ui.form.addEventListener('input', () => {
  approvedRequest = null;
  $('request-review').hidden = true;
});
ui.form.addEventListener('change', () => {
  approvedRequest = null;
  $('request-review').hidden = true;
});
function showRequestReview(payload) {
  const setup = ui.taskKind.value === 'project-setup';
  const host = $('request-review');
  host.hidden = false;
  host.replaceChildren(
    text('p', '送信前の確認', 'eyebrow small'),
    text('h2', 'この内容で依頼しますか？'),
  );
  const dl = text('dl', null, 'request-review-list');
  for (const [label, value] of [
    ['対象プロジェクト', projectLabel(payload.projectId) || '指定フォルダー'],
    ['作業フォルダー', payload.workspace],
    ['元の入力', setup ? clean($('project-purpose').value) : payload.instruction],
    ...(setup
      ? [
          ['未決の技術・条件', clean($('project-undecided-tech').value) || '未決'],
          ['補足', clean(ui.instruction.value) || 'なし'],
          [
            '準備予定',
            `${payload.workspace}/AGENTS.md（既存なら差分確認）\n${payload.workspace}/.agents/skills/<name>/SKILL.md（必要な場合のみ）\nGlobalは読取のみ。外部Skill候補は調査後に採否・未確認を報告します。`,
          ],
        ]
      : []),
    ['添付', attachmentDrafts.task.map(attachmentLabel).join('\n') || 'なし'],
    ['ほしい成果', payload.requestContext.outcome || '指定なし'],
    ['完了条件', payload.requestContext.done || '指定なし'],
    ['作業範囲への希望', payload.requestContext.scope || '指定なし'],
    [
      '参照するCodex履歴',
      payload.requestContext.historyRefs.map((item) => `${item.title}（${item.id}）`).join('\n') ||
        '添付なし',
    ],
    ['参加担当', '最初は指揮官。内容を確認し必要な担当のみを選定します。'],
    [
      'AIへ渡る情報',
      '上記の入力・指定範囲と対象プロジェクトの資料。添付履歴はタイトル・ID・フォルダーのみ。担当の接続先は設定に従います。',
    ],
    [
      '編集できる担当',
      '既存の実装担当のみ。その他の担当は読み取り。作業範囲への希望は指示として渡します。',
    ],
  ]) {
    dl.append(text('dt', label), text('dd', value));
  }
  host.append(dl);
  if (setup) {
    const details = document.createElement('details');
    details.append(
      text('summary', '担当へ渡す準備手順を読む'),
      text('p', payload.instruction, 'run-meta'),
    );
    host.append(details);
  }
  const confirm = text('button', 'この内容でチームに依頼する', 'primary-button');
  confirm.type = 'button';
  confirm.addEventListener('click', () => {
    approvedRequest = JSON.stringify(payload);
    ui.form.requestSubmit();
  });
  const back = text('button', '内容を修正する', 'secondary-button');
  back.type = 'button';
  back.addEventListener('click', () => {
    host.hidden = true;
    (setup ? $('project-purpose') : ui.instruction).focus();
  });
  host.append(confirm, back);
  host.scrollIntoView({ block: 'start', behavior: 'instant' });
  host.querySelector('h2').tabIndex = -1;
  host.querySelector('h2').focus();
}
ui.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submitting) return;
  if (attachmentLoading.task) {
    setMessage('添付の読み込みが終わるまでお待ちください。', 'error');
    return;
  }
  const setup = ui.taskKind.value === 'project-setup';
  const instruction = clean(ui.instruction.value);
  if (setup && !state.capabilities?.projectSetup) {
    setMessage(
      '新規プロジェクトの準備を使うにはAgent Officeを更新して再起動してください。',
      'error',
    );
    return;
  }
  const workspace = clean(ui.workspace.value);
  const projectId = ui.project.value === '__custom' ? '' : ui.project.value;
  const selectedProject = projects.find((project) => project.id === projectId);
  if (!setup && !instruction) {
    setMessage('依頼内容を入力してください。', 'error');
    ui.instruction.focus();
    return;
  }
  if (
    selectedProject &&
    (selectedProject.available === false || workspace !== selectedProject.path)
  ) {
    setMessage('プロジェクトとフォルダの組み合わせを確認してください。', 'error');
    return;
  }
  if (!workspace.startsWith('/')) {
    setMessage('作業するフォルダの絶対パスを入力してください。', 'error');
    ui.workspace.focus();
    return;
  }
  if (setup && !clean($('project-purpose').value)) {
    setMessage('新規プロジェクトの目的を入力してください。', 'error');
    $('project-purpose').focus();
    return;
  }
  if (state.runtime && state.runtime.available === false) {
    setMessage('実行環境が利用できません。接続状態を確認してください。', 'error');
    return;
  }
  const payload = requestPayload();
  if (payload.instruction.length > 20000) {
    setMessage('依頼文が20,000文字を超えています。入力を短くしてください。', 'error');
    return;
  }
  if (approvedRequest !== JSON.stringify(payload)) {
    showRequestReview(payload);
    return;
  }
  approvedRequest = null;
  submitting = true;
  lockForm(ui.form, true);
  ui.submit.firstElementChild.textContent = '依頼を届けています…';
  setMessage('チームに依頼を届けています。');
  try {
    const result = await mutate('/api/runs', 'POST', payload);
    const created = result.run || result;
    if (created?.id) {
      showingCurrentTeam = false;
      selectedRunId = created.id;
      manuallySelectedRun = true;
    }
    ui.instruction.value = '';
    if (setup) {
      $('project-purpose').value = '';
      $('project-undecided-tech').value = '';
    }
    attachmentDrafts.task.length = 0;
    renderAttachmentDraft('task');
    for (const id of ['task-outcome', 'task-done', 'task-scope']) $(id).value = '';
    $('request-review').hidden = true;
    setMessage('依頼を受け付けました。進み具合を確認しています。', 'success');
    await loadState();
    experience?.navigate('office');
    document
      .querySelector('.office-section')
      .scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    setMessage(error.message || '依頼を送れませんでした。', 'error');
  } finally {
    submitting = false;
    lockForm(ui.form, false);
    ui.submit.firstElementChild.textContent = '依頼前の確認へ';
  }
});
ui.cancel.addEventListener('click', async () => {
  const run = selectedRun();
  if (!run || cancelling) return;
  cancelling = true;
  renderRun();
  try {
    await mutate(`/api/runs/${encodeURIComponent(run.id)}/cancel`, 'POST');
    stoppingRuns.add(run.id);
    render();
    setMessage('中止を受け付けました。', 'success');
    await loadState();
  } catch (error) {
    setMessage(error.message || '中止できませんでした。', 'error');
  } finally {
    cancelling = false;
    renderRun();
  }
});

function renderFollowup() {
  const run = selectedRun();
  const active =
    Boolean(state.activeRunId) ||
    runs().some((item) => ['running', 'queued'].includes(item.status));
  const supported = state.capabilities?.continuation === true;
  const unavailable = !connected || state.runtime?.available === false || !supported;
  const button = $('open-followup');
  button.hidden = !run;
  button.disabled = unavailable || active || followupSubmitting;
  $('followup-note').textContent = !run
    ? ''
    : !supported
      ? '引き継ぎ機能はアプリ更新後に利用できます。'
      : active
        ? '実行中は直接割り込めません。完了を待つか、中止してから修正・追加を依頼してください。'
        : '新しい依頼フォームと違い、前の要件と成果を覚えた状態で続けられます。';
  const source = runs().find((item) => item.id === followupSourceId);
  $('submit-followup').disabled = followupSubmitting || unavailable || active || !source;
  $('submit-followup').textContent = followupSubmitting
    ? '引き継いでいます…'
    : '引き継いで依頼する';
  $('close-followup').disabled = followupSubmitting;
  $('followup-instruction').disabled = followupSubmitting;
  if (source)
    $('followup-source').textContent =
      `引き継ぎ元：${source.instruction}\n対象：${source.workspace}`;
  $('followup-inherited').textContent = source?.attachments?.length
    ? `引き継ぐ添付：${source.attachments.map(attachmentLabel).join(' ／ ')}`
    : '引き継ぐ添付：なし';
}
$('open-followup').addEventListener('click', () => {
  if ($('open-followup').disabled) return;
  const run = selectedRun();
  if (!run) return;
  if (followupSourceId) followupDrafts.set(followupSourceId, $('followup-instruction').value);
  if (followupSourceId)
    followupAttachmentDrafts.set(followupSourceId, [...attachmentDrafts.followup]);
  followupSourceId = run.id;
  $('followup-instruction').value = followupDrafts.get(run.id) || '';
  attachmentDrafts.followup = [...(followupAttachmentDrafts.get(run.id) || [])];
  renderAttachmentDraft('followup');
  $('followup-form').hidden = false;
  $('followup-message').textContent = '';
  renderFollowup();
  $('followup-instruction').focus();
});
$('close-followup').addEventListener('click', () => {
  $('followup-form').hidden = true;
});
let approvedFollowup = null;
$('followup-instruction').addEventListener('input', () => {
  approvedFollowup = null;
  $('followup-review')?.remove();
});
$('followup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (followupSubmitting || $('submit-followup').disabled) return;
  if (attachmentLoading.followup) {
    $('followup-message').textContent = '添付の読み込みが終わるまでお待ちください。';
    return;
  }
  const instruction = clean($('followup-instruction').value);
  if (!instruction) return;
  const sourceId = followupSourceId;
  const fingerprint = JSON.stringify({
    sourceId,
    instruction,
    attachments: uploadPayload('followup'),
  });
  if (approvedFollowup !== fingerprint) {
    $('followup-review')?.remove();
    const source = runs().find((item) => item.id === sourceId);
    const review = text('section', null, 'request-review');
    review.id = 'followup-review';
    review.append(
      text('h3', '続きの依頼を送る前に確認'),
      text('h4', '元の入力'),
      text('p', source?.rootInstruction || source?.instruction),
      text('h4', '今回の修正・追加'),
      text('p', instruction),
      text('h4', '引き継ぐ対象'),
      text('p', source?.workspace),
      text('h4', '添付'),
      text(
        'p',
        [
          ...(source?.attachments || []).map(attachmentLabel),
          ...attachmentDrafts.followup.map(attachmentLabel),
        ].join('\n') || 'なし',
      ),
      text(
        'p',
        '元の完了条件・担当成果・指摘を引き継ぎ、新しい依頼として開始します。参加担当は指揮官が改めて選びます。',
      ),
    );
    const confirm = text('button', '確認して続きを依頼する', 'primary-button');
    confirm.type = 'button';
    confirm.addEventListener('click', () => {
      approvedFollowup = fingerprint;
      $('followup-form').requestSubmit();
    });
    review.append(confirm);
    $('followup-form').append(review);
    review.scrollIntoView({ block: 'start' });
    return;
  }
  approvedFollowup = null;
  followupSubmitting = true;
  lockForm($('followup-form'), true);
  renderFollowup();
  try {
    const result = await mutate('/api/runs', 'POST', {
      instruction,
      continueFromRunId: sourceId,
      attachments: uploadPayload('followup'),
    });
    showingCurrentTeam = false;
    selectedRunId = result.id;
    manuallySelectedRun = true;
    followupDrafts.delete(sourceId);
    followupAttachmentDrafts.delete(sourceId);
    $('followup-instruction').value = '';
    attachmentDrafts.followup.length = 0;
    renderAttachmentDraft('followup');
    $('followup-form').hidden = true;
    followupSourceId = null;
    await loadState();
  } catch (error) {
    $('followup-message').textContent = error.message || '引き継ぎに失敗しました。';
  } finally {
    followupSubmitting = false;
    lockForm($('followup-form'), false);
    renderFollowup();
  }
});

function ensureOfficeScene() {
  const signature = `${roleOrder.join(',')}:${renderMode}`;
  if (officeScene && signature === sceneSignature) return;
  officeScene?.dispose();
  sceneSignature = signature;
  officeScene = createOfficeScene($('office-scene'), {
    forceWebGL: renderMode === 'webgl2',
    extraAgents: roleOrder.filter((id) => !baseRoleOrder.includes(id)).map((id) => role(id)),
    onSelect(id) {
      selectedRoleId = id;
      experience?.navigate('work');
      renderRooms();
      renderOfficeScene();
      renderDetail();
      renderResults();
      if (window.innerWidth <= 1050)
        ui.detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
  });
}
function renderOfficeScene() {
  ensureOfficeScene();
  const run = selectedRun();
  officeScene.update(
    roleOrder.map((id) => {
      const info = role(id);
      const status = agentStatus(run, id);
      const speech = officeSpeech(run, {
        id,
        status,
        message: agentMessage(run, id),
        verdict: agent(run, id)?.result?.verdict,
        runStatus: run?.status,
      });
      return {
        id,
        name: info.name,
        title: info.title,
        status: speech.tone === 'blocked' ? 'blocked' : status,
        message: `${speech.label}：${speech.message}`,
      };
    }),
    {
      motion: document.documentElement.dataset.motion !== 'off',
      connected: connected && state.runtime?.available !== false,
      selectedId: selectedRoleId,
      consultingRoleId: escalationView(run)?.visitor || null,
    },
  );
  const runEvent = run?.events?.at(-1)?.at;
  $('office-state-caption').textContent =
    `担当状態：${!connected ? '接続未確認' : roleOrder.filter((id) => agentStatus(run, id) === 'working').length ? '作業中' : run?.status === 'completed' ? '報告済み・待機' : run?.status === 'needs_attention' ? '対応待ち' : '待機'} ／ 最終受信：${runEvent ? displayDate(runEvent) : '記録なし'} ／ 描画方式：${renderMode === 'webgl2' ? 'WebGL2を指定中（実際の方式は3D画面内に表示）' : '自動選択（実際の方式は3D画面内に表示）'}`;
}
window.addEventListener('pagehide', () => officeScene?.dispose(), { once: true });
mountSettings({
  mutate,
  onSaved: async () => {
    showingCurrentTeam = true;
    await loadState();
  },
});
experience = createExperience({
  run: selectedRun,
  roles: () => roleOrder.map(role),
  role,
  status: statusText,
  connected: () => connected && state.runtime?.available !== false,
  stopping: () =>
    stoppingRuns.has(selectedRun()?.id) && ['running', 'queued'].includes(selectedRun()?.status),
  agentStatus,
  agentMessage,
  workflow: () => workflowView(selectedRun(), connected && state.runtime?.available !== false),
  mutate,
  refresh: loadState,
  canContinue: () => connected && state.capabilities?.continuation && !state.activeRunId,
  followup: () => {
    experience.navigate('work');
    $('open-followup').click();
    $('followup-form').scrollIntoView({ block: 'start' });
  },
});
$('open-followup').addEventListener('click', () => experience.navigate('work'), { capture: true });
updateMotionSetting();
render();
loadProjects();
loadState();
window.setInterval(loadState, 2000);
