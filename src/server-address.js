export function resolveServerAddress(env = process.env) {
  const port = Number(env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT 必須是 1 到 65535 之間的整數');
  }
  return {
    host: String(env.HOST || '').trim() || undefined,
    port
  };
}
