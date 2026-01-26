/**
 * Node.js adapter for local development.
 * Uses @hono/node-server to run the Hono app.
 */

import 'dotenv/config';
import { serve } from '@hono/node-server';
import { createApp } from '../core/app.js';
import { getStorage, getStorageConfigFromEnv } from '../core/storage/index.js';

// Read configuration from environment variables.
// Org and allowed projects are per-token (OAuth or project token); not read from env.
const isLocalDev = process.env.NODE_ENV !== 'production';
const config = {
  adoApiVersion: process.env.ADO_API_VERSION ?? '7.1',
  oauthClientSecret: process.env.OAUTH_CLIENT_SECRET,
  requestLogPath: process.env.REQUEST_LOG_PATH ?? (isLocalDev ? '.data/requests.log' : undefined),
};

const port = parseInt(process.env.PORT ?? '3000', 10);

// Initialize storage.
const storageConfig = getStorageConfigFromEnv();
const storage = getStorage();

// Create the app with configuration.
const app = createApp(config);

const requestLogDisplay = config.requestLogPath ?? '-';

// Banner inner width (chars between ║ and ║). All content lines must match this.
const BANNER_W = 55;
const pad = (s: string, n: number) => s.substring(0, n).padEnd(n);
const borderTop = '╔' + '═'.repeat(BANNER_W) + '╗';
const borderMid = '╠' + '═'.repeat(BANNER_W) + '╣';
const borderBot = '╚' + '═'.repeat(BANNER_W) + '╝';
const row = (s: string) => '║' + pad(s, BANNER_W) + '║';

console.log(`
${borderTop}
${row('           GitLab-ADO Proxy Server')}
${borderMid}
${row('  Server:       ' + pad(`http://localhost:${port}`, BANNER_W - 15))}
${row('  API Ver:      ' + pad(config.adoApiVersion ?? '7.1', BANNER_W - 15))}
${row('  Storage:      ' + pad(storageConfig.type, BANNER_W - 15))}
${row('  Org/Projects: per-token (OAuth)')}
${row('  Request log:  ' + pad(requestLogDisplay, BANNER_W - 15))}
${borderBot}
`);

serve({
  fetch: app.fetch,
  port,
});

// Export storage for use in other modules.
export { storage };
