/**
 * AWS Lambda adapter.
 * Uses hono/aws-lambda to handle Lambda events.
 */

import { handle } from 'hono/aws-lambda';
import { createApp } from '../core/app.js';
import { getStorage } from '../core/storage/index.js';

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

// Initialize storage (uses environment variables for configuration).
// In Lambda, this will typically be DynamoDB.
const storage = getStorage();

// Create the app with configuration.
const app = createApp(config);

// Export the Lambda handler.
export const handler = handle(app);

// Export storage for use in other modules.
export { storage };
