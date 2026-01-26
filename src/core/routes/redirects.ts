/**
 * Web UI redirects: Redirect GitLab-style URLs to Azure DevOps.
 * 
 * Uses cached org mappings from repository lookups so users
 * don't need to provide the org name on every request after the first time.
 */

import { Hono } from 'hono';
import { getCachedOrgMapping, storeOrgMapping, getKnownOrgs } from '../helpers/repository.js';
import type { Env } from './env.js';

/**
 * Generate HTML page for selecting an organization.
 */
function generateOrgSelectorPage(
  knownOrgs: string[],
  namespace: string,
  project: string,
  originalPath: string
): string {
  const orgButtons = knownOrgs
    .map(org => `<button type="submit" name="org" value="${org.replace(/"/g, '&quot;')}" class="org-btn">${org.replace(/</g, '&lt;')}</button>`)
    .join('\n          ');

  return `<!DOCTYPE html>
<html>
<head>
  <title>Select Organization - GitLab-ADO Proxy</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 500px;
      margin: 50px auto;
      padding: 20px;
      background: #f5f5f5;
    }
    .card {
      background: white;
      border-radius: 8px;
      padding: 24px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    h2 { margin-top: 0; color: #333; }
    .path {
      background: #f0f0f0;
      padding: 12px;
      border-radius: 4px;
      font-family: monospace;
      margin-bottom: 20px;
      word-break: break-all;
    }
    .org-btn {
      display: block;
      width: 100%;
      padding: 12px 16px;
      margin-bottom: 8px;
      background: #0078d4;
      color: white;
      border: none;
      border-radius: 4px;
      font-size: 16px;
      cursor: pointer;
      text-align: left;
    }
    .org-btn:hover { background: #106ebe; }
    .org-btn:last-child { margin-bottom: 0; }
    .divider {
      text-align: center;
      margin: 20px 0;
      color: #666;
    }
    .manual-input {
      display: flex;
      gap: 8px;
    }
    .manual-input input {
      flex: 1;
      padding: 12px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 16px;
    }
    .manual-input button {
      padding: 12px 20px;
      background: #28a745;
      color: white;
      border: none;
      border-radius: 4px;
      font-size: 16px;
      cursor: pointer;
    }
    .manual-input button:hover { background: #218838; }
    .info { color: #666; font-size: 14px; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Select Azure DevOps Organization</h2>
    <div class="path">${namespace.replace(/</g, '&lt;')}/${project.replace(/</g, '&lt;')}</div>
    
    ${knownOrgs.length > 0 ? `
    <form method="POST" action="/_proxy/select-org">
      <input type="hidden" name="redirect_path" value="${originalPath.replace(/"/g, '&quot;')}">
      <input type="hidden" name="namespace" value="${namespace.replace(/"/g, '&quot;')}">
      <input type="hidden" name="project" value="${project.replace(/"/g, '&quot;')}">
      <p>Select an organization:</p>
      ${orgButtons}
    </form>
    <div class="divider">— or enter a new one —</div>
    ` : '<p>Enter your Azure DevOps organization name:</p>'}
    
    <form method="POST" action="/_proxy/select-org">
      <input type="hidden" name="redirect_path" value="${originalPath.replace(/"/g, '&quot;')}">
      <input type="hidden" name="namespace" value="${namespace.replace(/"/g, '&quot;')}">
      <input type="hidden" name="project" value="${project.replace(/"/g, '&quot;')}">
      <div class="manual-input">
        <input type="text" name="org" placeholder="Organization name" required>
        <button type="submit">Go</button>
      </div>
    </form>
    
    <p class="info">
      After selecting, you'll be redirected to Azure DevOps.
    </p>
  </div>
</body>
</html>`;
}

/**
 * Helper to handle redirect with org mapping.
 * No auth needed - just redirect to ADO and let them handle auth.
 */
async function handleRedirect(
  c: any,
  namespace: string,
  project: string,
  originalPath: string,
  buildAdoUrl: (orgName: string) => string
): Promise<Response> {
  // Check for cached org mapping.
  const cachedOrg = await getCachedOrgMapping(namespace, project);

  if (cachedOrg) {
    // We have the org - redirect directly to ADO.
    const adoUrl = buildAdoUrl(cachedOrg);
    return c.redirect(adoUrl);
  }

  // No cached org - show org selector page.
  const knownOrgs = await getKnownOrgs();
  const html = generateOrgSelectorPage(knownOrgs, namespace, project, originalPath);
  return c.html(html);
}

