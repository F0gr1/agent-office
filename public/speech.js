// Keep stage completion separate from final approval of the whole request.
export function speechFor({ id, status, message, verdict, runStatus }) {
  if (status === 'unknown') return { label: '接続確認中', message, tone: 'unknown' };
  if (status === 'working') return { label: '作業中', message, tone: 'working' };
  if (status === 'blocked' || verdict === 'blocked')
    return { label: '確認が必要', message, tone: 'blocked' };
  if (status === 'done' && verdict === 'revise')
    return { label: '修正をお願いします', message, tone: 'blocked' };
  if (id === 'commander' && runStatus === 'completed' && verdict === 'pass') {
    return { label: '最終OK · 依頼完了', message, tone: 'done' };
  }
  if (status === 'done') return { label: '担当工程を完了', message, tone: 'done' };
  if (status === 'stopped') return { label: '作業停止', message, tone: 'unknown' };
  if (status === 'skipped' || status === 'legacy')
    return { label: '今回はお休み', message, tone: 'idle' };
  return { label: '待機中', message, tone: 'idle' };
}
