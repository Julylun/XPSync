import { createApp } from './app.js';
import { loadConfig } from './config/index.js';
const config = loadConfig(),
  application = createApp(config);
const port = await application.listen();
console.log(`XPSync: http://${config.host}:${port}/admin/`);
if (!application.store.hasAdmin())
  console.log('Complete first-run setup in the dashboard using SETUP_TOKEN.');
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await application.close();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
