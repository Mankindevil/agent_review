import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function selectTestFiles(discovered, requested) {
  if (requested.length) return [...requested];
  return discovered
    .filter((file) => /^test\/[^/]+\.test\.js$/u.test(file.replaceAll('\\', '/')))
    .sort();
}

function runTests() {
  const discovered = readdirSync('test', { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => `test/${entry.name}`);
  const files = selectTestFiles(discovered, process.argv.slice(2));
  const child = spawn(process.execPath, ['--test', ...files], {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'test' }
  });

  child.once('error', (error) => {
    console.error(error);
    process.exitCode = 1;
  });

  child.once('exit', (code, signal) => {
    if (signal) {
      console.error(`Test runner exited after signal ${signal}`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = code ?? 1;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTests();
}
