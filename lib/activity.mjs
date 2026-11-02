const labels = Object.freeze({
  search: ['検索中', '検索処理が終了しました', '検索処理が終了し、次の更新を待っています'],
  read: ['資料を確認中', '資料の確認が終了しました', '資料の確認が終了し、次の更新を待っています'],
  test: ['テスト中', 'テスト処理が終了しました', 'テスト処理が終了し、次の更新を待っています'],
  edit: ['変更を確認中', '変更処理が終了しました', '変更処理が終了し、次の更新を待っています'],
  tool: [
    '連携ツールを使用中',
    '連携ツールの処理が終了しました',
    '連携ツールの処理が終了し、次の更新を待っています',
  ],
  command: [
    'コマンドを実行中',
    'コマンドの処理が終了しました',
    'コマンドの処理が終了し、次の更新を待っています',
  ],
  web: ['Web資料を検索中', 'Web検索が終了しました', 'Web検索が終了し、次の更新を待っています'],
  plan: [
    '作業計画を更新中',
    '作業計画の更新が終了しました',
    '作業計画の更新が終了し、次の更新を待っています',
  ],
  reasoning: [
    '内容を整理中',
    '内容の整理が終了しました',
    '内容の整理が終了し、次の更新を待っています',
  ],
});

export function commandCategory(command) {
  if (typeof command !== 'string') return 'command';
  let value = command.trim();
  const wrapped = value.match(
    /^(?:(?:\/usr\/bin\/env\s+)?(?:\/(?:usr\/)?bin\/)?(?:bash|zsh|sh))\s+-l?c\s+(['"])([\s\S]*)\1$/,
  );
  if (wrapped) {
    const [, quote, inner] = wrapped;
    // Only peel a literal, simple shell argument. Ambiguous escaping or expansion stays generic.
    if (inner.includes(quote) || /[\\$]/.test(inner)) return 'command';
    value = inner.trim();
  }
  // Compound shell expressions can do more than their first executable suggests.
  if (!value || /[|;&<>\n\r`]/.test(value) || value.includes('$(')) return 'command';
  if (/^(?:rg|grep)(?:\s|$)/.test(value)) return 'search';
  if (
    /^git\s+(?:diff|show|log|status)(?:\s|$)/.test(value) ||
    /^(?:cat|sed|head|tail|less)(?:\s|$)/.test(value)
  )
    return 'read';
  if (
    /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?:\s|$)/.test(value) ||
    /^(?:node\s+--test|pytest|go\s+test|cargo\s+test)(?:\s|$)/.test(value)
  )
    return 'test';
  if (/^apply_patch(?:\s|$)/.test(value)) return 'edit';
  return 'command';
}

export function categoryForItem(item) {
  switch (item?.type) {
    case 'command_execution':
      return commandCategory(item.command);
    case 'file_change':
      return 'edit';
    case 'mcp_tool_call':
      return 'tool';
    case 'web_search':
      return 'web';
    case 'plan_update':
      return 'plan';
    case 'reasoning':
      return 'reasoning';
    case 'agent_message':
      return 'reasoning';
    default:
      return null;
  }
}

export class ActivityTracker {
  constructor(onEvent, now = () => new Date().toISOString()) {
    this.onEvent = onEvent;
    this.now = now;
    this.active = new Map();
    this.completed = new Set();
    this.completedSteps = 0;
    this.repeatFailures = 0;
    this.category = 'plan';
    this.lastEventAt = null;
  }

  emit(message, phase, category = this.category) {
    this.category = category;
    this.lastEventAt = this.now();
    const activeSince = this.active.size
      ? [...this.active.values()].map((entry) => entry.at).sort()[0]
      : null;
    const progress = {
      phase,
      category,
      completedSteps: this.completedSteps,
      activeCount: this.active.size,
      lastEventAt: this.lastEventAt,
      activeSince,
      repeatFailures: this.repeatFailures,
    };
    if (typeof this.onEvent === 'function') this.onEvent(message, progress);
    return progress;
  }

  setRepeatFailures(count) {
    this.repeatFailures = count;
  }

  ingest(event) {
    if (event?.type === 'turn.started') {
      return {
        accepted: true,
        progress: this.emit('担当の作業を開始しました', 'starting', 'plan'),
      };
    }
    if (event?.type === 'turn.completed') {
      this.active.clear();
      return { accepted: true, progress: this.emit('回答を受領し、終了を確認中', 'finalizing') };
    }
    if (event?.type === 'turn.failed' || event?.type === 'error') {
      this.active.clear();
      return { accepted: true, progress: this.emit('作業を確認してください', 'blocked') };
    }
    if (!['item.started', 'item.completed'].includes(event?.type)) return { accepted: false };
    const category = categoryForItem(event.item);
    if (!category) return { accepted: false };
    const id =
      typeof event.item.id === 'string' || typeof event.item.id === 'number'
        ? String(event.item.id)
        : null;
    if (event.type === 'item.started') {
      if (id && (this.active.has(id) || this.completed.has(id))) return { accepted: false };
      if (id) this.active.set(id, { at: this.now(), category, type: event.item.type });
      else this.active.set(Symbol(), { at: this.now(), category, type: event.item.type });
      return { accepted: true, progress: this.emit(labels[category][0], 'executing', category) };
    }
    if (id && this.completed.has(id)) return { accepted: false };
    let key = id;
    if (!id)
      key = [...this.active.keys()].find(
        (candidate) =>
          typeof candidate === 'symbol' && this.active.get(candidate).type === event.item.type,
      );
    if (key !== undefined && key !== null) this.active.delete(key);
    if (id) this.completed.add(id);
    this.completedSteps++;
    const phase = this.active.size ? 'executing' : 'evaluating';
    const message = this.active.size ? labels[category][1] : labels[category][2];
    return { accepted: true, progress: this.emit(message, phase, category) };
  }
}
