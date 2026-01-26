/**
 * Node.js adapter for local development.
 * Uses @hono/node-server to run the Hono app.
 */

import 'dotenv/config';
import { serve } from '@hono/node-server';
import { createApp } from '../core/app.js';
import { getStorage, getStorageConfigFromEnv } from '../core/storage/index.js';

// Parse allowed projects from comma-separated environment variable.
function parseAllowedProjects(envVar?: string): string[] | undefined {
  if (!envVar || envVar.trim() === '') {
    return undefined;
  }
  return envVar.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
}

// Read configuration from environment variables.
const isLocalDev = process.env.NODE_ENV !== 'production';
const config = {
  adoBaseUrl: process.env.ADO_BASE_URL ?? 'https://dev.azure.com/org',
  adoApiVersion: process.env.ADO_API_VERSION ?? '7.1',
  oauthClientId: process.env.OAUTH_CLIENT_ID,
  oauthClientSecret: process.env.OAUTH_CLIENT_SECRET,
  allowedProjects: parseAllowedProjects(process.env.ALLOWED_PROJECTS),
  requestLogPath: process.env.REQUEST_LOG_PATH ?? (isLocalDev ? '.data/requests.log' : undefined),
};

const port = parseInt(process.env.PORT ?? '3000', 10);

// Initialize storage.
const storageConfig = getStorageConfigFromEnv();
const storage = getStorage();

// Create the app with configuration.
const app = createApp(config);

const allowedProjectsDisplay = config.allowedProjects 
  ? config.allowedProjects.join(', ').substring(0, 40) 
  : 'All projects';

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
${row('  Server:     ' + pad(`http://localhost:${port}`, BANNER_W - 13))}
${row('  ADO Base:   ' + pad(config.adoBaseUrl, BANNER_W - 13))}
${row('  API Ver:    ' + pad(config.adoApiVersion, BANNER_W - 13))}
${row('  Storage:    ' + pad(storageConfig.type, BANNER_W - 13))}
${row('  Projects:   ' + pad(allowedProjectsDisplay, BANNER_W - 13))}
${row('  Request log: ' + pad(requestLogDisplay, BANNER_W - 15))}
${borderBot}
`);

serve({
  fetch: app.fetch,
  port,
});

// Export storage for use in other modules.
export { storage };
