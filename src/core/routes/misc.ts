/**
 * Misc stub endpoints and catch-all for /api/v4/*.
 */

import { Hono } from 'hono';
import { getStorage } from '../storage/index.js';
import type { Env } from './env.js';
import type { StoredAccessToken } from '../types.js';

export function registerMisc(app: Hono<Env>): void {
  // GET /api/v4/version - Return GitLab version information.
  // This endpoint is often called by clients to verify the GitLab instance.
  app.get('/api/v4/version', (c) => {
    console.log('[GET /api/v4/version] Returning fake GitLab version');
    return c.json({
      version: '16.8.0',
      revision: 'gitlab-ado-proxy',
      enterprise: false,
    });
  });

  // GET /api/v4/personal_access_tokens/self - Get info about current token.
  // This endpoint is used by clients to verify the token is valid.
  app.get('/api/v4/personal_access_tokens/self', async (c) => {
    console.log('[GET /api/v4/personal_access_tokens/self] Token verification request');

    // Return token info based on what type of token was used.
    // For glpat-* tokens, we can look up the stored token data.
    const privateToken = c.req.header('PRIVATE-TOKEN');
    const authHeader = c.req.header('Authorization');
    const gitlabToken = privateToken || authHeader?.replace(/^Bearer\s+/i, '');

    if (gitlabToken?.startsWith('glpat-')) {
      // Look up the stored token.
      const storage = getStorage();
      const tokenLookup = await storage.get<{ projectId: string; tokenId: number }>(
        `token_lookup:${gitlabToken}`
      );

      if (tokenLookup) {
        const tokenData = await storage.get<StoredAccessToken>(
          `access_token:${tokenLookup.projectId}:${tokenLookup.tokenId}`
        );

        if (tokenData && !tokenData.revoked) {
          console.log('[GET /api/v4/personal_access_tokens/self] Returning stored token info:', {
            tokenId: tokenData.id,
            name: tokenData.name,
          });

          // Convert expires_at to date-only format if present.
          const expiresAtDate = tokenData.expiresAt
            ? tokenData.expiresAt.split('T')[0]
            : null;

          return c.json({
            id: tokenData.id,
            name: tokenData.name,
            description: tokenData.description,
            revoked: tokenData.revoked,
            created_at: tokenData.createdAt,
            scopes: tokenData.scopes,
            user_id: tokenData.userId,
            last_used_at: tokenData.lastUsedAt,
            active: !tokenData.revoked,
            expires_at: expiresAtDate,
            access_level: tokenData.accessLevel,
          });
        }
      }
    }

    // For regular ADO PATs, return a generic response.
    console.log('[GET /api/v4/personal_access_tokens/self] Returning generic token info');
    return c.json({
      id: 1,
      name: 'ado-pat',
      description: null,
      revoked: false,
      created_at: new Date().toISOString(),
      scopes: ['api', 'read_repository', 'write_repository'],
      user_id: 1,
      last_used_at: new Date().toISOString(),
      active: true,
      expires_at: null,
      access_level: 40,
    });
  });

  // GET /api/v4/metadata - GitLab instance metadata (used for version/capability checks).
  app.get('/api/v4/metadata', (c) => {
    console.log('[GET /api/v4/metadata] Returning fake GitLab metadata');
    return c.json({
      version: '16.8.0',
      revision: 'gitlab-ado-proxy',
      kas: {
        enabled: false,
        externalUrl: null,
        version: null,
      },
      enterprise: false,
    });
  });

  // GET /api/v4/application/settings - Application settings (minimal response).
  app.get('/api/v4/application/settings', (c) => {
    console.log('[GET /api/v4/application/settings] Returning minimal settings');
    return c.json({
      default_branch_name: 'main',
      repository_access_level: 'enabled',
    });
  });

  // GET /api/v4/groups - List groups (return empty array as ADO doesn't have same concept).
  app.get('/api/v4/groups', (c) => {
    console.log('[GET /api/v4/groups] Returning empty groups list');
    return c.json([]);
  });

  // GET /api/v4/namespaces - List namespaces (return minimal response).
  app.get('/api/v4/namespaces', (c) => {
    console.log('[GET /api/v4/namespaces] Returning minimal namespaces');
    return c.json([]);
  });

  // GET /api/v4/features - List feature flags (return empty).
  app.get('/api/v4/features', (c) => {
    console.log('[GET /api/v4/features] Returning empty features list');
    return c.json([]);
  });

  // Catch-all for unsupported endpoints.
  // This helps debug what endpoints Cursor is calling that we haven't implemented.
  app.all('/api/v4/*', (c) => {
    console.warn('[UNHANDLED ENDPOINT]', {
      method: c.req.method,
      path: c.req.path,
      url: c.req.url,
      headers: {
        'content-type': c.req.header('content-type'),
        'private-token': c.req.header('private-token') ? 'present' : 'absent',
        'authorization': c.req.header('authorization') ? 'present' : 'absent',
      },
    });
    return c.json(
      {
        error: 'Not Implemented',
        message: `Endpoint ${c.req.method} ${c.req.path} is not supported by this proxy`,
        statusCode: 501,
      },
      501
    );
  });
}
