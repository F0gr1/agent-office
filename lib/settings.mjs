import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { roles, specialistIds } from './roles.mjs';

export const MAX_AGENTS = 20;
export const MAX_SKILLS = 100;
export const CORE_IDS = roles.map((role) => role.id);
const REQUIRED_IDS = CORE_IDS.filter((id) => !specialistIds.includes(id));
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const clone = (value) => structuredClone(value);

export function defaultSettings() {
  return {
    version: 2,
    skills: [],
    agents: roles.map((role) => ({
      ...role,
      instructions: '',
      skillIds: [],
      provider: 'codex',
      stage: ['qa', 'reviewer', 'reviewer2'].includes(role.id) ? 'review' : 'planning',
      enabled: true,
      useModeDefaults: true,
    })),
  };
}

function boundedString(value, label, max, { optional = false } = {}) {
  if (typeof value !== 'string' || value.length > max || (!optional && !value.trim()))
    throw Error(`${label}が正しくありません`);
  return value.trim();
}

export function validateSettings(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![1, 2].includes(value.version) ||
    !Array.isArray(value.agents) ||
    value.agents.length < CORE_IDS.length ||
    value.agents.length > MAX_AGENTS
  )
    throw Error('エージェント設定が正しくありません');
  if (value.version === 2 && (!Array.isArray(value.skills) || value.skills.length > MAX_SKILLS))
    throw Error('Officeスキル設定が正しくありません');
  const skillIds = new Set();
  const skills = (value.version === 2 ? value.skills : []).map((input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw Error('Officeスキル設定が正しくありません');
    const id = boundedString(input.id, 'スキルID', 64);
    if (!/^skill_[a-z0-9-]{1,58}$/.test(id) || skillIds.has(id))
      throw Error('スキルIDが正しくありません');
    skillIds.add(id);
    if (!Number.isSafeInteger(input.revision) || input.revision < 1)
      throw Error('スキルの版が正しくありません');
    if (typeof input.enabled !== 'boolean') throw Error('スキルの有効状態が正しくありません');
    return {
      id,
      name: boundedString(input.name, 'スキル名', 80),
      description: boundedString(input.description, 'スキル説明', 1000, { optional: true }),
      instructions: boundedString(input.instructions, 'スキル指示', 8000),
      revision: input.revision,
      enabled: input.enabled,
    };
  });
  const ids = new Set();
  const agents = value.agents.map((input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw Error('エージェント設定が正しくありません');
    const id = boundedString(input.id, 'ID', 64);
    if ((!CORE_IDS.includes(id) && !/^custom_[a-z0-9_]{1,57}$/.test(id)) || ids.has(id))
      throw Error('エージェントIDが正しくありません');
    ids.add(id);
    const isCore = CORE_IDS.includes(id);
    const name = boundedString(input.name, '名前', 80);
    const title = boundedString(input.title, '役割', 120);
    const description = boundedString(input.description, '説明', 1000, { optional: true });
    const instructions = boundedString(input.instructions ?? '', '指示', 8000, { optional: true });
    const assignedSkills = value.version === 1 ? [] : (input.skillIds ?? []);
    if (
      !Array.isArray(assignedSkills) ||
      assignedSkills.length > 10 ||
      assignedSkills.some(
        (item) => typeof item !== 'string' || !/^skill_[a-z0-9-]{1,58}$/.test(item),
      ) ||
      new Set(assignedSkills).size !== assignedSkills.length
    )
      throw Error('担当のスキル割当が正しくありません');
    const provider = input.provider ?? 'codex';
    if (!['codex', 'claude'].includes(provider)) throw Error('プロバイダーが正しくありません');
    const model = boundedString(input.model, 'モデル', 80);
    if (!MODEL_PATTERN.test(model)) throw Error('モデル名が正しくありません');
    if (provider === 'claude' && !/^(?:claude-[a-z0-9.-]+|sonnet|opus|haiku|fable)$/.test(model))
      throw Error('Claudeのモデル名を指定してください');
    const effort = boundedString(input.effort, '推論強度', 16);
    if (
      !EFFORTS.has(effort) ||
      (provider === 'claude' && !['low', 'medium', 'high', 'max'].includes(effort))
    )
      throw Error('推論強度が正しくありません');
    const stage =
      input.stage ??
      (isCore && ['qa', 'reviewer', 'reviewer2'].includes(id) ? 'review' : 'planning');
    if (!['planning', 'review'].includes(stage)) throw Error('担当工程が正しくありません');
    if (typeof input.enabled !== 'boolean') throw Error('有効状態が正しくありません');
    if (REQUIRED_IDS.includes(id) && !input.enabled)
      throw Error('必須エージェントは無効にできません');
    const useModeDefaults = input.useModeDefaults ?? false;
    if (typeof useModeDefaults !== 'boolean') throw Error('モード設定が正しくありません');
    return {
      id,
      name,
      title,
      description,
      instructions,
      skillIds: [...assignedSkills],
      provider,
      model,
      effort,
      stage,
      enabled: input.enabled,
      useModeDefaults,
    };
  });
  for (const id of CORE_IDS) if (!ids.has(id)) throw Error(`必須エージェント ${id} がありません`);
  for (const agent of agents) {
    const length = agent.skillIds.reduce((total, id) => {
      const skill = skills.find((entry) => entry.id === id);
      return total + (skill?.enabled ? skill.instructions.length : 0);
    }, 0);
    if (length > 32000) throw Error('担当へのスキル指示は合計32000字以内にしてください');
  }
  return { version: 2, skills, agents };
}

export class SettingsStore {
  constructor({ dataDir }) {
    this.path = join(dataDir, 'settings.json');
    mkdirSync(dataDir, { recursive: true });
    this.value = existsSync(this.path)
      ? validateSettings(JSON.parse(readFileSync(this.path, 'utf8')))
      : defaultSettings();
  }

  get() {
    return clone(this.value);
  }

  save(value) {
    if (value?.version === 1 && this.value.version === 2 && this.value.skills.length)
      throw Error('古い設定形式ではスキルを上書きできません。再読み込みしてください');
    if (
      value?.version === 2 &&
      this.value.agents.some(
        (agent) =>
          agent.skillIds.length &&
          !Array.isArray(value.agents?.find((item) => item.id === agent.id)?.skillIds),
      )
    )
      throw Error('古い設定形式では担当のスキル割当を上書きできません。再読み込みしてください');
    const valid = validateSettings(value);
    const previous = new Map(this.value.skills.map((skill) => [skill.id, skill]));
    for (const skill of valid.skills) {
      const old = previous.get(skill.id);
      if (!old) {
        if (skill.revision !== 1) throw Error('新しいスキルの版は1にしてください');
        continue;
      }
      const changed = ['name', 'description', 'instructions', 'enabled'].some(
        (key) => skill[key] !== old[key],
      );
      skill.revision = changed ? old.revision + 1 : old.revision;
      if (!Number.isSafeInteger(skill.revision)) throw Error('スキルの版の上限に達しました');
    }
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(valid, null, 2), { mode: 0o600, flag: 'wx' });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.path);
      this.value = valid;
      return this.get();
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
