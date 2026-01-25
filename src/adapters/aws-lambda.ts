/**
 * AWS Lambda adapter.
 * Uses hono/aws-lambda to handle Lambda events.
 */

import { handle } from 'hono/aws-lambda';
import { createApp } from '../core/app.js';

// Read configuration from environment variables.
const config = {
  adoBaseUrl: process.env.ADO_BASE_URL ?? 'https://dev.azure.com/org',
  adoApiVersion: process.env.ADO_API_VERSION ?? '7.1',
};

// Create the app with configuration.
const app = createApp(config);

// Export the Lambda handler.
export const handler = handle(app);
