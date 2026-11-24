import { createApp } from './app.factory.js';
import { loadConfig } from './config/app-config.js';

const config = loadConfig(process.env);
const app = await createApp(config);
await app.listen(config.port);
