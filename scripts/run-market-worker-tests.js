import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function resolvePythonCommand(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const cwd = options.cwd ?? process.cwd();
  const exists = options.exists ?? existsSync;
  const commandExists = options.commandExists ?? defaultCommandExists;
  if (String(env.PANDA_DATA_PYTHON || '').trim()) {
    return env.PANDA_DATA_PYTHON;
  }

  const virtualenvPython = path.resolve(
    cwd,
    platform === 'win32'
      ? '.venv/Scripts/python.exe'
      : '.venv/bin/python'
  );
  if (exists(virtualenvPython)) return virtualenvPython;

  const candidates = platform === 'win32'
    ? ['python', 'py']
    : ['python3', 'python'];
  const discovered = candidates.find((candidate) => commandExists(candidate));
  if (discovered) return discovered;
  throw new Error(
    'Python interpreter not found; set PANDA_DATA_PYTHON or create the repository .venv'
  );
}

function defaultCommandExists(command) {
  const result = spawnSync(command, ['--version'], {
    stdio: 'ignore',
    windowsHide: true
  });
  return !result.error && result.status === 0;
}

function runTests() {
  let command;
  try {
    command = resolvePythonCommand();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  const child = spawn(
    command,
    [
      '-m',
      'unittest',
      'discover',
      '-s',
      'test/market-worker',
      '-p',
      'test_*.py'
    ],
    {
      stdio: 'inherit',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    }
  );
  child.once('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runTests();
}
