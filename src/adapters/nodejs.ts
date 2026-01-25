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
const config = {
  adoBaseUrl: process.env.ADO_BASE_URL ?? 'https://dev.azure.com/org',
  adoApiVersion: process.env.ADO_API_VERSION ?? '7.1',
  oauthClientId: process.env.OAUTH_CLIENT_ID,
  oauthClientSecret: process.env.OAUTH_CLIENT_SECRET,
  allowedProjects: parseAllowedProjects(process.env.ALLOWED_PROJECTS),
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

console.log(`
╔═══════════════════════════════════════════════════════════╗
║           GitLab-ADO Proxy Server                         ║
╠═══════════════════════════════════════════════════════════╣
║  Server:     http://localhost:${port.toString().padEnd(26)}║
║  ADO Base:   ${config.adoBaseUrl.substring(0, 42).padEnd(42)}║
║  API Ver:    ${config.adoApiVersion.padEnd(42)}║
║  Storage:    ${storageConfig.type.padEnd(42)}║
║  Projects:   ${allowedProjectsDisplay.padEnd(42)}║
╚═══════════════════════════════════════════════════════════╝
`);

serve({
  fetch: app.fetch,
  port,
});

// Export storage for use in other modules.
export { storage };
