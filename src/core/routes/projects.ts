/**
 * Projects list route (GET /api/v4/projects).
 */

import { Hono } from 'hono';
import { MappingService } from '../mapping.js';
import type { Env } from './env.js';
import type { ADORepository } from '../types.js';

export function registerProjects(app: Hono<Env>): void {
  app.get('/api/v4/projects', async (c) => {
    const { ctx } = c.var;

    // Query parameters.
    const search = c.req.query('search');
    // Default to 100 repos per page, max 1000.
    const perPage = Math.min(parseInt(c.req.query('per_page') ?? '100', 10), 1000);
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

        // Fetch repositories from each allowed project in parallel.
        const projectFetches = ctx.config.allowedProjects.map(async (projectName) => {
          // Request up to 1000 repos per project.
          const reposUrl = MappingService.buildAdoUrl(
            ctx.config.adoBaseUrl,
            `/${encodeURIComponent(projectName)}/_apis/git/repositories?$top=1000`
          );

          try {
            const response = await fetch(reposUrl, {
              method: 'GET',
              headers: {
                Authorization: ctx.adoAuthHeader,
                'Content-Type': 'application/json',
              },
            });

            if (!response.ok) {
              console.warn('[GET /api/v4/projects] Failed to fetch repos for project:', {
                project: projectName,
                status: response.status,
              });
              return [];
            }

            const contentType = response.headers.get('Content-Type') ?? '';
            if (!contentType.includes('application/json')) {
              console.warn('[GET /api/v4/projects] Non-JSON response for project:', {
                project: projectName,
                contentType,
              });
              return [];
            }

            const data = (await response.json()) as { value: ADORepository[]; count: number };
            console.log('[GET /api/v4/projects] Fetched repos for project:', {
              project: projectName,
              count: data.value?.length ?? 0,
            });
            return data.value ?? [];
          } catch (error) {
            console.error('[GET /api/v4/projects] Error fetching repos for project:', {
              project: projectName,
              error: error instanceof Error ? error.message : String(error),
            });
            return [];
          }
        });

        const projectResults = await Promise.all(projectFetches);
        repos = projectResults.flat();

        console.log('[GET /api/v4/projects] Combined repos from allowed projects:', {
          totalRepos: repos.length,
          projectsCounted: ctx.config.allowedProjects.length,
        });
      } else {
        // No project restrictions - fetch all repositories in the organization.
        // Request up to 1000 repos.
        const reposUrl = MappingService.buildAdoUrl(
          ctx.config.adoBaseUrl,
          '/_apis/git/repositories?$top=1000'
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
        repos = data.value;

        console.log('[GET /api/v4/projects] ADO API response:', {
          totalRepos: data.count,
          returnedRepos: repos.length,
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

      // Limit results.
      const beforeLimit = repos.length;
      repos = repos.slice(0, perPage);
      console.log('[GET /api/v4/projects] After pagination:', {
        before: beforeLimit,
        after: repos.length,
        perPage,
      });

      // Get proxy base URL from request for constructing web_url.
      const requestUrl = new URL(c.req.url);
      const proxyBaseUrl = `${requestUrl.protocol}//${requestUrl.host}`;

      // Map to GitLab projects format.
      const projects = repos.map((repo) => MappingService.mapRepositoryToProject(repo, proxyBaseUrl));

      console.log('[GET /api/v4/projects] Success:', {
        returnedProjects: projects.length,
        projectIds: projects.map((p) => p.id),
        projectNames: projects.map((p) => p.name),
        samplePathWithNamespace: projects[0]?.path_with_namespace,
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
}
