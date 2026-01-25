# GitLab-ADO Proxy

A cloud-agnostic middleware that emulates GitLab's REST API and proxies requests to Azure DevOps. This enables Cursor Cloud Agents to work seamlessly with Azure DevOps repositories.

## Features

- **GitLab API Emulation**: Implements GitLab REST API endpoints that proxy to equivalent Azure DevOps APIs.
- **Multi-Runtime Support**: Deploy to AWS Lambda, Vercel Edge, or run locally with Node.js.
- **Cloud-Agnostic Core**: The core logic is platform-agnostic, using only standard Web APIs.
- **Production-Ready**: Includes Terraform configuration for AWS Lambda deployment.

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

## Architecture

```
src/
├── core/                 # Platform-agnostic logic
│   ├── app.ts           # Hono application and routes
│   ├── mapping.ts       # GitLab <-> ADO mapping service
│   ├── types.ts         # TypeScript interfaces
│   └── index.ts         # Core exports
├── adapters/            # Runtime-specific entry points
│   ├── aws-lambda.ts    # AWS Lambda handler
│   ├── nodejs.ts        # Node.js server
│   └── vercel.ts        # Vercel Edge handler
infra/
└── terraform/           # AWS deployment configuration
    ├── main.tf          # Main Terraform configuration
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

```bash
export ADO_BASE_URL="https://dev.azure.com/your-org"
export ADO_API_VERSION="7.1"
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

## Usage with Cursor

Once deployed, configure your Cursor Cloud Agent to use the proxy URL as the GitLab base URL:

```
https://your-function-url.lambda-url.us-east-1.on.aws
```

Use your Azure DevOps PAT as the GitLab private token.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ADO_BASE_URL` | Azure DevOps organization URL (project-agnostic) | Required |
| `ADO_API_VERSION` | Azure DevOps API version | `7.1` |
| `PORT` | Local server port (Node.js only) | `3000` |

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
- **`src/adapters/`**: Runtime-specific adapters.

## License

MIT
