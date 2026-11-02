import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { specialistIds, runModes } from './lib/roles.mjs';

export class InputError extends Error {}

export function resolveMode(mode) {
  if (mode === undefined || mode === null || mode === '') return 'standard';
  if (!runModes.includes(mode)) throw new InputError('モデル設定が不正です');
  return mode;
}

function isAvailableDirectory(path) {
  try {
    return isAbsolute(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function readProjects(file) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    data = { syncedAt: null, source: '登録プロジェクトは未設定です', projects: [] };
  }
  if (!Array.isArray(data.projects)) throw new InputError('プロジェクト一覧の形式が不正です');
  return {
    syncedAt: data.syncedAt,
    source: data.source,
    projects: data.projects.map((project) => ({
      id: project.id,
      label: project.label,
      path: project.path,
      available: isAvailableDirectory(project.path),
    })),
  };
}

function resolveWorkspace(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw new InputError('存在する作業フォルダの絶対パスを指定してください');
  }
  let workspace;
  try {
    if (!statSync(path).isDirectory()) throw Error();
    workspace = realpathSync(path);
  } catch {
    throw new InputError('作業フォルダが見つかりません');
  }
  if (workspace === '/' || workspace === process.env.HOME) {
    throw new InputError('専用の作業フォルダを指定してください');
  }
  return workspace;
}

function resolveProject(projectId, workspace, catalog) {
  if (projectId !== undefined && typeof projectId !== 'string') {
    throw new InputError('プロジェクトを選び直してください');
  }
  if (!projectId || projectId === '__custom') return null;

  const selected = catalog.projects.find((project) => project.id === projectId);
  if (!selected || !selected.available) {
    throw new InputError('選択したプロジェクトが見つからないか、フォルダを利用できません');
  }
  if (realpathSync(selected.path) !== workspace) {
    throw new InputError(
      '選択したプロジェクトと作業フォルダが一致しません。プロジェクトを選び直してください',
    );
  }
  return { id: selected.id, label: selected.label, path: workspace };
}

function resolveSpecialists(value) {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > specialistIds.length ||
    !value.every((id) => specialistIds.includes(id))
  ) {
    throw new InputError('参加する専門担当の指定が不正です');
  }
  return [...new Set(value)];
}

export function resolveProjectInput(body, catalog) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new InputError('入力形式が不正です');
  }
  const workspace = resolveWorkspace(body.workspace);
  return {
    workspace,
    project: resolveProject(body.projectId, workspace, catalog),
    specialists: resolveSpecialists(body.specialists),
  };
}
