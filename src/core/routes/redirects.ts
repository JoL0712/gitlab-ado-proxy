/**
 * Web UI redirects: Redirect GitLab-style URLs to Azure DevOps.
 * 
 * Maintains a persistent mapping of namespace/repo -> org name so users
 * don't need to provide the org name on every request after the first time.
 */

import { Hono } from 'hono';
import { MappingService } from '../mapping.js';
import { getStorage } from '../storage/index.js';
import { toUrlSafe } from '../helpers/repository.js';
import type { Env } from './env.js';
import type { OAuthTokenData, StoredAccessToken } from '../types.js';

/**
 * Get the cached org name for a namespace/project path.
 */
async function getCachedOrgMapping(namespace: string, project: string): Promise<string | null> {
  const storage = getStorage();
  const key = `org_mapping:${namespace.toLowerCase()}/${project.toLowerCase()}`;
  const orgName = await storage.get<string>(key);
  return orgName;
}

/**
 * Store the org name mapping for a namespace/project path.
 */
async function storeOrgMapping(namespace: string, project: string, orgName: string): Promise<void> {
  const storage = getStorage();
  const key = `org_mapping:${namespace.toLowerCase()}/${project.toLowerCase()}`;
  await storage.set(key, orgName);
  console.log('[Org Mapping] Stored mapping:', { namespace, project, orgName });
}

/**
 * Extract auth info from request (similar to git.ts but for web redirects).
 * If cachedOrgName is provided, use it instead of requiring username.
 */
