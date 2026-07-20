import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const roots = ['server.js', 'src', 'public', 'scripts', 'examples/agents', 'test'];
const files = [];

for (const root of roots) {
  const info = await readdir(root, { withFileTypes: true }).catch(() => []);
  if (!info.length && root.endsWith('.js')) {
    files.push(root);
    continue;
  }
  for (const entry of info) {
    if (entry.isFile() && entry.name.endsWith('.js')) files.push(path.join(root, entry.name));
  }
}

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`Syntax OK · ${files.length} JavaScript files`);
