import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import {
  attachmentPreview,
  readAttachment,
  saveAttachments,
  validateUploads,
} from '../lib/attachments.mjs';
import { cliArgs } from '../lib/codex-runner.mjs';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const webp = 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA';
const text = (value) => Buffer.from(value).toString('base64');
const dataDir = () => mkdtempSync(join(tmpdir(), 'office-attachments-'));

test('寸法が上限を超える画像は全体デコード前に拒否する', () => {
  const original = childProcess.spawnSync;
  let converted = false;
  childProcess.spawnSync = (_file, args) => {
    if (args[0] === '-s') converted = true;
    return { status: 0, stdout: 'pixelWidth: 20000\npixelHeight: 20000' };
  };
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => saveAttachments(dataDir(), randomUUID(), [{ name: 'large.png', dataBase64: png }]),
      /寸法/,
    );
    assert.equal(converted, false);
  } finally {
    childProcess.spawnSync = original;
    syncBuiltinESMExports();
  }
});

test('画像と文書を別名保存し、内容と所有依頼を照合する', () => {
  const dir = dataDir(),
    runId = randomUUID();
  const saved = saveAttachments(dir, runId, [
    { name: 'same.png', dataBase64: png },
    { name: 'same.png', dataBase64: png },
    { name: 'notes.md', dataBase64: text('hello') },
  ]);
  assert.equal(saved.length, 3);
  assert.notEqual(saved[0].id, saved[1].id);
  assert.equal(attachmentPreview(dir, saved[2]).text, 'hello');
  assert.match(attachmentPreview(dir, saved[0]).dataUrl, /^data:image\/png;base64,/);
  assert.equal(readAttachment(dir, saved[0]).path.includes(runId), true);
  assert.equal(saveAttachments(dir, randomUUID(), [], saved).length, 3);
  assert.throws(
    () =>
      saveAttachments(
        dir,
        randomUUID(),
        Array(3).fill({ name: 'x.txt', dataBase64: text('x') }),
        saved,
      ),
    /5件/,
  );
  const path = readAttachment(dir, saved[0]).path;
  writeFileSync(path, 'tampered');
  assert.throws(() => readAttachment(dir, saved[0]));
});

test('WebP画像も実デコードして保存する', () => {
  const saved = saveAttachments(dataDir(), randomUUID(), [
    { name: 'sample.webp', dataBase64: webp },
  ]);
  assert.equal(saved[0].mime, 'image/webp');
});

test('PDFは保存情報を参照できるが本文を返さない', () => {
  const dir = dataDir();
  const [saved] = saveAttachments(dir, randomUUID(), [
    { name: 'report.pdf', dataBase64: text('%PDF-1.4\n%%EOF') },
  ]);
  const preview = attachmentPreview(dir, saved);
  assert.match(preview.note, /内容解析は未対応/);
  assert.equal(preview.text, undefined);
  assert.equal(preview.dataUrl, undefined);
});

test('形式偽装・パス名・破損・超過を拒否する', () => {
  assert.throws(() => validateUploads([{ name: '../a.png', dataBase64: png }]), /ファイル名/);
  assert.throws(
    () => validateUploads([{ name: 'fake.png', dataBase64: text('not image') }]),
    /実データ/,
  );
  assert.throws(() => validateUploads([{ name: 'a.jpg', dataBase64: png }]), /実データ/);
  assert.throws(() => validateUploads([{ name: 'a.txt', dataBase64: 'AA==' }]), /制御文字/);
  assert.throws(() => validateUploads([{ name: 'a.txt', dataBase64: '!!!!' }]), /データ形式/);
  assert.throws(
    () => validateUploads(Array(6).fill({ name: 'a.txt', dataBase64: text('x') })),
    /5件/,
  );
  assert.throws(
    () => validateUploads([{ name: 'a.txt', dataBase64: text('x'.repeat(100 * 1024 + 1)) }]),
    /容量/,
  );
});

test('保存先のシンボリックリンクと不正な参照を拒否する', () => {
  const dir = dataDir();
  symlinkSync(tmpdir(), join(dir, 'attachments'));
  assert.throws(
    () => saveAttachments(dir, randomUUID(), [{ name: 'a.txt', dataBase64: text('hello') }]),
    /保存先/,
  );
  assert.throws(
    () => readAttachment(dir, { ownerRunId: '../other', id: randomUUID(), ext: 'txt' }),
    /参照情報/,
  );
});

test('Codexへの画像パスは個別の--image引数になる', () => {
  const path = '/tmp/example.png';
  const args = cliArgs(
    { workspace: '/tmp', imagePaths: [path] },
    { id: 'builder', model: 'gpt-6.1-sol', effort: 'low' },
  );
  assert.deepEqual(args.slice(-3), ['--image', path, '-']);
});
