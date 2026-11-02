export const MAX_ESCALATIONS = 2;

// CLI failures can contain tool arguments or command output. Only known, fixed
// diagnostics are suitable for the run history and the commander's prompt.
export function safeErrorMessage(error) {
  if (error?.code === 'OFFICE_LOOP_GUARD')
    return '同じ操作の失敗が続いたため停止しました。実行条件の確認が必要です。';
  if (error?.message === '担当の回答形式を確認できませんでした') return error.message;
  if (error?.message === 'Codex実行エラー') return error.message;
  if (error?.message === '担当の実行が30分を超えたため停止しました') return error.message;
  return '担当の実行中にエラーが発生しました。実行環境と作業結果の確認が必要です。';
}

export function incidentEvidence(result, error) {
  if (result)
    return {
      verdict: result.verdict,
      summary: result.summary,
      issues: result.issues,
      checks: result.checks,
      content: result.content,
    };
  return {
    error: safeErrorMessage(error),
    code: error?.code === 'OFFICE_LOOP_GUARD' ? 'OFFICE_LOOP_GUARD' : 'RUNTIME_ERROR',
  };
}

export function isPermissionBlock(result) {
  if (result?.verdict !== 'blocked') return false;
  return /権限|許可|承認|認証|アクセス拒否|permission|approval|forbidden|unauthorized|sandbox/i.test(
    [result.summary, ...result.issues].join(' '),
  );
}
