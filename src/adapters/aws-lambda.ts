/**
 * AWS Lambda adapter.
 * Uses hono/aws-lambda to handle Lambda events.
 */

import { handle } from 'hono/aws-lambda';
import { createApp } from '../core/app.js';
import { getStorage } from '../core/storage/index.js';

// Read configuration from environment variables.
// Org and allowed projects are per-token (OAuth or project token); not read from env.
const config = {
  adoApiVersion: process.env.ADO_API_VERSION ?? '7.1',
  oauthClientSecret: process.env.OAUTH_CLIENT_SECRET,
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
