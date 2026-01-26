/**
 * Single project route (GET /api/v4/projects/:id).
 */

import { Hono } from 'hono';
import { MappingService } from '../mapping.js';
import { fetchRepositoryInfo } from '../helpers/repository.js';
import type { Env } from './env.js';

export function registerProject(app: Hono<Env>): void {
  app.get('/api/v4/projects/:id', async (c) => {
    const { ctx } = c.var;
    const projectId = c.req.param('id');

    console.log('[GET /api/v4/projects/:id] Request:', {
      projectId,
      decodedId: decodeURIComponent(projectId),
    });

    try {
      // Use the helper function to fetch repository info (handles both GUIDs and names).
      const repoInfo = await fetchRepositoryInfo(
        projectId,
        ctx.adoAuthHeader,
        ctx.config.adoBaseUrl,
        ctx.config.allowedProjects
      );

      if (!repoInfo) {
        console.warn('[GET /api/v4/projects/:id] Repository not found:', { projectId });
        return c.json(
          {
            error: 'Not Found',
            message: `Repository '${projectId}' not found`,
            statusCode: 404,
          },
          404
        );
      }

      // Get proxy base URL from request for constructing web_url.
      const requestUrl = new URL(c.req.url);
      const proxyBaseUrl = `${requestUrl.protocol}//${requestUrl.host}`;

      const gitlabProject = MappingService.mapRepositoryToProject(repoInfo.repo, proxyBaseUrl);
      console.log('[GET /api/v4/projects/:id] Success:', {
        projectId,
        repoName: repoInfo.repo.name,
        adoProject: repoInfo.projectName,
        pathWithNamespace: gitlabProject.path_with_namespace,
      });
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
}
