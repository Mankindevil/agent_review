import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const roots = ['server.js', 'src', 'public', 'scripts', 'examples/agents', 'agents/market-analyst', 'test', 'scripts/run-market-worker-tests.js'];
const files = [];

async function addJavaScriptFiles(root) {
  const info = await readdir(root, { withFileTypes: true }).catch(() => []);
  if (!info.length && root.endsWith('.js')) {
    files.push(root);
    return;
  }
  for (const entry of info) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) await addJavaScriptFiles(file);
    if (entry.isFile() && entry.name.endsWith('.js')) files.push(file);
  }
}

for (const root of roots) await addJavaScriptFiles(root);

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`Syntax OK · ${files.length} JavaScript files`);
