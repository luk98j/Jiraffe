/** Fixed on purpose: the server is local-only and the host is not configurable. */
export const HOST = '127.0.0.1';

export function getPort(env: Record<string, string | undefined> = process.env): number {
  const raw = env.JIRAFFE_PORT;
  if (raw === undefined || raw === '') return 4317;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid JIRAFFE_PORT "${raw}"`);
  }
  return port;
}
