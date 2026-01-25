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

  // GET /api/v4/user - Get current authenticated user.
  app.get('/api/v4/user', async (c) => {
    const { ctx } = c.var;

    try {
      // ADO uses the Connection Data API to get current user info.
      const profileUrl = MappingService.buildAdoUrl(
        ctx.config.adoBaseUrl,
        '/_apis/connectionData',
        ctx.config.adoApiVersion ?? '7.1'
      );

      const response = await fetch(profileUrl, {
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

      const data = (await response.json()) as {
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

      // Map to GitLab user format.
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
    } catch (error) {
      console.error('Error fetching user:', error);
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

      const data = (await response.json()) as { value: ADORepository[]; count: number };
      
      // Filter by search term if provided.
      let repos = data.value;
      if (search) {
        const searchLower = search.toLowerCase();
        repos = repos.filter(
          (r) =>
            r.name.toLowerCase().includes(searchLower) ||
            r.project.name.toLowerCase().includes(searchLower)
        );
      }

      // Limit results.
      repos = repos.slice(0, perPage);

      // Map to GitLab projects format.
      const projects = repos.map((repo) => MappingService.mapRepositoryToProject(repo));

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
});
