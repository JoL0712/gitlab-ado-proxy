import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { MappingService } from './mapping.js';
import type {
  ProxyConfig,
  RequestContext,
  GitLabMergeRequestCreate,
  ADORepository,
  ADOGitRefsResponse,
  ADOPullRequest,
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

  // Middleware: Auth conversion and context setup.
  app.use('/api/v4/*', async (c, next) => {
    const gitlabToken = c.req.header('PRIVATE-TOKEN');

    if (!gitlabToken) {
      return c.json(
        {
          error: 'Unauthorized',
          message: 'PRIVATE-TOKEN header is required',
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

    return next();
  });

  // Health check endpoint.
  app.get('/health', (c) => {
    return c.json({ status: 'healthy', timestamp: new Date().toISOString() });
  });

  // GET /api/v4/projects/:id - Get project (repository) details.
  app.get('/api/v4/projects/:id', async (c) => {
    const { ctx } = c.var;
    const projectId = c.req.param('id');

    try {
      const adoUrl = MappingService.buildAdoUrl(
        ctx.config.adoBaseUrl,
        `/_apis/git/repositories/${projectId}`,
        ctx.config.adoApiVersion
      );

      const response = await fetch(adoUrl, {
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

      const adoRepo = (await response.json()) as ADORepository;
      const gitlabProject = MappingService.mapRepositoryToProject(adoRepo);

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
      // First, get repository info to know the default branch.
      const repoUrl = MappingService.buildAdoUrl(
        ctx.config.adoBaseUrl,
        `/_apis/git/repositories/${projectId}`,
        ctx.config.adoApiVersion
      );

      const repoResponse = await fetch(repoUrl, {
        method: 'GET',
        headers: {
          Authorization: ctx.adoAuthHeader,
          'Content-Type': 'application/json',
        },
      });

      let defaultBranch = 'main';
      if (repoResponse.ok) {
        const repo = (await repoResponse.json()) as ADORepository;
        defaultBranch = repo.defaultBranch ?? 'refs/heads/main';
      }

      // Get branches (refs with heads filter).
      const refsUrl = MappingService.buildAdoUrl(
        ctx.config.adoBaseUrl,
        `/_apis/git/repositories/${projectId}/refs?filter=heads`,
        ctx.config.adoApiVersion
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
      // Get repository info for default branch.
      const repoUrl = MappingService.buildAdoUrl(
        ctx.config.adoBaseUrl,
        `/_apis/git/repositories/${projectId}`,
        ctx.config.adoApiVersion
      );

      const repoResponse = await fetch(repoUrl, {
        method: 'GET',
        headers: {
          Authorization: ctx.adoAuthHeader,
          'Content-Type': 'application/json',
        },
      });

      let defaultBranch = 'main';
      if (repoResponse.ok) {
        const repo = (await repoResponse.json()) as ADORepository;
        defaultBranch = repo.defaultBranch ?? 'refs/heads/main';
      }

      // Get specific branch ref.
      const refUrl = MappingService.buildAdoUrl(
        ctx.config.adoBaseUrl,
        `/_apis/git/repositories/${projectId}/refs?filter=heads/${branchName}`,
        ctx.config.adoApiVersion
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

      // Convert to ADO format.
      const prCreate = MappingService.mapMergeRequestCreateToPullRequestCreate(mrCreate);

      const prUrl = MappingService.buildAdoUrl(
        ctx.config.adoBaseUrl,
        `/_apis/git/repositories/${projectId}/pullrequests`,
        ctx.config.adoApiVersion
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
      let prPath = `/_apis/git/repositories/${projectId}/pullrequests`;
      if (adoStatus) {
        prPath += `?searchCriteria.status=${adoStatus}`;
      }

      const prUrl = MappingService.buildAdoUrl(
        ctx.config.adoBaseUrl,
        prPath,
        ctx.config.adoApiVersion
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
      const prUrl = MappingService.buildAdoUrl(
        ctx.config.adoBaseUrl,
        `/_apis/git/repositories/${projectId}/pullrequests/${mrIid}`,
        ctx.config.adoApiVersion
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
  adoBaseUrl: process.env.ADO_BASE_URL ?? 'https://dev.azure.com/org/project',
  adoApiVersion: process.env.ADO_API_VERSION ?? '7.1',
});
