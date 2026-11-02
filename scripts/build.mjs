import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';
// Bundle dependencies locally so the app needs no CDN or new server routes.
await build({
  entryPoints: [new URL('../public/main.js', import.meta.url).pathname],
  outfile: new URL('../public/app.js', import.meta.url).pathname,
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  minify: true,
  legalComments: 'inline',
});

const css = [
  'base.css',
  'office-scene.css',
  'settings-enhancements.css',
  'experience.css',
  'theme.css',
].map((name) => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8'));
writeFileSync(new URL('../public/styles.css', import.meta.url), css.join('\n'));
const dist = new URL('../dist/', import.meta.url);
mkdirSync(dist, { recursive: true });
for (const name of ['index.html', 'app.js', 'styles.css', 'theme-init.js'])
  copyFileSync(new URL(`../public/${name}`, import.meta.url), new URL(name, dist));
