# GitLab-ADO Proxy

A cloud-agnostic middleware that emulates GitLab's REST API and proxies requests to Azure DevOps. This enables Cursor Cloud Agents to work seamlessly with Azure DevOps repositories.

## Features

- **GitLab API Emulation**: Implements GitLab REST API endpoints that proxy to equivalent Azure DevOps APIs.
- **Multi-Runtime Support**: Deploy to AWS Lambda or run locally with Node.js.
- **Cloud-Agnostic Core**: The core logic is platform-agnostic, using only standard Web APIs.
- **Production-Ready**: Includes Terraform configuration for AWS Lambda deployment with DynamoDB storage.

## Supported Endpoints

### User & Authentication

| GitLab API | Azure DevOps API | Description |
|------------|------------------|-------------|
| `GET /api/v4/user` | `GET /_apis/connectionData` | Get current authenticated user |

### Projects (Repositories)

| GitLab API | Azure DevOps API | Description |
|------------|------------------|-------------|
| `GET /api/v4/projects` | `GET /_apis/git/repositories` | List all repositories |
| `GET /api/v4/projects/:id` | `GET /_apis/git/repositories/:id` | Get project details |

### Branches

| GitLab API | Azure DevOps API | Description |
|------------|------------------|-------------|
| `GET /api/v4/projects/:id/repository/branches` | `GET /_apis/git/repositories/:id/refs?filter=heads` | List branches |
| `GET /api/v4/projects/:id/repository/branches/:branch` | `GET /_apis/git/repositories/:id/refs?filter=heads/:branch` | Get single branch |
| `POST /api/v4/projects/:id/repository/branches` | `POST /_apis/git/repositories/:id/refs` | Create branch |
| `DELETE /api/v4/projects/:id/repository/branches/:branch` | `POST /_apis/git/repositories/:id/refs` | Delete branch |

### Files & Tree

| GitLab API | Azure DevOps API | Description |
|------------|------------------|-------------|
| `GET /api/v4/projects/:id/repository/tree` | `GET /_apis/git/repositories/:id/items` | List files and directories |
| `GET /api/v4/projects/:id/repository/files/:path` | `GET /_apis/git/repositories/:id/items?path=` | Get file content (base64) |
| `GET /api/v4/projects/:id/repository/files/:path/raw` | `GET /_apis/git/repositories/:id/items?path=` | Get raw file content |
| `HEAD /api/v4/projects/:id/repository/files/:path` | `HEAD /_apis/git/repositories/:id/items?path=` | Check if file exists |
| `GET /api/v4/projects/:id/repository/blobs/:sha` | `GET /_apis/git/repositories/:id/blobs/:sha` | Get blob by SHA |

### Commits

| GitLab API | Azure DevOps API | Description |
|------------|------------------|-------------|
| `GET /api/v4/projects/:id/repository/commits` | `GET /_apis/git/repositories/:id/commits` | List commits |
| `GET /api/v4/projects/:id/repository/commits/:sha` | `GET /_apis/git/repositories/:id/commits/:sha` | Get single commit |
| `POST /api/v4/projects/:id/repository/commits` | `POST /_apis/git/repositories/:id/pushes` | Create commit(s) |
| `GET /api/v4/projects/:id/repository/compare` | `POST /_apis/git/repositories/:id/commitsbatch` | Compare branches/commits |

### Merge Requests (Pull Requests)

| GitLab API | Azure DevOps API | Description |
|------------|------------------|-------------|
| `POST /api/v4/projects/:id/merge_requests` | `POST /_apis/git/repositories/:id/pullrequests` | Create merge request |
| `GET /api/v4/projects/:id/merge_requests` | `GET /_apis/git/repositories/:id/pullrequests` | List merge requests |
| `GET /api/v4/projects/:id/merge_requests/:iid` | `GET /_apis/git/repositories/:id/pullrequests/:id` | Get single merge request |
| `PUT /api/v4/projects/:id/merge_requests/:iid` | `PATCH /_apis/git/repositories/:id/pullrequests/:id` | Update merge request |
| `PUT /api/v4/projects/:id/merge_requests/:iid/merge` | `PATCH /_apis/git/repositories/:id/pullrequests/:id` | Merge a merge request |
| `GET /api/v4/projects/:id/merge_requests/:iid/changes` | `GET /_apis/git/repositories/:id/pullrequests/:id/iterations` | Get MR changes/diff |