export function registerRedirects(app: Hono<Env>): void {
  // POST /_proxy/select-org - Handle org selection form submission.
  app.post('/_proxy/select-org', async (c) => {
    const body = await c.req.parseBody();
    const org = (body.org as string)?.trim();
    const redirectPath = (body.redirect_path as string) || '/';
    const namespace = (body.namespace as string)?.trim();
    const project = (body.project as string)?.trim();

    if (!org) {
      return c.text('Organization name is required', 400);
    }

    // Store the org mapping for this namespace/project.
    if (namespace && project) {
      await storeOrgMapping(namespace, project, org);
    }

    // Redirect back to the original path - now with org cached, it will prompt for PAT.
    return c.redirect(redirectPath);
  });

  // Redirect: /:namespace/:project/-/merge_requests/:iid -> ADO PR page.
  app.get('/:namespace/:project/-/merge_requests/:iid', async (c) => {
    const namespace = c.req.param('namespace');
    const project = c.req.param('project');
    const iid = c.req.param('iid');
    const originalPath = `/${namespace}/${project}/-/merge_requests/${iid}`;

    return handleRedirect(c, namespace, project, originalPath, (orgName) => {
      const url = `https://dev.azure.com/${encodeURIComponent(orgName)}/${encodeURIComponent(namespace)}/_git/${encodeURIComponent(project)}/pullrequest/${iid}`;
      console.log('[Redirect] Merge request:', { from: originalPath, to: url });
      return url;
    });
  });

  // Redirect: /:namespace/:project (project/repo page) -> ADO repo page.
  app.get('/:namespace/:project', async (c) => {
    const namespace = c.req.param('namespace');
    const project = c.req.param('project');
    const originalPath = `/${namespace}/${project}`;

    // Skip if this looks like an API or special request.
    if (namespace === 'api' || namespace === 'oauth' || namespace === '_proxy' || project === 'info') {
      return c.notFound();
    }

    return handleRedirect(c, namespace, project, originalPath, (orgName) => {
      const url = `https://dev.azure.com/${encodeURIComponent(orgName)}/${encodeURIComponent(namespace)}/_git/${encodeURIComponent(project)}`;
      console.log('[Redirect] Repository:', { from: originalPath, to: url });
      return url;
    });
  });

  // Redirect: /:namespace/:project/-/commit/:sha -> ADO commit page.
  app.get('/:namespace/:project/-/commit/:sha', async (c) => {
    const namespace = c.req.param('namespace');
    const project = c.req.param('project');
    const sha = c.req.param('sha');
    const originalPath = `/${namespace}/${project}/-/commit/${sha}`;

    return handleRedirect(c, namespace, project, originalPath, (orgName) => {
      const url = `https://dev.azure.com/${encodeURIComponent(orgName)}/${encodeURIComponent(namespace)}/_git/${encodeURIComponent(project)}/commit/${sha}`;
      console.log('[Redirect] Commit:', { from: originalPath, to: url });
      return url;
    });
  });

  // Redirect: /:namespace/:project/-/tree/:ref -> ADO branch/tree page.
  app.get('/:namespace/:project/-/tree/:ref{.+}', async (c) => {
    const namespace = c.req.param('namespace');
    const project = c.req.param('project');
    const ref = c.req.param('ref');
    const originalPath = `/${namespace}/${project}/-/tree/${ref}`;

    return handleRedirect(c, namespace, project, originalPath, (orgName) => {
      const url = `https://dev.azure.com/${encodeURIComponent(orgName)}/${encodeURIComponent(namespace)}/_git/${encodeURIComponent(project)}?version=GB${encodeURIComponent(ref)}`;
      console.log('[Redirect] Tree:', { from: originalPath, to: url });
      return url;
    });
  });

  // Redirect: /:namespace/:project/-/blob/:ref/*path -> ADO file page.
  app.get('/:namespace/:project/-/blob/:ref{.+}', async (c) => {
    const namespace = c.req.param('namespace');
    const project = c.req.param('project');
    const refAndPath = c.req.param('ref');
    const originalPath = `/${namespace}/${project}/-/blob/${refAndPath}`;

    // Parse ref and path from combined param.
    const slashIndex = refAndPath.indexOf('/');
    const ref = slashIndex !== -1 ? refAndPath.substring(0, slashIndex) : refAndPath;
    const path = slashIndex !== -1 ? refAndPath.substring(slashIndex) : '';

    return handleRedirect(c, namespace, project, originalPath, (orgName) => {
      const url = `https://dev.azure.com/${encodeURIComponent(orgName)}/${encodeURIComponent(namespace)}/_git/${encodeURIComponent(project)}?path=${encodeURIComponent(path)}&version=GB${encodeURIComponent(ref)}`;
      console.log('[Redirect] Blob:', { from: originalPath, to: url });
      return url;
    });
  });

  // Redirect: /:namespace/:project/-/branches -> ADO branches page.
  app.get('/:namespace/:project/-/branches', async (c) => {
    const namespace = c.req.param('namespace');
    const project = c.req.param('project');
    const originalPath = `/${namespace}/${project}/-/branches`;

    return handleRedirect(c, namespace, project, originalPath, (orgName) => {
      const url = `https://dev.azure.com/${encodeURIComponent(orgName)}/${encodeURIComponent(namespace)}/_git/${encodeURIComponent(project)}/branches`;
      console.log('[Redirect] Branches:', { from: originalPath, to: url });
      return url;
    });
  });

  // Redirect: /:namespace/:project/-/compare/:refs -> ADO compare page.
  app.get('/:namespace/:project/-/compare/:refs', async (c) => {
    const namespace = c.req.param('namespace');
    const project = c.req.param('project');
    const refs = c.req.param('refs');
    const originalPath = `/${namespace}/${project}/-/compare/${refs}`;

    // GitLab format: base...head.
    const [base, head] = refs.includes('...') ? refs.split('...') : [refs, 'main'];

    return handleRedirect(c, namespace, project, originalPath, (orgName) => {
      const url = `https://dev.azure.com/${encodeURIComponent(orgName)}/${encodeURIComponent(namespace)}/_git/${encodeURIComponent(project)}/branchCompare?baseVersion=GB${encodeURIComponent(base)}&targetVersion=GB${encodeURIComponent(head)}`;
      console.log('[Redirect] Compare:', { from: originalPath, to: url });
      return url;
    });
  });
}
