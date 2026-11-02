export function escalationView(run) {
  const incident = run?.escalation;
  if (!incident) return null;
  const status = incident.status;
  const waiting = ['awaiting_user', 'failed', 'exhausted'].includes(status);
  const consulting = status === 'consulting' && run.status === 'running';
  const title =
    {
      consulting: '社長室で解決方法を相談中',
      instructed: '指揮官が対応方針を決定',
      retrying: '指揮官の指示で再確認中',
      resolved: '相談への対応を終え、通常工程へ',
      awaiting_user: '社長室であなたの対応を待っています',
      failed: '指揮官の確認を完了できませんでした',
      exhausted: '自動相談の上限に達しました',
    }[status] || '社長室への相談';
  return {
    title: run.status === 'cancelled' ? '相談を中止しました' : title,
    waiting,
    consulting,
    visitor:
      (consulting || (waiting && run.status !== 'cancelled')) && incident.sourceRole !== 'commander'
        ? incident.sourceRole
        : null,
    reason: incident.reason || '',
    instruction: incident.result?.content || '',
    summary: incident.result?.summary || '',
  };
}
