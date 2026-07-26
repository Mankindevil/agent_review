import path from 'node:path';

const SYSTEM_ENV_KEYS = [
  'PATH', 'Path', 'PATHEXT',
  'SystemRoot', 'SYSTEMROOT', 'WINDIR',
  'ComSpec', 'COMSPEC',
  'LANG', 'LANGUAGE', 'LC_ALL', 'TERM'
];

const CLAUDE_ENV_KEYS = [
  ...SYSTEM_ENV_KEYS,
  'CLAUDE_CODE_EFFORT_LEVEL'
];

export function localCliEnv(
  runtimeId,
  workspace,
  parentEnv = process.env,
  { cursorConfigHome } = {}
) {
  const env = { NO_COLOR: '1' };
  const allowedKeys = runtimeId === 'claude-code' ? CLAUDE_ENV_KEYS : SYSTEM_ENV_KEYS;
  for (const key of allowedKeys) {
    if (typeof parentEnv[key] === 'string' && parentEnv[key]) env[key] = parentEnv[key];
  }

  const disposableCursorConfigHome = runtimeId === 'cursor'
    ? normalizedAbsolutePath(cursorConfigHome)
    : null;
  if (runtimeId === 'cursor') env.AGENT_CLI_CREDENTIAL_STORE = 'file';

  // Windows Cursor CLI persists tokens at %APPDATA%\Cursor\auth.json, not under
  // XDG_CONFIG_HOME/cursor/. Point APPDATA at the auth home so isolated probes
  // and runs can see the durable login without the host Roaming profile.
  const windowsCursorAppData = runtimeId === 'cursor'
    && process.platform === 'win32'
    && disposableCursorConfigHome
    ? disposableCursorConfigHome
    : workspace;

  return {
    ...env,
    HOME: workspace,
    USERPROFILE: workspace,
    APPDATA: windowsCursorAppData,
    LOCALAPPDATA: workspace,
    XDG_CONFIG_HOME: disposableCursorConfigHome || workspace,
    XDG_CACHE_HOME: workspace,
    XDG_DATA_HOME: workspace,
    XDG_STATE_HOME: workspace,
    TMPDIR: workspace,
    TMP: workspace,
    TEMP: workspace
  };
}

export function cursorAuthConfigHome(env = process.env) {
  return normalizedAbsolutePath(env.CURSOR_AUTH_CONFIG_HOME);
}

function normalizedAbsolutePath(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const candidate = value.trim();
  return path.isAbsolute(candidate) ? candidate : null;
}
