/**
 * Repository lookup helpers.
 * Used by project, repository, and git route modules.
 */

import { MappingService } from '../mapping.js';
import { getStorage } from '../storage/index.js';
import type { ADORepository } from '../types.js';

/**
 * Convert a string to URL-safe format for comparison.
 */
export function toUrlSafe(str: string): string {
  return str.toLowerCase().replace(/\s+/g, '-');
}

/**
 * Get the cached org name for a namespace/project path.
 */
export async function getCachedOrgMapping(namespace: string, project: string): Promise<string | null> {
  const storage = getStorage();
  const key = `org_mapping:${namespace.toLowerCase()}/${project.toLowerCase()}`;
  return await storage.get<string>(key);
}

/**
 * Store the org name mapping for a namespace/project path.
 */
export async function storeOrgMapping(namespace: string, project: string, orgName: string): Promise<void> {
  const storage = getStorage();
  const key = `org_mapping:${namespace.toLowerCase()}/${project.toLowerCase()}`;
  
  // Check if already cached to avoid unnecessary writes.
  const existing = await storage.get<string>(key);
  if (existing === orgName) {
    return;
  }
  
  await storage.set(key, orgName);
  console.log('[Org Mapping] Stored:', { path: `${namespace}/${project}`, orgName });
  
  // Also store this org in the known orgs list.
  await addKnownOrg(orgName);
}

/**
 * Add an organization to the list of known/validated orgs.
 */
export async function addKnownOrg(orgName: string): Promise<void> {
  const storage = getStorage();
  const key = 'known_orgs';
  const existing = await storage.get<string[]>(key) ?? [];
  
  // Check if already in the list (case-insensitive).
  const normalized = orgName.trim();
  if (existing.some(o => o.toLowerCase() === normalized.toLowerCase())) {
    return;
  }
  
  existing.push(normalized);
  await storage.set(key, existing);
  console.log('[Known Orgs] Added:', { orgName: normalized, total: existing.length });
}

/**
 * Get the list of known/validated organization names.
 */
export async function getKnownOrgs(): Promise<string[]> {
  const storage = getStorage();
  const key = 'known_orgs';
  return await storage.get<string[]>(key) ?? [];
}

/**
 * Store a mapping from a URL-safe name to its actual ADO name.
 * This allows reverse-mapping normalized names back to the originals
 * when constructing ADO web URLs (e.g., "engineering-shared-tools" → "Engineering Shared Tools").
 */
export async function storeActualName(urlSafeName: string, actualName: string): Promise<void> {
  // Skip if the names are identical (no mapping needed).
  if (urlSafeName === actualName) {
    return;
  }
  const storage = getStorage();
  const key = `actual_name:${urlSafeName.toLowerCase()}`;
  const existing = await storage.get<string>(key);
  if (existing === actualName) {
    return;
  }
  await storage.set(key, actualName);
  console.log('[Name Mapping] Stored:', { urlSafe: urlSafeName, actual: actualName });
}

/**
 * Look up the actual ADO name for a URL-safe name.
 * Returns the actual name if cached, or the input name as-is if no mapping exists.
 */
