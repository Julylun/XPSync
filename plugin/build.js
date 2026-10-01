import { transform } from 'esbuild';
import { zipSync, strToU8, unzipSync } from 'fflate';
import { readFile, writeFile } from 'node:fs/promises';
const root = new URL('./', import.meta.url);
// These two browser modules have no third-party imports. Transform the combined
// source in memory, keeping builds portable in restricted Windows workspaces.
const engine = (await readFile(new URL('src/sync-engine.js', root), 'utf8')).replace(
  /^export /gm,
  '',
);
const host = (await readFile(new URL('src/host.js', root), 'utf8')).replace(/^import .*;\r?\n/, '');
const { code } = await transform(engine + '\n' + host, { format: 'iife', target: 'es2022' });
await writeFile(new URL('plugin.js', root), code);
const ui = await readFile(new URL('src/settings.html', root), 'utf8'),
  script = await readFile(new URL('src/settings.js', root), 'utf8');
await writeFile(new URL('index.html', root), ui.replace('/* XPSYNC_SETTINGS_SCRIPT */', script));
const files = {};
for (const name of ['manifest.json', 'plugin.js', 'index.html', 'icon.svg'])
  files[name] = strToU8(await readFile(new URL(name, root), 'utf8'));
const zip = zipSync(files, { level: 9 });
if (Object.keys(unzipSync(zip)).length !== 4) throw new Error('Invalid plugin archive');
await writeFile(new URL('xpsync.zip', root), zip);
console.log(`Built plugin/xpsync.zip (${zip.length} bytes)`);
