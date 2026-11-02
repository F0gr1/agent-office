// Model output is data: only configured, enabled roles can be dispatched.
export function validateDispatch(value, roles) {
  if (
    !value ||
    typeof value.summary !== 'string' ||
    !value.summary.trim() ||
    !Array.isArray(value.assignments) ||
    value.assignments.length > roles.length - 1
  )
    throw Error('社長の担当選定を確認できませんでした');
  const seen = new Set();
  const assignments = value.assignments.map((entry) => {
    const role = roles.find((role) => role.id === entry?.roleId);
    if (
      !role ||
      role.id === 'commander' ||
      !role.enabled ||
      seen.has(role.id) ||
      !['reason', 'instruction'].every(
        (key) => typeof entry[key] === 'string' && entry[key].trim() && entry[key].length <= 8000,
      )
    )
      throw Error('社長の担当選定に無効・重複した担当または不明な指示があります');
    seen.add(role.id);
    return { roleId: role.id, reason: entry.reason.trim(), instruction: entry.instruction.trim() };
  });
  // An independent check is required for file changes, but the commander chooses who.
  if (
    seen.has('builder') &&
    !assignments.some(({ roleId }) => {
      const role = roles.find((role) => role.id === roleId);
      return roleId !== 'builder' && role.stage === 'review';
    })
  )
    throw Error('実装には社長が選ぶ独立した確認担当が1名以上必要です');
  // Planning precedes changes; independent reviewers inspect the result afterwards.
  const phase = (id) =>
    id === 'builder' ? 1 : roles.find((role) => role.id === id).stage === 'review' ? 2 : 0;
  if (
    assignments.some((entry, i) => i > 0 && phase(entry.roleId) < phase(assignments[i - 1].roleId))
  )
    throw Error('担当の順序は準備・実装・検証の順にしてください');
  return { summary: value.summary.trim(), assignments };
}

export function dispatchInstruction(roles) {
  const catalog = roles
    .filter((role) => role.enabled && role.id !== 'commander')
    .map((role) => ({
      roleId: role.id,
      title: role.title,
      description: role.description,
      stage: role.id === 'builder' ? 'implementation' : role.stage,
      provider: role.provider,
      model: role.model,
      effort: role.effort,
    }));
  return `元の依頼・追加指示・既存成果を確認し、目標と完了条件を整理して今回必要な担当だけ選んでください。
全員を定型的に呼ばない。軽微な説明や判断は社長が直接回答してassignmentsを空配列にできる。調査だけの依頼には実装担当を呼ばない。前回の担当構成をそのまま再利用せず今回の必要性を判断する。
出力dispatchにsummary（全体方針）とassignments（roleId,reason,instructionの配列）を記載。選ぶ各担当の作業固有の必要性と具体的な依頼・完了条件を示す。使用可能な担当のみを各1回選び、準備→実装→確認の順序にする。全役割が任意だが、builderを使う場合は実装後の独立した確認担当（stage:review）を1名以上選ぶ。レビュー2名を固定で選ばない。実装の権限を持つのはbuilderのみ。担当のモデルや権限を変更しない。
社長だけで完了する場合contentに最終回答と根拠・確認範囲を記載する。担当を選ぶ場合contentに完了条件と引継ぎを記載する。情報不足ならblockedまたはreviseで返す。
使用可能な担当: ${JSON.stringify(catalog)}`;
}
