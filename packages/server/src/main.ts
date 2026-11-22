import { readFileSync } from 'node:fs';
import { createEngine } from '@jiraffe/engine';
import { buildServer, listen } from './app.ts';

const version = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;
const engine = createEngine({
  dbPath: process.env.JIRAFFE_DB_PATH ?? './data/jiraffe.db',
  version,
});
const app = buildServer(engine);
await listen(app);
console.log(
  `Jiraffe server listening on http://127.0.0.1:${(app.server.address() as { port: number }).port}`,
);

// Not awaited: a slow Jira must not delay the UI.
void engine.start();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    engine.stop();
    void app.close().then(() => {
      engine.close();
      process.exit(0);
    });
  });
}
