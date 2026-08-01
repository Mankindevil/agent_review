import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

const DEFAULT_CURSOR_AUTH_CONFIG_HOME = '/var/lib/agent-review/cursor-auth';
const DEFAULT_CLAUDE_SETTINGS = Object.freeze({
  baseUrl: 'https://llmx.tqx.ai',
  model: 'claude-sonnet-4-6'
});
const ABSOLUTE_READ_DENIES = [
  '/proc/**', '/run/**', '/tmp/**', '/sys/**', '/dev/**',
  '/etc/**', '/opt/**', '/var/**', '/home/**', '/root/**',
  '/mnt/**', '/media/**'
];

export async function prepareRuntimeWorkspace(runtimeId, workspace, {
  cursorAuthConfigHome = process.env.CURSOR_AUTH_CONFIG_HOME,
  claudeSettings = DEFAULT_CLAUDE_SETTINGS
} = {}) {
  if (runtimeId === 'claude-code') {
    const directory = path.join(workspace, '.claude');
    const settings = {
      $schema: 'https://json.schemastore.org/claude-code-settings.json',
      env: {
        CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
        CLAUDE_CODE_USE_BEDROCK: '0',
        CLAUDE_CODE_USE_FOUNDRY: '0',
        CLAUDE_CODE_USE_VERTEX: '0',
        ENABLE_TOOL_SEARCH: 'true',
        ...(claudeSettings ? { ANTHROPIC_API_KEY: '' } : {}),
        ...(claudeSettings?.baseUrl ? { ANTHROPIC_BASE_URL: claudeSettings.baseUrl } : {})
      },
      ...(claudeSettings?.model ? { model: claudeSettings.model } : {}),
      skipDangerousModePermissionPrompt: true,
      theme: 'auto'
    };
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(directory, 'settings.json'),
      `${JSON.stringify(settings, null, 2)}\n`,
      { mode: 0o600 }
    );
    return;
  }
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
