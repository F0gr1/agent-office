import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const MAX_INSTRUCTION_LENGTH = 20000;
const MAX_CONTINUATION_BYTES = 160000;
const terminalStatuses = new Set(['completed', 'cancelled', 'failed', 'needs_attention']);

export class ContinuationError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function checkedWorkspace(source) {
  const path = source.workspace;
  if (typeof path !== 'string' || !isAbsolute(path))
    throw new ContinuationError(400, '継続元の作業フォルダが不正です');
  let canonical;
  try {
    if (!statSync(path).isDirectory()) throw Error();
    canonical = realpathSync(path);
  } catch {
    throw new ContinuationError(400, '継続元の作業フォルダが見つかりません');
  }
  if (canonical === '/' || canonical === process.env.HOME || canonical !== path)
    throw new ContinuationError(400, '継続元の作業フォルダを確認できません');
  if (source.project) {
    if (source.project.path !== path)
      throw new ContinuationError(400, '継続元のプロジェクトと作業フォルダが一致しません');
  }
  return path;
}

export function makeContinuation(source, input) {
  if (!terminalStatuses.has(source.status))
    throw new ContinuationError(409, '実行中の依頼は停止または完了後に継続してください');
  const instruction = typeof input.instruction === 'string' ? input.instruction.trim() : '';
  if (!instruction || input.instruction.length > MAX_INSTRUCTION_LENGTH)
    throw new ContinuationError(400, '追加指示を1〜20,000文字で入力してください');
  const workspace = checkedWorkspace(source);
  const expected = {
    workspace,
    project: source.project || null,
    mode: source.mode,
    specialists: source.selectionMode === 'auto' ? undefined : source.specialists,
  };
  for (const key of Object.keys(expected)) {
    if (input[key] !== undefined && !sameValue(input[key], expected[key]))
      throw new ContinuationError(400, `継続時に${key}を変更できません`);
  }
  const rootInstruction = source.rootInstruction ?? source.instruction;
  const userAdditions = [...(source.userAdditions || []), instruction];
  const priorResults = structuredClone(source.priorResults || {});
  for (const [id, agent] of Object.entries(source.agents || {})) {
    if (agent.result) priorResults[id] = structuredClone(agent.result);
  }
  const priorRun = {
    id: source.id,
    status: source.status,
    stage: source.stage,
    error: source.error || null,
  };
  const payload = { rootInstruction, userAdditions, priorResults, priorRun };
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_CONTINUATION_BYTES)
    throw new ContinuationError(
      413,
      '継続履歴が上限を超えました。新しい依頼として必要な内容をまとめて開始してください',
    );
  return {
    ...expected,
    instruction,
    continueFromRunId: source.id,
    ...payload,
  };
}
