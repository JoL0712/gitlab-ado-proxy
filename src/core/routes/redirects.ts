/**
 * Web UI redirects: Redirect GitLab-style URLs to Azure DevOps.
 */

import { Hono } from 'hono';
import { MappingService } from '../mapping.js';
import { getStorage } from '../storage/index.js';
import { toUrlSafe } from '../helpers/repository.js';
import type { Env } from './env.js';
import type { OAuthTokenData, StoredAccessToken } from '../types.js';

/**
 * Extract auth info from request (similar to git.ts but for web redirects).
 */
async function extractWebAuth(c: any): Promise<{
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

  // Raw ADO PAT with org name as username.
  if (username && username.trim() !== '') {
    const orgName = username.trim();
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

export function registerRedirects(app: Hono<Env>): void {
  // Redirect: /:namespace/:project/-/merge_requests/:iid -> ADO PR page.
  app.get('/:namespace/:project/-/merge_requests/:iid', async (c) => {
    const namespace = c.req.param('namespace');
    const project = c.req.param('project');
    const iid = c.req.param('iid');

    const auth = await extractWebAuth(c);

    if (!auth) {
      // Prompt for credentials.
      return c.text('Authentication required. Use your ADO org name as username and PAT as password.', 401, {
        'WWW-Authenticate': 'Basic realm="Azure DevOps"',
      });
    }

    // Resolve the actual project name.
    const actualProjectName = await resolveProjectName(namespace, auth.adoAuthHeader, auth.adoBaseUrl);
    if (!actualProjectName) {
      return c.text(`Project not found: ${namespace}`, 404);
    }

    // Build the Azure DevOps PR URL.
    const adoUrl = `https://dev.azure.com/${encodeURIComponent(auth.orgName)}/${encodeURIComponent(actualProjectName)}/_git/${encodeURIComponent(project)}/pullrequest/${iid}`;

    console.log('[Redirect] Merge request redirect:', {
      from: `/${namespace}/${project}/-/merge_requests/${iid}`,
      to: adoUrl,
    });

    return c.redirect(adoUrl);
  });

  // Redirect: /:namespace/:project (project/repo page) -> ADO repo page.
  app.get('/:namespace/:project', async (c) => {
    const namespace = c.req.param('namespace');
    const project = c.req.param('project');

    // Skip if this looks like an API or git request.
    if (namespace === 'api' || namespace === 'oauth' || project === 'info') {
      return c.notFound();
    }

    const auth = await extractWebAuth(c);

    if (!auth) {
      return c.text('Authentication required. Use your ADO org name as username and PAT as password.', 401, {
        'WWW-Authenticate': 'Basic realm="Azure DevOps"',
      });
    }

    const actualProjectName = await resolveProjectName(namespace, auth.adoAuthHeader, auth.adoBaseUrl);
    if (!actualProjectName) {
      return c.text(`Project not found: ${namespace}`, 404);
    }

    const adoUrl = `https://dev.azure.com/${encodeURIComponent(auth.orgName)}/${encodeURIComponent(actualProjectName)}/_git/${encodeURIComponent(project)}`;

    console.log('[Redirect] Repository redirect:', {
      from: `/${namespace}/${project}`,
      to: adoUrl,
    });

    return c.redirect(adoUrl);
  });

  // Redirect: /:namespace/:project/-/commit/:sha -> ADO commit page.
  app.get('/:namespace/:project/-/commit/:sha', async (c) => {
    const namespace = c.req.param('namespace');
    const project = c.req.param('project');
    const sha = c.req.param('sha');

    const auth = await extractWebAuth(c);

    if (!auth) {
      return c.text('Authentication required. Use your ADO org name as username and PAT as password.', 401, {
        'WWW-Authenticate': 'Basic realm="Azure DevOps"',
      });
    }

    const actualProjectName = await resolveProjectName(namespace, auth.adoAuthHeader, auth.adoBaseUrl);
    if (!actualProjectName) {
      return c.text(`Project not found: ${namespace}`, 404);
    }

    const adoUrl = `https://dev.azure.com/${encodeURIComponent(auth.orgName)}/${encodeURIComponent(actualProjectName)}/_git/${encodeURIComponent(project)}/commit/${sha}`;

    console.log('[Redirect] Commit redirect:', {
      from: `/${namespace}/${project}/-/commit/${sha}`,
      to: adoUrl,
    });

    return c.redirect(adoUrl);
  });

  // Redirect: /:namespace/:project/-/tree/:ref -> ADO branch/tree page.
  app.get('/:namespace/:project/-/tree/:ref{.+}', async (c) => {
    const namespace = c.req.param('namespace');
    const project = c.req.param('project');
    const ref = c.req.param('ref');

    const auth = await extractWebAuth(c);

    if (!auth) {
      return c.text('Authentication required. Use your ADO org name as username and PAT as password.', 401, {
        'WWW-Authenticate': 'Basic realm="Azure DevOps"',
      });
    }

    const actualProjectName = await resolveProjectName(namespace, auth.adoAuthHeader, auth.adoBaseUrl);
    if (!actualProjectName) {
      return c.text(`Project not found: ${namespace}`, 404);
    }

    const adoUrl = `https://dev.azure.com/${encodeURIComponent(auth.orgName)}/${encodeURIComponent(actualProjectName)}/_git/${encodeURIComponent(project)}?version=GB${encodeURIComponent(ref)}`;

    console.log('[Redirect] Tree redirect:', {
      from: `/${namespace}/${project}/-/tree/${ref}`,
      to: adoUrl,
    });

    return c.redirect(adoUrl);
  });

  // Redirect: /:namespace/:project/-/blob/:ref/*path -> ADO file page.
  app.get('/:namespace/:project/-/blob/:ref{.+}', async (c) => {
    const namespace = c.req.param('namespace');
    const project = c.req.param('project');
    const refAndPath = c.req.param('ref');

    const auth = await extractWebAuth(c);

    if (!auth) {
      return c.text('Authentication required. Use your ADO org name as username and PAT as password.', 401, {
        'WWW-Authenticate': 'Basic realm="Azure DevOps"',
      });
    }

    const actualProjectName = await resolveProjectName(namespace, auth.adoAuthHeader, auth.adoBaseUrl);
    if (!actualProjectName) {
      return c.text(`Project not found: ${namespace}`, 404);
    }

    // The ref might include the path (e.g., "main/src/file.ts").
    // ADO URL format: ?path=/src/file.ts&version=GBmain
    const slashIndex = refAndPath.indexOf('/');
    let ref = refAndPath;
    let path = '';
    if (slashIndex !== -1) {
      ref = refAndPath.substring(0, slashIndex);
      path = refAndPath.substring(slashIndex);
    }

    const adoUrl = `https://dev.azure.com/${encodeURIComponent(auth.orgName)}/${encodeURIComponent(actualProjectName)}/_git/${encodeURIComponent(project)}?path=${encodeURIComponent(path)}&version=GB${encodeURIComponent(ref)}`;

    console.log('[Redirect] Blob redirect:', {
      from: `/${namespace}/${project}/-/blob/${refAndPath}`,
      to: adoUrl,
    });

    return c.redirect(adoUrl);
  });

  // Redirect: /:namespace/:project/-/branches -> ADO branches page.
  app.get('/:namespace/:project/-/branches', async (c) => {
    const namespace = c.req.param('namespace');
    const project = c.req.param('project');

    const auth = await extractWebAuth(c);

    if (!auth) {
      return c.text('Authentication required. Use your ADO org name as username and PAT as password.', 401, {
        'WWW-Authenticate': 'Basic realm="Azure DevOps"',
      });
    }

    const actualProjectName = await resolveProjectName(namespace, auth.adoAuthHeader, auth.adoBaseUrl);
    if (!actualProjectName) {
      return c.text(`Project not found: ${namespace}`, 404);
    }

    const adoUrl = `https://dev.azure.com/${encodeURIComponent(auth.orgName)}/${encodeURIComponent(actualProjectName)}/_git/${encodeURIComponent(project)}/branches`;

    console.log('[Redirect] Branches redirect:', {
      from: `/${namespace}/${project}/-/branches`,
      to: adoUrl,
    });

    return c.redirect(adoUrl);
  });

  // Redirect: /:namespace/:project/-/compare/:refs -> ADO compare page.
  app.get('/:namespace/:project/-/compare/:refs', async (c) => {
    const namespace = c.req.param('namespace');
    const project = c.req.param('project');
    const refs = c.req.param('refs');

    const auth = await extractWebAuth(c);

    if (!auth) {
      return c.text('Authentication required. Use your ADO org name as username and PAT as password.', 401, {
        'WWW-Authenticate': 'Basic realm="Azure DevOps"',
      });
    }

    const actualProjectName = await resolveProjectName(namespace, auth.adoAuthHeader, auth.adoBaseUrl);
    if (!actualProjectName) {
      return c.text(`Project not found: ${namespace}`, 404);
    }

    // GitLab format: base...head, ADO format: ?baseVersion=GBbase&targetVersion=GBhead
    const [base, head] = refs.includes('...') ? refs.split('...') : [refs, 'main'];

    const adoUrl = `https://dev.azure.com/${encodeURIComponent(auth.orgName)}/${encodeURIComponent(actualProjectName)}/_git/${encodeURIComponent(project)}/branchCompare?baseVersion=GB${encodeURIComponent(base)}&targetVersion=GB${encodeURIComponent(head)}`;

    console.log('[Redirect] Compare redirect:', {
      from: `/${namespace}/${project}/-/compare/${refs}`,
      to: adoUrl,
    });

    return c.redirect(adoUrl);
  });
}