async function extractWebAuth(c: any, cachedOrgName?: string | null): Promise<{
  adoAuthHeader: string;
  adoBaseUrl: string;
  orgName: string;
  allowedProjects: string[];
} | null> {
  const authHeader = c.req.header('Authorization');
  if (!authHeader) {
    return null;
  }

  let token: string | null = null;
  let username: string | null = null;

  if (authHeader.toLowerCase().startsWith('basic ')) {
    try {
      const base64Credentials = authHeader.substring(6).trim();
      const decoded = Buffer.from(base64Credentials, 'base64').toString('utf-8');
      const colonIndex = decoded.indexOf(':');
      if (colonIndex !== -1) {
        username = decoded.substring(0, colonIndex);
        token = decoded.substring(colonIndex + 1);
      } else {
        token = decoded;
      }
    } catch (e) {
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
      orgName: oauthData.orgName,
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
    if (!tokenData || tokenData.revoked) {
      return null;
    }
    // Extract org name from adoBaseUrl.
    const orgMatch = tokenData.adoBaseUrl.match(/dev\.azure\.com\/([^/]+)/);
    const orgName = orgMatch ? orgMatch[1] : '';
    return {
      adoAuthHeader: MappingService.convertAuth(tokenData.adoPat),
      adoBaseUrl: tokenData.adoBaseUrl,
      orgName,
      allowedProjects: tokenData.allowedProjects,
    };
  }

  // Raw ADO PAT: try cached org name first, then username.
  const orgName = cachedOrgName || (username && username.trim() !== '' ? username.trim() : null);
  if (orgName) {
    return {
      adoAuthHeader: MappingService.convertAuth(token),
      adoBaseUrl: `https://dev.azure.com/${encodeURIComponent(orgName)}`,
      orgName,
      allowedProjects: [],
    };
  }

  return null;
}

/**
 * Find the actual project name from ADO (handles URL-safe to real name conversion).
 */
async function resolveProjectName(
  projectPath: string,
  adoAuthHeader: string,
  adoBaseUrl: string
): Promise<string | null> {
  // First try the path as-is.
  const projectsUrl = MappingService.buildAdoUrl(adoBaseUrl, '/_apis/projects');
  const response = await fetch(projectsUrl, {
    method: 'GET',
    headers: {
      Authorization: adoAuthHeader,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as { value: Array<{ name: string }> };

  // Try exact match first.
  const exactMatch = data.value.find(
    (p) => p.name.toLowerCase() === projectPath.toLowerCase()
  );
  if (exactMatch) {
    return exactMatch.name;
  }

  // Try URL-safe match.
  const urlSafeMatch = data.value.find(
    (p) => toUrlSafe(p.name) === projectPath.toLowerCase()
  );
  if (urlSafeMatch) {
    return urlSafeMatch.name;
  }

  return null;
}

/**
 * Helper to handle auth and redirect with org mapping caching.
 */
async function handleRedirect(
  c: any,
  namespace: string,
  project: string,
  buildAdoUrl: (orgName: string, actualProjectName: string) => string
): Promise<Response> {
  // Check for cached org mapping.
  const cachedOrg = await getCachedOrgMapping(namespace, project);

  // Try to extract auth (use cached org if available).
  const auth = await extractWebAuth(c, cachedOrg);

  if (!auth) {
    // Prompt for credentials.
    const message = cachedOrg
      ? 'Authentication required. Enter any username and your ADO PAT as password.'
      : 'Authentication required. Use your ADO org name as username and PAT as password.';
    return c.text(message, 401, {
      'WWW-Authenticate': 'Basic realm="Azure DevOps"',
    });
  }

  // Resolve the actual project name.
  const actualProjectName = await resolveProjectName(namespace, auth.adoAuthHeader, auth.adoBaseUrl);
  if (!actualProjectName) {
    return c.text(`Project not found: ${namespace}`, 404);
  }

  // Store org mapping if we don't have it cached.
  if (!cachedOrg) {
    await storeOrgMapping(namespace, project, auth.orgName);
  }

  // Build and redirect to ADO URL.
  const adoUrl = buildAdoUrl(auth.orgName, actualProjectName);
  return c.redirect(adoUrl);
}

export function registerRedirects(app: Hono<Env>): void {
  // Redirect: /:namespace/:project/-/merge_requests/:iid -> ADO PR page.
  app.get('/:namespace/:project/-/merge_requests/:iid', async (c) => {
    const namespace = c.req.param('namespace');
    const project = c.req.param('project');
    const iid = c.req.param('iid');

    return handleRedirect(c, namespace, project, (orgName, actualProjectName) => {
      const url = `https://dev.azure.com/${encodeURIComponent(orgName)}/${encodeURIComponent(actualProjectName)}/_git/${encodeURIComponent(project)}/pullrequest/${iid}`;
      console.log('[Redirect] Merge request:', { from: `/${namespace}/${project}/-/merge_requests/${iid}`, to: url });
      return url;
    });
  });

  // Redirect: /:namespace/:project (project/repo page) -> ADO repo page.
  app.get('/:namespace/:project', async (c) => {
    const namespace = c.req.param('namespace');
    const project = c.req.param('project');

    // Skip if this looks like an API or special request.
    if (namespace === 'api' || namespace === 'oauth' || project === 'info') {
      return c.notFound();
    }

    return handleRedirect(c, namespace, project, (orgName, actualProjectName) => {
      const url = `https://dev.azure.com/${encodeURIComponent(orgName)}/${encodeURIComponent(actualProjectName)}/_git/${encodeURIComponent(project)}`;
      console.log('[Redirect] Repository:', { from: `/${namespace}/${project}`, to: url });
      return url;
    });
  });

  // Redirect: /:namespace/:project/-/commit/:sha -> ADO commit page.
  app.get('/:namespace/:project/-/commit/:sha', async (c) => {
    const namespace = c.req.param('namespace');
    const project = c.req.param('project');
    const sha = c.req.param('sha');

    return handleRedirect(c, namespace, project, (orgName, actualProjectName) => {
      const url = `https://dev.azure.com/${encodeURIComponent(orgName)}/${encodeURIComponent(actualProjectName)}/_git/${encodeURIComponent(project)}/commit/${sha}`;
      console.log('[Redirect] Commit:', { from: `/${namespace}/${project}/-/commit/${sha}`, to: url });
      return url;
    });
  });

  // Redirect: /:namespace/:project/-/tree/:ref -> ADO branch/tree page.
  app.get('/:namespace/:project/-/tree/:ref{.+}', async (c) => {
    const namespace = c.req.param('namespace');
    const project = c.req.param('project');
    const ref = c.req.param('ref');

    return handleRedirect(c, namespace, project, (orgName, actualProjectName) => {
      const url = `https://dev.azure.com/${encodeURIComponent(orgName)}/${encodeURIComponent(actualProjectName)}/_git/${encodeURIComponent(project)}?version=GB${encodeURIComponent(ref)}`;
      console.log('[Redirect] Tree:', { from: `/${namespace}/${project}/-/tree/${ref}`, to: url });
      return url;
    });
  });

  // Redirect: /:namespace/:project/-/blob/:ref/*path -> ADO file page.
  app.get('/:namespace/:project/-/blob/:ref{.+}', async (c) => {
    const namespace = c.req.param('namespace');
    const project = c.req.param('project');
    const refAndPath = c.req.param('ref');

    // Parse ref and path from combined param.
    const slashIndex = refAndPath.indexOf('/');
    const ref = slashIndex !== -1 ? refAndPath.substring(0, slashIndex) : refAndPath;
    const path = slashIndex !== -1 ? refAndPath.substring(slashIndex) : '';

    return handleRedirect(c, namespace, project, (orgName, actualProjectName) => {
      const url = `https://dev.azure.com/${encodeURIComponent(orgName)}/${encodeURIComponent(actualProjectName)}/_git/${encodeURIComponent(project)}?path=${encodeURIComponent(path)}&version=GB${encodeURIComponent(ref)}`;
      console.log('[Redirect] Blob:', { from: `/${namespace}/${project}/-/blob/${refAndPath}`, to: url });
      return url;
    });
  });

  // Redirect: /:namespace/:project/-/branches -> ADO branches page.
  app.get('/:namespace/:project/-/branches', async (c) => {
    const namespace = c.req.param('namespace');
    const project = c.req.param('project');

    return handleRedirect(c, namespace, project, (orgName, actualProjectName) => {
      const url = `https://dev.azure.com/${encodeURIComponent(orgName)}/${encodeURIComponent(actualProjectName)}/_git/${encodeURIComponent(project)}/branches`;
      console.log('[Redirect] Branches:', { from: `/${namespace}/${project}/-/branches`, to: url });
      return url;
    });
  });

  // Redirect: /:namespace/:project/-/compare/:refs -> ADO compare page.
  app.get('/:namespace/:project/-/compare/:refs', async (c) => {
    const namespace = c.req.param('namespace');
    const project = c.req.param('project');
    const refs = c.req.param('refs');

    // GitLab format: base...head.
    const [base, head] = refs.includes('...') ? refs.split('...') : [refs, 'main'];

    return handleRedirect(c, namespace, project, (orgName, actualProjectName) => {
      const url = `https://dev.azure.com/${encodeURIComponent(orgName)}/${encodeURIComponent(actualProjectName)}/_git/${encodeURIComponent(project)}/branchCompare?baseVersion=GB${encodeURIComponent(base)}&targetVersion=GB${encodeURIComponent(head)}`;
      console.log('[Redirect] Compare:', { from: `/${namespace}/${project}/-/compare/${refs}`, to: url });
      return url;
    });
  });
}
