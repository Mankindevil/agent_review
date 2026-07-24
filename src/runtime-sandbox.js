import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

const DEFAULT_CURSOR_AUTH_CONFIG_HOME = '/var/lib/agent-review/cursor-auth';
const ABSOLUTE_READ_DENIES = [
  '/proc/**', '/run/**', '/tmp/**', '/sys/**', '/dev/**',
  '/etc/**', '/opt/**', '/var/**', '/home/**', '/root/**',
  '/mnt/**', '/media/**'
];

export async function prepareRuntimeWorkspace(runtimeId, workspace, {
  cursorAuthConfigHome = process.env.CURSOR_AUTH_CONFIG_HOME
} = {}) {
  if (runtimeId !== 'cursor') return;
  const directory = path.join(workspace, '.cursor');
  const authHome = normalizeAbsoluteRulePath(cursorAuthConfigHome)
    || DEFAULT_CURSOR_AUTH_CONFIG_HOME;
  const permissions = {
    permissions: {
      allow: [],
      deny: [
        'Shell(*)',
        'WebFetch(*)',
        'WebSearch(*)',
        'Mcp(*)',
        'Write(**)',
        'Write(/**)',
        'Read(**)',
        'Read(/**)',
        'Read(**/.env*)',
        'Read(**/*.key)',
        'Read(**/*.pem)',
        ...ABSOLUTE_READ_DENIES.map((target) => `Read(${target})`),
        `Read(${authHome}/**)`,
        'Read(/opt/agent-review/**)',
        'Read(/var/lib/agent-review/**)'
      ]
    }
  };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(directory, 'cli.json'),
    `${JSON.stringify(permissions, null, 2)}\n`,
    { mode: 0o600 }
  );
}

function normalizeAbsoluteRulePath(value) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value.trim())) return null;
  return value.trim().replaceAll('\\', '/').replace(/\/+$/, '');
}
