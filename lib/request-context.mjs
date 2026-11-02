const fields = ['outcome', 'done', 'scope', 'historyRefs'];
const historyFields = ['id', 'title', 'cwd'];
const MAX_CONTEXT_BYTES = 16000;
const MAX_TEXT_LENGTH = 4000;
const MAX_HISTORY_REFS = 10;

export class RequestContextError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkedText(value, name, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength)
    throw new RequestContextError(`${name}を1〜${maxLength}文字で入力してください`);
  return value.trim();
}

function optionalText(value, name) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > MAX_TEXT_LENGTH)
    throw new RequestContextError(`${name}は${MAX_TEXT_LENGTH}文字以内で入力してください`);
  return value.trim();
}

function rejectUnknownKeys(value, allowed, name) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new RequestContextError(`${name}に対応していない項目があります`);
}

export function validateRequestContext(value) {
  if (value === undefined) return null;
  if (!object(value)) throw new RequestContextError('依頼の文脈が正しくありません');
  rejectUnknownKeys(value, fields, '依頼の文脈');
  const result = {
    outcome: optionalText(value.outcome, '目標'),
    done: optionalText(value.done, '完了条件'),
    scope: optionalText(value.scope, '作業範囲'),
  };
  if (value.historyRefs !== undefined) {
    if (!Array.isArray(value.historyRefs) || value.historyRefs.length > MAX_HISTORY_REFS)
      throw new RequestContextError(`履歴参照は最大${MAX_HISTORY_REFS}件です`);
    result.historyRefs = value.historyRefs.map((ref) => {
      if (!object(ref)) throw new RequestContextError('履歴参照が正しくありません');
      rejectUnknownKeys(ref, historyFields, '履歴参照');
      return {
        id: checkedText(ref.id, '履歴ID', 200),
        title: checkedText(ref.title, '履歴タイトル', 300),
        cwd: checkedText(ref.cwd, '履歴の作業場所', 1024),
      };
    });
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_CONTEXT_BYTES)
    throw new RequestContextError('依頼の文脈が上限を超えています');
  return result;
}
