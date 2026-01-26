/**
 * Hono app env and shared route types.
 * Used by route modules and middleware for consistent typing.
 */

import type { RequestContext } from '../types.js';

export type Env = {
  Variables: {
    ctx: RequestContext;
  };
};

/** In-memory OAuth session (step 1 -> step 2). */
export interface OAuthSession {
  clientId: string;
  redirectUri: string;
  state: string;
  responseType: string;
  scope: string;
  pat: string;
  projects: string[];
  expiresAt: number;
}

/** In-memory OAuth code (code -> access token). */
export interface OAuthCode {
  accessToken: string;
  expiresAt: number;
}

/** OAuth state passed into registerOauth. One set per app instance. */
export interface OAuthState {
  authSessions: Map<string, OAuthSession>;
  oauthCodes: Map<string, OAuthCode>;
}
