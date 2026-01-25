/**
 * Node.js adapter for local development.
 * Uses @hono/node-server to run the Hono app.
 */

import { serve } from '@hono/node-server';
import { createApp } from '../core/app.js';

// Read configuration from environment variables.
const config = {
  adoBaseUrl: process.env.ADO_BASE_URL ?? 'https://dev.azure.com/org/project',
  adoApiVersion: process.env.ADO_API_VERSION ?? '7.1',
};

const port = parseInt(process.env.PORT ?? '3000', 10);

// Create the app with configuration.
const app = createApp(config);

console.log(`
╔═══════════════════════════════════════════════════════════╗
║           GitLab-ADO Proxy Server                         ║
╠═══════════════════════════════════════════════════════════╣
║  Server:     http://localhost:${port.toString().padEnd(26)}║
║  ADO Base:   ${config.adoBaseUrl.substring(0, 42).padEnd(42)}║
║  API Ver:    ${config.adoApiVersion.padEnd(42)}║
╚═══════════════════════════════════════════════════════════╝
`);

serve({
  fetch: app.fetch,
  port,
});
