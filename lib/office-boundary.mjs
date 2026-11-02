export function assertOfficeIntake(env = process.env) {
  if (env.AGENT_OFFICE_WORKER === '1') {
    const error = new Error(
      'Officeの担当実行からOfficeへ再転送できません。割り当てられた作業を直接実行してください。',
    );
    error.code = 'OFFICE_RECURSIVE_DISPATCH';
    throw error;
  }
}
