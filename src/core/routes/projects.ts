/**
 * Projects list route (GET /api/v4/projects).
 */

import { Hono } from 'hono';
import { MappingService } from '../mapping.js';
import { storeActualName } from '../helpers/repository.js';
import type { Env } from './env.js';
import type { ADORepository } from '../types.js';

// Maximum per_page value allowed.
const MAX_PER_PAGE = 1000;

// Default per_page when not specified by the client.
const DEFAULT_PER_PAGE = 100;

// Number of repos to request per ADO API call.
const ADO_TOP = 1000;

/**
 * Fetch all repositories from a single ADO project, following continuation tokens.
 */
async function fetchAllReposForProject(
  adoBaseUrl: string,
  adoAuthHeader: string,
  projectName: string
): Promise<ADORepository[]> {
  const allRepos: ADORepository[] = [];
  let continuationToken: string | null = null;

  do {
    let reposPath = `/${encodeURIComponent(projectName)}/_apis/git/repositories?$top=${ADO_TOP}`;
    if (continuationToken) {
      reposPath += `&continuationToken=${encodeURIComponent(continuationToken)}`;
    }

    const reposUrl = MappingService.buildAdoUrl(adoBaseUrl, reposPath);

    try {
      const response = await fetch(reposUrl, {
        method: 'GET',
        headers: {
          Authorization: adoAuthHeader,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        console.warn('[fetchAllReposForProject] Failed to fetch repos:', {
          project: projectName,
          status: response.status,
        });
        break;
      }

      const contentType = response.headers.get('Content-Type') ?? '';
      if (!contentType.includes('application/json')) {
        console.warn('[fetchAllReposForProject] Non-JSON response:', {
          project: projectName,
          contentType,
        });
        break;
      }

      const data = (await response.json()) as { value: ADORepository[]; count: number };
      if (data.value && data.value.length > 0) {
        allRepos.push(...data.value);
      }

      // Check for continuation token in response headers.
      continuationToken = response.headers.get('x-ms-continuationtoken') ?? null;
    } catch (error) {
      console.error('[fetchAllReposForProject] Error:', {
        project: projectName,
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  } while (continuationToken);

  return allRepos;
}

/**
 * Fetch all repositories at the organization level, following continuation tokens.
 */
async function fetchAllReposForOrg(
  adoBaseUrl: string,
  adoAuthHeader: string
): Promise<{ repos: ADORepository[]; error: Response | null }> {
  const allRepos: ADORepository[] = [];
  let continuationToken: string | null = null;

  do {
    let reposPath = `/_apis/git/repositories?$top=${ADO_TOP}`;
    if (continuationToken) {
      reposPath += `&continuationToken=${encodeURIComponent(continuationToken)}`;
    }

    const reposUrl = MappingService.buildAdoUrl(adoBaseUrl, reposPath);

    const response = await fetch(reposUrl, {
      method: 'GET',
      headers: {
        Authorization: adoAuthHeader,
        'Content-Type': 'application/json',
      },
    });

    // Check content type before processing.
    const contentType = response.headers.get('Content-Type') ?? '';
    const isJson = contentType.includes('application/json') || contentType.includes('text/json');

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[fetchAllReposForOrg] ADO API error:', {
        status: response.status,
        statusText: response.statusText,
        contentType,
        isJson,
        error: isJson ? errorText : errorText.substring(0, 500),
        url: reposUrl,
      });

      // Return a synthetic error response for the caller to handle.
      return {
        repos: [],
        error: new Response(
          JSON.stringify({
            error: 'ADO API Error',
            message: isJson
              ? errorText
              : `Received ${contentType} instead of JSON. This may indicate an authentication or endpoint issue.`,
            statusCode: response.status,
          }),
          { status: response.status, headers: { 'Content-Type': 'application/json' } }
        ),
      };
    }

    // Check if response is actually JSON before parsing.
    if (!isJson) {
      const responseText = await response.text();
      console.error('[fetchAllReposForOrg] Non-JSON response received:', {
        contentType,
        status: response.status,
        responsePreview: responseText.substring(0, 500),
        url: reposUrl,
      });
      return {
        repos: [],
        error: new Response(
          JSON.stringify({
            error: 'ADO API Error',
            message: `Expected JSON but received ${contentType}. This may indicate an authentication or endpoint issue.`,
            statusCode: response.status,
          }),
          { status: response.status, headers: { 'Content-Type': 'application/json' } }
        ),
      };
    }

    const data = (await response.json()) as { value: ADORepository[]; count: number };
    if (data.value && data.value.length > 0) {
      allRepos.push(...data.value);
    }

    // Check for continuation token in response headers.
    continuationToken = response.headers.get('x-ms-continuationtoken') ?? null;
  } while (continuationToken);

  return { repos: allRepos, error: null };
}

export function registerProjects(app: Hono<Env>): void {
  app.get('/api/v4/projects', async (c) => {
    const { ctx } = c.var;

    // Query parameters.
    const search = c.req.query('search');
    // Default to 100 repos per page, max 1000.
    const perPage = Math.min(
      Math.max(parseInt(c.req.query('per_page') ?? String(DEFAULT_PER_PAGE), 10) || DEFAULT_PER_PAGE, 1),
      MAX_PER_PAGE
    );
    const minAccessLevel = c.req.query('min_access_level');
    const archived = c.req.query('archived');
    const currentPage = Math.max(parseInt(c.req.query('page') ?? '1', 10) || 1, 1);
    const pagination = c.req.query('pagination');

    console.log('[GET /api/v4/projects] Request:', {
      search,
      perPage,
      minAccessLevel,
      archived,
      page: currentPage,
      pagination,
      allowedProjects: ctx.config.allowedProjects ?? 'all',
      queryString: c.req.url.split('?')[1] || '',
    });

    try {
      let repos: ADORepository[] = [];

      // If allowed projects are configured, fetch repos only from those projects.
      // This is more efficient than fetching all repos and filtering.
      if (ctx.config.allowedProjects && ctx.config.allowedProjects.length > 0) {
        console.log('[GET /api/v4/projects] Fetching repos from allowed projects only:', {
          allowedProjects: ctx.config.allowedProjects,
        });

        // Fetch all repositories from each allowed project in parallel.
        const projectFetches = ctx.config.allowedProjects.map((projectName) =>
          fetchAllReposForProject(ctx.config.adoBaseUrl, ctx.adoAuthHeader, projectName)
        );

        const projectResults = await Promise.all(projectFetches);
        repos = projectResults.flat();

        console.log('[GET /api/v4/projects] Combined repos from allowed projects:', {
          totalRepos: repos.length,
          projectsCounted: ctx.config.allowedProjects.length,
        });
      } else {
        // No project restrictions - fetch all repositories in the organization.
        const result = await fetchAllReposForOrg(ctx.config.adoBaseUrl, ctx.adoAuthHeader);

        if (result.error) {
          const errorBody = await result.error.json();
          return c.json(errorBody, result.error.status as 400 | 401 | 403 | 404 | 500);
        }

        repos = result.repos;

        console.log('[GET /api/v4/projects] ADO API response:', {
          totalRepos: repos.length,
          firstRepo: repos[0]?.name,
        });
      }

      // Filter by search term if provided.
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

      // Cache URL-safe → actual name mappings for all repos.
      // Use a Set to avoid duplicate storage calls.
      const seenNames = new Set<string>();
      for (const repo of repos) {
        const urlSafeProject = MappingService.toUrlSafePath(repo.project.name);
        const urlSafeRepo = MappingService.toUrlSafePath(repo.name);
        if (!seenNames.has(urlSafeProject)) {
          seenNames.add(urlSafeProject);
          await storeActualName(urlSafeProject, repo.project.name);
        }
        if (!seenNames.has(urlSafeRepo)) {
          seenNames.add(urlSafeRepo);
          await storeActualName(urlSafeRepo, repo.name);
        }
      }

      // Calculate pagination.
      const totalCount = repos.length;
      const totalPages = Math.max(Math.ceil(totalCount / perPage), 1);
      const offset = (currentPage - 1) * perPage;
      const paginatedRepos = repos.slice(offset, offset + perPage);

      console.log('[GET /api/v4/projects] After pagination:', {
        totalCount,
        totalPages,
        currentPage,
        perPage,
        offset,
        returnedCount: paginatedRepos.length,
      });

      // Get proxy base URL from request for constructing web_url.
      const requestUrl = new URL(c.req.url);
      const proxyBaseUrl = `${requestUrl.protocol}//${requestUrl.host}`;

      // Map to GitLab projects format.
      const projects = paginatedRepos.map((repo) => MappingService.mapRepositoryToProject(repo, proxyBaseUrl));

      console.log('[GET /api/v4/projects] Success:', {
        returnedProjects: projects.length,
        projectNames: projects.map((p) => p.name),
        samplePathWithNamespace: projects[0]?.path_with_namespace,
      });

      // Set GitLab-style pagination headers.
      c.header('X-Total', String(totalCount));
      c.header('X-Total-Pages', String(totalPages));
      c.header('X-Per-Page', String(perPage));
      c.header('X-Page', String(currentPage));
      if (currentPage < totalPages) {
        c.header('X-Next-Page', String(currentPage + 1));
      }
      if (currentPage > 1) {
        c.header('X-Prev-Page', String(currentPage - 1));
      }

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
}
