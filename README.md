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

### OAuth 2.0 Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /oauth/authorize` | OAuth authorization endpoint (shows authorization form) |
| `POST /oauth/authorize` | Handles authorization form submission |
| `POST /oauth/token` | Token exchange endpoint (exchanges authorization code for access token) |

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
│       ├── memory.ts    # In-memory adapter (local dev)
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

Then edit `.env` with your values:

```env
ADO_BASE_URL=https://dev.azure.com/your-org
ADO_API_VERSION=7.1
PORT=3000
```

**Option 2: Using command line (Windows)**

**PowerShell:**
```powershell
$env:ADO_BASE_URL="https://dev.azure.com/your-org"
$env:ADO_API_VERSION="7.1"
$env:PORT="3000"
npm run dev
```

**Command Prompt (CMD):**
```cmd
set ADO_BASE_URL=https://dev.azure.com/your-org
set ADO_API_VERSION=7.1
set PORT=3000
npm run dev
```

**Option 3: Using command line (Linux/Mac)**

```bash
export ADO_BASE_URL="https://dev.azure.com/your-org"
export ADO_API_VERSION="7.1"
export PORT=3000
npm run dev
```

2. Start the development server:

```bash
npm run dev
```

3. Test the proxy:

```bash
curl -H "PRIVATE-TOKEN: your-ado-pat" \
  http://localhost:3000/api/v4/projects/your-repo-id
```

### Building

```bash
npm run build
```

## Authentication

The proxy converts GitLab's `PRIVATE-TOKEN` header to Azure DevOps Basic authentication:

- **GitLab**: `PRIVATE-TOKEN: <your-ado-pat>`
- **Converted to ADO**: `Authorization: Basic base64(:PAT)`

Your Azure DevOps Personal Access Token (PAT) should have appropriate permissions:

- **Code**: Read (for projects and branches)
- **Code**: Write (for creating pull requests)

## AWS Deployment

### 1. Configure Variables

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`:

```hcl
ado_base_url = "https://dev.azure.com/your-org"
aws_region   = "us-east-1"
environment  = "prod"
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

2. In Cursor Cloud, go to Integrations → GitLab Self-Hosted

3. Fill in the form:
   - **GitLab Hostname**: Your proxy URL (e.g., `https://your-function-url.lambda-url.us-east-1.on.aws`)
   - **Application ID**: The value you set in `OAUTH_CLIENT_ID` environment variable (or any value if not set)
   - **Secret**: The value you set in `OAUTH_CLIENT_SECRET` environment variable (or any value if not set)

   **Security Note**: For production, set `OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET` environment variables to restrict OAuth access. If these are not set, any client_id and client_secret will be accepted.

4. Click "Register" - Cursor will redirect you to the authorization page

5. Enter your Azure DevOps Personal Access Token (PAT) in the authorization form

6. Click "Authorize" - Cursor will complete the OAuth flow and use the token for API calls

### Option 2: Direct API Token

You can also use the proxy directly with the `PRIVATE-TOKEN` header:

```bash
curl -H "PRIVATE-TOKEN: your-ado-pat" \
  https://your-function-url.lambda-url.us-east-1.on.aws/api/v4/projects/your-repo-id
```

**Note**: Your Azure DevOps PAT should have appropriate permissions:
- **Code**: Read (for projects and branches)
- **Code**: Write (for creating pull requests)

## Environment Variables

### Core Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `ADO_BASE_URL` | Azure DevOps organization URL (project-agnostic) | Required |
| `ADO_API_VERSION` | Azure DevOps API version | `7.1` |
| `OAUTH_CLIENT_ID` | OAuth client ID for validating OAuth requests (optional, recommended for security) | None (accepts any) |
| `OAUTH_CLIENT_SECRET` | OAuth client secret for validating token exchange (optional, recommended for security) | None (accepts any) |
| `PORT` | Local server port (Node.js only) | `3000` |

### Storage Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `STORAGE_TYPE` | Storage adapter type: `memory`, `dynamodb` | `memory` |
| `STORAGE_TABLE_NAME` | DynamoDB table name (required for `dynamodb` type) | - |
| `STORAGE_KEY_PREFIX` | Key prefix for namespacing | `gitlab-ado-proxy` |
| `AWS_REGION` | AWS region for DynamoDB | `us-east-1` |

## Storage

The proxy uses a pluggable key-value storage system for OAuth tokens and sessions. This is essential for serverless environments where in-memory storage doesn't persist between invocations.

### Storage Adapters

| Adapter | Use Case | Configuration |
|---------|----------|---------------|
| `memory` | Local development, testing | Default, no config needed |
| `dynamodb` | AWS Lambda, production | Set `STORAGE_TYPE=dynamodb` and `STORAGE_TABLE_NAME` |

### Local Development

For local development, the default `memory` storage is sufficient:

```bash
# Uses in-memory storage by default
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
  - `memory.ts`: In-memory adapter for local development.
  - `dynamodb.ts`: DynamoDB adapter for AWS Lambda.
  - `factory.ts`: Creates storage instances based on configuration.
- **`src/adapters/`**: Runtime-specific adapters.

## License

MIT