### Project Access Tokens

| GitLab API | Description |
|------------|-------------|
| `GET /api/v4/projects/:id/access_tokens` | List project access tokens |
| `GET /api/v4/projects/:id/access_tokens/:token_id` | Get details on a project access token |
| `POST /api/v4/projects/:id/access_tokens` | Create project access token (issues proxy-managed `glpat-*` token) |
| `POST /api/v4/projects/:id/access_tokens/:token_id/rotate` | Rotate project access token (supports `self` keyword) |
| `DELETE /api/v4/projects/:id/access_tokens/:token_id` | Revoke project access token |

### OAuth 2.0 Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /oauth/authorize` | Step 1: OAuth authorization — enter PAT for org (client_id = org name) |
| `POST /oauth/authorize` | Validates PAT via ADO Projects API, shows project-selection form |
| `POST /oauth/authorize/confirm` | Step 2: Confirm selected projects, create proxy token, redirect with code |
| `POST /oauth/token` | Exchanges authorization code for proxy access token (not the raw PAT) |

The value sent as `client_id` in OAuth is the **Azure DevOps organization name**. The proxy returns a **proxy token** (`glpat-oauth-...`) that carries org and user-selected projects; the raw PAT is never returned to the client.

### Instance Information

| GitLab API | Description |
|------------|-------------|
| `GET /api/v4/version` | Returns GitLab version information |
| `GET /api/v4/metadata` | Returns GitLab instance metadata |
| `GET /api/v4/personal_access_tokens/self` | Returns info about current token |
| `GET /api/v4/application/settings` | Returns application settings |
| `GET /api/v4/groups` | Returns empty groups list |
| `GET /api/v4/namespaces` | Returns empty namespaces list |
| `GET /api/v4/features` | Returns empty features list |

### Additional Repository Endpoints

| GitLab API | Azure DevOps API | Description |
|------------|------------------|-------------|
| `GET /api/v4/projects/:id/repository/refs` | `GET /_apis/git/repositories/:id/refs` | List refs (branches/tags) |

## Architecture

```
src/
├── core/                 # Platform-agnostic logic
│   ├── app.ts           # Hono application and routes
│   ├── mapping.ts       # GitLab <-> ADO mapping service
│   ├── types.ts         # TypeScript interfaces
│   ├── index.ts         # Core exports
│   └── storage/         # Key-value storage abstraction
│       ├── types.ts     # Storage interface and types
│       ├── memory.ts    # In-memory adapter (ephemeral)
│       ├── file.ts      # File-backed adapter (local dev, persists across restarts)
│       ├── dynamodb.ts  # DynamoDB adapter (AWS Lambda)
│       ├── factory.ts   # Storage factory
│       └── index.ts     # Storage exports
├── adapters/            # Runtime-specific entry points
│   ├── aws-lambda.ts    # AWS Lambda handler
│   └── nodejs.ts        # Node.js server (local development)
infra/
└── terraform/           # AWS deployment configuration
    ├── main.tf          # Main Terraform configuration (Lambda + DynamoDB)
    ├── variables.tf     # Input variables
    ├── outputs.tf       # Output values
    └── terraform.tfvars.example  # Example configuration
```

## Quick Start

### Prerequisites

- Node.js 20+
- npm or yarn
- (For deployment) Terraform 1.5+ and AWS CLI configured

### Installation

```bash
npm install
```

### Local Development

1. Set environment variables:

**Option 1: Using a `.env` file (Recommended)**

Create a `.env` file in the project root:

