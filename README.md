# Chemicalist Generator

Chemicalist generates a modular NestJS backend and an independent Next.js admin
frontend from JSON manifests. The generator keeps domain manifests separate from
application configuration, infrastructure choices, and UI design tokens.

## Requirements

- Node.js 20 or newer (the generator itself supports Node.js 18+).
- npm.
- Docker Desktop only if you want to run the generated stack with Docker Compose.

## Install the CLI

From this repository, link the command globally:

```powershell
cd gen
npm install
npm link
chemicalist --help
```

For a project-local install:

```powershell
npm install --save-dev C:\path\to\chemicalist\gen
npx chemicalist --help
```

You can also invoke it without installing:

```powershell
node .\bin\chemicalist.js --help
```

## Manifest file layout

For a project named `example`, keep related configuration next to each other:

```text
manifests/
  example.manifest.json                 # Lab, Studio, models and relationships
  example.config.json                   # App metadata and output targets
  example.infrastructure.manifest.json # Database, capabilities and services
  example.frontend.manifest.json        # Whether the admin UI is generated
  ui.template.json                      # Colors, typography, radius and theme
```

The generator discovers the optional sibling files automatically. You may pass
other file paths through the CLI options. The manifest contains business
structure; application and infrastructure choices do not need to be duplicated
in it.

### Domain manifest

The domain manifest describes the Lab/Studio, enums, relationships, operations,
search/sort fields, and models. For each model, `dtos.create`, `dtos.update`,
and `dtos.query` explicitly select the fields accepted by generated request
DTOs. Zod schemas are strict and reject unknown input.

`customMethods` adds safe, equality-based repository methods:

```json
{
  "customMethods": [
    { "name": "findOneBySku", "operation": "findOneBy", "fields": ["sku"] },
    { "name": "countByStatus", "operation": "countBy", "fields": ["status"] }
  ]
}
```

Supported operations: `findOneBy`, `findManyBy`, `countBy`, and `isExistedBy`.
Method names must be camelCase, and reserved repository methods cannot be
overridden.

### App config and output selection

`example.config.json` holds application metadata and output choices:

```json
{
  "app": {
    "name": "inventory-suite",
    "title": "Inventory Suite",
    "apiPrefix": "api",
    "apiVersion": "1",
    "port": 3000
  },
  "outputs": {
    "webservice": true,
    "api": true,
    "frontend": true
  }
}
```

`api` controls backend/API generation, `frontend` controls the admin UI, and
`webservice` controls backend Docker/Compose output. The frontend requires the
API. All manifests registered into the same generated app must use compatible
app, database, and output settings.

### Infrastructure selection

`example.infrastructure.manifest.json` controls Prisma/database, optional
capabilities, and infrastructure services:

```json
{
  "persistence": {
    "provider": "prisma",
    "database": "postgres",
    "schema": "public"
  },
  "capabilities": {
    "cache": true,
    "messaging": true,
    "outbox": true,
    "inbox": true,
    "saga": true
  },
  "services": {
    "elasticsearch": false
  }
}
```

Supported databases are PostgreSQL (`postgres`) and MongoDB (`mongodb`). Redis
is enabled with `cache`; RabbitMQ with `messaging`. Outbox, inbox, and saga
automatically require messaging (and their other platform dependencies).
Elasticsearch is an optional Docker service.

### UI template

`ui.template.json` customizes the generated admin panel without editing
generated CSS. Supported color keys are `background`, `surface`, `surfaceMuted`,
`border`, `text`, `textMuted`, `primary`, `primaryHover`, `danger`,
`dangerBackground`, `success`, `successBackground`, `warning`, and
`warningBackground`. Colors must be six-digit hex values.

```json
{
  "colors": {
    "background": "#f6f7f9",
    "surface": "#ffffff",
    "primary": "#0f766e",
    "primaryHover": "#115e59"
  },
  "typography": {
    "fontFamily": "system-ui, Segoe UI, sans-serif",
    "baseFontSize": "15px"
  },
  "radius": "10px"
}
```

## Generate a project

Validate one or more domain manifests:

```powershell
chemicalist validate .\manifests\example.manifest.json
```

Initialize an app. In an interactive terminal, the wizard asks about database,
Elasticsearch, RabbitMQ, Redis, outbox/inbox/saga, and the webservice/API/UI
outputs. Selected answers are saved to the sibling config files:

```powershell
chemicalist init .\manifests\example.manifest.json
```

For CI or to accept all existing config defaults without prompts:

```powershell
chemicalist init .\manifests\example.manifest.json --yes --no-install
```

Override output locations and install dependencies automatically:

```powershell
chemicalist init .\manifests\example.manifest.json `
  --out .\chemicalist.backend `
  --frontend-out .\chemicalist.frontend
```

For subsequent manifest changes, run `chemicalist generate` with the same
manifest. If the frontend has not been generated yet, it is bootstrapped on the
first generation. Generator-owned files can be regenerated safely; use `--force`
only when you intentionally want to replace local edits in those files.

Other useful commands:

