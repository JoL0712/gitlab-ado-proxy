/**
 * OAuth routes: authorize (GET/POST), authorize/confirm, token.
 */

import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { MappingService } from '../mapping.js';
import { getStorage } from '../storage/index.js';
import type { Env, OAuthState } from './env.js';
import type { ProxyConfig } from '../types.js';
import type { OAuthTokenData } from '../types.js';

const SESSION_TTL_MS = 10 * 60 * 1000;

function normalizeOrgForUrl(org: string): string {
  return encodeURIComponent(org.trim().replace(/\s+/g, '-'));
}

export function registerOauth(
  app: Hono<Env>,
  config: ProxyConfig,
  state: OAuthState
): void {
  const { authSessions, oauthCodes } = state;

  // GET /oauth/authorize - Step 1: show form to enter PAT for client_id (org name).
  app.get('/oauth/authorize', async (c) => {
    const clientId = c.req.query('client_id');
    const redirectUri = c.req.query('redirect_uri');
    const stateParam = c.req.query('state');
    const responseType = c.req.query('response_type');
    const scope = c.req.query('scope');

    if (!clientId || !redirectUri || !stateParam || responseType !== 'code') {
      return c.json(
        { error: 'invalid_request', error_description: 'Missing required parameters', statusCode: 400 },
        400
      );
    }

    const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Authorize Application</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 500px; margin: 50px auto; padding: 20px; }
    .form-group { margin-bottom: 15px; }
    label { display: block; margin-bottom: 5px; font-weight: bold; }
    input[type="text"] { width: 100%; padding: 8px; box-sizing: border-box; }
    button { background: #007bff; color: white; padding: 10px 20px; border: none; cursor: pointer; }
    button:hover { background: #0056b3; }
    .info { background: #f0f0f0; padding: 10px; margin-bottom: 20px; border-radius: 4px; }
  </style>
</head>
<body>
  <h2>Authorize Application</h2>
  <div class="info">
    <p><strong>Organization:</strong> ${clientId}</p>
    <p><strong>Scopes:</strong> ${scope || 'api'}</p>
  </div>
  <form method="POST" action="/oauth/authorize">
    <input type="hidden" name="client_id" value="${clientId}">
    <input type="hidden" name="redirect_uri" value="${redirectUri}">
    <input type="hidden" name="state" value="${stateParam}">
    <input type="hidden" name="response_type" value="${responseType}">
    <input type="hidden" name="scope" value="${scope || 'api'}">
    <div class="form-group">
      <label for="pat">Azure DevOps Personal Access Token:</label>
      <input type="text" id="pat" name="pat" placeholder="Enter your ADO PAT" required>
      <small>This token will be used to authenticate with Azure DevOps and list projects.</small>
    </div>
    <button type="submit">Continue</button>
  </form>
</body>
</html>
    `;
    return c.html(html);
  });

  // POST /oauth/authorize - Step 1: validate PAT via ADO Projects API, then show project-selection (step 2).
  app.post('/oauth/authorize', async (c) => {
    const body = await c.req.parseBody();
    const clientId = (body.client_id as string)?.trim();
    const redirectUri = (body.redirect_uri as string)?.trim();
    const stateParam = (body.state as string)?.trim();
    const responseType = (body.response_type as string)?.trim();
    const scope = (body.scope as string)?.trim() || 'api';
    const pat = (body.pat as string)?.trim();
    const selectedProjects = body['projects[]'] ?? body.selected_projects;

    if (!clientId || !redirectUri || !stateParam || responseType !== 'code' || !pat) {
      return c.json(
        { error: 'invalid_request', error_description: 'Missing required parameters', statusCode: 400 },
        400
      );
    }

    // Step 2 already done (session_id + projects): not handled here; that is POST /oauth/authorize/confirm.
    if (selectedProjects !== undefined && selectedProjects !== null) {
      return c.json(
        { error: 'invalid_request', error_description: 'Submit project selection to /oauth/authorize/confirm', statusCode: 400 },
        400
      );
    }

    const adoBaseUrl = `https://dev.azure.com/${normalizeOrgForUrl(clientId)}`;
    const projectsUrl = MappingService.buildAdoUrl(adoBaseUrl, '/_apis/projects');
    const authHeader = MappingService.convertAuth(pat);

    const response = await fetch(projectsUrl, {
      method: 'GET',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      const text = await response.text();
      console.warn('[OAuth] PAT validation failed:', { status: response.status, body: text.slice(0, 200) });
      return c.json(
        {
          error: 'access_denied',
          error_description: 'Invalid PAT or organization unreachable',
          statusCode: 400,
        },
        400
      );
    }

    type AdoProject = { name: string; id?: string };
    const data = (await response.json()) as { value?: AdoProject[] };
    const projects: string[] = (data.value ?? []).map((p) => p.name).filter(Boolean);

    const sessionId = Buffer.from(`${Date.now()}-${Math.random()}`).toString('base64url');
    const expiresAt = Date.now() + SESSION_TTL_MS;
    authSessions.set(sessionId, {
      clientId,
      redirectUri,
      state: stateParam,
      responseType,
      scope,
      pat,
      projects,
      expiresAt,
    });

    const projectList = projects
      .map(
        (name) =>
          `<label><input type="checkbox" name="projects[]" value="${name.replace(/"/g, '&quot;')}"> ${name.replace(/</g, '&lt;')}</label>`
      )
      .join('<br>');

    const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Select Projects</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 500px; margin: 50px auto; padding: 20px; }
    .form-group { margin-bottom: 15px; }
    label { display: block; margin: 8px 0; }
    button { background: #007bff; color: white; padding: 10px 20px; border: none; cursor: pointer; }
    button:hover { background: #0056b3; }
    .info { background: #f0f0f0; padding: 10px; margin-bottom: 20px; border-radius: 4px; }
  </style>
</head>
<body>
  <h2>Select Projects</h2>
  <div class="info">
    <p>Choose which Azure DevOps projects this token may access for organization <strong>${clientId.replace(/</g, '&lt;')}</strong>.</p>
  </div>
  <form method="POST" action="/oauth/authorize/confirm">
    <input type="hidden" name="session_id" value="${sessionId}">
    <div class="form-group">
      ${projectList || '<p>No projects found.</p>'}
    </div>
    <button type="submit">Authorize</button>
  </form>
</body>
</html>
    `;
    return c.html(html);
  });

  // POST /oauth/authorize/confirm - Step 2: create proxy token, store it, redirect with code.
  app.post('/oauth/authorize/confirm', async (c) => {
    const body = await c.req.parseBody();
    const sessionId = (body.session_id as string)?.trim();
    const rawProjects = body['projects[]'] ?? body.selected_projects;

    if (!sessionId) {
      return c.json(
        { error: 'invalid_request', error_description: 'Missing session_id', statusCode: 400 },
        400
      );
    }

    const session = authSessions.get(sessionId);
    authSessions.delete(sessionId);

    if (!session || Date.now() > session.expiresAt) {
      return c.json(
        { error: 'invalid_request', error_description: 'Session expired or invalid', statusCode: 400 },
        400
      );
    }

    const selectedProjects: string[] = Array.isArray(rawProjects)
      ? rawProjects.map((p) => String(p).trim()).filter(Boolean)
      : typeof rawProjects === 'string'
        ? rawProjects.split(',').map((p) => p.trim()).filter(Boolean)
        : [];

    const adoBaseUrl = `https://dev.azure.com/${normalizeOrgForUrl(session.clientId)}`;
    const allowedProjects = selectedProjects.length > 0 ? selectedProjects : session.projects;

    const tokenValue = `glpat-oauth-${randomBytes(24).toString('base64url')}`;
    const kv = getStorage();
    const oauthData: OAuthTokenData = {
      adoPat: session.pat,
      orgName: session.clientId,
      adoBaseUrl,
      allowedProjects,
    };
    await kv.set(`oauth_token:${tokenValue}`, oauthData);

    const authCode = Buffer.from(`${Date.now()}-${Math.random()}`).toString('base64url');
    oauthCodes.set(authCode, {
      accessToken: tokenValue,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    const redirectUrl = new URL(session.redirectUri);
    redirectUrl.searchParams.set('code', authCode);
    redirectUrl.searchParams.set('state', session.state);
    return c.redirect(redirectUrl.toString());
  });

  // POST /oauth/token - Exchange code or refresh token for access token.
  app.post('/oauth/token', async (c) => {
    const body = await c.req.parseBody();
    const grantType = body.grant_type as string;
    const clientSecret = body.client_secret as string;

    // Validate client_secret if configured.
    if (config.oauthClientSecret && (!clientSecret || clientSecret !== config.oauthClientSecret)) {
      return c.json(
        { error: 'invalid_client', error_description: 'Invalid client_secret', statusCode: 401 },
        401
      );
    }

    if (grantType === 'authorization_code') {
      const code = body.code as string;

      if (!code) {
        return c.json(
          { error: 'invalid_request', error_description: 'Missing authorization code', statusCode: 400 },
          400
        );
      }

      const codeData = oauthCodes.get(code);
      if (!codeData) {
        return c.json(
          { error: 'invalid_grant', error_description: 'Invalid or expired authorization code', statusCode: 400 },
          400
        );
      }
      if (Date.now() > codeData.expiresAt) {
        oauthCodes.delete(code);
        return c.json(
          { error: 'invalid_grant', error_description: 'Authorization code has expired', statusCode: 400 },
          400
        );
      }
      oauthCodes.delete(code);

      // Generate a refresh token that maps to the same OAuth data.
      const refreshToken = `glrt-${randomBytes(32).toString('base64url')}`;
      const kv = getStorage();

      // Store refresh token mapping to the access token.
      // Refresh tokens are long-lived (90 days) and get extended on each use.
      const refreshTokenData = {
        accessToken: codeData.accessToken,
        createdAt: Date.now(),
      };
      await kv.set(`refresh_token:${refreshToken}`, refreshTokenData, { ttl: 90 * 24 * 60 * 60 });

      return c.json({
        access_token: codeData.accessToken,
        token_type: 'Bearer',
        expires_in: 7200,
        refresh_token: refreshToken,
        scope: 'api',
      });
    } else if (grantType === 'refresh_token') {
      const refreshToken = body.refresh_token as string;

      if (!refreshToken) {
        return c.json(
          { error: 'invalid_request', error_description: 'Missing refresh_token', statusCode: 400 },
          400
        );
      }

      const kv = getStorage();
      const refreshData = await kv.get<{ accessToken: string; createdAt: number }>(`refresh_token:${refreshToken}`);

      if (!refreshData) {
        return c.json(
          { error: 'invalid_grant', error_description: 'Invalid or expired refresh token', statusCode: 400 },
          400
        );
      }

      // Verify the original OAuth token still exists.
      const oauthData = await kv.get<OAuthTokenData>(`oauth_token:${refreshData.accessToken}`);
      if (!oauthData) {
        // Original token was revoked or deleted.
        await kv.delete(`refresh_token:${refreshToken}`);
        return c.json(
          { error: 'invalid_grant', error_description: 'Associated access token no longer valid', statusCode: 400 },
          400
        );
      }

      // Generate a new access token with the same OAuth data.
      const newAccessToken = `glpat-oauth-${randomBytes(24).toString('base64url')}`;
      await kv.set(`oauth_token:${newAccessToken}`, oauthData);

      // Generate a new refresh token (token rotation for security).
      // Each refresh extends the TTL by 90 days, so users never have to re-login.
      const newRefreshToken = `glrt-${randomBytes(32).toString('base64url')}`;
      const newRefreshData = {
        accessToken: newAccessToken,
        createdAt: Date.now(),
      };
      await kv.set(`refresh_token:${newRefreshToken}`, newRefreshData, { ttl: 90 * 24 * 60 * 60 });

      // Invalidate the old refresh token.
      await kv.delete(`refresh_token:${refreshToken}`);

      return c.json({
        access_token: newAccessToken,
        token_type: 'Bearer',
        expires_in: 7200,
        refresh_token: newRefreshToken,
        scope: 'api',
      });
    } else {
      return c.json(
        { error: 'unsupported_grant_type', error_description: 'Supported grant types: authorization_code, refresh_token', statusCode: 400 },
        400
      );
    }
  });
}
