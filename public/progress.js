const labels = {
  starting: '担当を起動中',
  executing: 'ツール実行中',
  evaluating: '結果を受領・次の更新待ち',
  finalizing: '担当の回答を受領・終了確認中',
  blocked: '反復を停止・確認が必要',
};
export function duration(seconds) {
  const n = Math.max(0, Math.floor(seconds));
  return n < 60 ? `${n}秒` : `${Math.floor(n / 60)}分${String(n % 60).padStart(2, '0')}秒`;
}
export function progressView(agent, now = Date.now()) {
  const p = agent?.progress;
  const secondsSince = (stamp) => {
    const value = Date.parse(stamp);
    return Number.isFinite(value) ? Math.max(0, (now - value) / 1000) : null;
  };
  const total = secondsSince(agent?.startedAt);
  const silence = secondsSince(p?.lastEventAt || agent?.startedAt);
  const active = p?.activeCount > 0 ? secondsSince(p.activeSince) : null;
  const stale = silence !== null && silence >= 90;
  const label = p ? labels[p.phase] || '進捗の更新待ち' : '詳細な進捗の受信待ち';
  const activity = p ? agent.activity || label : label;
  return {
    label,
    activity,
    total: total === null ? '—' : duration(total),
    active: active === null ? null : duration(active),
    silence: silence === null ? '—' : duration(silence),
    stale,
    completed: Number.isSafeInteger(p?.completedSteps) ? p.completedSteps : 0,
    activeCount: Number.isSafeInteger(p?.activeCount) ? p.activeCount : 0,
    repeatFailures: Number.isSafeInteger(p?.repeatFailures) ? p.repeatFailures : 0,
    message: stale
      ? `${activity}。最終更新から${duration(silence)}（実行の継続状況は未確認）`
      : `${activity}（担当開始から${total === null ? '—' : duration(total)}）`,
  };
}
