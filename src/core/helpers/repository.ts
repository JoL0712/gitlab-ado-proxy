/**
 * Repository lookup helpers.
 * Used by project, repository, and git route modules.
 */

import { MappingService } from '../mapping.js';
import type { ADORepository } from '../types.js';

/**
 * Convert a string to URL-safe format for comparison.
 */
export function toUrlSafe(str: string): string {
  return str.toLowerCase().replace(/\s+/g, '-');
}

/**
 * Find the actual project name from allowed projects by matching URL-safe versions.
 */
export function findActualProjectName(
  urlSafeName: string,
  allowedProjects?: string[]
): string | null {
  if (!allowedProjects || allowedProjects.length === 0) {
    return null;
  }

  const urlSafeLower = urlSafeName.toLowerCase();
  for (const project of allowedProjects) {
    if (toUrlSafe(project) === urlSafeLower) {
      return project;
    }
  }
  return null;
}

/**
 * Helper function to fetch repository info and extract project name.
 * Supports multiple identifier formats:
 * - Repository GUID (e.g., "d1567dcd-066c-4a96-897a-20860d99a3c0")
 * - Repository name only (e.g., "my-repo")
 * - GitLab-style path (e.g., "project-name/repo-name" or "Project%20Name/repo-name")
 * Also enforces project access restrictions if allowedProjects is configured.
 */
export async function fetchRepositoryInfo(
  repositoryId: string,
  adoAuthHeader: string,
  adoBaseUrl: string,
  adoApiVersion: string,
  allowedProjects?: string[]
): Promise<{ repo: ADORepository; projectName: string } | null> {
  try {
    // URL-decode the repositoryId in case it contains encoded characters.
    const decodedId = decodeURIComponent(repositoryId);

    console.log('[fetchRepositoryInfo] Looking up repository:', {
      originalId: repositoryId,
      decodedId,
      hasSlash: decodedId.includes('/'),
      allowedProjects,
    });

    // Check if this is a GitLab-style path (project/repo format).
    if (decodedId.includes('/')) {
      const slashIndex = decodedId.lastIndexOf('/');
      const projectPathPart = decodedId.substring(0, slashIndex);
      const repoPathPart = decodedId.substring(slashIndex + 1);

      console.log('[fetchRepositoryInfo] Parsed as project/repo path:', {
        projectPathPart,
        repoPathPart,
      });

      // Try to find the actual project name from allowed projects.
      // The path might be URL-safe (main-system) but we need the actual name (Main System).
      let actualProjectName = findActualProjectName(projectPathPart, allowedProjects);

      // If not found in allowed projects, use the path as-is (might be the actual name).
      if (!actualProjectName) {
        // Check if the path matches an allowed project directly (case-insensitive).
        if (allowedProjects && allowedProjects.length > 0) {
          const match = allowedProjects.find(
            (p) => p.toLowerCase() === projectPathPart.toLowerCase()
          );
          if (match) {
            actualProjectName = match;
          } else {
            console.warn('[fetchRepositoryInfo] Project not in allowed list:', {
              projectPathPart,
              urlSafeVersion: toUrlSafe(projectPathPart),
              allowedProjects,
              allowedUrlSafe: allowedProjects.map(toUrlSafe),
            });
            return null;
          }
        } else {
          // No allowed projects restriction - use the path as-is.
          actualProjectName = projectPathPart;
        }
      }

      console.log('[fetchRepositoryInfo] Resolved project name:', {
        pathPart: projectPathPart,
        actualName: actualProjectName,
      });

      // Try to fetch using the actual project name first.
      let repoUrl = MappingService.buildAdoUrl(
        adoBaseUrl,
        `/${encodeURIComponent(actualProjectName)}/_apis/git/repositories/${encodeURIComponent(repoPathPart)}`,
        adoApiVersion
      );

      console.log('[fetchRepositoryInfo] Fetching from project-level URL:', { url: repoUrl });

      let response = await fetch(repoUrl, {
        method: 'GET',
        headers: {
          Authorization: adoAuthHeader,
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        const repo = (await response.json()) as ADORepository;
        console.log('[fetchRepositoryInfo] Found repository via project path:', {
          repoId: repo.id,
          repoName: repo.name,
          projectName: repo.project.name,
        });
        return { repo, projectName: repo.project.name };
      }

      // If failed, try searching within the project for a repo matching the URL-safe name.
      console.log('[fetchRepositoryInfo] Direct lookup failed, searching within project:', {
        project: actualProjectName,
        repoPath: repoPathPart,
      });

      const listUrl = MappingService.buildAdoUrl(
        adoBaseUrl,
        `/${encodeURIComponent(actualProjectName)}/_apis/git/repositories`,
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
        const data = (await listResponse.json()) as { value: ADORepository[] };

        // Find repo by name or URL-safe name.
        const matchingRepo = data.value.find(
          (r) =>
            r.name.toLowerCase() === repoPathPart.toLowerCase() ||
            toUrlSafe(r.name) === repoPathPart.toLowerCase()
        );

        if (matchingRepo) {
          console.log('[fetchRepositoryInfo] Found repository by search:', {
            repoId: matchingRepo.id,
            repoName: matchingRepo.name,
            projectName: matchingRepo.project.name,
          });
          return { repo: matchingRepo, projectName: matchingRepo.project.name };
        }
      }

      console.warn('[fetchRepositoryInfo] Failed to find repository:', {
        projectPathPart,
        repoPathPart,
        actualProjectName,
      });
      return null;
    }

    // Try to get repository at organization level (works for GUIDs).
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

      // Check if this repository's project is in the allowed list.
      if (allowedProjects && allowedProjects.length > 0) {
        const allowedLower = allowedProjects.map((p) => p.toLowerCase());
        if (!allowedLower.includes(repo.project.name.toLowerCase())) {
          console.warn('[fetchRepositoryInfo] Repository project not in allowed list:', {
            repositoryId,
            projectName: repo.project.name,
            allowedProjects,
          });
          return null;
        }
      }

      return { repo, projectName: repo.project.name };
    }

    // If it failed with "project name required", it's likely a repository name, not a GUID.
    // Try to search for it across all repositories.
    const errorText = await response.text();
    if (errorText.includes('project name is required')) {
      console.log('[fetchRepositoryInfo] Searching for repo by name:', { repositoryId });

      // If we have allowed projects, search only within those projects.
      if (allowedProjects && allowedProjects.length > 0) {
        for (const projectName of allowedProjects) {
          const projectRepoUrl = MappingService.buildAdoUrl(
            adoBaseUrl,
            `/${encodeURIComponent(projectName)}/_apis/git/repositories/${encodeURIComponent(repositoryId)}`,
            adoApiVersion
          );

          const projectResponse = await fetch(projectRepoUrl, {
            method: 'GET',
            headers: {
              Authorization: adoAuthHeader,
              'Content-Type': 'application/json',
            },
          });

          if (projectResponse.ok) {
            const repo = (await projectResponse.json()) as ADORepository;
            console.log('[fetchRepositoryInfo] Found repo in allowed project:', {
              repoName: repo.name,
              projectName: repo.project.name,
            });
            return { repo, projectName: repo.project.name };
          }
        }
        return null;
      }

      // No allowed projects restriction - list all repositories.
      const listUrl = MappingService.buildAdoUrl(adoBaseUrl, '/_apis/git/repositories', adoApiVersion);

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
    console.error('[fetchRepositoryInfo] Error:', error);
    return null;
  }
}
