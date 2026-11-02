export const roles = [
  {
    id: 'commander',
    name: 'モカ',
    title: '指揮官',
    model: 'gpt-6-sol',
    effort: 'high',
    description: '依頼を整理し、担当へ指示。最後に依頼と成果を照合します。',
  },
  {
    id: 'researcher',
    name: 'ハル',
    title: '調査',
    model: 'gpt-6-luna',
    effort: 'high',
    description: '依頼に必要な資料と現状を調査し、根拠と未確認事項を整理します。',
  },
  {
    id: 'planner',
    name: 'ミント',
    title: 'PG · 仕様担当',
    model: 'gpt-6-sol',
    effort: 'high',
    description: '調査して仕様・完了条件・実装手順を作ります。',
  },
  {
    id: 'architect',
    name: 'レオ',
    title: '設計責任者',
    model: 'gpt-6-astra',
    effort: 'medium',
    description: '仕様と既存構成を照合し、実装設計と技術上のリスクを確認します。',
  },
  {
    id: 'designer',
    name: 'ニコ',
    title: 'UI/UX',
    model: 'gpt-6-sol',
    effort: 'high',
    description: '必要な画面と操作の流れを検討し、実装に渡すUI/UX要件を整理します。',
  },
  {
    id: 'builder',
    name: 'ピコ',
    title: 'PG2 · 実装担当',
    model: 'gpt-6-sol',
    effort: 'high',
    description: '仕様に沿ってコードとUIを実装し、テストします。',
  },
  {
    id: 'qa',
    name: 'ユキ',
    title: 'QA',
    model: 'gpt-6-sol',
    effort: 'high',
    description: '実装を読み取り専用で確認し、実行できた検証と未検証の範囲を分けて報告します。',
  },
  {
    id: 'reviewer',
    name: 'ルル',
    title: 'レビュワー',
    model: 'gpt-6-sol',
    effort: 'high',
    description: '仕様との一致・回帰・テストの根拠を独立して確認します。',
  },
  {
    id: 'reviewer2',
    name: 'ソラ',
    title: 'レビュワー2',
    model: 'gpt-6-astra',
    effort: 'medium',
    description: '境界条件・安全性・見落としを別の視点から確認します。',
  },
];

export const specialistIds = ['researcher', 'architect', 'designer', 'qa'];
export const runModes = ['economy', 'standard', 'careful'];

export function roleForMode(role, mode) {
  if (mode === 'careful' && role.id === 'commander') {
    return { ...role, model: 'gpt-6-astra', effort: 'high' };
  }
  if (mode === 'economy' && ['researcher', 'planner', 'designer'].includes(role.id)) {
    return { ...role, effort: 'medium' };
  }
  return { ...role };
}
