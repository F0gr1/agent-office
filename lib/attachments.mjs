import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';

const formats = {
  png: { mime: 'image/png', kind: 'image', max: 5 * 1024 * 1024 },
  jpg: { mime: 'image/jpeg', kind: 'image', max: 5 * 1024 * 1024 },
  webp: { mime: 'image/webp', kind: 'image', max: 5 * 1024 * 1024 },
  pdf: { mime: 'application/pdf', kind: 'stored', max: 5 * 1024 * 1024 },
  txt: { mime: 'text/plain', kind: 'text', max: 100 * 1024 },
  md: { mime: 'text/markdown', kind: 'text', max: 100 * 1024 },
  csv: { mime: 'text/csv', kind: 'text', max: 100 * 1024 },
  tsv: { mime: 'text/tab-separated-values', kind: 'text', max: 100 * 1024 },
  json: { mime: 'application/json', kind: 'text', max: 100 * 1024 },
  log: { mime: 'text/plain', kind: 'text', max: 100 * 1024 },
};
const idPattern = /^[a-f0-9-]{36}$/;
const decoder = new TextDecoder('utf-8', { fatal: true });

export class AttachmentError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function invalid(message) {
  throw new AttachmentError(message);
}
function safeName(name) {
  if (
    typeof name !== 'string' ||
    !name ||
    name.length > 180 ||
    /[\\/\u0000-\u001f\u007f]/.test(name) ||
    name === '.' ||
    name === '..'
  )
    invalid('添付ファイル名が不正です');
  return name;
}
function typeFor(name) {
  const ext = name.split('.').at(-1)?.toLowerCase();
  const normalized = ext === 'jpeg' ? 'jpg' : ext;
  if (!formats[normalized])
    invalid('この形式は添付できません。PNG/JPEG/WebP、テキスト資料、PDFに対応しています');
  return { ext: normalized, ...formats[normalized] };
}
function validateBytes(bytes, format) {
  if (!bytes.length || bytes.length > format.max) invalid('添付ファイルの容量が上限を超えています');
  if (format.kind === 'text') {
    let value;
    try {
      value = decoder.decode(bytes);
    } catch {
      invalid('テキスト資料はUTF-8で保存してください');
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))
      invalid('テキスト資料に制御文字が含まれています');
    if (format.ext === 'json') {
      try {
        JSON.parse(value);
      } catch {
        invalid('JSONファイルの内容が不正です');
      }
    }
    return;
  }
  if (format.ext === 'pdf') {
    if (
      bytes.subarray(0, 5).toString() !== '%PDF-' ||
      !bytes.subarray(-1024).includes(Buffer.from('%%EOF'))
    )
      invalid('PDFの内容を確認できません');
    return;
  }
  const png = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  const jpg =
    bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) &&
    bytes.subarray(-2).equals(Buffer.from('ffd9', 'hex'));
  const webp =
    bytes.subarray(0, 4).toString() === 'RIFF' &&
    bytes.subarray(8, 12).toString() === 'WEBP' &&
    bytes.readUInt32LE(4) + 8 === bytes.length;
  if (
    !(
      (format.ext === 'png' && png) ||
      (format.ext === 'jpg' && jpg) ||
      (format.ext === 'webp' && webp)
    )
  )
    invalid('画像の実データと形式が一致しません');
  if (format.ext === 'png' && bytes.includes(Buffer.from('acTL')))
    invalid('アニメーション画像は添付できません');
  if (format.ext === 'webp' && bytes.includes(Buffer.from('ANIM')))
    invalid('アニメーション画像は添付できません');
}

