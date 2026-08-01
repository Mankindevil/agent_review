import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function resolveReportPython(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const root = options.root ?? repositoryRoot;
  const exists = options.exists ?? existsSync;
  const explicit = String(env.REPORT_PDF_PYTHON || env.PANDA_DATA_PYTHON || '').trim();
  if (explicit) return explicit;

  const candidate = path.join(
    root,
    platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python'
  );
  if (exists(candidate)) return candidate;
  throw new Error(
    'PDF Python interpreter not found; set REPORT_PDF_PYTHON or PANDA_DATA_PYTHON, or create the repository .venv'
  );
}
