import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Only allowlisted, scalar defaults are returned. Never expose configuration,
// credentials, MCP sections, or the text of user instructions to the browser.
export function codexGlobal(root = process.env.CODEX_HOME || join(homedir(), '.codex')) {
  const files = Object.fromEntries(
    ['config.toml', 'AGENTS.md', 'AGENTS.override.md'].map((name) => [
      name,
      existsSync(join(root, name)),
    ]),
  );
  const result = {
    checkedAt: new Date().toISOString(),
    status: 'unavailable',
    fields: {},
    files,
    agentRoleIds: [],
    note: '既定値の読取結果です。プロジェクト・起動時指定を含む実効値は未確認です。Globalへの適用・継承は未対応です。',
  };
  try {
    const config = readFileSync(join(root, 'config.toml'), 'utf8');
    const rootText = config.split(/^\s*\[/m)[0];
    for (const key of ['model', 'model_reasoning_effort']) {
      const match = rootText.match(
        new RegExp(`^\\s*${key}\\s*=\\s*["']([A-Za-z0-9._:-]{1,80})["']\\s*(?:#.*)?$`, 'm'),
      );
      if (match) result.fields[key] = match[1];
    }
    result.agentRoleIds = [
      ...config.matchAll(/^\s*\[agents\.([A-Za-z0-9_-]{1,64})\]\s*(?:#.*)?$/gm),
    ].map((match) => match[1]);
    result.status = 'read';
  } catch {
    result.note = 'Global設定を読み取れませんでした。Officeの担当設定は引き続き利用できます。';
  }
  return result;
}

export function projectHistory(file, project) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { source: 'Codex履歴の取得時点の情報', syncedAt: null, items: [], available: false };
  }
  const items = (Array.isArray(data.items) ? data.items : [])
    .filter((item) => project && (item.projectId === project.id || item.cwd === project.path))
    .map((item) => ({
      id: item.id,
      title: item.title,
      cwd: item.cwd,
      match: item.projectId === project.id ? 'project' : 'folder',
      projectId: item.projectId || null,
    }));
  return {
    source: 'Codex履歴メタデータの取得時点の情報（本文・自動同期なし）',
    syncedAt: data.syncedAt,
    items,
    available: true,
  };
}