export function validateUploads(input = []) {
  if (!Array.isArray(input) || input.length > 5) invalid('添付は5件までです');
  let total = 0,
    textTotal = 0;
  return input.map((item) => {
    if (!item || typeof item !== 'object') invalid('添付データが不正です');
    const name = safeName(item.name);
    const format = typeFor(name);
    if (
      typeof item.dataBase64 !== 'string' ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.dataBase64)
    )
      invalid('添付のデータ形式が不正です');
    const bytes = Buffer.from(item.dataBase64, 'base64');
    if (bytes.toString('base64') !== item.dataBase64) invalid('添付のデータ形式が不正です');
    if (
      item.mime &&
      item.mime !== format.mime &&
      !(format.ext === 'jpg' && item.mime === 'image/jpeg') &&
      !(format.ext === 'log' && item.mime === '')
    )
      invalid('添付の申告形式が一致しません');
    validateBytes(bytes, format);
    total += bytes.length;
    if (format.kind === 'text') textTotal += bytes.length;
    if (total > 12 * 1024 * 1024 || textTotal > 200 * 1024)
      invalid('添付の合計容量が上限を超えています');
    return { name, format, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
}

function pathFor(dataDir, attachment) {
  if (
    !idPattern.test(attachment.ownerRunId) ||
    !idPattern.test(attachment.id) ||
    !formats[attachment.ext]
  )
    invalid('添付の参照情報が不正です');
  return join(dataDir, 'attachments', attachment.ownerRunId, `${attachment.id}.${attachment.ext}`);
}
export function readAttachment(dataDir, attachment) {
  const root = join(dataDir, 'attachments');
  const folder = join(root, attachment.ownerRunId || '');
  const path = pathFor(dataDir, attachment);
  try {
    if (lstatSync(root).isSymbolicLink() || lstatSync(folder).isSymbolicLink())
      invalid('添付の保存先が不正です');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size !== attachment.size) invalid('添付ファイルを確認できません');
      bytes = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
    if (createHash('sha256').update(bytes).digest('hex') !== attachment.sha256)
      invalid('添付ファイルが変更されています');
    return { path, bytes };
  } catch (error) {
    if (error instanceof AttachmentError) throw error;
    invalid('添付ファイルを確認できません');
  }
}
export function attachmentPreview(dataDir, attachment) {
  const { bytes } = readAttachment(dataDir, attachment);
  if (attachment.kind === 'image')
    return { ...attachment, dataUrl: `data:${attachment.mime};base64,${bytes.toString('base64')}` };
  if (attachment.kind === 'text') return { ...attachment, text: decoder.decode(bytes) };
  return { ...attachment, note: 'PDFは保存・参照のみ。内容解析は未対応です。' };
}
export function saveAttachments(dataDir, runId, uploads, inherited = []) {
  const checked = validateUploads(uploads);
  if (checked.length + inherited.length > 5) invalid('継承分を含む添付は5件までです');
  let total = checked.reduce((n, x) => n + x.bytes.length, 0),
    textTotal = checked
      .filter((x) => x.format.kind === 'text')
      .reduce((n, x) => n + x.bytes.length, 0);
  for (const attachment of inherited) {
    readAttachment(dataDir, attachment);
    total += attachment.size;
    if (attachment.kind === 'text') textTotal += attachment.size;
  }
  if (total > 12 * 1024 * 1024 || textTotal > 200 * 1024)
    invalid('継承分を含む添付の合計容量が上限を超えています');
  if (!checked.length) return [...inherited];
  const root = join(dataDir, 'attachments');
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) invalid('添付の保存先が不正です');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const folder = join(root, runId);
  mkdirSync(folder, { mode: 0o700 });
  try {
    const saved = checked.map(({ name, format, bytes, sha256 }) => {
      const id = randomUUID();
      const entry = {
        id,
        ownerRunId: runId,
        name,
        ext: format.ext,
        mime: format.mime,
        kind: format.kind,
        size: bytes.length,
        sha256,
      };
      const path = pathFor(dataDir, entry);
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeFileSync(fd, bytes);
      } finally {
        closeSync(fd);
      }
      if (format.kind === 'image') {
        const check = spawnSync('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path], {
          encoding: 'utf8',
          timeout: 5000,
        });
        const w = Number(check.stdout?.match(/pixelWidth: (\d+)/)?.[1]);
        const h = Number(check.stdout?.match(/pixelHeight: (\d+)/)?.[1]);
        if (check.status !== 0 || !w || !h || w * h > 16_000_000)
          invalid('画像をデコードできないか、寸法が上限を超えています');
        const decoded = join(folder, `${id}.validated.png`);
        const conversion = spawnSync(
          '/usr/bin/sips',
          ['-s', 'format', 'png', path, '--out', decoded],
          {
            encoding: 'utf8',
            timeout: 5000,
          },
        );
        rmSync(decoded, { force: true });
        if (conversion.status !== 0) invalid('画像をデコードできません');
      }
      return entry;
    });
    return [...inherited, ...saved];
  } catch (error) {
    rmSync(folder, { recursive: true, force: true });
    throw error;
  }
}
