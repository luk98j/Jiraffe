import { buildServer, listen } from './app.ts';

const app = buildServer({ version: '0.1.0' });
await listen(app);
console.log('Jiraffe server listening on http://127.0.0.1:' + (app.server.address() as { port: number }).port);
