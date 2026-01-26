/**
 * Git Smart HTTP protocol routes (info/refs, git-upload-pack, git-receive-pack).
 */

import { gunzipSync, inflateSync } from 'node:zlib';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { MappingService } from '../mapping.js';
import { getStorage } from '../storage/index.js';
import { fetchRepositoryInfo } from '../helpers/repository.js';
import type { Env } from './env.js';
import type { ProxyConfig } from '../types.js';
import type { OAuthTokenData, StoredAccessToken } from '../types.js';

async function extractGitAuth(c: Context<Env>): Promise<{
  adoAuthHeader: string;
  adoBaseUrl: string;
  allowedProjects: string[];
} | null> {
  const authHeader = c.req.header('Authorization');
  if (!authHeader) {
    return null;
  }

  let token: string | null = null;
  if (authHeader.toLowerCase().startsWith('basic ')) {
    try {
      const base64Credentials = authHeader.substring(6).trim();
      const decoded = Buffer.from(base64Credentials, 'base64').toString('utf-8');
      const colonIndex = decoded.indexOf(':');
      token = colonIndex !== -1 ? decoded.substring(colonIndex + 1) : decoded;
    } catch (e) {
      console.warn('[Git Auth] Failed to decode Basic auth:', e);
      return null;
    }
  } else if (authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  }

  if (!token || token.trim() === '') {
    return null;
  }

  const storage = getStorage();

  if (token.startsWith('glpat-oauth-')) {
    const oauthData = await storage.get<OAuthTokenData>(`oauth_token:${token}`);
    if (!oauthData) {
      return null;
    }
    return {
      adoAuthHeader: MappingService.convertAuth(oauthData.adoPat),
      adoBaseUrl: oauthData.adoBaseUrl,
      allowedProjects: oauthData.allowedProjects,
    };
  }

  if (token.startsWith('glpat-')) {
    const tokenLookup = await storage.get<{ projectId: string; tokenId: number }>(
      `token_lookup:${token}`
    );
    if (!tokenLookup) {
      return null;
    }
    const tokenData = await storage.get<StoredAccessToken>(
      `access_token:${tokenLookup.projectId}:${tokenLookup.tokenId}`
    );
    if (
      !tokenData ||
      tokenData.revoked ||
      tokenData.adoBaseUrl === undefined ||
      tokenData.allowedProjects === undefined
    ) {
      return null;
    }
    return {
      adoAuthHeader: MappingService.convertAuth(tokenData.adoPat),
      adoBaseUrl: tokenData.adoBaseUrl,
      allowedProjects: tokenData.allowedProjects,
    };
  }

  // Raw PAT is not accepted for Git.
  return null;
}

function decodeGitBody(raw: ArrayBuffer, contentEncoding: string | undefined): ArrayBuffer {
  if (!contentEncoding) {
    return raw;
  }
  const enc = contentEncoding.toLowerCase().replace(/;.*/, '').trim();
  if (enc !== 'gzip' && enc !== 'deflate') {
    return raw;
  }
  const buf = Buffer.from(raw);
  const decoded = enc === 'gzip' ? gunzipSync(buf) : inflateSync(buf);
  return decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength);
}

