export function prepareSkillApplication(run, role) {
  if (!run.skillSnapshot) return { status: 'unrecorded', entries: [], promptSkills: [] };
  const ids = role.skillIds || [];
  if (!ids.length) return { status: 'not_assigned', entries: [], promptSkills: [] };
  const definitions = new Map(run.skillSnapshot.definitions.map((skill) => [skill.id, skill]));
  const entries = [];
  const promptSkills = [];
  for (const skillId of ids) {
    const skill = definitions.get(skillId);
    if (!skill) {
      entries.push({
        skillId,
        revision: null,
        name: skillId,
        status: 'missing',
        reason: '参照不能',
      });
    } else if (!skill.enabled) {
      entries.push({
        skillId,
        revision: skill.revision,
        name: skill.name,
        status: 'disabled',
        reason: '無効のため未適用',
      });
    } else {
      entries.push({
        skillId,
        revision: skill.revision,
        name: skill.name,
        status: 'injected',
        reason: 'プロンプトへ適用',
      });
      promptSkills.push(skill);
    }
  }
  return { status: 'prepared', entries, promptSkills };
}
