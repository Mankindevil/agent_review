import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROJECT_ENV_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');

export function parseEnvText(text) {
  const values = {};
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);

  for (const line of lines) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || !ENV_NAME.test(match[1])) continue;
    values[match[1]] = parseValue(match[2]);
  }

  return values;
}

export function applyEnv(values, target = process.env) {
  const applied = [];
  for (const [name, value] of Object.entries(values)) {
    if (target[name] !== undefined) continue;
    target[name] = String(value);
    applied.push(name);
  }
  return applied;
}

export async function loadEnvFile(file = process.env.ENV_FILE || PROJECT_ENV_FILE, target = process.env) {
  try {
    const values = parseEnvText(await readFile(file, 'utf8'));
    return { loaded: true, path: file, applied: applyEnv(values, target) };
  } catch (error) {
    if (error.code === 'ENOENT') return { loaded: false, path: file, applied: [] };
    throw new Error(`无法读取环境变量文件 ${file}: ${error.message}`, { cause: error });
  }
}

export async function loadFallbackEnv(target = process.env) {
  const file = target.ENV_FALLBACK_FILE?.trim();
  if (!file) return { loaded: false, path: null, applied: [] };
  return loadEnvFile(file, target);
}

function parseValue(raw) {
  const value = raw.trim();
  if (!value) return '';

  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1);
    return end === -1 ? value.slice(1) : value.slice(1, end);
  }

  if (value.startsWith('"')) {
    const end = findClosingDoubleQuote(value);
    const quoted = end === -1 ? value.slice(1) : value.slice(1, end);
    return quoted.replace(/\\(n|r|t|"|\\)/g, (_, escape) => ({ n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' })[escape]);
  }

  return value.replace(/\s+#.*$/, '').trim();
}

function findClosingDoubleQuote(value) {
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] === '"' && value[index - 1] !== '\\') return index;
  }
  return -1;
}

await loadEnvFile();
if (process.env.NODE_ENV !== 'test') await loadFallbackEnv();
