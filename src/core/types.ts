/**
 * GitLab API Types.
 * These represent the request/response shapes for GitLab's REST API.
 */

// GitLab Project (Repository).
export interface GitLabProject {
  id: number | string;
  name: string;
  description: string | null;
  default_branch: string;
  visibility: 'private' | 'internal' | 'public';
  web_url: string;
  ssh_url_to_repo: string;
  http_url_to_repo: string;
  path_with_namespace: string;
  namespace: {
    id: number;
    name: string;
    path: string;
    full_path: string;
  };
  created_at: string;
  last_activity_at: string;
}

// GitLab Branch.
export interface GitLabBranch {
  name: string;
  merged: boolean;
  protected: boolean;
  default: boolean;
  developers_can_push: boolean;
  developers_can_merge: boolean;
  can_push: boolean;
  web_url: string;
  commit: {
    id: string;
    short_id: string;
    title: string;
    author_name: string;
    author_email: string;
    authored_date: string;
    committer_name: string;
    committer_email: string;
    committed_date: string;
    message: string;
    parent_ids: string[];
    web_url: string;
  };
}

// GitLab Merge Request (PR).
export interface GitLabMergeRequest {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  state: 'opened' | 'closed' | 'merged';
  source_branch: string;
  target_branch: string;
  source_project_id: number;
  target_project_id: number;
  author: {
    id: number;
    username: string;
    name: string;
    avatar_url: string;
    web_url: string;
  };
  web_url: string;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  closed_at: string | null;
}

// GitLab Merge Request Create Payload.
export interface GitLabMergeRequestCreate {
  source_branch: string;
  target_branch: string;
  title: string;
  description?: string;
  remove_source_branch?: boolean;
}

/**
 * Azure DevOps API Types.
 * These represent the request/response shapes for ADO's REST API.
 */

// ADO Repository.
export interface ADORepository {
  id: string;
  name: string;
  url: string;
  project: {
    id: string;
    name: string;
    url: string;
    state: string;
    visibility: 'private' | 'public';
  };
  defaultBranch: string;
  size: number;
  remoteUrl: string;
  sshUrl: string;
  webUrl: string;
  isDisabled: boolean;
}

// ADO Git Ref (Branch).
export interface ADOGitRef {
  name: string;
  objectId: string;
  creator: {
    displayName: string;
    url: string;
    id: string;
    uniqueName: string;
    imageUrl: string;
  };
  url: string;
}

// ADO Git Refs Response.
export interface ADOGitRefsResponse {
  value: ADOGitRef[];
  count: number;
}

// ADO Pull Request.
export interface ADOPullRequest {
  pullRequestId: number;
  codeReviewId: number;
  status: 'active' | 'abandoned' | 'completed';
  createdBy: {
    displayName: string;
    url: string;
    id: string;
    uniqueName: string;
    imageUrl: string;
  };
  creationDate: string;
  closedDate: string | null;
  title: string;
  description: string | null;
  sourceRefName: string;
  targetRefName: string;
  mergeStatus: string;
  isDraft: boolean;
  repository: {
    id: string;
    name: string;
    url: string;
    project: {
      id: string;
      name: string;
      state: string;
    };
  };
  url: string;
}

// ADO Pull Request Create Payload.
export interface ADOPullRequestCreate {
  sourceRefName: string;
  targetRefName: string;
  title: string;
  description?: string;
  isDraft?: boolean;
}

// ADO Commit.
export interface ADOCommit {
  commitId: string;
  author: {
    name: string;
    email: string;
    date: string;
  };
  committer: {
    name: string;
    email: string;
    date: string;
  };
  comment: string;
  url: string;
}

/**
 * Proxy Configuration.
 */
export interface ProxyConfig {
  // Base URL for Azure DevOps organization (e.g., https://dev.azure.com/org).
  // The proxy is project-agnostic and uses repository GUIDs to access repositories across all projects.
  adoBaseUrl: string;
  // Optional: Override the API version.
  adoApiVersion?: string;
}

/**
 * Request Context.
 * Passed through handlers to provide access to config and auth.
 */
export interface RequestContext {
  config: ProxyConfig;
  adoAuthHeader: string;
}

/**
 * API Error Response.
 */
export interface APIError {
  error: string;
  message: string;
  statusCode: number;
}
