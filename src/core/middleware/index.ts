/**
 * App middleware: CORS, logging, request log file, and /api/v4/* auth context.
 */

import { appendFile, mkdir, unlink } from 'fs/promises';
import { dirname } from 'path';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { MappingService } from '../mapping.js';
import { getStorage } from '../storage/index.js';
import type { Env } from '../routes/env.js';
import type {
  ProxyConfig,
  EffectiveConfig,
  OAuthTokenData,
  StoredAccessToken,
} from '../types.js';

function bodyForLog(buf: ArrayBuffer, contentType: string | undefined): string {
  const ct = (contentType ?? '').toLowerCase();
  const isBinary =
    ct.includes('git-upload-pack') ||
    ct.includes('git-receive-pack') ||
    ct.includes('octet-stream');
  if (isBinary || buf.byteLength === 0) {
    return buf.byteLength === 0 ? '' : `<binary, ${buf.byteLength} bytes>`;
  }
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (decoded.includes('\0')) {
    return `<binary, ${buf.byteLength} bytes>`;
  }
  return decoded;
}

export function applyMiddleware(app: Hono<Env>, config: ProxyConfig): void {
  // Middleware: CORS.
  app.use('*', cors());

  // Middleware: Logger.
  app.use('*', logger());

  // Middleware: Debug request logger for all requests.
  app.use('*', async (c, next) => {
    const start = Date.now();
    const { method, url } = c.req;
    const path = new URL(url).pathname;

    console.log(`[REQUEST] ${method} ${path}`, {
      fullUrl: url,
      headers: {
        'content-type': c.req.header('content-type'),
        'private-token': c.req.header('private-token') ? 'present' : 'absent',
        'authorization': c.req.header('authorization') ? 'present' : 'absent',
      },
    });

    await next();

    const duration = Date.now() - start;
    console.log(`[RESPONSE] ${method} ${path} -> ${c.res.status} (${duration}ms)`);
  });

  // Middleware: Full request/response file logging (local development only).
  // Log file is removed on first write after startup so each server run starts with a fresh file.
  if (config.requestLogPath) {
    const logPath = config.requestLogPath;
    let dirEnsured = false;
    let clearedOnStart = false;

    app.use('*', async (c, next) => {
      const ts = new Date().toISOString();
      const { method, url } = c.req;
      const reqHeaders = Object.fromEntries(c.req.raw.headers.entries());
      let reqBody: string;
      try {
        const reqBuf = await c.req.raw.clone().arrayBuffer();
        reqBody = bodyForLog(reqBuf, c.req.header('Content-Type'));
      } catch {
        reqBody = '<missing>';
      }
      await next();
      let resBody: string;
      try {
        const resBuf = await c.res.clone().arrayBuffer();
        resBody = bodyForLog(resBuf, c.res.headers.get('Content-Type') ?? undefined);
      } catch {
        resBody = '<missing>';
      }
      if (!dirEnsured) {
        await mkdir(dirname(logPath), { recursive: true });
        dirEnsured = true;
      }
      if (!clearedOnStart) {
        await unlink(logPath).catch(() => {});
        clearedOnStart = true;
      }
      const entry = [
        '',
        `--- ${ts} ${method} ${url} ---`,
        'REQUEST: ' + JSON.stringify({ method, url, headers: reqHeaders, body: reqBody }),
        'RESPONSE: ' + JSON.stringify({
          status: c.res.status,
          headers: Object.fromEntries(c.res.headers.entries()),
          body: resBody,
        }),
        '',
      ].join('\n');
      await appendFile(logPath, entry, 'utf-8');
    });
  }

  // Middleware: Auth conversion and context setup.
  app.use('/api/v4/*', async (c, next) => {
    // Support multiple authentication methods:
    // 1. PRIVATE-TOKEN header (GitLab style)
    // 2. Bearer token (OAuth style)
    // 3. Basic auth (git client style) - may contain glpat token or raw ADO PAT
    const privateToken = c.req.header('PRIVATE-TOKEN');
    const authHeader = c.req.header('Authorization');
    let gitlabToken = privateToken;
    let basicAuthUsername: string | null = null;

    if (!gitlabToken && authHeader) {
      if (authHeader.startsWith('Bearer ')) {
        gitlabToken = authHeader.replace(/^Bearer\s+/i, '');
      } else if (authHeader.toLowerCase().startsWith('basic ')) {
        // Basic auth: base64 of "username:password" where password might be glpat-* token or raw ADO PAT.
        try {
          const base64Credentials = authHeader.substring(6).trim();
          // Use Buffer.from for Node.js compatibility.
          const decoded = Buffer.from(base64Credentials, 'base64').toString('utf-8');
          console.log('[Auth] Decoding Basic auth:', {
            base64Length: base64Credentials.length,
            decodedLength: decoded.length,
            hasColon: decoded.includes(':'),
          });
          // Format could be ":PAT", "user:PAT", "git:PAT", "orgname:ADO_PAT", etc.
          const colonIndex = decoded.indexOf(':');
          if (colonIndex !== -1) {
            const username = decoded.substring(0, colonIndex);
            const password = decoded.substring(colonIndex + 1);
            basicAuthUsername = username;
            // Use the password as the token (it might be a glpat or regular PAT).
            gitlabToken = password;
            console.log('[Auth] Extracted token from Basic auth:', {
              username: username || '(empty)',
              tokenPrefix: password.substring(0, 10) + '...',
              tokenLength: password.length,
            });
          } else {
            // No colon - might be just a token.
            gitlabToken = decoded;
            console.log('[Auth] Basic auth without colon, using whole value:', {
              tokenPrefix: decoded.substring(0, 10) + '...',
            });
          }
        } catch (e) {
          console.warn('[Auth] Failed to decode Basic auth header:', e);
        }
      }
    }

    // Validate token exists and is not "undefined" or empty.
    if (!gitlabToken || gitlabToken === 'undefined' || gitlabToken.trim() === '') {
      console.warn('[Auth] Missing or invalid authentication token:', {
        path: c.req.path,
        method: c.req.method,
        hasPrivateToken: !!privateToken,
        privateTokenValue: privateToken ? privateToken.substring(0, 10) + '...' : 'none',
        hasAuthorization: !!authHeader,
        authorizationValue: authHeader ? authHeader.substring(0, 20) + '...' : 'none',
        extractedToken: gitlabToken,
      });
      c.header('WWW-Authenticate', 'Bearer error="invalid_token", error_description="Credentials required or invalid"');
      c.header('X-Require-Reauth', 'true');
      return c.json({ message: '401 Unauthorized' }, 401);
    }

    let adoAuthHeader: string;
    let effectiveConfig: EffectiveConfig;
    let tokenSource = privateToken
      ? 'PRIVATE-TOKEN'
      : authHeader?.startsWith('Basic ')
        ? 'Basic-Auth'
        : 'Authorization';

    const storage = getStorage();

    // OAuth proxy token (glpat-oauth-*): resolve from oauth_token storage and set effective config.
    if (gitlabToken.startsWith('glpat-oauth-')) {
      try {
        const oauthData = await storage.get<OAuthTokenData>(`oauth_token:${gitlabToken}`);
        if (!oauthData) {
          console.warn('[Auth] OAuth proxy token not found.');
          c.header('WWW-Authenticate', 'Bearer error="invalid_token", error_description="Invalid or expired OAuth token"');
          c.header('X-Require-Reauth', 'true');
          return c.json({ message: '401 Unauthorized' }, 401);
        }
        adoAuthHeader = MappingService.convertAuth(oauthData.adoPat);
        effectiveConfig = {
          ...config,
          adoBaseUrl: oauthData.adoBaseUrl,
          allowedProjects: oauthData.allowedProjects,
        };
        tokenSource = 'OAuthProxyToken';
        console.log('[Auth] OAuth proxy token resolved:', { orgName: oauthData.orgName });
      } catch (error) {
        console.error('[Auth] Error resolving OAuth token:', error);
        return c.json(
          { error: 'Internal Server Error', message: 'Failed to validate OAuth token', statusCode: 500 },
          500
        );
      }
    } else if (gitlabToken.startsWith('glpat-')) {
      // Project access token: resolve and require stored adoBaseUrl/allowedProjects.
      try {
        const tokenLookup = await storage.get<{ projectId: string; tokenId: number }>(`token_lookup:${gitlabToken}`);
        if (!tokenLookup) {
          console.warn('[Auth] Project access token not found in storage.');
          c.header('WWW-Authenticate', 'Bearer error="invalid_token", error_description="Invalid or expired project access token"');
          c.header('X-Require-Reauth', 'true');
          return c.json({ message: '401 Unauthorized' }, 401);
        }
        const tokenData = await storage.get<StoredAccessToken>(
          `access_token:${tokenLookup.projectId}:${tokenLookup.tokenId}`
        );
        if (!tokenData || tokenData.revoked) {
          c.header('WWW-Authenticate', 'Bearer error="invalid_token", error_description="Project access token has been revoked"');
          c.header('X-Require-Reauth', 'true');
          return c.json({ message: '401 Unauthorized' }, 401);
        }
        if (tokenData.expiresAt && new Date(tokenData.expiresAt) < new Date()) {
          c.header('WWW-Authenticate', 'Bearer error="invalid_token", error_description="Project access token has expired"');
          c.header('X-Require-Reauth', 'true');
          return c.json({ message: '401 Unauthorized' }, 401);
        }
        if (tokenData.adoBaseUrl === undefined || tokenData.allowedProjects === undefined) {
          console.warn('[Auth] Project token missing adoBaseUrl/allowedProjects (legacy token).');
          c.header('WWW-Authenticate', 'Bearer error="invalid_token", error_description="Token must be re-created"');
          c.header('X-Require-Reauth', 'true');
          return c.json({ message: '401 Unauthorized' }, 401);
        }
        tokenData.lastUsedAt = new Date().toISOString();
        await storage.set(
          `access_token:${tokenLookup.projectId}:${tokenLookup.tokenId}`,
          tokenData
        );
        adoAuthHeader = MappingService.convertAuth(tokenData.adoPat);
        effectiveConfig = {
          ...config,
          adoBaseUrl: tokenData.adoBaseUrl,
          allowedProjects: tokenData.allowedProjects,
        };
        tokenSource = 'ProjectAccessToken';
        console.log('[Auth] Project access token resolved:', { projectId: tokenLookup.projectId, tokenId: tokenLookup.tokenId });
      } catch (error) {
        console.error('[Auth] Error looking up project access token:', error);
        return c.json(
          { error: 'Internal Server Error', message: 'Failed to validate project access token', statusCode: 500 },
          500
        );
      }
    } else if (basicAuthUsername && basicAuthUsername.trim() !== '') {
      // Raw Azure DevOps PAT with organization name in username field.
      const orgName = basicAuthUsername.trim();
      console.log('[Auth] Using raw ADO PAT with org:', { orgName });
      adoAuthHeader = MappingService.convertAuth(gitlabToken);
      effectiveConfig = {
        ...config,
        adoBaseUrl: `https://dev.azure.com/${encodeURIComponent(orgName)}`,
        // Allow all projects - the PAT's permissions will restrict access.
        allowedProjects: [],
      };
      tokenSource = 'RawADOPAT';
    } else {
      // Raw PAT without organization name is not accepted.
      console.warn('[Auth] Raw PAT not accepted without organization name; use OAuth, project tokens, or provide org name as username.');
      c.header('WWW-Authenticate', 'Basic realm="Azure DevOps", error="invalid_token", error_description="Provide organization name as username with ADO PAT as password"');
      c.header('X-Require-Reauth', 'true');
      return c.json({ message: '401 Unauthorized' }, 401);
    }

    // Set context for downstream handlers.
    c.set('ctx', {
      config: effectiveConfig,
      adoAuthHeader,
    });

    console.log('[Auth] Request authenticated:', {
      path: c.req.path,
      method: c.req.method,
      hasToken: !!gitlabToken,
      tokenLength: gitlabToken.length,
      tokenPrefix: gitlabToken.substring(0, 8) + '...',
      tokenSource,
    });

    return next();
  });
}
