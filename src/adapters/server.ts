/**
 * Production Node.js server adapter.
 * Long-running server bound to all interfaces for deployment in containers or VMs.
 */

import 'dotenv/config';
import { serve } from '@hono/node-server';
import { createApp } from '../core/app.js';
import { getStorage, getStorageConfigFromEnv } from '../core/storage/index.js';

const host = process.env.HOST ?? '0.0.0.0';
const port = parseInt(process.env.PORT ?? '3000', 10);

const config = {
  oauthClientSecret: process.env.OAUTH_CLIENT_SECRET,
  requestLogPath: process.env.REQUEST_LOG_PATH,
};

const storageConfig = getStorageConfigFromEnv();
const storage = getStorage();
const app = createApp(config);

serve(
  {
    fetch: app.fetch,
    port,
    hostname: host,
  },
  (info) => {
    console.log(`GitLab-ADO Proxy listening on http://${info.address}:${info.port} (storage: ${storageConfig.type})`);
  }
);

export { storage };
