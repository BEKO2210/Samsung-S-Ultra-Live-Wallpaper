#!/usr/bin/env node
// Bundles a wallpaper into a single self-contained HTML file so it can be
// dropped into a "Web Page Live Wallpaper" app (Android) or opened offline.
// Inlines shared/style.css, shared/engine.js, and the wallpaper's main.js.
// Usage: node scripts/bundle-wallpaper.mjs <wallpaper-name>

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const name = process.argv[2] || 'milky-way';
const dir  = resolve(ROOT, 'wallpapers', name);

const css    = readFileSync(resolve(ROOT, 'shared/style.css'), 'utf8');
const engine = readFileSync(resolve(ROOT, 'shared/engine.js'), 'utf8');
const main   = readFileSync(resolve(dir, 'main.js'), 'utf8');

// Strip the ES-module import from main.js — we'll expose engine exports on
// a single object and rewrite the destructured names into that object.
const importMatch = main.match(/^import\s*\{([\s\S]*?)\}\s*from\s*['"][^'"]+['"];?\s*/m);
if (!importMatch) throw new Error('main.js does not start with an import block');
const imports = importMatch[1].split(',').map(s => s.trim()).filter(Boolean);
const mainBody = main.slice(importMatch[0].length);

// Rewrite engine.js: `export function foo` → `function foo` and collect names.
const exportedNames = [];
const engineStripped = engine.replace(
  /export\s+function\s+([A-Za-z_$][\w$]*)/g,
  (_m, id) => { exportedNames.push(id); return `function ${id}`; },
);

// Wrap engine in an inner IIFE so its top-level names don't collide with
// names that main.js destructures (e.g. both declare `createCanvas`).
const engineIife =
  `const __engine = (() => {\n${engineStripped}\n` +
  `return { ${exportedNames.join(', ')} };\n})();`;
const destructure = `const { ${imports.join(', ')} } = __engine;`;

const title = name.replace(/(^|-)([a-z])/g, (_m, s, c) => (s ? ' ' : '') + c.toUpperCase());

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,maximum-scale=1,user-scalable=no" />
<meta name="theme-color" content="#000000" />
<title>${title} — Live Wallpaper</title>
<style>
${css}
</style>
</head>
<body>
<div class="hud" id="hud">${title}</div>
<script>
(function () {
${engineIife}
${destructure}
${mainBody}
})();
</script>
</body>
</html>
`;

const outPath = resolve(dir, 'wallpaper.html');
writeFileSync(outPath, html);
console.log(`Wrote ${outPath} (${(html.length / 1024).toFixed(1)} KB)`);
