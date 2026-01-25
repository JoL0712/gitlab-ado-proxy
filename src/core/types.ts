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

// GitLab User.
export interface GitLabUser {
  id: number;
  username: string;
  name: string;
  state: 'active' | 'blocked' | 'deactivated';
  avatar_url: string;
  web_url: string;
  email: string;
  is_admin: boolean;
  can_create_group: boolean;
  can_create_project: boolean;
}

// GitLab Project Access Token.
export interface GitLabProjectAccessToken {
  id: number;
  name: string;
  revoked: boolean;
  created_at: string;
  scopes: string[];
  user_id: number;
  last_used_at: string | null;
  active: boolean;
  expires_at: string | null;
  // Only included when creating a new token.
  token?: string;
  access_level?: number;
}

// GitLab Project Access Token Create Payload.
export interface GitLabProjectAccessTokenCreate {
  name: string;
  scopes: string[];
  access_level?: number;
  expires_at?: string;
}

// Stored access token (internal representation).
export interface StoredAccessToken {
  id: number;
  projectId: string;
  name: string;
  scopes: string[];
  accessLevel: number;
  // The actual ADO PAT that this token maps to.
  adoPat: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revoked: boolean;
  // User info from when the token was created.
  userId: number;
  userName: string;
}

// GitLab Tree Item (file/directory in repository).
export interface GitLabTreeItem {
  id: string;
  name: string;
  type: 'tree' | 'blob';
  path: string;
  mode: string;
}

// GitLab File.
export interface GitLabFile {
  file_name: string;
  file_path: string;
  size: number;
  encoding: 'base64' | 'text';
  content: string;
  content_sha256: string;
  ref: string;
  blob_id: string;
  commit_id: string;
  last_commit_id: string;
}

// GitLab Commit.
export interface GitLabCommit {
  id: string;
  short_id: string;
  title: string;
  author_name: string;
  author_email: string;
  authored_date: string;
  committer_name: string;
  committer_email: string;
  committed_date: string;
  created_at: string;
  message: string;
  parent_ids: string[];
  web_url: string;
}

// GitLab Commit Create Payload.
export interface GitLabCommitCreate {
  branch: string;
  commit_message: string;
  actions: GitLabCommitAction[];
  author_email?: string;
  author_name?: string;
  start_branch?: string;
}

// GitLab Commit Action.
export interface GitLabCommitAction {
  action: 'create' | 'delete' | 'move' | 'update' | 'chmod';
  file_path: string;
  content?: string;
  encoding?: 'text' | 'base64';
  previous_path?: string;
  last_commit_id?: string;
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
  changeCounts?: {
    Add: number;
    Edit: number;
    Delete: number;
  };
  url: string;
  parents?: string[];
}

// ADO Commits Response.
export interface ADOCommitsResponse {
  value: ADOCommit[];
  count: number;
}

// ADO User Profile.
export interface ADOUserProfile {
  displayName: string;
  publicAlias: string;
  emailAddress: string;
  coreRevision: number;
  timeStamp: string;
  id: string;
  revision: number;
}

// ADO Tree Item (file/directory).
export interface ADOTreeItem {
  objectId: string;
  relativePath: string;
  mode: string;
  gitObjectType: 'blob' | 'tree';
  url: string;
  size?: number;
}

// ADO Tree Response.
export interface ADOTreeResponse {
  value: ADOTreeItem[];
  count: number;
}

// ADO Item (file content).
export interface ADOItem {
  objectId: string;
  gitObjectType: 'blob' | 'tree';
  commitId: string;
  path: string;
  url: string;
  content?: string;
}

// ADO Push (for creating commits).
export interface ADOPush {
  refUpdates: ADORefUpdate[];
  commits: ADOPushCommit[];
}

// ADO Ref Update.
export interface ADORefUpdate {
  name: string;
  oldObjectId: string;
}

// ADO Push Commit.
export interface ADOPushCommit {
  comment: string;
  changes: ADOChange[];
  author?: {
    name: string;
    email: string;
  };
}

// ADO Change.
export interface ADOChange {
  changeType: 'add' | 'edit' | 'delete' | 'rename';
  item: {
    path: string;
  };
  newContent?: {
    content: string;
    contentType: 'rawtext' | 'base64encoded';
  };
  sourceServerItem?: string;
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
  // Optional: OAuth client ID for validating OAuth requests.
  oauthClientId?: string;
  // Optional: OAuth client secret for validating OAuth token exchange.
  oauthClientSecret?: string;
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