export async function getActualName(urlSafeName: string): Promise<string> {
  const storage = getStorage();
  const key = `actual_name:${urlSafeName.toLowerCase()}`;
  const actual = await storage.get<string>(key);
  return actual ?? urlSafeName;
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
 * If orgName is provided, caches the org mapping for the repo path.
 */
export async function fetchRepositoryInfo(
  repositoryId: string,
  adoAuthHeader: string,
  adoBaseUrl: string,
  allowedProjects?: string[],
  orgName?: string
): Promise<{ repo: ADORepository; projectName: string } | null> {
  // Helper to cache org mapping and name mappings on successful lookup.
  const cacheAndReturn = async (
    repo: ADORepository,
    projectName: string,
    namespace: string,
    repoName: string
  ): Promise<{ repo: ADORepository; projectName: string }> => {
    // Always cache URL-safe → actual name mappings so redirects work.
    const urlSafeProject = toUrlSafe(projectName);
    const urlSafeRepo = toUrlSafe(repo.name);
    await storeActualName(urlSafeProject, projectName);
    await storeActualName(urlSafeRepo, repo.name);

    if (orgName) {
      // Cache both the URL-safe path and actual names.
      await storeOrgMapping(namespace, repoName, orgName);
      // Also cache with actual names if different.
      if (urlSafeProject !== namespace.toLowerCase() || urlSafeRepo !== repoName.toLowerCase()) {
        await storeOrgMapping(urlSafeProject, urlSafeRepo, orgName);
      }
    }
    return { repo, projectName };
  };

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
        `/${encodeURIComponent(actualProjectName)}/_apis/git/repositories/${encodeURIComponent(repoPathPart)}`
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
        return cacheAndReturn(repo, repo.project.name, projectPathPart, repoPathPart);
      }

      // If failed, try searching within the project for a repo matching the URL-safe name.
      console.log('[fetchRepositoryInfo] Direct lookup failed, searching within project:', {
        project: actualProjectName,
        repoPath: repoPathPart,
      });

      let listUrl = MappingService.buildAdoUrl(
        adoBaseUrl,
        `/${encodeURIComponent(actualProjectName)}/_apis/git/repositories`
      );

      let listResponse = await fetch(listUrl, {
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
          return cacheAndReturn(matchingRepo, matchingRepo.project.name, projectPathPart, repoPathPart);
        }
      }

      // If project lookup failed (404), try to find the actual project name from ADO.
      // This handles cases where the URL uses a URL-safe name but the actual project has spaces.
      if (!listResponse.ok) {
        console.log('[fetchRepositoryInfo] Project not found, querying ADO for project list');

        const projectsUrl = MappingService.buildAdoUrl(adoBaseUrl, '/_apis/projects');
        const projectsResponse = await fetch(projectsUrl, {
          method: 'GET',
          headers: {
            Authorization: adoAuthHeader,
            'Content-Type': 'application/json',
          },
        });

        if (projectsResponse.ok) {
          const projectsData = (await projectsResponse.json()) as { value: Array<{ name: string }> };

          // Find project by URL-safe name match.
          const matchingProject = projectsData.value.find(
            (p) => toUrlSafe(p.name) === projectPathPart.toLowerCase()
          );

          if (matchingProject) {
            console.log('[fetchRepositoryInfo] Found matching project from ADO:', {
              urlSafeName: projectPathPart,
              actualName: matchingProject.name,
            });

            // Now search for the repository in this project.
            listUrl = MappingService.buildAdoUrl(
              adoBaseUrl,
              `/${encodeURIComponent(matchingProject.name)}/_apis/git/repositories`
            );

            listResponse = await fetch(listUrl, {
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
                console.log('[fetchRepositoryInfo] Found repository in matched project:', {
                  repoId: matchingRepo.id,
                  repoName: matchingRepo.name,
                  projectName: matchingRepo.project.name,
                });
                return cacheAndReturn(matchingRepo, matchingRepo.project.name, projectPathPart, repoPathPart);
              }
            }
          }
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
      `/_apis/git/repositories/${repositoryId}`
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

      // Cache URL-safe → actual name mappings.
      await storeActualName(toUrlSafe(repo.project.name), repo.project.name);
      await storeActualName(toUrlSafe(repo.name), repo.name);

      // Cache with URL-safe project and repo names.
      if (orgName) {
        await storeOrgMapping(toUrlSafe(repo.project.name), toUrlSafe(repo.name), orgName);
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
            `/${encodeURIComponent(projectName)}/_apis/git/repositories/${encodeURIComponent(repositoryId)}`
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
            // Cache URL-safe → actual name mappings.
            await storeActualName(toUrlSafe(repo.project.name), repo.project.name);
            await storeActualName(toUrlSafe(repo.name), repo.name);
            if (orgName) {
              await storeOrgMapping(toUrlSafe(repo.project.name), toUrlSafe(repo.name), orgName);
            }
            return { repo, projectName: repo.project.name };
          }
        }
        return null;
      }

      // No allowed projects restriction - list all repositories.
      const listUrl = MappingService.buildAdoUrl(adoBaseUrl, '/_apis/git/repositories');

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
          // Cache URL-safe → actual name mappings.
          await storeActualName(toUrlSafe(matchingRepo.project.name), matchingRepo.project.name);
          await storeActualName(toUrlSafe(matchingRepo.name), matchingRepo.name);
          if (orgName) {
            await storeOrgMapping(toUrlSafe(matchingRepo.project.name), toUrlSafe(matchingRepo.name), orgName);
          }
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
