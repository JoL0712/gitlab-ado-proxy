import { ADO_API_VERSION } from './constants.js';
import type {
  GitLabProject,
  GitLabBranch,
  GitLabMergeRequest,
  GitLabMergeRequestCreate,
  GitLabUser,
  GitLabTreeItem,
  GitLabFile,
  GitLabCommit,
  GitLabCommitCreate,
  ADORepository,
  ADOGitRef,
  ADOPullRequest,
  ADOPullRequestCreate,
  ADOCommit,
  ADOUserProfile,
  ADOTreeItem,
  ADOPush,
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
   * Convert a string to a URL-safe path (lowercase, spaces to hyphens).
   */
  static toUrlSafePath(str: string): string {
    return str.toLowerCase().replace(/\s+/g, '-');
  }

  /**
   * Map ADO Repository to GitLab Project format.
   */
  static mapRepositoryToProject(repo: ADORepository, proxyBaseUrl?: string): GitLabProject {
    // Create URL-safe paths.
    const projectPath = this.toUrlSafePath(repo.project.name);
    const repoPath = this.toUrlSafePath(repo.name);
    const pathWithNamespace = `${projectPath}/${repoPath}`;

    // Use URL-safe names throughout to ensure consistency.
    // Cursor may construct paths from namespace.name + name, so these must be URL-safe.
    // Also construct web_url using the proxy base URL if provided.
    const webUrl = proxyBaseUrl
      ? `${proxyBaseUrl}/${pathWithNamespace}`
      : repo.webUrl;

    return {
      id: repo.id,
      name: repoPath,
      path: repoPath,
      description: null,
      default_branch: repo.defaultBranch?.replace('refs/heads/', '') ?? 'main',
      visibility: repo.project.visibility === 'public' ? 'public' : 'private',
      web_url: webUrl,
      ssh_url_to_repo: repo.sshUrl ?? '',
      http_url_to_repo: repo.remoteUrl ?? '',
      path_with_namespace: pathWithNamespace,
      namespace: {
        id: parseInt(repo.project.id, 16) || 0,
        name: projectPath,
        path: projectPath,
        full_path: projectPath,
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
   * If projectName is provided, uses project-level URL format.
   * Otherwise, uses organization-level URL format.
   */
  static buildAdoUrl(
    baseUrl: string,
    path: string,
    projectName?: string,
    apiVersionOverride?: string
  ): string {
    // Ensure base URL doesn't have trailing slash.
    const base = baseUrl.replace(/\/$/, '');
    // Ensure path starts with slash.
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    
    // If project name is provided, insert it into the URL path.
    let fullUrl: string;
    if (projectName) {
      // Insert project name after organization: https://dev.azure.com/org/project/_apis/...
      fullUrl = `${base}/${projectName}${normalizedPath}`;
    } else {
      // Organization-level: https://dev.azure.com/org/_apis/...
      fullUrl = `${base}${normalizedPath}`;
    }
    
    // Add api-version query parameter.
    const apiVersion = apiVersionOverride ?? ADO_API_VERSION;
    const separator = normalizedPath.includes('?') ? '&' : '?';
    return `${fullUrl}${separator}api-version=${apiVersion}`;
  }

  /**
   * Map ADO User Profile to GitLab User format.
   */
  static mapUserProfileToUser(profile: ADOUserProfile): GitLabUser {
    return {
      id: parseInt(profile.id.replace(/-/g, '').substring(0, 8), 16) || 1,
      username: profile.publicAlias || profile.emailAddress?.split('@')[0] || 'user',
      name: profile.displayName,
      state: 'active',
      avatar_url: '',
      web_url: '',
      email: profile.emailAddress || '',
      is_admin: false,
      can_create_group: true,
      can_create_project: true,
    };
  }

  /**
   * Map ADO Tree Item to GitLab Tree Item format.
   */
  static mapTreeItemToGitLabTreeItem(item: ADOTreeItem): GitLabTreeItem {
    const pathParts = item.relativePath.split('/');
    const name = pathParts[pathParts.length - 1];

    return {
      id: item.objectId,
      name: name,
      type: item.gitObjectType === 'tree' ? 'tree' : 'blob',
      path: item.relativePath,
      mode: item.mode || (item.gitObjectType === 'tree' ? '040000' : '100644'),
    };
  }

  /**
   * Map ADO Item (file) to GitLab File format.
   */
  static mapItemToGitLabFile(
    path: string,
    content: string,
    objectId: string,
    commitId: string,
    ref: string,
    isBase64: boolean = false
  ): GitLabFile {
    const pathParts = path.split('/');
    const fileName = pathParts[pathParts.length - 1];
    
    // Calculate content size.
    const size = isBase64 ? Math.floor(content.length * 0.75) : content.length;

    return {
      file_name: fileName,
      file_path: path.startsWith('/') ? path.substring(1) : path,
      size: size,
      encoding: isBase64 ? 'base64' : 'text',
      content: content,
      content_sha256: objectId,
      ref: ref,
      blob_id: objectId,
      commit_id: commitId,
      last_commit_id: commitId,
    };
  }

  /**
   * Map ADO Commit to GitLab Commit format.
   */
  static mapCommitToGitLabCommit(commit: ADOCommit, webUrl?: string): GitLabCommit {
    return {
      id: commit.commitId,
      short_id: commit.commitId.substring(0, 8),
      title: commit.comment?.split('\n')[0] ?? '',
      author_name: commit.author?.name ?? '',
      author_email: commit.author?.email ?? '',
      authored_date: commit.author?.date ?? new Date().toISOString(),
      committer_name: commit.committer?.name ?? '',
      committer_email: commit.committer?.email ?? '',
      committed_date: commit.committer?.date ?? new Date().toISOString(),
      created_at: commit.author?.date ?? new Date().toISOString(),
      message: commit.comment ?? '',
      parent_ids: commit.parents ?? [],
      web_url: webUrl ?? commit.url ?? '',
    };
  }

  /**
   * Map GitLab Commit Create payload to ADO Push format.
   */
  static mapCommitCreateToPush(
    commitCreate: GitLabCommitCreate,
    oldObjectId: string
  ): ADOPush {
    const changes = commitCreate.actions.map((action) => {
      const changeTypeMap: Record<string, 'add' | 'edit' | 'delete' | 'rename'> = {
        create: 'add',
        update: 'edit',
        delete: 'delete',
        move: 'rename',
        chmod: 'edit',
      };

      const change: {
        changeType: 'add' | 'edit' | 'delete' | 'rename';
        item: { path: string };
        newContent?: { content: string; contentType: 'rawtext' | 'base64encoded' };
        sourceServerItem?: string;
      } = {
        changeType: changeTypeMap[action.action] ?? 'edit',
        item: {
          path: action.file_path.startsWith('/') ? action.file_path : `/${action.file_path}`,
        },
      };

      if (action.content !== undefined && action.action !== 'delete') {
        change.newContent = {
          content: action.content,
          contentType: action.encoding === 'base64' ? 'base64encoded' : 'rawtext',
        };
      }

      if (action.previous_path && action.action === 'move') {
        change.sourceServerItem = action.previous_path.startsWith('/')
          ? action.previous_path
          : `/${action.previous_path}`;
      }

      return change;
    });

    const push: ADOPush = {
      refUpdates: [
        {
          name: `refs/heads/${commitCreate.branch}`,
          oldObjectId: oldObjectId,
        },
      ],
      commits: [
        {
          comment: commitCreate.commit_message,
          changes: changes,
        },
      ],
    };

    if (commitCreate.author_name || commitCreate.author_email) {
      push.commits[0].author = {
        name: commitCreate.author_name ?? '',
        email: commitCreate.author_email ?? '',
      };
    }

    return push;
  }
}
