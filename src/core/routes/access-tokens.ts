/**
 * Project access token routes (list, create, get, delete, rotate).
 */

import { Hono } from 'hono';
import { getStorage } from '../storage/index.js';
import type { Env } from './env.js';
import type {
  GitLabProjectAccessToken,
  GitLabProjectAccessTokenCreate,
  StoredAccessToken,
} from '../types.js';

export function registerAccessTokens(app: Hono<Env>): void {
  // GET /api/v4/projects/:id/access_tokens - List project access tokens.
  app.get('/api/v4/projects/:id/access_tokens', async (c) => {
    const projectId = c.req.param('id');

    console.log('[GET /api/v4/projects/:id/access_tokens] Request:', {
      projectId,
    });

    try {
      const storage = getStorage();
      const result = await storage.list<StoredAccessToken>({
        prefix: `access_token:${projectId}:`,
      });

      // Map stored tokens to GitLab format (without exposing the actual token).
      const tokens: GitLabProjectAccessToken[] = result.items
        .filter((item) => !item.item.value.revoked)
        .map((item) => {
          // Convert expires_at to date-only format if present.
          const expiresAtDate = item.item.value.expiresAt
            ? item.item.value.expiresAt.split('T')[0]
            : null;

          return {
            id: item.item.value.id,
            name: item.item.value.name,
            description: item.item.value.description,
            revoked: item.item.value.revoked,
            created_at: item.item.value.createdAt,
            scopes: item.item.value.scopes,
            user_id: item.item.value.userId,
            last_used_at: item.item.value.lastUsedAt,
            active: !item.item.value.revoked && (
              !item.item.value.expiresAt || new Date(item.item.value.expiresAt) > new Date()
            ),
            expires_at: expiresAtDate,
            access_level: item.item.value.accessLevel,
          };
        });

      console.log('[GET /api/v4/projects/:id/access_tokens] Found tokens:', {
        projectId,
        count: tokens.length,
        tokenIds: tokens.map((t) => t.id),
      });

      return c.json(tokens);
    } catch (error) {
      console.error('[GET /api/v4/projects/:id/access_tokens] Error:', error);
      return c.json(
        {
          error: 'Internal Server Error',
          message: error instanceof Error ? error.message : 'Unknown error',
          statusCode: 500,
        },
        500
      );
    }
  });

  // POST /api/v4/projects/:id/access_tokens - Create project access token.
  app.post('/api/v4/projects/:id/access_tokens', async (c) => {
    const { ctx } = c.var;
    const projectId = c.req.param('id');

    try {
      const body = (await c.req.json()) as GitLabProjectAccessTokenCreate;

      console.log('[POST /api/v4/projects/:id/access_tokens] Request:', {
        projectId,
        name: body.name,
        description: body.description,
        scopes: body.scopes,
        accessLevel: body.access_level,
        expiresAt: body.expires_at,
      });

      // Validate required fields.
      if (!body.name || !body.scopes || body.scopes.length === 0) {
        return c.json(
          {
            error: 'Bad Request',
            message: 'name and scopes are required',
            statusCode: 400,
          },
          400
        );
      }

      // Extract the original ADO PAT from the auth header.
      // The ctx.adoAuthHeader is "Basic base64(:PAT)", we need to extract the PAT.
      const authMatch = ctx.adoAuthHeader.match(/^Basic\s+(.+)$/i);
      if (!authMatch) {
        return c.json(
          {
            error: 'Unauthorized',
            message: 'Invalid authorization format',
            statusCode: 401,
          },
          401
        );
      }

      const decoded = Buffer.from(authMatch[1], 'base64').toString('utf-8');
      // Extract PAT from "username:password" or ":password" format.
      const colonIndex = decoded.indexOf(':');
      const adoPat = colonIndex !== -1 ? decoded.substring(colonIndex + 1) : decoded;

      // Generate a unique token ID and the token value itself.
      // Use a smaller ID to stay within 32-bit integer range that some systems expect.
      const tokenId = Date.now() % 2147483647;
      const randomPart = Math.random().toString(36).substring(2);
      const tokenValue = `glpat-${Buffer.from(`${Date.now()}-${randomPart}`).toString('base64url')}`;

      // Calculate expiration.
      // GitLab expects expires_at as date only (YYYY-MM-DD), not full ISO timestamp.
      let expiresAt: string | null = null;
      let expiresAtDate: string | null = null;
      let ttlSeconds: number | undefined;
      if (body.expires_at) {
        const expiresDate = new Date(body.expires_at);
        expiresAt = expiresDate.toISOString();
        // Extract just the date portion for the API response.
        expiresAtDate = expiresAt.split('T')[0];
        ttlSeconds = Math.max(0, Math.floor((expiresDate.getTime() - Date.now()) / 1000));
      }

      // Create the stored token.
      const storedToken: StoredAccessToken = {
        id: tokenId,
        projectId,
        name: body.name,
        description: body.description ?? null,
        scopes: body.scopes,
        accessLevel: body.access_level ?? 40,
        adoPat,
        createdAt: new Date().toISOString(),
        expiresAt,
        lastUsedAt: null,
        revoked: false,
        userId: 1,
        userName: 'user',
        adoBaseUrl: ctx.config.adoBaseUrl,
        allowedProjects: ctx.config.allowedProjects,
      };

      // Store the token by its generated value (so we can look it up when used).
      const storage = getStorage();
      await storage.set(
        `access_token:${projectId}:${tokenId}`,
        storedToken,
        ttlSeconds ? { ttl: ttlSeconds } : undefined
      );

      // Also store a mapping from token value to token ID for quick lookup.
      await storage.set(
        `token_lookup:${tokenValue}`,
        { projectId, tokenId },
        ttlSeconds ? { ttl: ttlSeconds } : undefined
      );

      // Return the created token (including the actual token value).
      const response: GitLabProjectAccessToken = {
        id: tokenId,
        name: body.name,
        description: storedToken.description,
        revoked: false,
        created_at: storedToken.createdAt,
        scopes: body.scopes,
        user_id: storedToken.userId,
        last_used_at: null,
        active: true,
        expires_at: expiresAtDate,
        access_level: storedToken.accessLevel,
        token: tokenValue,
      };

      console.log('[POST /api/v4/projects/:id/access_tokens] Created token:', {
        projectId,
        tokenId,
        name: body.name,
        tokenPrefix: tokenValue.substring(0, 15) + '...',
        expiresAtDate,
      });

      return c.json(response, 201);
    } catch (error) {
      console.error('[POST /api/v4/projects/:id/access_tokens] Error:', error);
      return c.json(
        {
          error: 'Internal Server Error',
          message: error instanceof Error ? error.message : 'Unknown error',
          statusCode: 500,
        },
        500
      );
    }
  });

  // GET /api/v4/projects/:id/access_tokens/:token_id - Get details on a project access token.
  app.get('/api/v4/projects/:id/access_tokens/:token_id', async (c) => {
    const projectId = c.req.param('id');
    const tokenId = c.req.param('token_id');

    console.log('[GET /api/v4/projects/:id/access_tokens/:token_id] Request:', {
      projectId,
      tokenId,
    });

    try {
      const storage = getStorage();
      const storageKey = `access_token:${projectId}:${tokenId}`;
      const tokenData = await storage.get<StoredAccessToken>(storageKey);

      if (!tokenData) {
        return c.json(
          {
            error: 'Not Found',
            message: `Access token ${tokenId} not found`,
            statusCode: 404,
          },
          404
        );
      }

      // Convert expires_at to date-only format if present.
      const expiresAtDate = tokenData.expiresAt
        ? tokenData.expiresAt.split('T')[0]
        : null;

      console.log('[GET /api/v4/projects/:id/access_tokens/:token_id] Found token:', {
        projectId,
        tokenId,
        name: tokenData.name,
      });

      return c.json({
        id: tokenData.id,
        name: tokenData.name,
        description: tokenData.description,
        revoked: tokenData.revoked,
        created_at: tokenData.createdAt,
        scopes: tokenData.scopes,
        user_id: tokenData.userId,
        last_used_at: tokenData.lastUsedAt,
        active: !tokenData.revoked && (
          !tokenData.expiresAt || new Date(tokenData.expiresAt) > new Date()
        ),
        expires_at: expiresAtDate,
        access_level: tokenData.accessLevel,
      });
    } catch (error) {
      console.error('[GET /api/v4/projects/:id/access_tokens/:token_id] Error:', error);
      return c.json(
        {
          error: 'Internal Server Error',
          message: error instanceof Error ? error.message : 'Unknown error',
          statusCode: 500,
        },
        500
      );
    }
  });

  // DELETE /api/v4/projects/:id/access_tokens/:token_id - Revoke project access token.
  app.delete('/api/v4/projects/:id/access_tokens/:token_id', async (c) => {
    const projectId = c.req.param('id');
    const tokenId = c.req.param('token_id');

    console.log('[DELETE /api/v4/projects/:id/access_tokens/:token_id] Request:', {
      projectId,
      tokenId,
    });

    try {
      const storage = getStorage();
      const storageKey = `access_token:${projectId}:${tokenId}`;
      const tokenData = await storage.get<StoredAccessToken>(storageKey);

      if (!tokenData) {
        return c.json(
          {
            error: 'Not Found',
            message: `Access token ${tokenId} not found`,
            statusCode: 404,
          },
          404
        );
      }

      // Mark as revoked instead of deleting.
      tokenData.revoked = true;
      await storage.set(storageKey, tokenData);

      console.log('[DELETE /api/v4/projects/:id/access_tokens/:token_id] Revoked token:', {
        projectId,
        tokenId,
      });

      return c.body(null, 204);
    } catch (error) {
      console.error('[DELETE /api/v4/projects/:id/access_tokens/:token_id] Error:', error);
      return c.json(
        {
          error: 'Internal Server Error',
          message: error instanceof Error ? error.message : 'Unknown error',
          statusCode: 500,
        },
        500
      );
    }
  });

  // POST /api/v4/projects/:id/access_tokens/:token_id/rotate - Rotate project access token.
  app.post('/api/v4/projects/:id/access_tokens/:token_id/rotate', async (c) => {
    const { ctx } = c.var;
    const projectId = c.req.param('id');
    const tokenIdParam = c.req.param('token_id');

    console.log('[POST /api/v4/projects/:id/access_tokens/:token_id/rotate] Request:', {
      projectId,
      tokenId: tokenIdParam,
    });

    try {
      const storage = getStorage();
      let tokenId = tokenIdParam;

      // Handle 'self' keyword - look up the current token.
      if (tokenIdParam === 'self') {
        const privateToken = c.req.header('PRIVATE-TOKEN');
        const authHeader = c.req.header('Authorization');
        const gitlabToken = privateToken || authHeader?.replace(/^Bearer\s+/i, '');

        if (gitlabToken?.startsWith('glpat-')) {
          const tokenLookup = await storage.get<{ projectId: string; tokenId: number }>(
            `token_lookup:${gitlabToken}`
          );
          if (tokenLookup) {
            tokenId = tokenLookup.tokenId.toString();
          }
        }
      }

      const storageKey = `access_token:${projectId}:${tokenId}`;
      const oldTokenData = await storage.get<StoredAccessToken>(storageKey);

      if (!oldTokenData) {
        return c.json(
          {
            error: 'Unauthorized',
            message: 'Token not found',
            statusCode: 401,
          },
          401
        );
      }

      if (oldTokenData.revoked) {
        return c.json(
          {
            error: 'Unauthorized',
            message: 'Token has been revoked',
            statusCode: 401,
          },
          401
        );
      }

      // Revoke the old token.
      oldTokenData.revoked = true;
      await storage.set(storageKey, oldTokenData);

      // Create a new token with the same properties.
      const body = (await c.req.json().catch(() => ({}))) as { expires_at?: string };
      const newTokenId = Date.now() % 2147483647;
      const randomPart = Math.random().toString(36).substring(2);
      const newTokenValue = `glpat-${Buffer.from(`${Date.now()}-${randomPart}`).toString('base64url')}`;

      // Calculate new expiration.
      let newExpiresAt: string | null = null;
      let newExpiresAtDate: string | null = null;
      let ttlSeconds: number | undefined;

      if (body.expires_at) {
        const expiresDate = new Date(body.expires_at);
        newExpiresAt = expiresDate.toISOString();
        newExpiresAtDate = newExpiresAt.split('T')[0];
        ttlSeconds = Math.max(0, Math.floor((expiresDate.getTime() - Date.now()) / 1000));
      } else if (oldTokenData.expiresAt) {
        // Default to 1 week from now if original had an expiration.
        const expiresDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        newExpiresAt = expiresDate.toISOString();
        newExpiresAtDate = newExpiresAt.split('T')[0];
        ttlSeconds = 7 * 24 * 60 * 60;
      }

      const newTokenData: StoredAccessToken = {
        id: newTokenId,
        projectId,
        name: oldTokenData.name,
        description: oldTokenData.description,
        scopes: oldTokenData.scopes,
        accessLevel: oldTokenData.accessLevel,
        adoPat: oldTokenData.adoPat,
        createdAt: new Date().toISOString(),
        expiresAt: newExpiresAt,
        lastUsedAt: null,
        revoked: false,
        userId: oldTokenData.userId,
        userName: oldTokenData.userName,
        adoBaseUrl: ctx.config.adoBaseUrl,
        allowedProjects: ctx.config.allowedProjects,
      };

      // Store the new token.
      await storage.set(
        `access_token:${projectId}:${newTokenId}`,
        newTokenData,
        ttlSeconds ? { ttl: ttlSeconds } : undefined
      );

      // Store the new token lookup.
      await storage.set(
        `token_lookup:${newTokenValue}`,
        { projectId, tokenId: newTokenId },
        ttlSeconds ? { ttl: ttlSeconds } : undefined
      );

      console.log('[POST /api/v4/projects/:id/access_tokens/:token_id/rotate] Rotated token:', {
        projectId,
        oldTokenId: tokenId,
        newTokenId,
      });

      return c.json({
        id: newTokenId,
        name: newTokenData.name,
        description: newTokenData.description,
        revoked: false,
        created_at: newTokenData.createdAt,
        scopes: newTokenData.scopes,
        user_id: newTokenData.userId,
        last_used_at: null,
        active: true,
        expires_at: newExpiresAtDate,
        access_level: newTokenData.accessLevel,
        token: newTokenValue,
      });
    } catch (error) {
      console.error('[POST /api/v4/projects/:id/access_tokens/:token_id/rotate] Error:', error);
      return c.json(
        {
          error: 'Bad Request',
          message: error instanceof Error ? error.message : 'Unknown error',
          statusCode: 400,
        },
        400
      );
    }
  });
}