```bash
# Copy the example file
cp .env.example .env
```

Then edit `.env` with your values. Org and projects come from OAuth tokens; no `ADO_BASE_URL` or `ALLOWED_PROJECTS`:

```env
ADO_API_VERSION=7.1
PORT=3000
```

**Option 2: Using command line (Windows)**

**PowerShell:**
```powershell
$env:ADO_API_VERSION="7.1"
$env:PORT="3000"
npm run dev
```

**Command Prompt (CMD):**
```cmd
set ADO_API_VERSION=7.1
set PORT=3000
npm run dev
```

**Option 3: Using command line (Linux/Mac)**

```bash
export ADO_API_VERSION="7.1"
export PORT=3000
npm run dev
```

2. Start the development server:

```bash
npm run dev
```

3. Test the proxy: use an OAuth-issued proxy token or a project token (see [Authentication](#authentication)). Raw PATs are not accepted.

### Building

```bash
npm run build
```

## Authentication

Only **OAuth-issued proxy tokens** and **project access tokens** (created via the API when using an OAuth token) are accepted. Raw Azure DevOps PATs are not accepted for API or Git requests.

- **OAuth flow**: `client_id` is the ADO organization name. The user enters a PAT, selects projects, and receives a proxy token (`glpat-oauth-...`) that carries org and allowed projects.
- **Project tokens**: Created with `POST /api/v4/projects/:id/access_tokens` when using an OAuth token; they store the same org and allowed projects and are used as `glpat-*`.

Credentials are sent as GitLab-style `PRIVATE-TOKEN` or `Authorization: Bearer <token>` and converted to ADO Basic auth under the hood using the stored PAT.

## Access Control

Organization and allowed projects are **per-token** and come from OAuth only:

- During OAuth, the user selects which ADO projects the token may access (or all if none chosen).
- That set is stored with the proxy token and used for all API and Git requests made with that token.
- Project tokens created via the API inherit the creating user’s org and allowed projects.

There is no env-based `ADO_BASE_URL` or `ALLOWED_PROJECTS`; everything is derived from the token.

## AWS Deployment

### 1. Configure Variables

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`. Org and projects are per-token (OAuth); no `ado_base_url` or `allowed_projects`:

```hcl
aws_region   = "us-east-1"
environment  = "prod"
oauth_client_secret = "your-secret"   # optional, for token exchange
```

### 2. Deploy

```bash
terraform init
terraform plan
terraform apply
```

### 3. Get the Function URL

```bash
terraform output function_url
```

## Usage with Cursor Cloud

### Option 1: OAuth Flow (Recommended for Cursor Cloud)

1. Deploy the proxy and get the function URL:
   ```bash
   terraform output function_url
   ```

2. In Cursor Cloud, go to Integrations → GitLab Self-Hosted.

3. Configure:
   - **GitLab Hostname**: Your proxy URL (e.g., `https://your-function-url.lambda-url.us-east-1.on.aws`)
   - **Application ID**: Your **Azure DevOps organization name** (this is sent as `client_id` in OAuth)
   - **Secret**: Optional; set `OAUTH_CLIENT_SECRET` on the proxy and use the same value here to protect the token exchange

4. Click "Register". Cursor redirects to the proxy’s authorization page.

5. **Step 1**: Enter your Azure DevOps PAT for that org. The proxy validates it with the ADO Projects API.

6. **Step 2**: Choose which projects the token may access (or leave all selected), then click "Authorize". The proxy creates a proxy token and redirects back with an authorization code.

7. Cursor exchanges the code for an access token. The token is a proxy token (`glpat-oauth-...`), not the raw PAT. All API and Git requests use that token; org and projects are taken from it.

### Option 2: Project or OAuth tokens only

Use the proxy with `PRIVATE-TOKEN` or `Authorization: Bearer` only when the value is an OAuth-issued proxy token or a project token created via the API. Raw Azure DevOps PATs are rejected.

## Environment Variables

### Core Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `ADO_API_VERSION` | Azure DevOps API version | `7.1` |
| `OAUTH_CLIENT_SECRET` | OAuth client secret for token exchange (optional, recommended for security) | None (accepts any) |
| `PORT` | Local server port (Node.js only) | `3000` |

Org and allowed projects are not configured via env; they come from each token (OAuth or project token). The OAuth `client_id` is always the ADO organization name.

### Storage Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `STORAGE_TYPE` | Storage adapter type: `file`, `memory`, `dynamodb` | `file` |
| `STORAGE_FILE_PATH` | Path to JSON file for file adapter | `.data/storage.json` |
| `STORAGE_TABLE_NAME` | DynamoDB table name (required for `dynamodb` type) | - |
| `STORAGE_KEY_PREFIX` | Key prefix for namespacing | `gitlab-ado-proxy` |
| `AWS_REGION` | AWS region for DynamoDB | `us-east-1` |

## Storage

The proxy uses a pluggable key-value storage system for OAuth tokens and sessions. This is essential for serverless environments where in-memory storage doesn't persist between invocations.

### Storage Adapters

| Adapter | Use Case | Configuration |
|---------|----------|---------------|
| `file` | Local development (persists across restarts) | Default, writes to `.data/storage.json` |
| `memory` | Ephemeral testing | Set `STORAGE_TYPE=memory` |
| `dynamodb` | AWS Lambda, production | Set `STORAGE_TYPE=dynamodb` and `STORAGE_TABLE_NAME` |

### Local Development

For local development, the default `file` storage persists data to `.data/storage.json` so tokens and mappings survive server restarts:

```bash
# Uses file-backed storage by default (.data/storage.json)
npm run dev
```

### AWS Lambda (DynamoDB)

The Terraform configuration automatically creates a DynamoDB table when `enable_dynamodb_storage = true` (default):

```hcl
# In terraform.tfvars
enable_dynamodb_storage = true
dynamodb_billing_mode   = "PAY_PER_REQUEST"  # Serverless pricing
```

The Lambda function will automatically use the DynamoDB table for persistent storage.

### Storage Interface

The storage system provides a simple key-value interface:

```typescript
interface KVStorage {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, options?: { ttl?: number }): Promise<void>;
  delete(key: string): Promise<boolean>;
  exists(key: string): Promise<boolean>;
  list<T>(options?: { prefix?: string; limit?: number }): Promise<ListResult<T>>;
}
```

All storage operations support automatic TTL (time-to-live) for expiring OAuth tokens and sessions.

## API Mapping Details

### Projects

The proxy maps ADO repository concepts to GitLab project format:

- Repository ID -> Project ID
- Repository name -> Project name
- Default branch (without refs/heads/) -> Default branch
- Project visibility -> Visibility (private/public)

### Branches

ADO refs are converted to GitLab branch format:

- `refs/heads/branch-name` -> `branch-name`
- Commit information is included when available.

### Merge Requests / Pull Requests

Status mapping:

| ADO Status | GitLab State |
|------------|--------------|
| `active` | `opened` |
| `completed` | `merged` |
| `abandoned` | `closed` |

## Development

### Type Checking

```bash
npm run typecheck
```

### Project Structure

- **`src/core/types.ts`**: TypeScript interfaces for both GitLab and ADO APIs.
- **`src/core/mapping.ts`**: Pure functions for converting between API formats.
- **`src/core/app.ts`**: Hono application with route handlers.
- **`src/core/storage/`**: Cloud-agnostic key-value storage abstraction.
  - `types.ts`: Storage interface definition.
  - `memory.ts`: In-memory adapter (ephemeral).
  - `file.ts`: File-backed adapter for local development (persists to JSON).
  - `dynamodb.ts`: DynamoDB adapter for AWS Lambda.
  - `factory.ts`: Creates storage instances based on configuration.
- **`src/adapters/`**: Runtime-specific adapters.

## License

MIT
