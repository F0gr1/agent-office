const groups = [
  [{ key: 'brief', role: 'commander', label: '指示整理' }],
  [{ key: 'researcher', role: 'researcher', label: '調査', optional: true }],
  [{ key: 'planner', role: 'planner', label: '仕様書' }],
  [{ key: 'architect', role: 'architect', label: '設計', optional: true }],
  [{ key: 'designer', role: 'designer', label: 'UI / UX', optional: true }],
  [{ key: 'builder', role: 'builder', label: '実装・修正' }],
  [{ key: 'qa', role: 'qa', label: 'QA', optional: true }],
  [
    { key: 'reviewer', role: 'reviewer', label: 'レビュー①' },
    { key: 'reviewer2', role: 'reviewer2', label: 'レビュー②' },
  ],
  [{ key: 'final', role: 'commander', label: '最終承認' }],
];
const labels = {
  idle: '待機',
  active: '現在ここ',
  done: '工程完了',
  blocked: '確認待ち',
  revise: '修正が必要',
  skipped: '今回は省略',
  stopped: '停止',
  unknown: '接続未確認',
};

export function resultEntries(run) {
  if (Array.isArray(run?.tasks) && run.tasks.length) return run.tasks.filter(Boolean);
  if (!run?.agents) return [];
  return Object.entries(run.agents)
    .filter(([, value]) => value && (value.result || value.output))
    .map(([roleId, value], index) => ({
      id: `legacy-${roleId}-${index}`,
      roleId,
      instruction: value.assignment || '',
      status: value.status,
      startedAt: value.startedAt,
      finishedAt: value.finishedAt,
      result: { ...value.result, content: value.result?.content || value.output },
      error: value.error,
      model: value.model,
      effort: value.effort,
      provider: value.provider,
    }));
}

function automaticWorkflow(run, connected) {
  const assignments = Array.isArray(run?.dispatch?.assignments)
    ? run.dispatch.assignments.filter((item) => item && typeof item.roleId === 'string')
    : [];
  const selected = new Set(['commander']);
  for (const item of assignments) selected.add(item.roleId);
  const roles = Array.isArray(run?.roles) ? run.roles : [];
  const ordered = ['commander', ...assignments.map((item) => item.roleId)].filter(
    (id, index, all) => all.indexOf(id) === index,
  );
  const tasks = Array.isArray(run?.tasks) ? run.tasks : [];
  const groups = ordered.map((id) => {
    const assignment = assignments.find((item) => item.roleId === id);
    const latest = tasks.filter((task) => task?.roleId === id).at(-1);
    const agent = run?.agents?.[id];
    let status = 'idle';
    const currentStatus = agent?.status || latest?.status;
    if (currentStatus === 'working') status = run.status === 'running' ? 'active' : 'stopped';
    else if (currentStatus === 'blocked') status = 'blocked';
    else if (currentStatus === 'done')
      status = latest?.result?.verdict === 'revise' ? 'revise' : 'done';
    if (!connected && ['active', 'blocked', 'stopped'].includes(status)) status = 'unknown';
    return [
      {
        key: id,
        role: id,
        label:
          roles.find((role) => role?.id === id)?.title || (id === 'commander' ? '指揮・統合' : id),
        reason: assignment?.reason || '',
        instruction: assignment?.instruction || '',
        status,
        stateLabel: labels[status],
      },
    ];
  });
  const skipped = !run?.dispatch
    ? []
    : roles
        .filter((role) => role?.id && !selected.has(role.id))
        .map((role) => ({
          role: role.id,
          label: role.title || role.name || role.id,
          reason: run?.agents?.[role.id]?.summary || '',
        }));
  const active = groups.flat().filter((item) => item.status === 'active');
  let headline = !run
    ? '依頼を待っています'
    : run.status === 'completed'
      ? '依頼が完了しました'
      : run.status === 'cancelled'
        ? '依頼を中止しました'
        : run.status === 'failed'
          ? 'エラー · 対応が必要'
          : run.status === 'needs_attention'
            ? '確認待ち · 次の指示が必要'
            : active.length
              ? `${active.map((item) => item.label).join('・')}が作業中`
              : assignments.length
                ? '選ばれた担当の更新を待っています'
                : '指揮官が担当を選んでいます';
  if (!connected) headline = '接続を確認中 · 表示は最後に取得した状態です';
  return {
    automatic: true,
    groups,
    skipped,
    headline,
    summary: run?.dispatch?.summary || '',
    consulting: false,
    round: run?.round || 0,
  };
}

