import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const html = read('../public/index.html');
const init = read('../public/theme-init.js');

function initializeTheme(savedValue, storageAvailable = true) {
  const root = { dataset: {} };
  const meta = { content: '#f7f5ed' };
  runInNewContext(init, {
    localStorage: {
      getItem(key) {
        assert.equal(key, 'agent-office-theme');
        if (!storageAvailable) throw new Error('Storage unavailable');
        return savedValue;
      },
    },
    document: {
      documentElement: root,
      querySelector(selector) {
        assert.equal(selector, 'meta[name="theme-color"]');
        return meta;
      },
    },
  });
  return { root, meta };
}

test('saved dark theme is restored before the stylesheet loads', () => {
  const { root, meta } = initializeTheme('dark');
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(meta.content, '#171e1a');
});

test('saved light theme leaves the initial light appearance', () => {
  const { root, meta } = initializeTheme('light');
  assert.equal(root.dataset.theme, undefined);
  assert.equal(meta.content, '#f7f5ed');
});

test('unavailable storage does not block initial rendering', () => {
  const { root, meta } = initializeTheme(null, false);
  assert.equal(root.dataset.theme, undefined);
  assert.equal(meta.content, '#f7f5ed');
});

test('theme initializer is same-origin and allowed by the served CSP', () => {
  const server = read('../server.mjs');
  const build = read('../scripts/build.mjs');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0);
  assert.ok(scripts.every(([, , body]) => body.trim() === ''));
  const src = scripts[0][1].match(/\bsrc="([^"]+)"/)?.[1];
  assert.equal(src, './theme-init.js');
  assert.ok(html.indexOf(scripts[0][0]) < html.indexOf('<link rel="stylesheet"'));
  assert.equal(new URL(src, 'http://127.0.0.1:4317/').origin, 'http://127.0.0.1:4317');
  assert.match(server, /\['\/theme-init\.js', 'theme-init\.js'\]/);
  const scriptPolicy = server.match(/script-src ([^;]+);/)?.[1];
  assert.equal(scriptPolicy, "'self'");
  assert.match(server, /setSecurityHeaders\(res\);[\s\S]*return serveStatic\(url\.pathname, res\)/);
  assert.match(server, /filename\.endsWith\('\.js'\)\s*\? 'text\/javascript; charset=utf-8'/);
  assert.match(build, /\['index\.html', 'app\.js', 'styles\.css', 'theme-init\.js'\]/);
});

test('desktop package includes every local asset referenced by the Office HTML', () => {
  const script = read('../scripts/package-desktop.mjs');
  const copyList = script.match(
    /for \(const file of \[([^\]]+)\]\)\s*cpSync\(join\(root, 'public', file\), join\(backend, 'public', file\)\)/,
  )?.[1];
  assert.ok(copyList, 'Desktop public asset copy list must be present');
  const copied = new Set([...copyList.matchAll(/'([^']+)'/g)].map((match) => match[1]));
  const referenced = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((match) => match[1]);
  assert.ok(referenced.length > 0);
  for (const asset of referenced) assert.ok(copied.has(asset), `${asset} is missing from Desktop`);
});
