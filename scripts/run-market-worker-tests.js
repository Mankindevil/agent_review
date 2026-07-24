import { spawn } from 'node:child_process';

const command = process.env.PANDA_DATA_PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
const child = spawn(command, ['-m', 'unittest', 'discover', '-s', 'test/market-worker', '-p', 'test_*.py'], {
  stdio: 'inherit',
  env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
});
child.once('error', (error) => { console.error(error); process.exitCode = 1; });
child.once('exit', (code) => { process.exitCode = code ?? 1; });