export function registerGit(app: Hono<Env>, config: ProxyConfig): void {
  // GET /:namespace/:project/info/refs - Git discovery endpoint.
  app.get('/:namespace/:project/info/refs', async (c) => {
    const namespace = c.req.param('namespace');
    const project = c.req.param('project');
    const service = c.req.query('service');

    // Extract auth for Git HTTP (not handled by /api/v4/* middleware).
    const gitAuth = await extractGitAuth(c);

    console.log('[Git Smart HTTP] info/refs request:', {
      namespace,
      project,
      service,
      hasAuth: !!gitAuth,
    });

    // Check for authentication.
    if (!gitAuth) {
      // Return 401 to prompt git client for credentials.
      return c.text('Authentication required', 401, {
        'WWW-Authenticate': 'Basic realm="Git"',
      });
    }

    if (!service || !['git-upload-pack', 'git-receive-pack'].includes(service)) {
      return c.text('Invalid service', 400);
    }

    try {
      const repoPath = `${namespace}/${project}`;
      const repoInfo = await fetchRepositoryInfo(
        repoPath,
        gitAuth.adoAuthHeader,
        gitAuth.adoBaseUrl,
        config.adoApiVersion ?? '7.1',
        gitAuth.allowedProjects
      );

      if (!repoInfo) {
        console.log('[Git Smart HTTP] Repository not found:', { repoPath });
        return c.text('Repository not found', 404);
      }

      const adoGitUrl = `${gitAuth.adoBaseUrl}/${encodeURIComponent(repoInfo.projectName)}/_git/${encodeURIComponent(repoInfo.repo.name)}/info/refs?service=${service}`;

      console.log('[Git Smart HTTP] Proxying to ADO:', { adoGitUrl });

      const response = await fetch(adoGitUrl, {
        method: 'GET',
        headers: {
          Authorization: gitAuth.adoAuthHeader,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.log('[Git Smart HTTP] ADO error:', {
          status: response.status,
          error: errorText.slice(0, 200),
        });
        return c.text(errorText, response.status as 400 | 401 | 403 | 404 | 500);
      }

      // Forward the response with correct content type.
      const body = await response.arrayBuffer();
      return c.body(body, 200, {
        'Content-Type':
          response.headers.get('Content-Type') ?? `application/x-${service}-advertisement`,
        'Cache-Control': 'no-cache',
      });
    } catch (error) {
      console.error('[Git Smart HTTP] Error:', error);
      return c.text('Internal Server Error', 500);
    }
  });

  // POST /:namespace/:project/git-upload-pack - Git fetch/clone data.
  app.post('/:namespace/:project/git-upload-pack', async (c) => {
    const namespace = c.req.param('namespace');
    const project = c.req.param('project');

    // Extract auth for Git HTTP.
    const gitAuth = await extractGitAuth(c);

    console.log('[Git Smart HTTP] git-upload-pack request:', {
      namespace,
      project,
      hasAuth: !!gitAuth,
    });

    // Check for authentication.
    if (!gitAuth) {
      return c.text('Authentication required', 401, {
        'WWW-Authenticate': 'Basic realm="Git"',
      });
    }

    try {
      const repoPath = `${namespace}/${project}`;
      const repoInfo = await fetchRepositoryInfo(
        repoPath,
        gitAuth.adoAuthHeader,
        gitAuth.adoBaseUrl,
        config.adoApiVersion ?? '7.1',
        gitAuth.allowedProjects
      );

      if (!repoInfo) {
        return c.text('Repository not found', 404);
      }

      const adoGitUrl = `${gitAuth.adoBaseUrl}/${encodeURIComponent(repoInfo.projectName)}/_git/${encodeURIComponent(repoInfo.repo.name)}/git-upload-pack`;
      const rawBody = await c.req.arrayBuffer();
      const requestBody = decodeGitBody(rawBody, c.req.header('Content-Encoding') ?? undefined);

      const response = await fetch(adoGitUrl, {
        method: 'POST',
        headers: {
          Authorization: gitAuth.adoAuthHeader,
          'Content-Type': c.req.header('Content-Type') ?? 'application/x-git-upload-pack-request',
        },
        body: requestBody,
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.log('[Git Smart HTTP] ADO error:', {
          status: response.status,
          error: errorText.slice(0, 200),
        });
        return c.text(errorText, response.status as 400 | 401 | 403 | 404 | 500);
      }

      const body = await response.arrayBuffer();
      return c.body(body, 200, {
        'Content-Type':
          response.headers.get('Content-Type') ?? 'application/x-git-upload-pack-result',
        'Cache-Control': 'no-cache',
      });
    } catch (error) {
      console.error('[Git Smart HTTP] Error:', error);
      return c.text('Internal Server Error', 500);
    }
  });

  // POST /:namespace/:project/git-receive-pack - Git push data.
  app.post('/:namespace/:project/git-receive-pack', async (c) => {
    const namespace = c.req.param('namespace');
    const project = c.req.param('project');

    // Extract auth for Git HTTP.
    const gitAuth = await extractGitAuth(c);

    console.log('[Git Smart HTTP] git-receive-pack request:', {
      namespace,
      project,
      hasAuth: !!gitAuth,
    });

    // Check for authentication.
    if (!gitAuth) {
      return c.text('Authentication required', 401, {
        'WWW-Authenticate': 'Basic realm="Git"',
      });
    }

    try {
      const repoPath = `${namespace}/${project}`;
      const repoInfo = await fetchRepositoryInfo(
        repoPath,
        gitAuth.adoAuthHeader,
        gitAuth.adoBaseUrl,
        config.adoApiVersion ?? '7.1',
        gitAuth.allowedProjects
      );

      if (!repoInfo) {
        return c.text('Repository not found', 404);
      }

      const adoGitUrl = `${gitAuth.adoBaseUrl}/${encodeURIComponent(repoInfo.projectName)}/_git/${encodeURIComponent(repoInfo.repo.name)}/git-receive-pack`;
      const rawBody = await c.req.arrayBuffer();
      const requestBody = decodeGitBody(rawBody, c.req.header('Content-Encoding') ?? undefined);

      const response = await fetch(adoGitUrl, {
        method: 'POST',
        headers: {
          Authorization: gitAuth.adoAuthHeader,
          'Content-Type':
            c.req.header('Content-Type') ?? 'application/x-git-receive-pack-request',
        },
        body: requestBody,
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.log('[Git Smart HTTP] ADO error:', {
          status: response.status,
          error: errorText.slice(0, 200),
        });
        return c.text(errorText, response.status as 400 | 401 | 403 | 404 | 500);
      }

      const body = await response.arrayBuffer();
      return c.body(body, 200, {
        'Content-Type':
          response.headers.get('Content-Type') ?? 'application/x-git-receive-pack-result',
        'Cache-Control': 'no-cache',
      });
    } catch (error) {
      console.error('[Git Smart HTTP] Error:', error);
      return c.text('Internal Server Error', 500);
    }
  });
}
