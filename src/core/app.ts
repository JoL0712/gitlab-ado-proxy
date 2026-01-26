/**
 * App composition: middleware and route registration.
 */

import { Hono } from 'hono';
import { applyMiddleware } from './middleware/index.js';
import {
  registerHealth,
  registerUser,
  registerProjects,
  registerProject,
  registerOauth,
  registerAccessTokens,
  registerRepository,
  registerMisc,
  registerGit,
} from './routes/index.js';
import type { Env, OAuthState } from './routes/env.js';
import type { ProxyConfig } from './types.js';

export function createApp(config: ProxyConfig): Hono<Env> {
  const app = new Hono<Env>();

  applyMiddleware(app, config);

  registerHealth(app);
  registerUser(app);
  registerProjects(app);

  const oauthCodes = new Map<string, { accessToken: string; expiresAt: number }>();
  const authSessions = new Map<
    string,
    {
      clientId: string;
      redirectUri: string;
      state: string;
      responseType: string;
      scope: string;
      pat: string;
      projects: string[];
      expiresAt: number;
    }
  >();
  registerOauth(app, config, { authSessions, oauthCodes } as OAuthState);

  registerAccessTokens(app);
  registerProject(app);
  registerRepository(app);
  registerMisc(app);
  registerGit(app);

  return app;
}

// Export a default app instance for simple usage.
// Org and allowed projects come from tokens only.
export const app = createApp({
  oauthClientSecret: process.env.OAUTH_CLIENT_SECRET,
});
