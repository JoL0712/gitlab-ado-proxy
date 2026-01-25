/**
 * Vercel Edge adapter.
 * Exports the Hono app's fetch handler for Vercel Edge Functions.
 */

import { createApp } from '../core/app.js';

// Read configuration from environment variables.
const config = {
  adoBaseUrl: process.env.ADO_BASE_URL ?? 'https://dev.azure.com/org',
  adoApiVersion: process.env.ADO_API_VERSION ?? '7.1',
  oauthClientId: process.env.OAUTH_CLIENT_ID,
  oauthClientSecret: process.env.OAUTH_CLIENT_SECRET,
};

// Create the app with configuration.
const app = createApp(config);

// Vercel Edge configuration.
export const runtime = 'edge';

// Export the fetch handler.
export default app;
