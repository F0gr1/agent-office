import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  openSync,
  closeSync,
  constants,
  fstatSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const MAX_BYTES = 64 * 1024;
export function skillDraftSnapshot(drafts) {
  return drafts
    .map(({ name, content }) => ({
      name,
      sha256: createHash('sha256').update(content).digest('hex'),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
function checkedDirectory(root, parts, create = false) {
  let path = root;
  for (const part of parts) {
    path = join(path, part);
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (create) {
        mkdirSync(path, { mode: 0o700 });
        stat = lstatSync(path);
      } else continue;
    }
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
      throw Error('Skillの配置先にリンクまたはフォルダー以外の項目があります');
  }
  return path;
}
function readRegular(path) {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_BYTES)
    throw Error('Skill草案は64KB以下の通常ファイルにしてください');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES)
      throw Error('Skill草案は64KB以下の通常ファイルにしてください');
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}
export function inspectSkillDrafts(workspace) {
  const directory = checkedDirectory(workspace, ['.office-preparation', 'skills']);
  if (!existsSync(directory)) return [];
  const names = readdirSync(directory);
  if (names.length > 20) throw Error('一度に配置できるSkill草案は20件までです');
  return names.map((name) => {
    if (name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
      throw Error('Skill草案の名前が不正です');
    const folder = checkedDirectory(workspace, ['.office-preparation', 'skills', name]);
    const files = readdirSync(folder);
    if (files.length !== 1 || files[0] !== 'SKILL.md')
      throw Error(
        '自動配置できる草案はSKILL.mdだけです。スクリプトや追加資料は別途確認してください',
      );
    const content = readRegular(join(folder, 'SKILL.md'));
    const metadata = content.match(
      /^---\r?\nname: ([a-z0-9-]+)\r?\ndescription: ("(?:[^"\\\r\n]|\\.)*")\r?\n---\r?\n([\s\S]+)$/,
    );
    if (!metadata || metadata[1] !== name)
      throw Error(
        'Skill草案のnameとフォルダー名を一致させ、descriptionはJSON形式の二重引用符で囲んでください',
      );
    const description = JSON.parse(metadata[2]);
    if (
      !description.trim() ||
      description.length > 1024 ||
      /[<>]/.test(description) ||
      !metadata[3].trim()
    )
      throw Error('Skill草案の説明または本文が不正です');
    return { name, content };
  });
}
export function publishSkillDrafts(workspace, drafts, { reviewed = false } = {}) {
  // Check every existing destination before writing any draft. Never replace a skill.
  let pending = 0;
  for (const draft of drafts) {
    if (
      typeof draft.name !== 'string' ||
      draft.name.length > 64 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draft.name)
    )
      throw Error('Skill草案の名前が不正です');
    const folder = checkedDirectory(workspace, ['.agents', 'skills', draft.name]);
    const path = join(folder, 'SKILL.md');
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (stat && readRegular(path) !== draft.content)
      throw Error(`既存Skill ${draft.name} は保持しました。草案との差分を確認してください`);
    if (!stat) pending++;
  }
  if (pending && !reviewed) throw Error('Skill草案の独立レビューが未完了です');
  return drafts.map((draft) => {
    const folder = checkedDirectory(workspace, ['.agents', 'skills', draft.name], true);
    const path = join(folder, 'SKILL.md');
    if (!existsSync(path)) writeFileSync(path, draft.content, { flag: 'wx', mode: 0o600 });
    else if (readRegular(path) !== draft.content)
      throw Error(`Skill ${draft.name} が変更されたため配置を中止しました`);
    return `.agents/skills/${draft.name}/SKILL.md`;
  });
}
