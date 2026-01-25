import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { MappingService } from './mapping.js';
import type {
  ProxyConfig,
  RequestContext,
  GitLabMergeRequestCreate,
  GitLabCommitCreate,
  ADORepository,
  ADOGitRefsResponse,
  ADOPullRequest,
  ADOTreeResponse,
  ADOCommitsResponse,
  ADOCommit,
  ADOUserProfile,
} from './types.js';

// Create the Hono app with typed context.
type Env = {
  Variables: {
    ctx: RequestContext;
  };
};

export function createApp(config: ProxyConfig): Hono<Env> {
  const app = new Hono<Env>();

  // Middleware: CORS.
  app.use('*', cors());

  // Middleware: Logger.
  app.use('*', logger());

  /**
   * Helper function to fetch repository info and extract project name.
   * This allows us to use project-level URLs even when we only have the repository GUID or name.
   * Supports both repository GUIDs (works at org level) and repository names (requires search).
   */
  async function fetchRepositoryInfo(
    repositoryId: string,
    adoAuthHeader: string,
    adoBaseUrl: string,
    adoApiVersion: string
  ): Promise<{ repo: ADORepository; projectName: string } | null> {
    try {
      // First, try to get repository at organization level (works for GUIDs).
      const repoUrl = MappingService.buildAdoUrl(
        adoBaseUrl,
        `/_apis/git/repositories/${repositoryId}`,
        adoApiVersion
      );

      const response = await fetch(repoUrl, {
        method: 'GET',
        headers: {
          Authorization: adoAuthHeader,
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        const repo = (await response.json()) as ADORepository;
        return { repo, projectName: repo.project.name };
      }

      // If it failed with "project name required", it's likely a repository name, not a GUID.
      // Try to search for it across all repositories in the organization.
      const errorText = await response.text();
      if (errorText.includes('project name is required')) {
        // List all repositories in the organization and find the one with matching name.
        const listUrl = MappingService.buildAdoUrl(
          adoBaseUrl,
          '/_apis/git/repositories',
          adoApiVersion
        );

        const listResponse = await fetch(listUrl, {
          method: 'GET',
          headers: {
            Authorization: adoAuthHeader,
            'Content-Type': 'application/json',
          },
        });

        if (listResponse.ok) {
          const reposData = (await listResponse.json()) as { value: ADORepository[] };
          const matchingRepo = reposData.value.find(
            (r) => r.name.toLowerCase() === repositoryId.toLowerCase() || r.id === repositoryId
          );

          if (matchingRepo) {
            return { repo: matchingRepo, projectName: matchingRepo.project.name };
          }
        }
      }

      return null;
    } catch (error) {
      console.error('Error fetching repository info:', error);
      return null;
    }
  }

  // Middleware: Auth conversion and context setup.
  app.use('/api/v4/*', async (c, next) => {
    // Support both PRIVATE-TOKEN header (GitLab style) and Bearer token (OAuth style).
    const privateToken = c.req.header('PRIVATE-TOKEN');
    const authHeader = c.req.header('Authorization');
    const gitlabToken = privateToken || authHeader?.replace(/^Bearer\s+/i, '');

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
      return c.json(
        {
          error: 'Unauthorized',
          message: 'PRIVATE-TOKEN header or Bearer token is required',
          statusCode: 401,
        },
        401
      );
    }

    // Convert GitLab token to ADO auth header.
    const adoAuthHeader = MappingService.convertAuth(gitlabToken);

    // Set context for downstream handlers.
    c.set('ctx', {
      config,
      adoAuthHeader,
    });

    console.log('[Auth] Request authenticated:', {
      path: c.req.path,
      method: c.req.method,
      hasToken: !!gitlabToken,
      tokenLength: gitlabToken.length,
      tokenPrefix: gitlabToken.substring(0, 8) + '...',
      tokenSource: privateToken ? 'PRIVATE-TOKEN' : 'Authorization',
    });

    return next();
  });

  // Health check endpoint.
  app.get('/health', (c) => {
    return c.json({ status: 'healthy', timestamp: new Date().toISOString() });
  });

  // GET /api/v4/user - Get current authenticated user.
  app.get('/api/v4/user', async (c) => {
    const { ctx } = c.var;

    try {
      // Try ConnectionData API first (organization-level endpoint).
      // Note: ConnectionData requires -preview suffix for version 7.1.
      const connectionDataApiVersion = ctx.config.adoApiVersion 
        ? `${ctx.config.adoApiVersion}-preview`
        : '7.1-preview';
      const connectionDataUrl = MappingService.buildAdoUrl(
        ctx.config.adoBaseUrl,
        '/_apis/ConnectionData',
        connectionDataApiVersion
      );

      console.log('[GET /api/v4/user] Attempting ConnectionData API:', {
        url: connectionDataUrl,
        method: 'GET',
        hasAuth: !!ctx.adoAuthHeader,
      });

      let response = await fetch(connectionDataUrl, {
        method: 'GET',
        headers: {
          Authorization: ctx.adoAuthHeader,
          'Content-Type': 'application/json',
        },
      });

      let usedFallback = false;
      let profileUrl = connectionDataUrl;

      // If ConnectionData fails, try Profile API as fallback.
      if (!response.ok) {
        const errorText = await response.text();
        console.warn('[GET /api/v4/user] ConnectionData API failed:', {
          status: response.status,
          statusText: response.statusText,
          url: connectionDataUrl,
          error: errorText,
          headers: Object.fromEntries(response.headers.entries()),
        });

        // Extract organization from base URL.
        const orgMatch = ctx.config.adoBaseUrl.match(/dev\.azure\.com\/([^\/]+)/);
        const org = orgMatch ? orgMatch[1] : '';

        // Try Profile API endpoint.
        profileUrl = `https://vssps.dev.azure.com/${org}/_apis/profile/profiles/me?api-version=5.1`;
        console.log('[GET /api/v4/user] Falling back to Profile API:', {
          url: profileUrl,
          organization: org,
        });

        usedFallback = true;
        response = await fetch(profileUrl, {
          method: 'GET',
          headers: {
            Authorization: ctx.adoAuthHeader,
            'Content-Type': 'application/json',
          },
        });
      }

      // Check content type before processing.
      const contentType = response.headers.get('Content-Type') ?? '';
      const isJson = contentType.includes('application/json') || contentType.includes('text/json');

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[GET /api/v4/user] All user API attempts failed:', {
          status: response.status,
          statusText: response.statusText,
          contentType,
          isJson,
          error: isJson ? errorText : errorText.substring(0, 500),
          usedFallback,
          url: profileUrl,
        });
        return c.json(
          {
            error: 'ADO API Error',
            message: isJson ? errorText : `Received ${contentType} instead of JSON. This may indicate an authentication or endpoint issue.`,
            statusCode: response.status,
          },
          response.status as 400 | 401 | 403 | 404 | 500
        );
      }

      // Check if response is actually JSON before parsing.
      if (!isJson) {
        const responseText = await response.text();
        console.error('[GET /api/v4/user] Non-JSON response received:', {
          contentType,
          status: response.status,
          responsePreview: responseText.substring(0, 500),
          url: profileUrl,
        });
        return c.json(
          {
            error: 'ADO API Error',
            message: `Expected JSON but received ${contentType}. This may indicate an authentication or endpoint issue.`,
            statusCode: response.status,
          },
          response.status as 400 | 401 | 403 | 404 | 500
        );
      }

      const responseData = (await response.json()) as
        | {
            authenticatedUser: {
              id: string;
              descriptor: string;
              subjectDescriptor: string;
              providerDisplayName: string;
              isActive: boolean;
              properties: {
                Account?: { $value: string };
              };
            };
          }
        | ADOUserProfile
        | Record<string, unknown>;

      console.log('[GET /api/v4/user] Success:', {
        usedFallback,
        responseType: 'authenticatedUser' in responseData ? 'ConnectionData' : 'Profile',
        hasData: !!responseData,
        dataKeys: Object.keys(responseData),
      });

      // Handle ConnectionData response format.
      if ('authenticatedUser' in responseData && responseData.authenticatedUser) {
        const data = responseData as {
          authenticatedUser: {
            id: string;
            descriptor: string;
            subjectDescriptor: string;
            providerDisplayName: string;
            isActive: boolean;
            properties: {
              Account?: { $value: string };
            };
          };
        };

        console.log('[GET /api/v4/user] Parsed ConnectionData response:', {
          userId: data.authenticatedUser.id,
          displayName: data.authenticatedUser.providerDisplayName,
          hasEmail: !!data.authenticatedUser.properties?.Account?.$value,
        });

        const user = MappingService.mapUserProfileToUser({
          id: data.authenticatedUser.id,
          displayName: data.authenticatedUser.providerDisplayName,
          publicAlias: data.authenticatedUser.providerDisplayName,
          emailAddress: data.authenticatedUser.properties?.Account?.$value ?? '',
          coreRevision: 0,
          timeStamp: new Date().toISOString(),
          revision: 0,
        });

        return c.json(user);
      }

      // Handle Profile API response format.
      if ('id' in responseData || 'displayName' in responseData) {
        const profile = responseData as ADOUserProfile;
        console.log('[GET /api/v4/user] Parsed Profile API response:', {
          userId: profile.id,
          displayName: profile.displayName,
          email: profile.emailAddress,
          publicAlias: profile.publicAlias,
        });

        const user = MappingService.mapUserProfileToUser(profile);
        return c.json(user);
      }

      // If we can't parse the response, return a generic user.
      console.warn('[GET /api/v4/user] Unexpected response format:', {
        responseData,
        keys: Object.keys(responseData),
        usedFallback,
      });
      const user = MappingService.mapUserProfileToUser({
        id: 'unknown',
        displayName: 'User',
        publicAlias: 'user',
        emailAddress: '',
        coreRevision: 0,
        timeStamp: new Date().toISOString(),
        revision: 0,
      });

      return c.json(user);
    } catch (error) {
      console.error('[GET /api/v4/user] Exception:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
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

  // GET /api/v4/projects - List all projects (repositories).
  app.get('/api/v4/projects', async (c) => {
    const { ctx } = c.var;

    // Query parameters.
    const search = c.req.query('search');
    const perPage = parseInt(c.req.query('per_page') ?? '20', 10);
    const minAccessLevel = c.req.query('min_access_level');
    const archived = c.req.query('archived');
    const page = c.req.query('page');
    const pagination = c.req.query('pagination');

    console.log('[GET /api/v4/projects] Request:', {
      search,
      perPage,
      minAccessLevel,
      archived,
      page,
      pagination,
      queryString: c.req.url.split('?')[1] || '',
    });

    try {
      // List all repositories in the organization.
      const reposUrl = MappingService.buildAdoUrl(
        ctx.config.adoBaseUrl,
        '/_apis/git/repositories',
        ctx.config.adoApiVersion ?? '7.1'
      );

      const response = await fetch(reposUrl, {
        method: 'GET',
        headers: {
          Authorization: ctx.adoAuthHeader,
          'Content-Type': 'application/json',
        },
      });

      // Check content type before processing.
      const contentType = response.headers.get('Content-Type') ?? '';
      const isJson = contentType.includes('application/json') || contentType.includes('text/json');

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[GET /api/v4/projects] ADO API error:', {
          status: response.status,
          statusText: response.statusText,
          contentType,
          isJson,
          error: isJson ? errorText : errorText.substring(0, 500),
          url: reposUrl,
        });
        return c.json(
          {
            error: 'ADO API Error',
            message: isJson ? errorText : `Received ${contentType} instead of JSON. This may indicate an authentication or endpoint issue.`,
            statusCode: response.status,
          },
          response.status as 400 | 401 | 403 | 404 | 500
        );
      }

      // Check if response is actually JSON before parsing.
      if (!isJson) {
        const responseText = await response.text();
        console.error('[GET /api/v4/projects] Non-JSON response received:', {
          contentType,
          status: response.status,
          responsePreview: responseText.substring(0, 500),
          url: reposUrl,
        });
        return c.json(
          {
            error: 'ADO API Error',
            message: `Expected JSON but received ${contentType}. This may indicate an authentication or endpoint issue.`,
            statusCode: response.status,
          },
          response.status as 400 | 401 | 403 | 404 | 500
        );
      }

      const data = (await response.json()) as { value: ADORepository[]; count: number };
      
      console.log('[GET /api/v4/projects] ADO API response:', {
        totalRepos: data.count,
        returnedRepos: data.value.length,
        firstRepo: data.value[0]?.name,
      });
      
      // Filter by search term if provided.
      let repos = data.value;
      if (search) {
        const searchLower = search.toLowerCase();
        const beforeFilter = repos.length;
        repos = repos.filter(
          (r) =>
            r.name.toLowerCase().includes(searchLower) ||
            r.project.name.toLowerCase().includes(searchLower)
        );
        console.log('[GET /api/v4/projects] After search filter:', {
          before: beforeFilter,
          after: repos.length,
          searchTerm: search,
        });
      }

      // Limit results.
      const beforeLimit = repos.length;
      repos = repos.slice(0, perPage);
      console.log('[GET /api/v4/projects] After pagination:', {
        before: beforeLimit,
        after: repos.length,
        perPage,
      });

      // Map to GitLab projects format.
      const projects = repos.map((repo) => MappingService.mapRepositoryToProject(repo));

      console.log('[GET /api/v4/projects] Success:', {
        returnedProjects: projects.length,
        projectIds: projects.map((p) => p.id),
        projectNames: projects.map((p) => p.name),
      });

      return c.json(projects);
    } catch (error) {
      console.error('Error listing projects:', error);
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

  // Simple in-memory store for OAuth authorization codes.
  // In production, you might want to use a proper cache/store.
  const oauthCodes = new Map<string, { accessToken: string; expiresAt: number }>();

  // GET /oauth/authorize - OAuth 2.0 authorization endpoint.
  app.get('/oauth/authorize', async (c) => {
    const clientId = c.req.query('client_id');
    const redirectUri = c.req.query('redirect_uri');
    const state = c.req.query('state');
    const responseType = c.req.query('response_type');
    const scope = c.req.query('scope');

    // Validate required parameters.
    if (!clientId || !redirectUri || !state || responseType !== 'code') {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Missing required parameters',
          statusCode: 400,
        },
        400
      );
    }

    // Validate client_id if OAuth client ID is configured.
    if (config.oauthClientId && clientId !== config.oauthClientId) {
      console.warn('[OAuth] Invalid client_id:', {
        provided: clientId,
        expected: config.oauthClientId,
        ip: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown',
      });
      return c.json(
        {
          error: 'invalid_client',
          error_description: 'Invalid client_id',
          statusCode: 401,
        },
        401
      );
    }

    // For a proxy, we'll accept any client_id and show a simple authorization page.
    // In a real implementation, you'd validate the client_id and show a proper consent page.
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
    <p><strong>Application:</strong> ${clientId}</p>
    <p><strong>Scopes:</strong> ${scope || 'api'}</p>
  </div>
  <form method="POST" action="/oauth/authorize">
    <input type="hidden" name="client_id" value="${clientId}">
    <input type="hidden" name="redirect_uri" value="${redirectUri}">
    <input type="hidden" name="state" value="${state}">
    <input type="hidden" name="response_type" value="${responseType}">
    <input type="hidden" name="scope" value="${scope || 'api'}">
    <div class="form-group">
      <label for="pat">Azure DevOps Personal Access Token:</label>
      <input type="text" id="pat" name="pat" placeholder="Enter your ADO PAT" required>
      <small>This token will be used to authenticate with Azure DevOps.</small>
    </div>
    <button type="submit">Authorize</button>
  </form>
</body>
</html>
    `;

    return c.html(html);
  });

  // POST /oauth/authorize - Handle authorization form submission.
  app.post('/oauth/authorize', async (c) => {
    const body = await c.req.parseBody();
    const clientId = c.req.query('client_id') || body.client_id as string;
    const redirectUri = c.req.query('redirect_uri') || body.redirect_uri as string;
    const state = c.req.query('state') || body.state as string;
    const responseType = c.req.query('response_type') || body.response_type as string;
    const pat = body.pat as string;

    if (!clientId || !redirectUri || !state || responseType !== 'code' || !pat) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Missing required parameters',
          statusCode: 400,
        },
        400
      );
    }

    // Validate client_id if OAuth client ID is configured.
    if (config.oauthClientId && clientId !== config.oauthClientId) {
      console.warn('[OAuth] Invalid client_id in POST:', {
        provided: clientId,
        expected: config.oauthClientId,
        ip: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown',
      });
      return c.json(
        {
          error: 'invalid_client',
          error_description: 'Invalid client_id',
          statusCode: 401,
        },
        401
      );
    }

    // Generate authorization code.
    const authCode = Buffer.from(`${Date.now()}-${Math.random()}`).toString('base64url');
    
    // Store the PAT with the authorization code (expires in 10 minutes).
    oauthCodes.set(authCode, {
      accessToken: pat,
      expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes.
    });

    // Redirect back to the application with the authorization code.
    const redirectUrl = new URL(redirectUri);
    redirectUrl.searchParams.set('code', authCode);
    redirectUrl.searchParams.set('state', state);

    return c.redirect(redirectUrl.toString());
  });

  // POST /oauth/token - OAuth 2.0 token endpoint.
  app.post('/oauth/token', async (c) => {
    const body = await c.req.parseBody();
    const grantType = body.grant_type as string;
    const code = body.code as string;
    const clientId = body.client_id as string;
    const clientSecret = body.client_secret as string;

    if (grantType !== 'authorization_code') {
      return c.json(
        {
          error: 'unsupported_grant_type',
          error_description: 'Only authorization_code grant type is supported',
          statusCode: 400,
        },
        400
      );
    }

    if (!code) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Missing authorization code',
          statusCode: 400,
        },
        400
      );
    }

    // Validate client_id if OAuth client ID is configured.
    if (config.oauthClientId && clientId !== config.oauthClientId) {
      console.warn('[OAuth] Invalid client_id in token exchange:', {
        provided: clientId,
        expected: config.oauthClientId,
        ip: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown',
      });
      return c.json(
        {
          error: 'invalid_client',
          error_description: 'Invalid client_id',
          statusCode: 401,
        },
        401
      );
    }

    // Validate client_secret if OAuth client secret is configured.
    if (config.oauthClientSecret) {
      if (!clientSecret || clientSecret !== config.oauthClientSecret) {
        console.warn('[OAuth] Invalid client_secret in token exchange:', {
          hasSecret: !!clientSecret,
          ip: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown',
        });
        return c.json(
          {
            error: 'invalid_client',
            error_description: 'Invalid client_secret',
            statusCode: 401,
          },
          401
        );
      }
    }

    // Look up the authorization code.
    const codeData = oauthCodes.get(code);
    if (!codeData) {
      return c.json(
        {
          error: 'invalid_grant',
          error_description: 'Invalid or expired authorization code',
          statusCode: 400,
        },
        400
      );
    }

    // Check if code has expired.
    if (Date.now() > codeData.expiresAt) {
      oauthCodes.delete(code);
      return c.json(
        {
          error: 'invalid_grant',
          error_description: 'Authorization code has expired',
          statusCode: 400,
        },
        400
      );
    }

    // Delete the code (one-time use).
    oauthCodes.delete(code);

    // Return the access token (which is the PAT).
    // GitLab OAuth tokens are typically valid for 2 hours, but we'll use the PAT directly.
    return c.json({
      access_token: codeData.accessToken,
      token_type: 'Bearer',
      expires_in: 7200, // 2 hours (GitLab standard).
      refresh_token: null, // Not implementing refresh tokens for simplicity.
      scope: 'api',
    });
  });

  // GET /api/v4/projects/:id/access_tokens - List project access tokens.
  // Note: Azure DevOps doesn't have project-level access tokens, so we return an empty array.
  app.get('/api/v4/projects/:id/access_tokens', async (c) => {
    const projectId = c.req.param('id');

    console.log('[GET /api/v4/projects/:id/access_tokens] Request:', {
      projectId,
    });

    // Azure DevOps uses organization-level Personal Access Tokens, not project-level tokens.
    // Return an empty array to indicate no project-specific tokens exist.
    return c.json([]);
  });

  // POST /api/v4/projects/:id/access_tokens - Create project access token.
  // Note: Azure DevOps doesn't support project-level access tokens.
  // Return 200 with empty response to satisfy Cursor Cloud's expectations.
  app.post('/api/v4/projects/:id/access_tokens', async (c) => {
    const projectId = c.req.param('id');

    console.log('[POST /api/v4/projects/:id/access_tokens] Request:', {
      projectId,
    });

    // Azure DevOps uses organization-level Personal Access Tokens, not project-level tokens.
    // Return 200 with empty array to indicate no tokens can be created,
    // but don't block Cursor Cloud from proceeding with other operations.
    return c.json([]);
  });

  // GET /api/v4/projects/:id - Get project (repository) details.
  app.get('/api/v4/projects/:id', async (c) => {
    const { ctx } = c.var;
    const projectId = c.req.param('id');

    try {
      // Use the helper function to fetch repository info (handles both GUIDs and names).
      const repoInfo = await fetchRepositoryInfo(
        projectId,
        ctx.adoAuthHeader,
        ctx.config.adoBaseUrl,
        ctx.config.adoApiVersion ?? '7.1'
      );

      if (!repoInfo) {
        return c.json(
          {
            error: 'Not Found',
            message: `Repository '${projectId}' not found`,
            statusCode: 404,
          },
          404
        );
      }

      const gitlabProject = MappingService.mapRepositoryToProject(repoInfo.repo);
      return c.json(gitlabProject);
    } catch (error) {
      console.error('Error fetching project:', error);
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

  // GET /api/v4/projects/:id/repository/branches - List branches.
  app.get('/api/v4/projects/:id/repository/branches', async (c) => {
    const { ctx } = c.var;
    const projectId = c.req.param('id');

    try {
      // First, get repository info to know the default branch and project name.
      const repoInfo = await fetchRepositoryInfo(
        projectId,
        ctx.adoAuthHeader,
        ctx.config.adoBaseUrl,
        ctx.config.adoApiVersion ?? '7.1'
      );

      if (!repoInfo) {
        return c.json(
          {
            error: 'Not Found',
            message: `Repository '${projectId}' not found`,
            statusCode: 404,
          },
          404
        );
      }

      const { repo, projectName } = repoInfo;
      const defaultBranch = repo.defaultBranch ?? 'refs/heads/main';

      // Get branches (refs with heads filter) using project-level URL.
      const refsUrl = MappingService.buildAdoUrl(
        ctx.config.adoBaseUrl,
        `/_apis/git/repositories/${projectId}/refs?filter=heads`,
        ctx.config.adoApiVersion ?? '7.1',
        projectName
      );

      const response = await fetch(refsUrl, {
        method: 'GET',
        headers: {
          Authorization: ctx.adoAuthHeader,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        return c.json(
          {
            error: 'ADO API Error',
            message: errorText,
            statusCode: response.status,
          },
          response.status as 400 | 401 | 403 | 404 | 500
        );
      }

      const refsData = (await response.json()) as ADOGitRefsResponse;
      const branches = refsData.value.map((ref) =>
        MappingService.mapRefToBranch(ref, defaultBranch)
      );

      return c.json(branches);
    } catch (error) {
      console.error('Error fetching branches:', error);
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

  // GET /api/v4/projects/:id/repository/branches/:branch - Get single branch.
  app.get('/api/v4/projects/:id/repository/branches/:branch', async (c) => {
    const { ctx } = c.var;
    const projectId = c.req.param('id');
    const branchName = c.req.param('branch');

    try {
      // Get repository info for default branch and project name.
      const repoInfo = await fetchRepositoryInfo(
        projectId,
        ctx.adoAuthHeader,
        ctx.config.adoBaseUrl,
        ctx.config.adoApiVersion ?? '7.1'
      );

      if (!repoInfo) {
        return c.json(
          {
            error: 'Not Found',
            message: `Repository '${projectId}' not found`,
            statusCode: 404,
          },
          404
        );
      }

      const { repo, projectName } = repoInfo;
      const defaultBranch = repo.defaultBranch ?? 'refs/heads/main';

      // Get specific branch ref using project-level URL.
      const refUrl = MappingService.buildAdoUrl(
        ctx.config.adoBaseUrl,
        `/_apis/git/repositories/${projectId}/refs?filter=heads/${branchName}`,
        ctx.config.adoApiVersion ?? '7.1',
        projectName
      );

      const response = await fetch(refUrl, {
        method: 'GET',
        headers: {
          Authorization: ctx.adoAuthHeader,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        return c.json(
          {
            error: 'ADO API Error',
            message: errorText,
            statusCode: response.status,
          },
          response.status as 400 | 401 | 403 | 404 | 500
        );
      }

      const refsData = (await response.json()) as ADOGitRefsResponse;

      if (refsData.value.length === 0) {
        return c.json(
          {
            error: 'Not Found',
            message: `Branch '${branchName}' not found`,
            statusCode: 404,
          },
          404
        );
      }

      const branch = MappingService.mapRefToBranch(refsData.value[0], defaultBranch);
      return c.json(branch);
    } catch (error) {
      console.error('Error fetching branch:', error);
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

  // POST /api/v4/projects/:id/repository/branches - Create a new branch.
  app.post('/api/v4/projects/:id/repository/branches', async (c) => {
    const { ctx } = c.var;
    const projectId = c.req.param('id');

    try {
      const body = (await c.req.json()) as { branch: string; ref: string };

      if (!body.branch || !body.ref) {
        return c.json(
          {
            error: 'Bad Request',
            message: 'branch and ref are required',
            statusCode: 400,
          },
          400
        );
      }

      // Get repository info.
      const repoInfo = await fetchRepositoryInfo(
        projectId,
        ctx.adoAuthHeader,
        ctx.config.adoBaseUrl,
        ctx.config.adoApiVersion ?? '7.1'
      );

      if (!repoInfo) {
        return c.json(
          {
            error: 'Not Found',
            message: `Repository '${projectId}' not found`,
            statusCode: 404,
          },
          404
        );
      }

      // Get the source ref's commit SHA.
      const sourceRefUrl = MappingService.buildAdoUrl(
        ctx.config.adoBaseUrl,
        `/_apis/git/repositories/${projectId}/refs?filter=heads/${body.ref}`,
        ctx.config.adoApiVersion ?? '7.1',
        repoInfo.projectName
      );

      const sourceRefResponse = await fetch(sourceRefUrl, {
        method: 'GET',
        headers: {
          Authorization: ctx.adoAuthHeader,
          'Content-Type': 'application/json',
        },
      });

      if (!sourceRefResponse.ok) {
        const errorText = await sourceRefResponse.text();
        return c.json(
          {
            error: 'ADO API Error',
            message: errorText,
            statusCode: sourceRefResponse.status,
          },
          sourceRefResponse.status as 400 | 401 | 403 | 404 | 500
        );
      }

      const sourceRefData = (await sourceRefResponse.json()) as ADOGitRefsResponse;
      if (sourceRefData.value.length === 0) {
        return c.json(
          {
            error: 'Not Found',
            message: `Source branch '${body.ref}' not found`,
            statusCode: 404,
          },
          404
        );
      }

      const sourceObjectId = sourceRefData.value[0].objectId;

      // Create the new branch using refs API.
      const refsUrl = MappingService.buildAdoUrl(
        ctx.config.adoBaseUrl,
        `/_apis/git/repositories/${projectId}/refs`,
        ctx.config.adoApiVersion ?? '7.1',
        repoInfo.projectName
      );

      const refUpdate = [
        {
          name: `refs/heads/${body.branch}`,
          oldObjectId: '0000000000000000000000000000000000000000',
          newObjectId: sourceObjectId,
        },
      ];

      const createResponse = await fetch(refsUrl, {
        method: 'POST',
        headers: {
          Authorization: ctx.adoAuthHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(refUpdate),
      });

      if (!createResponse.ok) {
        const errorText = await createResponse.text();
        return c.json(
          {
            error: 'ADO API Error',
            message: errorText,
            statusCode: createResponse.status,
          },
          createResponse.status as 400 | 401 | 403 | 404 | 500
        );
      }

      const createData = (await createResponse.json()) as { value: Array<{ name: string; newObjectId: string; success: boolean }> };
      
      if (!createData.value[0]?.success) {
        return c.json(
          {
            error: 'Failed to create branch',
            message: 'Branch creation failed',
            statusCode: 400,
          },
          400
        );
      }

      // Return the created branch.
      const defaultBranch = repoInfo.repo.defaultBranch ?? 'refs/heads/main';
      const newBranch = MappingService.mapRefToBranch(
        {
          name: `refs/heads/${body.branch}`,
          objectId: sourceObjectId,
          creator: { displayName: '', url: '', id: '', uniqueName: '', imageUrl: '' },
          url: '',
        },
        defaultBranch
      );

      return c.json(newBranch, 201);
    } catch (error) {
      console.error('Error creating branch:', error);
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

  // DELETE /api/v4/projects/:id/repository/branches/:branch - Delete a branch.
  app.delete('/api/v4/projects/:id/repository/branches/:branch', async (c) => {
    const { ctx } = c.var;
    const projectId = c.req.param('id');
    const branchName = c.req.param('branch');

    try {
      // Get repository info.
      const repoInfo = await fetchRepositoryInfo(
        projectId,
        ctx.adoAuthHeader,
        ctx.config.adoBaseUrl,
        ctx.config.adoApiVersion ?? '7.1'
      );

      if (!repoInfo) {
        return c.json(
          {
            error: 'Not Found',
            message: `Repository '${projectId}' not found`,
            statusCode: 404,
          },
          404
        );
      }

      // Get the branch's current commit SHA.
      const refUrl = MappingService.buildAdoUrl(
        ctx.config.adoBaseUrl,
        `/_apis/git/repositories/${projectId}/refs?filter=heads/${branchName}`,
        ctx.config.adoApiVersion ?? '7.1',
        repoInfo.projectName
      );

      const refResponse = await fetch(refUrl, {
        method: 'GET',
        headers: {
          Authorization: ctx.adoAuthHeader,
          'Content-Type': 'application/json',
        },
      });

      if (!refResponse.ok) {
        const errorText = await refResponse.text();
        return c.json(
          {
            error: 'ADO API Error',
            message: errorText,
            statusCode: refResponse.status,
          },
          refResponse.status as 400 | 401 | 403 | 404 | 500
        );
      }

      const refData = (await refResponse.json()) as ADOGitRefsResponse;
      if (refData.value.length === 0) {
        return c.json(
          {
            error: 'Not Found',
            message: `Branch '${branchName}' not found`,
            statusCode: 404,
          },
          404
        );
      }

      const currentObjectId = refData.value[0].objectId;

      // Delete the branch using refs API.
      const refsUrl = MappingService.buildAdoUrl(
        ctx.config.adoBaseUrl,
        `/_apis/git/repositories/${projectId}/refs`,
        ctx.config.adoApiVersion ?? '7.1',
        repoInfo.projectName
      );

      const refUpdate = [
        {
          name: `refs/heads/${branchName}`,
          oldObjectId: currentObjectId,
          newObjectId: '0000000000000000000000000000000000000000',
        },
      ];

      const deleteResponse = await fetch(refsUrl, {
        method: 'POST',
        headers: {
          Authorization: ctx.adoAuthHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(refUpdate),
      });

      if (!deleteResponse.ok) {
        const errorText = await deleteResponse.text();
        return c.json(
          {
            error: 'ADO API Error',
            message: errorText,
            statusCode: deleteResponse.status,
          },
          deleteResponse.status as 400 | 401 | 403 | 404 | 500
        );
      }

      // Return 204 No Content on successful delete.
      return c.body(null, 204);
    } catch (error) {
      console.error('Error deleting branch:', error);
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

  // POST /api/v4/projects/:id/merge_requests - Create merge request.
  app.post('/api/v4/projects/:id/merge_requests', async (c) => {
    const { ctx } = c.var;
    const projectId = c.req.param('id');

    try {
      const mrCreate: GitLabMergeRequestCreate = await c.req.json();

      // Validate required fields.
      if (!mrCreate.source_branch || !mrCreate.target_branch || !mrCreate.title) {
        return c.json(
          {
            error: 'Bad Request',
            message: 'source_branch, target_branch, and title are required',
            statusCode: 400,
          },
          400
        );
      }

      // Get repository info to extract project name.
      const repoInfo = await fetchRepositoryInfo(
        projectId,
        ctx.adoAuthHeader,
        ctx.config.adoBaseUrl,
        ctx.config.adoApiVersion ?? '7.1'
      );

      if (!repoInfo) {
        return c.json(
          {
            error: 'Not Found',
            message: `Repository '${projectId}' not found`,
            statusCode: 404,
          },
          404
        );
      }

      // Convert to ADO format.
      const prCreate = MappingService.mapMergeRequestCreateToPullRequestCreate(mrCreate);

      const prUrl = MappingService.buildAdoUrl(
        ctx.config.adoBaseUrl,
        `/_apis/git/repositories/${projectId}/pullrequests`,
        ctx.config.adoApiVersion ?? '7.1',
        repoInfo.projectName
      );

      const response = await fetch(prUrl, {
        method: 'POST',
        headers: {
          Authorization: ctx.adoAuthHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(prCreate),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return c.json(
          {
            error: 'ADO API Error',
            message: errorText,
            statusCode: response.status,
          },
          response.status as 400 | 401 | 403 | 404 | 500
        );
      }

      const adoPr = (await response.json()) as ADOPullRequest;
      const mergeRequest = MappingService.mapPullRequestToMergeRequest(adoPr);

      return c.json(mergeRequest, 201);
    } catch (error) {
      console.error('Error creating merge request:', error);
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

  // GET /api/v4/projects/:id/merge_requests - List merge requests.
  app.get('/api/v4/projects/:id/merge_requests', async (c) => {
    const { ctx } = c.var;
    const projectId = c.req.param('id');

    // Map GitLab query params to ADO.
    const state = c.req.query('state');
    let adoStatus = '';
    if (state === 'opened') {
      adoStatus = 'active';
    } else if (state === 'merged') {
      adoStatus = 'completed';
    } else if (state === 'closed') {
      adoStatus = 'abandoned';
    }

    try {
      // Get repository info to extract project name.
      const repoInfo = await fetchRepositoryInfo(
        projectId,
        ctx.adoAuthHeader,
        ctx.config.adoBaseUrl,
        ctx.config.adoApiVersion ?? '7.1'
      );

      if (!repoInfo) {
        return c.json(
          {
            error: 'Not Found',
            message: `Repository '${projectId}' not found`,
            statusCode: 404,
          },
          404
        );
      }

      let prPath = `/_apis/git/repositories/${projectId}/pullrequests`;
      if (adoStatus) {
        prPath += `?searchCriteria.status=${adoStatus}`;
      }

      const prUrl = MappingService.buildAdoUrl(
        ctx.config.adoBaseUrl,
        prPath,
        ctx.config.adoApiVersion ?? '7.1',
        repoInfo.projectName
      );

      const response = await fetch(prUrl, {
        method: 'GET',
        headers: {
          Authorization: ctx.adoAuthHeader,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        return c.json(
          {
            error: 'ADO API Error',
            message: errorText,
            statusCode: response.status,
          },
          response.status as 400 | 401 | 403 | 404 | 500
        );
      }

      const data = (await response.json()) as { value: ADOPullRequest[] };
      const mergeRequests = data.value.map((pr) =>
        MappingService.mapPullRequestToMergeRequest(pr)
      );

      return c.json(mergeRequests);
    } catch (error) {
      console.error('Error listing merge requests:', error);
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

  // GET /api/v4/projects/:id/merge_requests/:mr_iid - Get single merge request.
  app.get('/api/v4/projects/:id/merge_requests/:mr_iid', async (c) => {
    const { ctx } = c.var;
    const projectId = c.req.param('id');
    const mrIid = c.req.param('mr_iid');

    try {
      // Get repository info to extract project name.
      const repoInfo = await fetchRepositoryInfo(
        projectId,
        ctx.adoAuthHeader,
        ctx.config.adoBaseUrl,
        ctx.config.adoApiVersion ?? '7.1'
      );

      if (!repoInfo) {
        return c.json(
          {
            error: 'Not Found',
            message: `Repository '${projectId}' not found`,
            statusCode: 404,
          },
          404
        );
      }

      const prUrl = MappingService.buildAdoUrl(
        ctx.config.adoBaseUrl,
        `/_apis/git/repositories/${projectId}/pullrequests/${mrIid}`,
        ctx.config.adoApiVersion ?? '7.1',
        repoInfo.projectName
      );

      const response = await fetch(prUrl, {
        method: 'GET',
        headers: {
          Authorization: ctx.adoAuthHeader,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        return c.json(
          {
            error: 'ADO API Error',
            message: errorText,
            statusCode: response.status,
          },
          response.status as 400 | 401 | 403 | 404 | 500
        );
      }

      const adoPr = (await response.json()) as ADOPullRequest;
      const mergeRequest = MappingService.mapPullRequestToMergeRequest(adoPr);

      return c.json(mergeRequest);
    } catch (error) {
      console.error('Error fetching merge request:', error);
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

  // PUT /api/v4/projects/:id/merge_requests/:mr_iid - Update merge request.
  app.put('/api/v4/projects/:id/merge_requests/:mr_iid', async (c) => {
    const { ctx } = c.var;
    const projectId = c.req.param('id');
    const mrIid = c.req.param('mr_iid');

    try {
      const body = (await c.req.json()) as {
        title?: string;
        description?: string;
        state_event?: 'close' | 'reopen';
      };

      // Get repository info.
      const repoInfo = await fetchRepositoryInfo(
        projectId,
        ctx.adoAuthHeader,
        ctx.config.adoBaseUrl,
        ctx.config.adoApiVersion ?? '7.1'
      );

      if (!repoInfo) {
        return c.json(
          {
            error: 'Not Found',
            message: `Repository '${projectId}' not found`,
            statusCode: 404,
          },
          404
        );
      }

      // Build ADO PR update payload.
      const adoUpdate: { title?: string; description?: string; status?: string } = {};
      if (body.title) {
        adoUpdate.title = body.title;
      }
      if (body.description !== undefined) {
        adoUpdate.description = body.description;
      }
      if (body.state_event === 'close') {
        adoUpdate.status = 'abandoned';
      } else if (body.state_event === 'reopen') {
        adoUpdate.status = 'active';
      }

      const prUrl = MappingService.buildAdoUrl(
        ctx.config.adoBaseUrl,
        `/_apis/git/repositories/${projectId}/pullrequests/${mrIid}`,
        ctx.config.adoApiVersion ?? '7.1',
        repoInfo.projectName
      );

      const response = await fetch(prUrl, {
        method: 'PATCH',
        headers: {
          Authorization: ctx.adoAuthHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(adoUpdate),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return c.json(
          {
            error: 'ADO API Error',
            message: errorText,
            statusCode: response.status,
          },
          response.status as 400 | 401 | 403 | 404 | 500
        );
      }

      const adoPr = (await response.json()) as ADOPullRequest;
      const mergeRequest = MappingService.mapPullRequestToMergeRequest(adoPr);

      return c.json(mergeRequest);
    } catch (error) {
      console.error('Error updating merge request:', error);
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

  // PUT /api/v4/projects/:id/merge_requests/:mr_iid/merge - Merge a merge request.
  app.put('/api/v4/projects/:id/merge_requests/:mr_iid/merge', async (c) => {
    const { ctx } = c.var;
    const projectId = c.req.param('id');
    const mrIid = c.req.param('mr_iid');

    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        merge_commit_message?: string;
        should_remove_source_branch?: boolean;
        squash?: boolean;
      };

      // Get repository info.
      const repoInfo = await fetchRepositoryInfo(
        projectId,
        ctx.adoAuthHeader,
        ctx.config.adoBaseUrl,
        ctx.config.adoApiVersion ?? '7.1'
      );

      if (!repoInfo) {
        return c.json(
          {
            error: 'Not Found',
            message: `Repository '${projectId}' not found`,
            statusCode: 404,
          },
          404
        );
      }

      // Complete the PR (merge).
      const prUrl = MappingService.buildAdoUrl(
        ctx.config.adoBaseUrl,
        `/_apis/git/repositories/${projectId}/pullrequests/${mrIid}`,
        ctx.config.adoApiVersion ?? '7.1',
        repoInfo.projectName
      );

      // First, get the PR to get the last merge source commit.
      const getResponse = await fetch(prUrl, {
        method: 'GET',
        headers: {
          Authorization: ctx.adoAuthHeader,
          'Content-Type': 'application/json',
        },
      });

      if (!getResponse.ok) {
        const errorText = await getResponse.text();
        return c.json(
          {
            error: 'ADO API Error',
            message: errorText,
            statusCode: getResponse.status,
          },
          getResponse.status as 400 | 401 | 403 | 404 | 500
        );
      }

      const prData = (await getResponse.json()) as ADOPullRequest & { lastMergeSourceCommit?: { commitId: string } };

      // Complete the PR.
      const completePayload: {
        status: string;
        lastMergeSourceCommit?: { commitId: string };
        completionOptions?: {
          deleteSourceBranch?: boolean;
          mergeCommitMessage?: string;
          squashMerge?: boolean;
        };
      } = {
        status: 'completed',
        lastMergeSourceCommit: prData.lastMergeSourceCommit,
        completionOptions: {
          deleteSourceBranch: body.should_remove_source_branch ?? false,
          mergeCommitMessage: body.merge_commit_message,
          squashMerge: body.squash ?? false,
        },
      };

      const response = await fetch(prUrl, {
        method: 'PATCH',
        headers: {
          Authorization: ctx.adoAuthHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(completePayload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return c.json(
          {
            error: 'ADO API Error',
            message: errorText,
            statusCode: response.status,
          },
          response.status as 400 | 401 | 403 | 404 | 500
        );
      }

      const adoPr = (await response.json()) as ADOPullRequest;
      const mergeRequest = MappingService.mapPullRequestToMergeRequest(adoPr);

      return c.json(mergeRequest);
    } catch (error) {
      console.error('Error merging merge request:', error);
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

  // GET /api/v4/projects/:id/merge_requests/:mr_iid/changes - Get MR changes/diff.
  app.get('/api/v4/projects/:id/merge_requests/:mr_iid/changes', async (c) => {
    const { ctx } = c.var;
    const projectId = c.req.param('id');
    const mrIid = c.req.param('mr_iid');

    try {
      // Get repository info.
      const repoInfo = await fetchRepositoryInfo(
        projectId,
        ctx.adoAuthHeader,
        ctx.config.adoBaseUrl,
        ctx.config.adoApiVersion ?? '7.1'
      );

      if (!repoInfo) {
        return c.json(
          {
            error: 'Not Found',
            message: `Repository '${projectId}' not found`,
            statusCode: 404,
          },
          404
        );
      }

      // Get PR details first.
      const prUrl = MappingService.buildAdoUrl(
        ctx.config.adoBaseUrl,
        `/_apis/git/repositories/${projectId}/pullrequests/${mrIid}`,
        ctx.config.adoApiVersion ?? '7.1',
        repoInfo.projectName
      );

      const prResponse = await fetch(prUrl, {
        method: 'GET',
        headers: {
          Authorization: ctx.adoAuthHeader,
          'Content-Type': 'application/json',
        },
      });

      if (!prResponse.ok) {
        const errorText = await prResponse.text();
        return c.json(
          {
            error: 'ADO API Error',
            message: errorText,
            statusCode: prResponse.status,
          },
          prResponse.status as 400 | 401 | 403 | 404 | 500
        );
      }

      const adoPr = (await prResponse.json()) as ADOPullRequest;

      // Get the iterations to find the diff.
      const iterationsUrl = MappingService.buildAdoUrl(
        ctx.config.adoBaseUrl,
        `/_apis/git/repositories/${projectId}/pullrequests/${mrIid}/iterations`,
        ctx.config.adoApiVersion ?? '7.1',
        repoInfo.projectName
      );

      const iterationsResponse = await fetch(iterationsUrl, {
        method: 'GET',
        headers: {
          Authorization: ctx.adoAuthHeader,
          'Content-Type': 'application/json',
        },
      });

      let changes: Array<{
        old_path: string;
        new_path: string;
        a_mode: string;
        b_mode: string;
        new_file: boolean;
        renamed_file: boolean;
        deleted_file: boolean;
        diff: string;
      }> = [];

      if (iterationsResponse.ok) {
        const iterationsData = (await iterationsResponse.json()) as {
          value: Array<{ id: number }>;
        };

        if (iterationsData.value.length > 0) {
          const lastIteration = iterationsData.value[iterationsData.value.length - 1];

          // Get changes for the last iteration.
          const changesUrl = MappingService.buildAdoUrl(
            ctx.config.adoBaseUrl,
            `/_apis/git/repositories/${projectId}/pullrequests/${mrIid}/iterations/${lastIteration.id}/changes`,
            ctx.config.adoApiVersion ?? '7.1',
            repoInfo.projectName
          );

          const changesResponse = await fetch(changesUrl, {
            method: 'GET',
            headers: {
              Authorization: ctx.adoAuthHeader,
              'Content-Type': 'application/json',
            },
          });

          if (changesResponse.ok) {
            const changesData = (await changesResponse.json()) as {
              changeEntries: Array<{
                changeTrackingId: number;
                changeId: number;
                item: { path: string };
                changeType: string;
                originalPath?: string;
              }>;
            };

            changes = changesData.changeEntries.map((entry) => ({
              old_path: entry.originalPath ?? entry.item.path,
              new_path: entry.item.path,
              a_mode: '100644',
              b_mode: '100644',
              new_file: entry.changeType === 'add',
              renamed_file: entry.changeType === 'rename',
              deleted_file: entry.changeType === 'delete',
              diff: '',
            }));
          }
        }
      }

      // Build GitLab MR with changes response.
      const mergeRequest = MappingService.mapPullRequestToMergeRequest(adoPr);

      return c.json({
        ...mergeRequest,
        changes: changes,
      });
    } catch (error) {
      console.error('Error fetching merge request changes:', error);
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

  // GET /api/v4/projects/:id/repository/tree - List repository tree (files and directories).
  app.get('/api/v4/projects/:id/repository/tree', async (c) => {
    const { ctx } = c.var;
    const projectId = c.req.param('id');

    // Query parameters.
    const path = c.req.query('path') ?? '';
    const ref = c.req.query('ref') ?? 'main';
    const recursive = c.req.query('recursive') === 'true';

    try {
      // Get repository info.
      const repoInfo = await fetchRepositoryInfo(
        projectId,
        ctx.adoAuthHeader,
        ctx.config.adoBaseUrl,
        ctx.config.adoApiVersion ?? '7.1'
      );

      if (!repoInfo) {
        return c.json(
          {
            error: 'Not Found',
            message: `Repository '${projectId}' not found`,
            statusCode: 404,
          },
          404
        );
      }

      // Build tree URL with path and version.
      let treePath = `/_apis/git/repositories/${projectId}/items`;
      const queryParams: string[] = [];
      queryParams.push(`scopePath=${encodeURIComponent(path || '/')}`);
      queryParams.push(`recursionLevel=${recursive ? 'Full' : 'OneLevel'}`);
      queryParams.push(`versionDescriptor.version=${encodeURIComponent(ref)}`);
      queryParams.push('versionDescriptor.versionType=branch');

      if (queryParams.length > 0) {
        treePath += `?${queryParams.join('&')}`;
      }

      const treeUrl = MappingService.buildAdoUrl(
        ctx.config.adoBaseUrl,
        treePath,
        ctx.config.adoApiVersion ?? '7.1',
        repoInfo.projectName
      );

      const response = await fetch(treeUrl, {
        method: 'GET',
        headers: {
          Authorization: ctx.adoAuthHeader,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        return c.json(
          {
            error: 'ADO API Error',
            message: errorText,
            statusCode: response.status,
          },
          response.status as 400 | 401 | 403 | 404 | 500
        );
      }

      const data = (await response.json()) as ADOTreeResponse;
      
      // Map to GitLab tree format, filtering out the root.
      const treeItems = data.value
        .filter((item) => item.relativePath && item.relativePath !== '/')
        .map((item) => MappingService.mapTreeItemToGitLabTreeItem(item));

      return c.json(treeItems);
    } catch (error) {
      console.error('Error fetching tree:', error);
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

  // GET /api/v4/projects/:id/repository/blobs/:sha - Get blob by SHA.
  app.get('/api/v4/projects/:id/repository/blobs/:sha', async (c) => {
    const { ctx } = c.var;
    const projectId = c.req.param('id');
    const sha = c.req.param('sha');

    try {
      // Get repository info.
      const repoInfo = await fetchRepositoryInfo(
        projectId,
        ctx.adoAuthHeader,
        ctx.config.adoBaseUrl,
        ctx.config.adoApiVersion ?? '7.1'
      );

      if (!repoInfo) {
        return c.json(
          {
            error: 'Not Found',
            message: `Repository '${projectId}' not found`,
            statusCode: 404,
          },
          404
        );
      }

      // Get blob content.
      const blobUrl = MappingService.buildAdoUrl(
        ctx.config.adoBaseUrl,
        `/_apis/git/repositories/${projectId}/blobs/${sha}`,
        ctx.config.adoApiVersion ?? '7.1',
        repoInfo.projectName
      );

      const response = await fetch(blobUrl, {
        method: 'GET',
        headers: {
          Authorization: ctx.adoAuthHeader,
          Accept: 'application/octet-stream',
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          return c.json(
            {
              error: 'Not Found',
              message: `Blob '${sha}' not found`,
              statusCode: 404,
            },
            404
          );
        }
        const errorText = await response.text();
        return c.json(
          {
            error: 'ADO API Error',
            message: errorText,
            statusCode: response.status,
          },
          response.status as 400 | 401 | 403 | 404 | 500
        );
      }

      // Return raw content.
      const buffer = await response.arrayBuffer();
      const content = btoa(String.fromCharCode(...new Uint8Array(buffer)));

      return c.json({
        size: buffer.byteLength,
        encoding: 'base64',
        content: content,
        sha: sha,
      });
    } catch (error) {
      console.error('Error fetching blob:', error);
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

  // HEAD /api/v4/projects/:id/repository/files/:file_path - Check if file exists.
  app.on('HEAD', '/api/v4/projects/:id/repository/files/:file_path{.+}', async (c) => {
    const { ctx } = c.var;
    const projectId = c.req.param('id');
    const filePath = c.req.param('file_path');
    const ref = c.req.query('ref') ?? 'main';

    try {
      // Get repository info.
      const repoInfo = await fetchRepositoryInfo(
        projectId,
        ctx.adoAuthHeader,
        ctx.config.adoBaseUrl,
        ctx.config.adoApiVersion ?? '7.1'
      );

      if (!repoInfo) {
        return c.body(null, 404);
      }

      // Check if file exists.
      const encodedPath = encodeURIComponent(`/${filePath}`);
      let itemPath = `/_apis/git/repositories/${projectId}/items`;
      itemPath += `?path=${encodedPath}`;
      itemPath += `&versionDescriptor.version=${encodeURIComponent(ref)}`;
      itemPath += '&versionDescriptor.versionType=branch';

      const itemUrl = MappingService.buildAdoUrl(
        ctx.config.adoBaseUrl,
        itemPath,
        ctx.config.adoApiVersion ?? '7.1',
        repoInfo.projectName
      );

      const response = await fetch(itemUrl, {
        method: 'HEAD',
        headers: {
          Authorization: ctx.adoAuthHeader,
        },
      });

      if (response.ok) {
        return c.body(null, 200);
      }
      return c.body(null, 404);
    } catch (error) {
      console.error('Error checking file existence:', error);
      return c.body(null, 500);
    }
  });

  // GET /api/v4/projects/:id/repository/files/:file_path/raw - Get raw file content.
  app.get('/api/v4/projects/:id/repository/files/:file_path{.+}/raw', async (c) => {
    const { ctx } = c.var;
    const projectId = c.req.param('id');
    // Remove '/raw' suffix from file_path.
    let filePath = c.req.param('file_path');
    if (filePath.endsWith('/raw')) {
      filePath = filePath.slice(0, -4);
    }
    const ref = c.req.query('ref') ?? 'main';

    try {
      // Get repository info.
      const repoInfo = await fetchRepositoryInfo(
        projectId,
        ctx.adoAuthHeader,
        ctx.config.adoBaseUrl,
        ctx.config.adoApiVersion ?? '7.1'
      );

      if (!repoInfo) {
        return c.json(
          {
            error: 'Not Found',
            message: `Repository '${projectId}' not found`,
            statusCode: 404,
          },
          404
        );
      }

      // Build file URL for raw content.
      const encodedPath = encodeURIComponent(`/${filePath}`);
      let itemPath = `/_apis/git/repositories/${projectId}/items`;
      itemPath += `?path=${encodedPath}`;
      itemPath += `&versionDescriptor.version=${encodeURIComponent(ref)}`;
      itemPath += '&versionDescriptor.versionType=branch';

      const itemUrl = MappingService.buildAdoUrl(
        ctx.config.adoBaseUrl,
        itemPath,
        ctx.config.adoApiVersion ?? '7.1',
        repoInfo.projectName
      );

      const response = await fetch(itemUrl, {
        method: 'GET',
        headers: {
          Authorization: ctx.adoAuthHeader,
          Accept: 'application/octet-stream',
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          return c.json(
            {
              error: 'Not Found',
              message: `File '${filePath}' not found`,
              statusCode: 404,
            },
            404
          );
        }
        const errorText = await response.text();
        return c.json(
          {
            error: 'ADO API Error',
            message: errorText,
            statusCode: response.status,
          },
          response.status as 400 | 401 | 403 | 404 | 500
        );
      }

      // Return raw content.
      const content = await response.text();
      return c.text(content);
    } catch (error) {
      console.error('Error fetching raw file:', error);
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

  // GET /api/v4/projects/:id/repository/files/:file_path - Get file content.
  app.get('/api/v4/projects/:id/repository/files/:file_path{.+}', async (c) => {
    const { ctx } = c.var;
    const projectId = c.req.param('id');
    const filePath = c.req.param('file_path');
    const ref = c.req.query('ref') ?? 'main';

    try {
      // Get repository info.
      const repoInfo = await fetchRepositoryInfo(
        projectId,
        ctx.adoAuthHeader,
        ctx.config.adoBaseUrl,
        ctx.config.adoApiVersion ?? '7.1'
      );

      if (!repoInfo) {
        return c.json(
          {
            error: 'Not Found',
            message: `Repository '${projectId}' not found`,
            statusCode: 404,
          },
          404
        );
      }

      // Build file URL.
      const encodedPath = encodeURIComponent(`/${filePath}`);
      let itemPath = `/_apis/git/repositories/${projectId}/items`;
      itemPath += `?path=${encodedPath}`;
      itemPath += `&versionDescriptor.version=${encodeURIComponent(ref)}`;
      itemPath += '&versionDescriptor.versionType=branch';
      itemPath += '&includeContent=true';

      const itemUrl = MappingService.buildAdoUrl(
        ctx.config.adoBaseUrl,
        itemPath,
        ctx.config.adoApiVersion ?? '7.1',
        repoInfo.projectName
      );

      const response = await fetch(itemUrl, {
        method: 'GET',
        headers: {
          Authorization: ctx.adoAuthHeader,
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          return c.json(
            {
              error: 'Not Found',
              message: `File '${filePath}' not found`,
              statusCode: 404,
            },
            404
          );
        }
        const errorText = await response.text();
        return c.json(
          {
            error: 'ADO API Error',
            message: errorText,
            statusCode: response.status,
          },
          response.status as 400 | 401 | 403 | 404 | 500
        );
      }

      // Get the raw content.
      const contentType = response.headers.get('Content-Type') ?? '';
      let content: string;
      let isBase64 = false;

      if (contentType.includes('application/json')) {
        // JSON response with metadata.
        const data = (await response.json()) as {
          objectId: string;
          commitId: string;
          path: string;
          content?: string;
        };
        content = data.content ?? '';
      } else {
        // Raw content - encode as base64.
        const buffer = await response.arrayBuffer();
        content = btoa(String.fromCharCode(...new Uint8Array(buffer)));
        isBase64 = true;
      }

      // Get commit info for the file.
      const commitsPath = `/_apis/git/repositories/${projectId}/commits?searchCriteria.itemPath=${encodedPath}&searchCriteria.$top=1`;
      const commitsUrl = MappingService.buildAdoUrl(
        ctx.config.adoBaseUrl,
        commitsPath,
        ctx.config.adoApiVersion ?? '7.1',
        repoInfo.projectName
      );

      const commitsResponse = await fetch(commitsUrl, {
        method: 'GET',
        headers: {
          Authorization: ctx.adoAuthHeader,
          'Content-Type': 'application/json',
        },
      });

      let commitId = '';
      if (commitsResponse.ok) {
        const commitsData = (await commitsResponse.json()) as ADOCommitsResponse;
        if (commitsData.value.length > 0) {
          commitId = commitsData.value[0].commitId;
        }
      }

      const file = MappingService.mapItemToGitLabFile(
        filePath,
        content,
        commitId,
        commitId,
        ref,
        isBase64
      );

      return c.json(file);
    } catch (error) {
      console.error('Error fetching file:', error);
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

  // GET /api/v4/projects/:id/repository/commits - List commits.
  app.get('/api/v4/projects/:id/repository/commits', async (c) => {
    const { ctx } = c.var;
    const projectId = c.req.param('id');

    // Query parameters.
    const ref = c.req.query('ref_name') ?? c.req.query('ref') ?? 'main';
    const path = c.req.query('path');
    const perPage = parseInt(c.req.query('per_page') ?? '20', 10);

    try {
      // Get repository info.
      const repoInfo = await fetchRepositoryInfo(
        projectId,
        ctx.adoAuthHeader,
        ctx.config.adoBaseUrl,
        ctx.config.adoApiVersion ?? '7.1'
      );

      if (!repoInfo) {
        return c.json(
          {
            error: 'Not Found',
            message: `Repository '${projectId}' not found`,
            statusCode: 404,
          },
          404
        );
      }

      // Build commits URL.
      const queryParams: string[] = [];
      queryParams.push(`searchCriteria.itemVersion.version=${encodeURIComponent(ref)}`);
      queryParams.push('searchCriteria.itemVersion.versionType=branch');
      queryParams.push(`searchCriteria.$top=${perPage}`);
      if (path) {
        queryParams.push(`searchCriteria.itemPath=${encodeURIComponent(path)}`);
      }

      const commitsPath = `/_apis/git/repositories/${projectId}/commits?${queryParams.join('&')}`;
      const commitsUrl = MappingService.buildAdoUrl(
        ctx.config.adoBaseUrl,
        commitsPath,
        ctx.config.adoApiVersion ?? '7.1',
        repoInfo.projectName
      );

      const response = await fetch(commitsUrl, {
        method: 'GET',
        headers: {
          Authorization: ctx.adoAuthHeader,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        return c.json(
          {
            error: 'ADO API Error',
            message: errorText,
            statusCode: response.status,
          },
          response.status as 400 | 401 | 403 | 404 | 500
        );
      }

      const data = (await response.json()) as ADOCommitsResponse;
      const commits = data.value.map((commit) =>
        MappingService.mapCommitToGitLabCommit(commit)
      );

      return c.json(commits);
    } catch (error) {
      console.error('Error fetching commits:', error);
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

  // GET /api/v4/projects/:id/repository/commits/:sha - Get single commit.
  app.get('/api/v4/projects/:id/repository/commits/:sha', async (c) => {
    const { ctx } = c.var;
    const projectId = c.req.param('id');
    const sha = c.req.param('sha');

    try {
      // Get repository info.
      const repoInfo = await fetchRepositoryInfo(
        projectId,
        ctx.adoAuthHeader,
        ctx.config.adoBaseUrl,
        ctx.config.adoApiVersion ?? '7.1'
      );

      if (!repoInfo) {
        return c.json(
          {
            error: 'Not Found',
            message: `Repository '${projectId}' not found`,
            statusCode: 404,
          },
          404
        );
      }

      // Get single commit.
      const commitUrl = MappingService.buildAdoUrl(
        ctx.config.adoBaseUrl,
        `/_apis/git/repositories/${projectId}/commits/${sha}`,
        ctx.config.adoApiVersion ?? '7.1',
        repoInfo.projectName
      );

      const response = await fetch(commitUrl, {
        method: 'GET',
        headers: {
          Authorization: ctx.adoAuthHeader,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          return c.json(
            {
              error: 'Not Found',
              message: `Commit '${sha}' not found`,
              statusCode: 404,
            },
            404
          );
        }
        const errorText = await response.text();
        return c.json(
          {
            error: 'ADO API Error',
            message: errorText,
            statusCode: response.status,
          },
          response.status as 400 | 401 | 403 | 404 | 500
        );
      }

      const adoCommit = (await response.json()) as ADOCommit;
      const commit = MappingService.mapCommitToGitLabCommit(adoCommit);

      return c.json(commit);
    } catch (error) {
      console.error('Error fetching commit:', error);
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

  // GET /api/v4/projects/:id/repository/compare - Compare branches/commits.
  app.get('/api/v4/projects/:id/repository/compare', async (c) => {
    const { ctx } = c.var;
    const projectId = c.req.param('id');
    const from = c.req.query('from');
    const to = c.req.query('to');

    if (!from || !to) {
      return c.json(
        {
          error: 'Bad Request',
          message: 'from and to query parameters are required',
          statusCode: 400,
        },
        400
      );
    }

    try {
      // Get repository info.
      const repoInfo = await fetchRepositoryInfo(
        projectId,
        ctx.adoAuthHeader,
        ctx.config.adoBaseUrl,
        ctx.config.adoApiVersion ?? '7.1'
      );

      if (!repoInfo) {
        return c.json(
          {
            error: 'Not Found',
            message: `Repository '${projectId}' not found`,
            statusCode: 404,
          },
          404
        );
      }

      // Get commits between the two refs.
      const commitsUrl = MappingService.buildAdoUrl(
        ctx.config.adoBaseUrl,
        `/_apis/git/repositories/${projectId}/commitsbatch`,
        ctx.config.adoApiVersion ?? '7.1',
        repoInfo.projectName
      );

      const commitsResponse = await fetch(commitsUrl, {
        method: 'POST',
        headers: {
          Authorization: ctx.adoAuthHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          itemVersion: { version: to, versionType: 'branch' },
          compareVersion: { version: from, versionType: 'branch' },
        }),
      });

      let commits: Array<ReturnType<typeof MappingService.mapCommitToGitLabCommit>> = [];
      if (commitsResponse.ok) {
        const commitsData = (await commitsResponse.json()) as { value: ADOCommit[] };
        commits = commitsData.value.map((c) => MappingService.mapCommitToGitLabCommit(c));
      }

      // Get diff between the two refs.
      const diffUrl = MappingService.buildAdoUrl(
        ctx.config.adoBaseUrl,
        `/_apis/git/repositories/${projectId}/diffs/commits?baseVersion=${encodeURIComponent(from)}&baseVersionType=branch&targetVersion=${encodeURIComponent(to)}&targetVersionType=branch`,
        ctx.config.adoApiVersion ?? '7.1',
        repoInfo.projectName
      );

      const diffResponse = await fetch(diffUrl, {
        method: 'GET',
        headers: {
          Authorization: ctx.adoAuthHeader,
          'Content-Type': 'application/json',
        },
      });

      let diffs: Array<{
        old_path: string;
        new_path: string;
        a_mode: string;
        b_mode: string;
        new_file: boolean;
        renamed_file: boolean;
        deleted_file: boolean;
        diff: string;
      }> = [];

      if (diffResponse.ok) {
        const diffData = (await diffResponse.json()) as {
          changes: Array<{
            item: { path: string };
            changeType: string;
            sourceServerItem?: string;
          }>;
        };

        diffs = diffData.changes.map((change) => ({
          old_path: change.sourceServerItem ?? change.item.path,
          new_path: change.item.path,
          a_mode: '100644',
          b_mode: '100644',
          new_file: change.changeType === 'add',
          renamed_file: change.changeType === 'rename',
          deleted_file: change.changeType === 'delete',
          diff: '',
        }));
      }

      return c.json({
        commit: commits.length > 0 ? commits[0] : null,
        commits: commits,
        diffs: diffs,
        compare_timeout: false,
        compare_same_ref: from === to,
      });
    } catch (error) {
      console.error('Error comparing refs:', error);
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

  // POST /api/v4/projects/:id/repository/commits - Create a commit.
  app.post('/api/v4/projects/:id/repository/commits', async (c) => {
    const { ctx } = c.var;
    const projectId = c.req.param('id');

    try {
      const commitCreate: GitLabCommitCreate = await c.req.json();

      // Validate required fields.
      if (!commitCreate.branch || !commitCreate.commit_message || !commitCreate.actions?.length) {
        return c.json(
          {
            error: 'Bad Request',
            message: 'branch, commit_message, and actions are required',
            statusCode: 400,
          },
          400
        );
      }

      // Get repository info.
      const repoInfo = await fetchRepositoryInfo(
        projectId,
        ctx.adoAuthHeader,
        ctx.config.adoBaseUrl,
        ctx.config.adoApiVersion ?? '7.1'
      );

      if (!repoInfo) {
        return c.json(
          {
            error: 'Not Found',
            message: `Repository '${projectId}' not found`,
            statusCode: 404,
          },
          404
        );
      }

      // Get the current commit SHA for the branch.
      const refUrl = MappingService.buildAdoUrl(
        ctx.config.adoBaseUrl,
        `/_apis/git/repositories/${projectId}/refs?filter=heads/${commitCreate.branch}`,
        ctx.config.adoApiVersion ?? '7.1',
        repoInfo.projectName
      );

      const refResponse = await fetch(refUrl, {
        method: 'GET',
        headers: {
          Authorization: ctx.adoAuthHeader,
          'Content-Type': 'application/json',
        },
      });

      if (!refResponse.ok) {
        const errorText = await refResponse.text();
        return c.json(
          {
            error: 'ADO API Error',
            message: errorText,
            statusCode: refResponse.status,
          },
          refResponse.status as 400 | 401 | 403 | 404 | 500
        );
      }

      const refData = (await refResponse.json()) as ADOGitRefsResponse;
      if (refData.value.length === 0) {
        return c.json(
          {
            error: 'Not Found',
            message: `Branch '${commitCreate.branch}' not found`,
            statusCode: 404,
          },
          404
        );
      }

      const oldObjectId = refData.value[0].objectId;

      // Convert to ADO Push format.
      const push = MappingService.mapCommitCreateToPush(commitCreate, oldObjectId);

      // Create the push (commit).
      const pushUrl = MappingService.buildAdoUrl(
        ctx.config.adoBaseUrl,
        `/_apis/git/repositories/${projectId}/pushes`,
        ctx.config.adoApiVersion ?? '7.1',
        repoInfo.projectName
      );

      const pushResponse = await fetch(pushUrl, {
        method: 'POST',
        headers: {
          Authorization: ctx.adoAuthHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(push),
      });

      if (!pushResponse.ok) {
        const errorText = await pushResponse.text();
        return c.json(
          {
            error: 'ADO API Error',
            message: errorText,
            statusCode: pushResponse.status,
          },
          pushResponse.status as 400 | 401 | 403 | 404 | 500
        );
      }

      const pushData = (await pushResponse.json()) as {
        commits: ADOCommit[];
        refUpdates: { name: string; newObjectId: string }[];
      };

      // Return the created commit.
      if (pushData.commits && pushData.commits.length > 0) {
        const commit = MappingService.mapCommitToGitLabCommit(pushData.commits[0]);
        return c.json(commit, 201);
      }

      return c.json(
        {
          id: pushData.refUpdates[0]?.newObjectId ?? '',
          message: commitCreate.commit_message,
        },
        201
      );
    } catch (error) {
      console.error('Error creating commit:', error);
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

  // Catch-all for unsupported endpoints.
  app.all('/api/v4/*', (c) => {
    return c.json(
      {
        error: 'Not Implemented',
        message: `Endpoint ${c.req.method} ${c.req.path} is not supported by this proxy`,
        statusCode: 501,
      },
      501
    );
  });

  return app;
}

// Export a default app instance for simple usage.
export const app = createApp({
  adoBaseUrl: process.env.ADO_BASE_URL ?? 'https://dev.azure.com/org',
  adoApiVersion: process.env.ADO_API_VERSION ?? '7.1',
  oauthClientId: process.env.OAUTH_CLIENT_ID,
  oauthClientSecret: process.env.OAUTH_CLIENT_SECRET,
});
