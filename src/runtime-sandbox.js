import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

const CURSOR_PERMISSIONS = {
  permissions: {
    allow: [],
    deny: [
      'Shell(*)',
      'Write(**)',
      'Read(**/.env*)',
      'Read(**/*.key)',
      'Read(**/*.pem)',
      'Read(/etc/**)',
      'Read(/opt/agent-review/**)',
      'Read(/var/lib/agent-review/**)'
    ]
  }
};

export async function prepareRuntimeWorkspace(runtimeId, workspace) {
  if (runtimeId !== 'cursor') return;
  const directory = path.join(workspace, '.cursor');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(directory, 'cli.json'),
    `${JSON.stringify(CURSOR_PERMISSIONS, null, 2)}\n`,
    { mode: 0o600 }
  );
}
