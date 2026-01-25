import type {
  GitLabProject,
  GitLabBranch,
  GitLabMergeRequest,
  GitLabMergeRequestCreate,
  ADORepository,
  ADOGitRef,
  ADOPullRequest,
  ADOPullRequestCreate,
  ADOCommit,
} from './types.js';

/**
 * MappingService provides functions to convert between GitLab and Azure DevOps API formats.
 * All mappings are pure functions with no side effects.
 */
export class MappingService {
  /**
   * Convert GitLab PRIVATE-TOKEN header to ADO Basic auth header.
   * GitLab uses: PRIVATE-TOKEN: <token>
   * ADO uses: Authorization: Basic base64(:PAT)
   */
  static convertAuth(gitlabToken: string): string {
    // ADO expects the PAT as the password with an empty username.
    const credentials = `:${gitlabToken}`;
    const encoded = btoa(credentials);
    return `Basic ${encoded}`;
  }

  /**
   * Map ADO Repository to GitLab Project format.
   */
  static mapRepositoryToProject(repo: ADORepository): GitLabProject {
    return {
      id: repo.id,
      name: repo.name,
      description: null,
      default_branch: repo.defaultBranch?.replace('refs/heads/', '') ?? 'main',
      visibility: repo.project.visibility === 'public' ? 'public' : 'private',
      web_url: repo.webUrl,
      ssh_url_to_repo: repo.sshUrl ?? '',
      http_url_to_repo: repo.remoteUrl ?? '',
      path_with_namespace: `${repo.project.name}/${repo.name}`,
      namespace: {
        id: parseInt(repo.project.id, 16) || 0,
        name: repo.project.name,
        path: repo.project.name.toLowerCase().replace(/\s+/g, '-'),
        full_path: repo.project.name.toLowerCase().replace(/\s+/g, '-'),
      },
      created_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
    };
  }

  /**
   * Map ADO Git Ref to GitLab Branch format.
   * ADO refs come in format: refs/heads/branch-name.
   */
  static mapRefToBranch(
    ref: ADOGitRef,
    defaultBranch: string,
    commit?: ADOCommit
  ): GitLabBranch {
    // Extract branch name from refs/heads/branch-name.
    const branchName = ref.name.replace('refs/heads/', '');
    const isDefault = branchName === defaultBranch.replace('refs/heads/', '');

    return {
      name: branchName,
      merged: false,
      protected: isDefault,
      default: isDefault,
      developers_can_push: true,
      developers_can_merge: true,
      can_push: true,
      web_url: ref.url,
      commit: {
        id: commit?.commitId ?? ref.objectId,
        short_id: (commit?.commitId ?? ref.objectId).substring(0, 8),
        title: commit?.comment?.split('\n')[0] ?? '',
        author_name: commit?.author?.name ?? ref.creator?.displayName ?? '',
        author_email: commit?.author?.email ?? '',
        authored_date: commit?.author?.date ?? new Date().toISOString(),
        committer_name: commit?.committer?.name ?? ref.creator?.displayName ?? '',
        committer_email: commit?.committer?.email ?? '',
        committed_date: commit?.committer?.date ?? new Date().toISOString(),
        message: commit?.comment ?? '',
        parent_ids: [],
        web_url: commit?.url ?? '',
      },
    };
  }

  /**
   * Map ADO Pull Request to GitLab Merge Request format.
   */
  static mapPullRequestToMergeRequest(pr: ADOPullRequest): GitLabMergeRequest {
    // Map ADO status to GitLab state.
    const stateMap: Record<string, 'opened' | 'closed' | 'merged'> = {
      active: 'opened',
      abandoned: 'closed',
      completed: 'merged',
    };

    return {
      id: pr.pullRequestId,
      iid: pr.pullRequestId,
      title: pr.title,
      description: pr.description,
      state: stateMap[pr.status] ?? 'opened',
      source_branch: pr.sourceRefName.replace('refs/heads/', ''),
      target_branch: pr.targetRefName.replace('refs/heads/', ''),
      source_project_id: parseInt(pr.repository.project.id, 16) || 0,
      target_project_id: parseInt(pr.repository.project.id, 16) || 0,
      author: {
        id: parseInt(pr.createdBy.id, 16) || 0,
        username: pr.createdBy.uniqueName?.split('@')[0] ?? '',
        name: pr.createdBy.displayName,
        avatar_url: pr.createdBy.imageUrl ?? '',
        web_url: pr.createdBy.url ?? '',
      },
      web_url: pr.url,
      created_at: pr.creationDate,
      updated_at: pr.creationDate,
      merged_at: pr.status === 'completed' ? pr.closedDate : null,
      closed_at: pr.status !== 'active' ? pr.closedDate : null,
    };
  }

  /**
   * Map GitLab Merge Request Create payload to ADO Pull Request Create format.
   */
  static mapMergeRequestCreateToPullRequestCreate(
    mrCreate: GitLabMergeRequestCreate
  ): ADOPullRequestCreate {
    return {
      sourceRefName: `refs/heads/${mrCreate.source_branch}`,
      targetRefName: `refs/heads/${mrCreate.target_branch}`,
      title: mrCreate.title,
      description: mrCreate.description,
      isDraft: false,
    };
  }

  /**
   * Build ADO API URL from base URL and path.
   */
  static buildAdoUrl(
    baseUrl: string,
    path: string,
    apiVersion: string = '7.1'
  ): string {
    // Ensure base URL doesn't have trailing slash.
    const base = baseUrl.replace(/\/$/, '');
    // Ensure path starts with slash.
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    // Add api-version query parameter.
    const separator = normalizedPath.includes('?') ? '&' : '?';
    return `${base}${normalizedPath}${separator}api-version=${apiVersion}`;
  }
}