```powershell
chemicalist generate .\manifests\example.manifest.json --dry-run
chemicalist validate .\manifests\example.manifest.json --json
chemicalist list --out .\chemicalist.backend
chemicalist --version
```

## Run the generated app

### Local development

```powershell
cd .\chemicalist.backend
Copy-Item .env.example .env
npm run db:generate
npm run db:migrate       # PostgreSQL
npm run db:seed
npm run start:dev
```

For MongoDB, use `npm run db:push` instead of migrations. MongoDB must run as a
replica set for Prisma transactions; the generated Compose stack initializes a
single-node `rs0` replica set, and the local connection URL includes
`?replicaSet=rs0`. The admin frontend is a separate project:

```powershell
cd ..\chemicalist.frontend
npm run dev
```

The generated default super administrator is:

```text
Username: admin
Password: Admin@123456
```

The seed also creates the super-admin role and grants it every generated
platform and business permission. These are development credentials: change
`BOOTSTRAP_ADMIN_PASSWORD` in the backend `.env` before running the seed in any
shared or exposed environment. The frontend login accepts either username or
email.

### Docker

The backend contains a Dockerfile, `.dockerignore`, and a Compose stack for the
selected database and enabled services. If `outputs.webservice` is enabled:

```powershell
cd .\chemicalist.backend
Copy-Item .env.example .env
docker compose up --build
```

Compose uses the internal service hostname. Set `DATABASE_URL_DOCKER` in the
backend `.env` to override its default connection string. The frontend project
also has its own Dockerfile and can be built independently:

```powershell
cd ..\chemicalist.frontend
docker build -t inventory-suite-ui .
```

## Generated architecture

The backend separates platform concerns (`src/platform`), application
infrastructure (`src/infrastructure`), shared primitives (`src/shared`), and
business modules (`src/labs/<lab>/studios/<studio>`). It includes identity,
authentication, authorization/RBAC, audit, tenancy, validation, repositories,
tenant-scoped geographic locations, validation, repositories, and optional
transport capabilities.

The admin frontend is an independent Next.js App Router project with login,
authenticated layout, navigation, dashboard, generated model CRUD screens,
shared API client/components, responsive styling, and configurable design
tokens. Both projects have separate package manifests, Git ignores, and Docker
builds.

### Identity, authentication, authorization, tenancy, and locations

The generated auth endpoints are under `/api/v1/platform/auth`: `POST login`,
`POST refresh`, `POST logout`, `GET me`, and the email/mobile verification
endpoints. `GET sessions`, `DELETE sessions/:sessionId`, `POST logout-all`, and
`POST change-password` provide session and credential management. Access tokens
are bound to a persisted session; revoked sessions, disabled users, and changed
permissions take effect on the next request. Refresh tokens are stored as hashes
and rotated when refreshed. Set a unique `JWT_SECRET` of at least 32 characters
before using a production environment.

Identity and RBAC management endpoints are under `/api/v1/platform/identity`.
They include user/profile/device operations, roles, role groups, permission
groups, the permission catalogue, role assignments, and role-permission
management. `PUT roles/:roleKey/permissions`,
`PUT role-groups/:groupKey/roles`, and
`PUT permission-groups/:groupKey/permissions` replace grants atomically;
`DELETE users/:id/roles/:roleKey` and
`DELETE users/:id/role-groups/:groupKey` revoke assignments. Tenant-bound
callers are restricted to their tenant; only platform administrators can choose
another tenant or manage tenant creation. Permission checks use current database
grants rather than trusting privilege claims embedded in old access tokens.

Geographic records are tenant-owned and managed under
`/api/v1/platform/locations`: countries, regions, and cities can be created and
listed, and their parent-child relationships are checked. Authenticated users
can manage only their own addresses at `/api/v1/platform/locations/me/addresses`.
An address must reference an active country/region/city chain in the caller's
tenant. The generated system provides the schema and APIs; it does not bundle
a country/city dataset.

Audit records are written for HTTP actions, including failed authorization,
and non-platform administrators can only query records for their own tenant.
Sensitive request bodies and tokens are not copied into audit metadata.

Generated list endpoints support pagination, free-text search, typed filters,
AND/OR filter mode, and multiple sort keys. A query can use JSON filters and a
comma-separated sort, for example:

```text
GET /api/v1/products?page=2&pageSize=25&filterMode=or
  &filters={"name":{"contains":"widget"},"price":{"gte":10}}
  &sort=name:asc,createdAt:desc
```

Sort fields are limited by the manifest's `sort` entry. `sortBy` and `sortDir`
remain available for a single sort key. Generated repositories include
`createOne`, `createMany`, `updateOne`, `updateMany`, hard/soft delete and
restore operations, `getOneById`, `getAll`, `search`, duplicate/relation
checks, existence checks, and manifest-defined custom methods.

## Development and tests

From `gen/`:

```powershell
npm test
npm run validate:example
```

The generation tests verify manifest validation, DTO and query contracts,
repository methods, tenant-aware platform modules, location models/APIs,
RBAC/audit behavior, seeding assets, Docker output, and UI theme customization.
