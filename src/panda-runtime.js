import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DOCUMENT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '接口文档.md'
);
const cache = new Map();

export function buildPandaInterfaceReference(document, allowedMethods, {
  maxSectionChars = 12_000,
  maxTotalChars = 120_000
} = {}) {
  const source = String(document || '');
  const allowed = new Set(
    Array.isArray(allowedMethods)
      ? allowedMethods.filter((item) => typeof item === 'string' && item.trim())
      : []
  );
  if (!source.trim()) throw new Error('接口文档.md 为空');
  if (!allowed.size) throw new Error('Panda Data 白名单为空');

  const headings = [...source.matchAll(
    /^\*\*\d+\.\s+([A-Za-z][A-Za-z0-9_]*)\s+-[^\n]*\*\*\s*$/gmu
  )];
  const sections = [];
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const method = heading[1];
    if (!allowed.has(method)) continue;
    const start = heading.index;
    const end = headings[index + 1]?.index ?? source.length;
    let section = source.slice(start, end);
    const responseExample = section.search(/^\*\*响应示例\*\*\s*$/mu);
    if (responseExample >= 0) section = section.slice(0, responseExample);
    section = section.trim().replace(/\n{3,}/gu, '\n\n');
    sections.push(section.slice(0, maxSectionChars));
  }
  const missing = [...allowed].filter((method) =>
    !sections.some((section) => section.includes(` ${method} -`))
  );
  if (missing.length) {
    throw new Error(`接口文档.md 缺少白名单方法：${missing.join('、')}`);
  }
  const reference = [
    '# Panda Data 接口文档.md 白名单摘录',
    '',
    '调用形式：`import panda_data` 后调用以下只读方法；参数与字段以本摘录为准。',
    '',
    ...sections.flatMap((section) => [section, ''])
  ].join('\n').trim();
  return reference.slice(0, maxTotalChars);
}

export async function loadPandaInterfaceReference(allowedMethods, {
  documentPath = DEFAULT_DOCUMENT
} = {}) {
  const methods = [...new Set(allowedMethods || [])].sort();
  const key = `${documentPath}\n${methods.join(',')}`;
  if (!cache.has(key)) {
    cache.set(key, readFile(documentPath, 'utf8')
      .then((document) => buildPandaInterfaceReference(document, methods))
      .catch((error) => {
        cache.delete(key);
        throw error;
      }));
  }
  return cache.get(key);
}