function groupsFor(run) {
  const roles = Array.isArray(run?.roles) ? run.roles : [];
  const seen = new Set();
  const custom = roles.filter((role) => {
    if (!role || typeof role.id !== 'string' || !role.id.startsWith('custom_')) return false;
    if (!['planning', 'review'].includes(role.stage) || seen.has(role.id)) return false;
    seen.add(role.id);
    return true;
  });
  const customNode = (role) => ({
    key: role.id,
    role: role.id,
    label: role.title || role.name || role.id,
    optional: true,
    enabled: role.enabled !== false,
  });
  const planning = custom.filter((role) => role.stage === 'planning').map(customNode);
  const review = custom.filter((role) => role.stage === 'review').map(customNode);
  return [
    ...groups.slice(0, 5),
    ...planning.map((node) => [node]),
    ...groups.slice(5, 8),
    ...review.map((node) => [node]),
    ...groups.slice(8),
  ];
}

export function workflowView(run, connected = true) {
  if (run?.selectionMode === 'auto') return automaticWorkflow(run, connected);
  const incident = run?.escalation;
  const consulting = incident?.status === 'consulting' && run?.status === 'running';
  const progressed =
    (run?.round || 0) > 0 ||
    Object.entries(run?.agents || {}).some(
      ([id, a]) => id !== 'commander' && (a.startedAt || a.result),
    );
  const finalStarted =
    (run?.round || 0) > 0 &&
    run?.stage === 'commander' &&
    !consulting &&
    (!incident || incident.status === 'resolved' || incident.phase === 'final');
  const rows = groupsFor(run).map((group) =>
    group.map((node) => {
      const a = run?.agents?.[node.role];
      let status = 'idle';
      if (run) {
        if (node.key === 'brief' && progressed) status = 'done';
        else if (node.key === 'final' && run.status === 'completed') status = 'done';
        else if (node.key === 'final' && !finalStarted) status = 'idle';
        else if (
          node.optional &&
          (node.enabled === false ||
            a?.status === 'skipped' ||
            (Array.isArray(run.specialists) && !run.specialists.includes(node.role)))
        )
          status = 'skipped';
        else if (a?.status === 'working')
          status = run.status === 'running' && !consulting ? 'active' : 'stopped';
        else if (a?.result?.verdict === 'blocked' || a?.status === 'blocked') status = 'blocked';
        else if (a?.result?.verdict === 'revise') status = 'revise';
        else if (a?.status === 'done') status = 'done';
        if (consulting && node.role === 'commander' && node.key === 'brief' && !progressed)
          status = 'blocked';
        if (run.status === 'cancelled' && (status === 'active' || status === 'blocked'))
          status = 'stopped';
      }
      if (!connected && ['active', 'blocked', 'stopped'].includes(status)) status = 'unknown';
      return { ...node, status, stateLabel: labels[status] };
    }),
  );
  const active = rows
    .flat()
    .filter((n) => n.status === 'active')
    .map((n) => n.label);
  let headline = !run
    ? '依頼を待っています'
    : run.status === 'completed'
      ? '完了 · 指揮官の最終OK'
      : run.status === 'cancelled'
        ? '中止 · 作成済みの変更は残っています'
        : run.status === 'failed'
          ? 'エラー · 対応が必要'
          : run.status === 'needs_attention'
            ? '確認待ち · 次の指示が必要'
            : consulting
              ? '社長室 · 解決方法を相談中'
              : active.length
                ? `${active.join('・')}を実行中`
                : '次の工程への移行待ち';
  if (!connected) headline = '接続を確認中 · 表示は最後に取得した状態です';
  return { groups: rows, headline, consulting: connected && consulting, round: run?.round || 0 };
}
