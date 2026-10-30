"use strict";

/**
 * Shared/application-level backend files: build config, bootstrap, shared
 * kernel, database, platform capabilities and the app module.
 */

const { capabilityEnv } = require("../../engine/capabilities");
const { pascal } = require("../../engine/naming");

const NODE_VERSION = ">=20";

// ---------------------------------------------------------------------------
// Build / project configuration
// ---------------------------------------------------------------------------

function tsconfig() {
  return JSON.stringify(
    {
      compilerOptions: {
        module: "commonjs",
        declaration: false,
        removeComments: true,
        emitDecoratorMetadata: true,
        experimentalDecorators: true,
        allowSyntheticDefaultImports: true,
        esModuleInterop: true,
        target: "ES2022",
        sourceMap: true,
        outDir: "./dist",
        baseUrl: "./",
        incremental: true,
        skipLibCheck: true,
        strict: true,
        strictPropertyInitialization: true,
        noImplicitAny: true,
        noUnusedLocals: false,
        forceConsistentCasingInFileNames: true,
        noFallthroughCasesInSwitch: true,
      },
      include: ["src/**/*", "prisma/**/*"],
    },
    null,
    2,
  );
}

function tsconfigBuild() {
  return JSON.stringify(
    {
      extends: "./tsconfig.json",
      exclude: ["node_modules", "dist", "test", "frontend", "**/*.spec.ts"],
    },
    null,
    2,
  );
}

function nestCli() {
  return JSON.stringify(
    {
      $schema: "https://json.schemastore.org/nest-cli",
      collection: "@nestjs/schematics",
      sourceRoot: "src",
      compilerOptions: { deleteOutDir: true },
    },
    null,
    2,
  );
}

function scripts(ctx) {
  const databaseScripts = ctx.persistence.database === "mongodb"
    ? {
        "db:push": "prisma db push",
        "db:sync": "npm run db:push && npm run db:generate",
      }
    : {
        "db:migrate": "prisma migrate dev",
        "db:deploy": "prisma migrate deploy",
        "db:status": "prisma migrate status",
      };
  return {
    build: "nest build",
    start: "nest start",
    "start:dev": "nest start --watch",
    "start:prod": "node dist/main.js",
    "db:generate": "prisma generate",
    "db:validate": "prisma validate",
    "db:studio": "prisma studio",
    "db:seed": "prisma db seed",
    ...databaseScripts,
    "ui:install": "npm --prefix frontend install",
    "ui:dev": "npm --prefix frontend run dev",
    "ui:build": "npm --prefix frontend run build",
    test: "jest",
  };
}

function jestConfig() {
  return JSON.stringify(
    {
      moduleFileExtensions: ["js", "json", "ts"],
      rootDir: "src",
      testRegex: ".*\\.spec\\.ts$",
      transform: { "^.+\\.(t|j)s$": "ts-jest" },
      testEnvironment: "node",
      moduleNameMapper: {
        "^nestjs-zod$": "<rootDir>/../node_modules/nestjs-zod",
      },
    },
    null,
    2,
  );
}

function packageJson(ctx) {
  // The platform layer is always part of an application, so its runtime
  // dependencies are unconditional: identity/authentication is core.
  const deps = {
    "@nestjs/common": "^11.1.0",
    "@nestjs/core": "^11.1.0",
    "@nestjs/platform-express": "^11.1.0",
    "@nestjs/config": "^4.0.0",
    "@nestjs/jwt": "^11.0.0",
    "@prisma/client": "^6.16.0",
    "bcryptjs": "^3.0.2",
    "reflect-metadata": "^0.2.2",
    rxjs: "^7.8.2",
    zod: "^4.0.0",
    "nestjs-zod": "^5.5.0",
  };
  if (ctx.has("cache")) {
    deps["@nestjs/cache-manager"] = "^3.0.0";
    deps["cache-manager"] = "^7.0.0";
    deps["@keyv/redis"] = "^5.0.0";
  }
  if (ctx.has("messaging")) {
    deps.amqplib = "^0.10.4";
    deps["@nestjs/schedule"] = "^6.1.3";
  }

  const devDeps = {
    "@nestjs/cli": "^11.0.0",
    "@nestjs/testing": "^11.1.0",
    "@types/express": "^5.0.0",
    "@types/jest": "^29.5.14",
    "@types/node": "^22.10.0",
    jest: "^29.7.0",
    prisma: "^6.16.0",
    "ts-jest": "^29.2.5",
    "ts-node": "^10.9.2",
    typescript: "~5.9.2",
  };
  if (ctx.has("messaging")) devDeps["@types/amqplib"] = "^0.10.6";
  const dockerDatabaseSetup =
    ctx.persistence.database === "mongodb" ? "db:push" : "db:migrate";

  return JSON.stringify(
    {
      name: ctx.app.name + "-backend",
      version: "1.0.0",
      private: true,
      description:
        ctx.app.description ||
        "Chemicalist modular-monolith backend generated from manifests",
      license: "UNLICENSED",
      scripts: {
        ...scripts(ctx),
        "docker:setup":
          "npm run db:generate && npm run " +
          dockerDatabaseSetup +
          " && npm run db:seed",
      },
      dependencies: deps,
      devDependencies: devDeps,
      jest: JSON.parse(jestConfig()),
      prisma: { seed: "ts-node prisma/seed.ts" },
      engines: { node: NODE_VERSION },
    },
    null,
    2,
  );
}

function gitignore() {
  return [
    "node_modules/",
    "dist/",
    "coverage/",
    ".env",
    ".env.local",
    ".env.*.local",
    "*.log",
    ".DS_Store",
    "frontend/node_modules/",
    "frontend/dist/",
    "",
  ].join("\n");
}

function envExample(ctx) {
  const databaseUrl =
    ctx.persistence.database === "mongodb"
      ? "mongodb://localhost:27017/" + ctx.app.name.replace(/-/g, "_") + "?replicaSet=rs0"
      : "postgresql://localhost:5432/" +
        ctx.app.name.replace(/-/g, "_") +
        "?schema=" +
        ctx.persistence.schema;
  const lines = [
    "# Generated by chemicalist — copy to .env and adjust.",
    "NODE_ENV=development",
    "PORT=" + ctx.app.api.port,
    "DATABASE_URL=postgresql://postgres:postgres@localhost:5432/" +
      ctx.app.name.replace(/-/g, "_") +
      "?schema=" +
      ctx.persistence.schema,
    "CORS_ORIGIN=" + ctx.app.api.corsOrigin,
    "BOOTSTRAP_ADMIN_USERNAME=admin",
    "BOOTSTRAP_ADMIN_EMAIL=admin@chemicalist.local",
    "BOOTSTRAP_ADMIN_PASSWORD=Admin@123456",
    ...(ctx.app.hasVersioning ? ["API_VERSION=" + ctx.app.api.version] : []),
    "LOG_LEVEL=info",
  ];
  const capabilityVars = capabilityEnv(ctx.capabilities);
  for (const [key, value] of Object.entries(capabilityVars)) {
    lines.push(key + "=" + value);
  }
  if (ctx.services.elasticsearch) lines.push("ELASTICSEARCH_URL=http://localhost:9200");
  const databaseUrlIndex = lines.findIndex((line) => line.startsWith("DATABASE_URL="));
  if (databaseUrlIndex >= 0) lines[databaseUrlIndex] = "DATABASE_URL=" + databaseUrl;
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Prisma support files
// ---------------------------------------------------------------------------

function prismaConfig(ctx) {
  const defaultUrl =
    ctx.persistence.database === "mongodb"
      ? "mongodb://localhost:27017/" + ctx.app.name.replace(/-/g, "_") + "?replicaSet=rs0"
      : "postgresql://localhost:5432/postgres?schema=" + ctx.persistence.schema;
  return [
    "import { defineConfig, env } from 'prisma/config';",
    "",
    "export default defineConfig({",
    "  schema: 'prisma/schema.prisma',",
    ...(ctx.persistence.database === "mongodb"
      ? []
      : ["  migrations: {", "    path: 'prisma/migrations',", "  },"]),
    "  // `prisma generate` (build/postinstall) must not require a database connection.",
    "  datasource: {",
    "    url: process.env.DATABASE_URL ?? env('DATABASE_URL') ?? 'postgresql://postgres:postgres@localhost:5432/postgres?schema=public',",
    "  },",
    "});",
    "",
  ].join("\n").replace(
    /url: process\.env\.DATABASE_URL[^\n]*/,
    "url: process.env.DATABASE_URL ?? env('DATABASE_URL') ?? " +
      JSON.stringify(defaultUrl) +
      ",",
  );
}

function seedScript() {
  return [
    "import { PrismaClient } from '@prisma/client';",
    "import { hash } from 'bcryptjs';",
    "import { ALL_PERMISSION_KEYS } from '../src/platform/authorization/permission-catalog';",
    "",
    "const prisma = new PrismaClient();",
    "",
    "async function main(): Promise<void> {",
    "  const username = (process.env.BOOTSTRAP_ADMIN_USERNAME ?? 'admin').toLowerCase();",
    "  const email = (process.env.BOOTSTRAP_ADMIN_EMAIL ?? 'admin@chemicalist.local').toLowerCase();",
    "  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? 'Admin@123456';",
    "  const tenantSlug = process.env.BOOTSTRAP_TENANT_SLUG ?? 'default';",
    "  const tenant = await prisma.chemicalistTenant.upsert({",
    "    where: { slug: tenantSlug },",
    "    update: {},",
    "    create: { slug: tenantSlug, name: process.env.BOOTSTRAP_TENANT_NAME ?? 'Default Tenant' },",
    "  });",
    "  const existing = await prisma.chemicalistUser.findFirst({",
    "    where: { OR: [{ email }, { username }] },",
    "  });",
    "  if (existing && existing.email !== email) {",
    "    throw new Error('Bootstrap username is assigned to a different email address');",
    "  }",
    "  const passwordHash = await hash(password, 12);",
    "  const resetPassword = process.env.BOOTSTRAP_ADMIN_RESET_PASSWORD === 'true';",
    "  const admin = existing",
    "    ? await prisma.chemicalistUser.update({",
    "        where: { id: existing.id },",
    "        data: { username, ...(resetPassword ? { passwordHash } : {}), isPlatformAdmin: true, tenantId: tenant.id },",
    "      })",
    "    : await prisma.chemicalistUser.create({",
    "        data: { username, email, passwordHash, displayName: 'Super Administrator', isPlatformAdmin: true, tenantId: tenant.id },",
    "      });",
    "  let role = await prisma.chemicalistRole.findFirst({ where: { key: 'super-admin', tenantId: tenant.id } });",
    "  if (!role) {",
    "    role = await prisma.chemicalistRole.create({",
    "      data: { key: 'super-admin', name: 'Super Administrator', tenantId: tenant.id, isSystem: true },",
    "    });",
    "  }",
    "  for (const key of ALL_PERMISSION_KEYS) {",
    "    const permission = await prisma.chemicalistPermission.upsert({ where: { key }, update: {}, create: { key } });",
    "    await prisma.chemicalistRolePermission.upsert({",
    "      where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },",
    "      update: {},",
    "      create: { roleId: role.id, permissionId: permission.id },",
    "    });",
    "  }",
    "  await prisma.chemicalistUserRole.upsert({",
    "    where: { userId_roleId: { userId: admin.id, roleId: role.id } },",
    "    update: {},",
    "    create: { userId: admin.id, roleId: role.id, tenantId: tenant.id },",
    "  });",
    "  const credential = await prisma.chemicalistUserCredential.findFirst({ where: { userId: admin.id, type: 'PASSWORD' } });",
    "  if (credential) {",
    "    await prisma.chemicalistUserCredential.update({ where: { id: credential.id }, data: { identifier: email, secretHash: admin.passwordHash } });",
    "  } else {",
    "    await prisma.chemicalistUserCredential.create({",
    "      data: { userId: admin.id, type: 'PASSWORD', provider: 'local', identifier: email, secretHash: admin.passwordHash },",
    "    });",
    "  }",
    "  console.log('Seeded super administrator username: ' + username);",
    "  if (password === 'Admin@123456') console.warn('Change the default administrator password before exposing this app to a network.');",
    "}",
    "",
    "main()",
    "  .catch((error) => {",
    "    console.error(error);",
    "    process.exitCode = 1;",
    "  })",
    "  .finally(async () => {",
    "    await prisma.$disconnect();",
    "  });",
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function dockerfile(ctx) {
  return `FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./prisma.config.ts
EXPOSE ${ctx.app.api.port}
CMD ["node", "dist/main.js"]
`;
}

function dockerCompose(ctx) {
  const services = {};
  const database = ctx.persistence.database === "mongodb" ? "mongodb" : "postgres";
  if (database === "mongodb") {
    services.mongodb = {
      image: "mongo:8",
      restart: "unless-stopped",
      command: ["mongod", "--replSet", "rs0", "--bind_ip_all"],
      ports: ["27017:27017"],
      volumes: ["mongodb-data:/data/db"],
      healthcheck: {
        test: ["CMD", "mongosh", "--quiet", "--eval", "db.adminCommand('ping').ok"],
        interval: "5s",
        timeout: "5s",
        retries: 20,
      },
    };
    services["mongodb-replica-init"] = {
      image: "mongo:8",
      depends_on: { mongodb: { condition: "service_healthy" } },
      entrypoint: [
        "mongosh",
        "mongodb://mongodb:27017/admin",
        "--quiet",
        "--eval",
        "try { rs.status() } catch (error) { rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: 'mongodb:27017' }] }) }",
      ],
      restart: "no",
    };
  } else {
    services.postgres = {
      image: "postgres:17-alpine",
      restart: "unless-stopped",
      environment: {
        POSTGRES_USER: "${POSTGRES_USER:-chemicalist}",
        POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:-chemicalist}",
        POSTGRES_DB: "${POSTGRES_DB:-chemicalist}",
      },
      ports: ["5432:5432"],
      volumes: ["postgres-data:/var/lib/postgresql/data"],
      healthcheck: {
        test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"],
        interval: "5s",
        timeout: "5s",
        retries: 20,
      },
    };
  }
  if (ctx.has("cache")) {
    services.redis = {
      image: "redis:7-alpine",
      restart: "unless-stopped",
      ports: ["6379:6379"],
      volumes: ["redis-data:/data"],
    };
  }
  if (ctx.has("messaging")) {
    services.rabbitmq = {
      image: "rabbitmq:4-management-alpine",
      restart: "unless-stopped",
      ports: ["5672:5672", "15672:15672"],
      volumes: ["rabbitmq-data:/var/lib/rabbitmq"],
    };
  }
  if (ctx.services.elasticsearch) {
    services.elasticsearch = {
      image: "docker.elastic.co/elasticsearch/elasticsearch:8.17.0",
      environment: {
        discovery_type: "single-node",
        "xpack.security.enabled": "false",
        ES_JAVA_OPTS: "-Xms512m -Xmx512m",
      },
      ports: ["9200:9200"],
      volumes: ["elasticsearch-data:/usr/share/elasticsearch/data"],
    };
  }
  const dependencies = Object.fromEntries(
    Object.keys(services).map((name) => [
      name,
      {
        condition:
          name === "mongodb-replica-init"
            ? "service_completed_successfully"
            : ["postgres", "mongodb"].includes(name)
              ? "service_healthy"
              : "service_started",
      },
    ]),
  );
  const dockerEnvironment = {
    DATABASE_URL:
      "${DATABASE_URL_DOCKER:-" +
      (database === "mongodb"
        ? "mongodb://mongodb:27017/" + ctx.app.name.replace(/-/g, "_") + "?replicaSet=rs0"
        : "postgresql://chemicalist:chemicalist@postgres:5432/chemicalist?schema=" +
          ctx.persistence.schema) +
      "}",
  };
  if (ctx.has("cache")) dockerEnvironment.REDIS_URL = "${REDIS_URL_DOCKER:-redis://redis:6379}";
  if (ctx.has("messaging")) dockerEnvironment.RABBITMQ_URL = "${RABBITMQ_URL_DOCKER:-amqp://guest:guest@rabbitmq:5672}";
  if (ctx.services.elasticsearch) dockerEnvironment.ELASTICSEARCH_URL = "http://elasticsearch:9200";
  services.api = {
    build: { context: ".", dockerfile: "Dockerfile" },
    restart: "unless-stopped",
    env_file: [".env"],
    environment: dockerEnvironment,
    command: [
      "sh",
      "-c",
      "npx prisma db push && npm run db:seed && node dist/main.js",
    ],
    ports: ["${PORT:-" + ctx.app.api.port + "}:" + ctx.app.api.port],
    depends_on: dependencies,
  };
  const volumes = Object.keys(services)
    .filter((name) => ["postgres", "mongodb", "redis", "rabbitmq", "elasticsearch"].includes(name))
    .map((name) => name + "-data");
  return JSON.stringify(
    {
      services,
      ...(volumes.length ? { volumes: Object.fromEntries(volumes.map((name) => [name, null])) } : {}),
    },
    null,
    2,
  ) + "\n";
}

// ---------------------------------------------------------------------------
// Shared kernel
// ---------------------------------------------------------------------------

function sharedCommon() {
  return `/**
 * Standard API error payload returned by the global exception filter.
 */
export interface ApiErrorBody {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
  path: string;
  timestamp: string;
  requestId?: string;
}
`;
}

function sharedJsonType() {
  return `/** JSON-compatible value used by \`json\` manifest fields. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}
`;
}

function sharedPagination() {
  return `/** Generic pagination envelope returned by every list endpoint. */
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
`;
}

function sharedResult() {
  return `/** Lightweight operation result for use cases that need explicit failure reasons. */
export type OperationResult<T, E = { code: string; message: string }> =
  | { success: true; data: T }
  | { success: false; error: E };
`;
}

function sharedErrors() {
  return `import { HttpException, HttpStatus } from '@nestjs/common';

/** Raised when a resource is missing; rendered as 404 with a stable error code. */
export class ResourceNotFoundError extends HttpException {
  constructor(message = 'Resource not found') {
    super({ code: 'RESOURCE_NOT_FOUND', message }, HttpStatus.NOT_FOUND);
  }
}

/** Raised for business rule violations; rendered as 422. */
export class BusinessRuleViolationError extends HttpException {
  constructor(message: string, details?: unknown) {
    super({ code: 'BUSINESS_RULE_VIOLATION', message, details }, HttpStatus.UNPROCESSABLE_ENTITY);
  }
}

/** Raised when a tenant-scoped request has no verified tenant. */
export class TenantScopeViolationError extends HttpException {
  constructor(message = 'Tenant scope violation') {
    super({ code: 'TENANT_SCOPE_VIOLATION', message }, HttpStatus.FORBIDDEN);
  }
}

/** Raised when a unique constraint is violated. */
export class ConflictError extends HttpException {
  constructor(message = 'Resource already exists', details?: unknown) {
    super({ code: 'CONFLICT', message, details }, HttpStatus.CONFLICT);
  }
}
`;
}

function sharedFilters() {
  return `import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ApiErrorBody } from '../types/api-error';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';

/**
 * Converts every unhandled error into the stable ApiErrorBody shape.
 * Validation errors thrown by ZodValidationPipe keep their 400 status and issue list.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = (request.headers['x-request-id'] as string | undefined) ?? undefined;

    const body = this.toBody(exception, request.url, requestId);
    if (body.statusCode >= 500) {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }
    response.status(body.statusCode).json(body);
  }

  private toBody(exception: unknown, path: string, requestId?: string): ApiErrorBody {
    const base = { path, timestamp: new Date().toISOString(), requestId };

    if (exception instanceof PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        return {
          ...base,
          statusCode: HttpStatus.CONFLICT,
          code: 'CONFLICT',
          message: 'A record with the same unique value already exists',
          details: exception.meta,
        };
      }
      if (exception.code === 'P2025') {
        return { ...base, statusCode: HttpStatus.NOT_FOUND, code: 'RESOURCE_NOT_FOUND', message: 'Resource not found' };
      }
      if (exception.code === 'P2003') {
        return {
          ...base,
          statusCode: HttpStatus.CONFLICT,
          code: 'FOREIGN_KEY_CONSTRAINT',
          message: 'Referenced record does not exist or is still in use',
        };
      }
      return {
        ...base,
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        code: 'DATABASE_ERROR',
        message: 'Unexpected database error',
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      if (typeof payload === 'string') {
        return { ...base, statusCode: status, code: this.codeFor(status), message: payload };
      }
      const record = payload as Record<string, unknown>;
      const message =
        typeof record.message === 'string'
          ? record.message
          : Array.isArray(record.message)
            ? record.message.join('; ')
            : exception.message;
      return {
        ...base,
        statusCode: status,
        code: typeof record.code === 'string' ? record.code : this.codeFor(status),
        message,
        details: record.details ?? record.errors ?? undefined,
      };
    }

    if (exception instanceof Error) {
      return {
        ...base,
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        code: 'INTERNAL_ERROR',
        message: process.env.NODE_ENV === 'production' ? 'Internal server error' : exception.message,
      };
    }

    return {
      ...base,
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    };
  }

  private codeFor(status: number): string {
    switch (status) {
      case 400:
        return 'VALIDATION_FAILED';
      case 401:
        return 'UNAUTHENTICATED';
      case 403:
        return 'FORBIDDEN';
      case 404:
        return 'RESOURCE_NOT_FOUND';
      case 409:
        return 'CONFLICT';
      default:
        return status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED';
    }
  }
}
`;
}

function sharedValidationFilter() {
  return `import { Catch } from '@nestjs/common';
import { ZodValidationException } from 'nestjs-zod';
import { AllExceptionsFilter } from './all-exceptions.filter';

/** Maps Zod validation failures to a 400 response with a stable issue list. */
@Catch(ZodValidationException)
export class ZodValidationExceptionFilter extends AllExceptionsFilter {}
`;
}

function sharedRequestContext() {
  return `import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestIdentity {
  userId: string;
  sessionId?: string;
  email: string;
  roles: string[];
  tenantId?: string;
  isPlatformAdmin: boolean;
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestIdentity>();

/**
 * Request-scoped identity propagated through AsyncLocalStorage.
 * Guards write it; repositories read the tenant id from here (never from request data).
 */
export class RequestContext {
  static run<T>(identity: RequestIdentity, callback: () => T): T {
    return storage.run(identity, callback);
  }

  /**
   * Publishes the verified identity into the current request scope.
   * Guards call this *after* the request middleware opened the scope, so use
   * cases and repositories see the authenticated tenant.
   */
  static assign(identity: RequestIdentity): void {
    const current = storage.getStore();
    if (current) Object.assign(current, identity);
    else storage.run(identity, () => undefined);
  }

  static get(): RequestIdentity | undefined {
    return storage.getStore();
  }

  static require(): RequestIdentity {
    const identity = storage.getStore();
    if (!identity) throw new Error('RequestContext is not available outside of an HTTP request');
    return identity;
  }

  static tenantId(): string | undefined {
    return storage.getStore()?.tenantId;
  }

  static userId(): string | undefined {
    return storage.getStore()?.userId;
  }

  static isPlatformAdmin(): boolean {
    return storage.getStore()?.isPlatformAdmin === true;
  }
}
`;
}

function sharedRequestId() {
  return `import { randomUUID } from 'node:crypto';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/** Ensures every request has a correlation id that is echoed back in the response. */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.headers['x-request-id'];
    const requestId = Array.isArray(incoming) ? incoming[0] : incoming || randomUUID();
    req.headers['x-request-id'] = requestId;
    res.setHeader('x-request-id', requestId);
    next();
  }
}
`;
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

function prismaService() {
  return `import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/** Prisma lifecycle management shared by the whole application (global module). */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Prisma connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
`;
}

function databaseModule() {
  return `import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class DatabaseModule {}
`;
}

function unitOfWork() {
  return `import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PrismaService } from './prisma.service';

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');

export interface UnitOfWork {
  execute<T>(work: () => Promise<T>): Promise<T>;
  currentClient(): Prisma.TransactionClient | undefined;
}

/**
 * Prisma-backed unit of work.
 *
 * The active \`Prisma.TransactionClient\` is published through AsyncLocalStorage so
 * that repositories participating in the same unit of work issue their queries on
 * the transaction client instead of the root Prisma client.
 */
@Injectable()
export class UnitOfWorkService implements UnitOfWork {
  private readonly storage = new AsyncLocalStorage<Prisma.TransactionClient>();

  constructor(private readonly prisma: PrismaService) {}

  async execute<T>(work: () => Promise<T>): Promise<T> {
    if (this.storage.getStore()) {
      // Nested calls join the enclosing transaction instead of opening a new one.
      return work();
    }
    return this.prisma.$transaction(
      (tx: Prisma.TransactionClient) => this.storage.run(tx, work),
      { maxWait: 5_000, timeout: 30_000 },
    );
  }

  currentClient(): Prisma.TransactionClient | undefined {
    return this.storage.getStore();
  }

  /** Resolves to the transaction client when inside \`execute\`, otherwise the root client. */
  client(): Prisma.TransactionClient {
    return this.storage.getStore() ?? this.prisma;
  }
}
`;
}

function unitOfWorkModule() {
  return `import { Global, Module } from '@nestjs/common';
import { UNIT_OF_WORK, UnitOfWorkService } from './unit-of-work.service';

@Global()
@Module({
  providers: [UnitOfWorkService, { provide: UNIT_OF_WORK, useExisting: UnitOfWorkService }],
  exports: [UnitOfWorkService, UNIT_OF_WORK],
})
export class UnitOfWorkModule {}
`;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function configFiles(ctx) {
  const corsOrigin = ctx.app.api.corsOrigin;
  return `import { z } from 'zod';

/**
 * Environment configuration. Unknown or invalid values fail fast at startup.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(${ctx.app.api.port}),
  DATABASE_URL: z
    .string()
    .min(1)
    .default('postgresql://postgres:postgres@localhost:5432/postgres?schema=${ctx.persistence.schema}'),
  CORS_ORIGIN: z.string().default('${corsOrigin}'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
${ctx.has("cache") ? "  REDIS_URL: z.string().default('redis://localhost:6379'),\n" : ""}${ctx.has("messaging") ? "  RABBITMQ_URL: z.string().default('amqp://guest:guest@localhost:5672'),\n" : ""}${ctx.has("jwt") ? "  JWT_SECRET: z.string().min(16).default('change-me-in-production'),\n  JWT_EXPIRES_IN: z.string().default('1h'),\n  BOOTSTRAP_USER_EMAIL: z.string().email().optional().or(z.literal('')),\n  BOOTSTRAP_USER_PASSWORD: z.string().min(8).optional().or(z.literal('')),\n" : ""}${ctx.app.hasVersioning ? "  API_VERSION: z.string().default('" + ctx.app.api.version + "'),\n" : ""}
});

export type AppEnv = z.infer<typeof EnvSchema>;

export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const result = EnvSchema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => \`  - \${issue.path.join('.')}: \${issue.message}\`)
      .join('\\n');
    throw new Error('Invalid environment configuration:\\n' + issues);
  }
  return { ...config, ...result.data };
}

export const APP_CONFIG = 'APP_CONFIG';
export const appConfig = () => EnvSchema.parse(process.env);
`;
}

function configModule() {
  return `import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { validateEnv } from './env.schema';

@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['.env', '.env.local'],
      validate: validateEnv,
    }),
  ],
})
export class StaticConfigModule {}
`;
}

// ---------------------------------------------------------------------------
// Platform capabilities
// ---------------------------------------------------------------------------

function cacheModule() {
  return `import { CacheModule, type CacheModuleOptions } from '@nestjs/cache-manager';
import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createKeyv } from '@keyv/redis';

/**
 * Redis-backed cache. If Redis is unreachable the cache degrades gracefully
 * (Keyv retries in the background) instead of taking the API down.
 */
@Module({
  imports: [
    CacheModule.registerAsync({
      isGlobal: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService): CacheModuleOptions => {
        const url = config.get<string>('REDIS_URL') ?? 'redis://localhost:6379';
        Logger.log('Cache backend: Redis at ' + url, 'CacheModule');
        return {
          stores: [createKeyv(url, { namespace: 'chemicalist' })],
          ttl: 15_000,
        };
      },
    }),
  ],
})
export class CacheInfrastructureModule {}
`;
}

function messagingFiles(hasOutbox) {
  return {
    rabbitConnection: `import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { connect, type ChannelModel, type ConfirmChannel, type Options } from 'amqplib';

export const EXCHANGE = 'chemicalist.events';
export const DEAD_LETTER_EXCHANGE = 'chemicalist.events.dlx';

/**
 * Owns the AMQP connection/channel and reconnects automatically.
 * Tracking records are only reported as published when the broker confirms them.
 */
@Injectable()
export class RabbitConnection implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitConnection.name);
  private connection?: ChannelModel;
  private channel?: ConfirmChannel;
  private closing = false;
  private reconnectTimer?: NodeJS.Timeout;
  private ready: Promise<void>;

  constructor(private readonly config: ConfigService) {
    this.ready = new Promise((resolve) => {
      (this.resolveReady as unknown as () => void) = resolve;
    });
  }

  private resolveReady?: () => void;

  async onModuleInit(): Promise<void> {
    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    clearTimeout(this.reconnectTimer);
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }

  /** Resolves when the channel is available (used by background dispatchers). */
  whenReady(): Promise<void> {
    return this.channel ? Promise.resolve() : this.ready;
  }

  getChannel(): ConfirmChannel | undefined {
    return this.channel;
  }

  private async connect(): Promise<void> {
    const url = this.config.get<string>('RABBITMQ_URL') ?? 'amqp://guest:guest@localhost:5672';
    try {
      this.connection = await connect(url);
      this.connection.on('error', (error) => this.logger.warn('AMQP connection error: ' + error.message));
      this.connection.on('close', () => this.scheduleReconnect());
      const channel = await this.connection.createConfirmChannel();
      await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
      await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'topic', { durable: true });
      this.channel = channel;
      this.logger.log('RabbitMQ connected');
      this.resolveReady?.();
    } catch (error) {
      this.logger.warn('RabbitMQ unavailable, retrying in 5s: ' + (error as Error).message);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closing) return;
    this.channel = undefined;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => void this.connect(), 5_000);
    this.reconnectTimer.unref?.();
  }

  async assertQueue(queue: string, handler: (message: Buffer) => Promise<void>): Promise<void> {
    const channel = this.channel;
    if (!channel) return;
    await channel.assertQueue(queue, {
      durable: true,
      deadLetterExchange: DEAD_LETTER_EXCHANGE,
      deadLetterRoutingKey: queue + '.failed',
      arguments: { 'x-max-priority': 10 },
    } satisfies Options.AssertQueue);
    await channel.consume(queue, (message) => {
      if (!message) return;
      handler(message.content)
        .then(() => channel.ack(message))
        .catch((error: Error) => {
          this.logger.error('Consumer failed for ' + queue + ': ' + error.message);
          channel.nack(message, false, false);
        });
    });
  }
}
`,
    rabbitPublisher: `import { Injectable, Logger } from '@nestjs/common';
import { EXCHANGE, RabbitConnection } from './rabbit.connection';

export interface BrokerEnvelope {
  eventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  tenantId?: string | null;
  occurredAt: string;
  payload: unknown;
}

/** Publishes integration events to the topic exchange with publisher confirms. */
@Injectable()
export class RabbitPublisher {
  private readonly logger = new Logger(RabbitPublisher.name);

  constructor(private readonly rabbit: RabbitConnection) {}

  async publish(routingKey: string, message: BrokerEnvelope): Promise<void> {
    const channel = this.rabbit.getChannel();
    if (!channel) throw new Error('RabbitMQ channel is not available');
    const body = Buffer.from(JSON.stringify(message));
    await new Promise<void>((resolve, reject) => {
      channel.publish(
        EXCHANGE,
        routingKey,
        body,
        { persistent: true, contentType: 'application/json', messageId: message.eventId, timestamp: Date.now() },
        (error) => (error ? reject(error) : resolve()),
      );
    });
    this.logger.debug('Published ' + message.eventType + ' (' + message.eventId + ')');
  }
}
`,
    messagingModule: `import { Module } from '@nestjs/common';
import { RabbitConnection } from './rabbit.connection';
import { RabbitPublisher } from './rabbit.publisher';

@Module({
  providers: [RabbitConnection, RabbitPublisher],
  exports: [RabbitConnection, RabbitPublisher],
})
export class MessagingInfrastructureModule {}
${hasOutbox ? "" : ""}`,
  };
}

function outboxFiles() {
  return {
    outboxService: `import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { UnitOfWorkService } from '../../../infrastructure/database/unit-of-work.service';
import { RequestContext } from '../../../shared/context/request-context';
import type { DomainEvent } from '../contracts/domain-event';

/**
 * Transactional outbox.
 *
 * \`record\` writes the outbox row on the *current* transaction client, so the
 * business change and the message commit (or roll back) together.
 */
@Injectable()
export class OutboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly unitOfWork: UnitOfWorkService,
  ) {}

  async record(event: DomainEvent, options: { client?: unknown } = {}): Promise<void> {
    const client = (options.client as typeof this.prisma | undefined) ?? this.unitOfWork.client();
    await client.chemicalistOutboxMessage.create({
      data: {
        eventId: event.eventId,
        eventType: event.eventType,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        tenantId: RequestContext.tenantId() ?? null,
        payload: JSON.parse(JSON.stringify(event.payload ?? {})) as Prisma.InputJsonValue,
        occurredAt: event.occurredAt,
      },
    });
  }

  /** Convenience wrapper: run business work and outbox writes atomically. */
  async transactional<T>(work: (record: (event: DomainEvent) => Promise<void>) => Promise<T>): Promise<T> {
    return this.unitOfWork.execute(() => work((event) => this.record(event)));
  }

  /** Marks a message as published (used by the dispatcher). */
  static newId(): string {
    return randomUUID();
  }
}
`,
    dispatcher: `import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { RabbitPublisher } from '../messaging/rabbit.publisher';
import { RabbitConnection } from '../messaging/rabbit.connection';

const INTERVAL_MS = 2_000;
const BATCH_SIZE = 20;
const MAX_ATTEMPTS = 8;

/**
 * Polls pending outbox rows and publishes them to RabbitMQ.
 * Failures are retried with exponential backoff; exhausting retries parks the
 * message with status FAILED so it can be inspected instead of being lost.
 */
@Injectable()
export class OutboxDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxDispatcher.name);
  private stopped = false;
  private running = false;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly publisher: RabbitPublisher,
    private readonly rabbit: RabbitConnection,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.dispatchOnce(), INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  async dispatchOnce(): Promise<number> {
    if (this.running || this.stopped) return 0;
    this.running = true;
    let published = 0;
    try {
      if (!this.rabbit.getChannel()) return 0;
      const messages = await this.prisma.chemicalistOutboxMessage.findMany({
        where: { status: 'PENDING', availableAt: { lte: new Date() } },
        orderBy: { createdAt: 'asc' },
        take: BATCH_SIZE,
      });

      for (const message of messages) {
        try {
          await this.publisher.publish(message.aggregateType + '.' + message.eventType, {
            eventId: message.eventId,
            eventType: message.eventType,
            aggregateType: message.aggregateType,
            aggregateId: message.aggregateId,
            tenantId: message.tenantId,
            occurredAt: message.occurredAt.toISOString(),
            payload: message.payload,
          });
          await this.prisma.chemicalistOutboxMessage.update({
            where: { id: message.id },
            data: { status: 'PUBLISHED', publishedAt: new Date() },
          });
          published += 1;
        } catch (error) {
          const attempts = message.attempts + 1;
          await this.prisma.chemicalistOutboxMessage.update({
            where: { id: message.id },
            data: {
              attempts,
              status: attempts >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING',
              lastError: (error as Error).message.slice(0, 2000),
              availableAt: new Date(Date.now() + Math.min(60_000, 2 ** attempts * 250)),
            },
          });
        }
      }
    } finally {
      this.running = false;
    }
    return published;
  }
}
`,
    outboxModule: `import { Module } from '@nestjs/common';
import { OutboxService } from './outbox.service';
import { OutboxDispatcher } from './outbox.dispatcher';
import { MessagingInfrastructureModule } from '../messaging/messaging.module';

@Module({
  imports: [MessagingInfrastructureModule],
  providers: [OutboxService, OutboxDispatcher],
  exports: [OutboxService],
})
export class OutboxModule {}
`,
  };
}

function inboxFiles() {
  return {
    inboxService: `import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { UnitOfWorkService } from '../../../infrastructure/database/unit-of-work.service';
import { Prisma } from '@prisma/client';

/**
 * Inbox / idempotent consumer.
 *
 * The processed-message marker and the side effect are committed in the same
 * transaction; a redelivered message with the same id is skipped.
 */
@Injectable()
export class InboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly unitOfWork: UnitOfWorkService,
  ) {}

  async processOnce(
    consumer: string,
    message: { eventId: string; payload: unknown },
    handler: (payload: unknown) => Promise<void>,
  ): Promise<boolean> {
    const alreadyProcessed = await this.prisma.chemicalistProcessedMessage.findUnique({
      where: { consumer_messageId: { consumer, messageId: message.eventId } },
    });
    if (alreadyProcessed) return false;

    try {
      await this.unitOfWork.execute(async () => {
        await handler(message.payload);
        await this.unitOfWork.client().chemicalistProcessedMessage.create({
          data: { consumer, messageId: message.eventId },
        });
      });
      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // A concurrent delivery won the race: treat as duplicate.
        return false;
      }
      throw error;
    }
  }
}
`,
    inboxModule: `import { Global, Module } from '@nestjs/common';
import { InboxService } from './inbox.service';

@Global()
@Module({
  providers: [InboxService],
  exports: [InboxService],
})
export class InboxModule {}
`,
  };
}

function sagaFiles() {
  return {
    saga: `import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { UnitOfWorkService } from '../../../infrastructure/database/unit-of-work.service';

export type SagaStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'COMPENSATED';

export interface SagaStep<TContext> {
  readonly name: string;
  execute(context: TContext): Promise<void>;
  compensate?(context: TContext): Promise<void>;
}

export interface SagaDefinition<TContext> {
  readonly type: string;
  readonly steps: SagaStep<TContext>[];
  readonly maxAttempts?: number;
}

/**
 * Persisted saga orchestrator.
 *
 * State (current step, status, context, attempts) is stored in
 * \`chemicalist_saga_state\`.
 * Each step runs in its own transaction; if a step fails the executed steps are
 * compensated in reverse order and the saga is marked COMPENSATED/FAILED.
 */
@Injectable()
export class SagaOrchestrator {
  private readonly logger = new Logger(SagaOrchestrator.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly unitOfWork: UnitOfWorkService,
  ) {}

  async start<TContext extends Record<string, unknown>>(
    definition: SagaDefinition<TContext>,
    context: TContext,
  ): Promise<string> {
    const state = await this.prisma.chemicalistSagaState.create({
      data: {
        sagaType: definition.type,
        context: context as unknown as Prisma.InputJsonValue,
        status: 'RUNNING',
      },
    });
    await this.run(definition, state.id, context);
    return state.id;
  }

  /** Resumes a saga that failed transiently. */
  async resume<TContext extends Record<string, unknown>>(
    definition: SagaDefinition<TContext>,
    sagaId: string,
  ): Promise<void> {
    const state = await this.prisma.chemicalistSagaState.findUniqueOrThrow({ where: { id: sagaId } });
    if (state.status === 'COMPLETED' || state.status === 'COMPENSATED') return;
    await this.run(definition, sagaId, state.context as TContext, state.currentStep);
  }

  private async run<TContext extends Record<string, unknown>>(
    definition: SagaDefinition<TContext>,
    sagaId: string,
    context: TContext,
    startAt = 0,
  ): Promise<void> {
    const executed: SagaStep<TContext>[] = definition.steps.slice(0, startAt);
    for (let index = startAt; index < definition.steps.length; index += 1) {
      const step = definition.steps[index];
      try {
        await this.unitOfWork.execute(() => step.execute(context));
        executed.push(step);
        await this.prisma.chemicalistSagaState.update({
          where: { id: sagaId },
          data: {
            currentStep: index + 1,
            context: context as unknown as Prisma.InputJsonValue,
            status: 'RUNNING',
          },
        });
      } catch (error) {
        this.logger.error('Saga ' + definition.type + ' failed at step ' + step.name + ': ' + (error as Error).message);
        await this.compensate(executed, context);
        await this.prisma.chemicalistSagaState.update({
          where: { id: sagaId },
          data: {
            status: 'FAILED',
            lastError: (error as Error).message.slice(0, 2000),
            attempts: { increment: 1 },
          },
        });
        throw error;
      }
    }
    await this.prisma.chemicalistSagaState.update({ where: { id: sagaId }, data: { status: 'COMPLETED' } });
  }

  private async compensate<TContext>(steps: SagaStep<TContext>[], context: TContext): Promise<void> {
    for (const step of [...steps].reverse()) {
      if (!step.compensate) continue;
      try {
        await this.unitOfWork.execute(() => step.compensate!(context));
      } catch (error) {
        this.logger.error('Compensation failed for ' + step.name + ': ' + (error as Error).message);
      }
    }
  }
}
`,
    sagaModule: `import { Global, Module } from '@nestjs/common';
import { SagaOrchestrator } from './saga.orchestrator';

@Global()
@Module({
  providers: [SagaOrchestrator],
  exports: [SagaOrchestrator],
})
export class SagaModule {}
`,
  };
}

function securityFiles() {
  return {
    tokenService: `import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

export interface AccessTokenClaims {
  sub: string;
  email: string;
  roles: string[];
  tenantId?: string;
}

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async issue(claims: AccessTokenClaims): Promise<{ accessToken: string; expiresIn: string }> {
    const expiresIn = this.config.get<string>('JWT_EXPIRES_IN') ?? '1h';
    const accessToken = await this.jwt.signAsync(
      { ...claims, typ: 'access' },
      { secret: this.config.get<string>('JWT_SECRET'), expiresIn },
    );
    return { accessToken, expiresIn };
  }

  async verify(token: string): Promise<AccessTokenClaims> {
    const payload = await this.jwt.verifyAsync<Record<string, unknown>>(token, {
      secret: this.config.get<string>('JWT_SECRET'),
    });
    if (typeof payload.sub !== 'string' || !Array.isArray(payload.roles)) {
      throw new Error('Malformed token payload');
    }
    return {
      sub: payload.sub,
      email: String(payload.email ?? ''),
      roles: payload.roles.filter((role): role is string => typeof role === 'string'),
      tenantId: typeof payload.tenantId === 'string' ? payload.tenantId : undefined,
    };
  }
}
`,
    jwtGuard: `import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { RequestContext } from '../../../../shared/context/request-context';
import { TokenService } from '../jwt/token.service';

/**
 * Verifies the Bearer token and publishes the identity into AsyncLocalStorage.
 * Every studio controller enables it explicitly (see generated controllers).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly tokens: TokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user?: unknown }>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Missing bearer token' });
    }
    try {
      const claims = await this.tokens.verify(header.slice('Bearer '.length).trim());
      const identity = {
        userId: claims.sub,
        email: claims.email,
        roles: claims.roles,
        tenantId: claims.tenantId,
        requestId: String(request.headers['x-request-id'] ?? ''),
      };
      request.user = identity;
      RequestContext.run(identity, () => undefined);
      return true;
    } catch {
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Invalid or expired token' });
    }
  }
}
`,
    rolesGuard: `import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import { Reflector } from '@nestjs/core';

export const ROLES_KEY = 'required-roles';
/** Declares the roles allowed to call a handler. */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;
    const request = context.switchToHttp().getRequest<Request & { user?: { roles?: string[] } }>();
    const roles = request.user?.roles ?? [];
    if (!required.some((role) => roles.includes(role))) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Insufficient role' });
    }
    return true;
  }
}
`,
    authService: `import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { compare, hash } from 'bcryptjs';
import { TokenService } from './token.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Creates the bootstrap user from environment variables when it does not
   * exist yet. Without BOOTSTRAP_USER_EMAIL/PASSWORD no user is created.
   */
  async ensureBootstrapUser(): Promise<void> {
    const email = this.config.get<string>('BOOTSTRAP_USER_EMAIL');
    const password = this.config.get<string>('BOOTSTRAP_USER_PASSWORD');
    if (!email || !password) return;
    const existing = await this.prisma.chemicalistUser.findUnique({
      where: { email },
    });
    if (existing) return;
    await this.prisma.chemicalistUser.create({
      data: { email, passwordHash: await hash(password, 12), roles: ['admin'] },
    });
  }

  async login(email: string, password: string) {
    const user = await this.prisma.chemicalistUser.findUnique({
      where: { email },
    });
    if (!user || !(await compare(password, user.passwordHash))) {
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });
    }
    return this.tokens.issue({
      sub: user.id,
      email: user.email,
      roles: user.roles,
      tenantId: user.tenantId ?? undefined,
    });
  }
}
`,
    authController: `import { Body, Controller, Post } from '@nestjs/common';
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { AuthService } from './auth.service';

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export class LoginDto extends createZodDto(LoginSchema) {}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  login(@Body() body: LoginDto) {
    return this.auth.login(body.email, body.password);
  }
}
`,
    securityModule: `import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { TokenService } from './jwt/token.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { AuthService } from './auth/auth.service';
import { AuthController } from './auth/auth.controller';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({ secret: config.get<string>('JWT_SECRET') }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    TokenService,
    JwtAuthGuard,
    AuthService,
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [TokenService, JwtAuthGuard, AuthService],
})
export class SecurityModule {}
`,
  };
}

function tenancyFiles() {
  return {
    tenantContext: `import { RequestContext } from '../../../shared/context/request-context';

/** Reads the verified tenant from the request identity (never from user input). */
export class TenantContext {
  static current(): string | undefined {
    return RequestContext.tenantId();
  }

  static require(): string {
    const tenantId = RequestContext.tenantId();
    if (!tenantId) {
      const error = new Error('Tenant context is required but missing');
      (error as Error & { status?: number }).status = 403;
      throw error;
    }
    return tenantId;
  }
}
`,
    tenantGuard: `import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { TenantContext } from './tenant-context';

/**
 * Rejects requests that carry no verified tenant claim and blocks attempts to
 * override the tenant through query/body/headers.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request & { user?: { tenantId?: string } }>();
    const claimedTenantHeader = request.headers['x-tenant-id'];
    if (claimedTenantHeader) {
      throw new ForbiddenException({ code: 'TENANT_SCOPE_VIOLATION', message: 'Tenant id must come from the access token' });
    }
    const body = request.body as { tenantId?: unknown } | undefined;
    if (body && Object.prototype.hasOwnProperty.call(body, 'tenantId')) {
      throw new ForbiddenException({ code: 'TENANT_SCOPE_VIOLATION', message: 'tenantId is not a client-writable field' });
    }
    if (!request.user?.tenantId) {
      throw new ForbiddenException({ code: 'TENANT_SCOPE_VIOLATION', message: 'Token has no tenant scope' });
    }
    if (TenantContext.current() === undefined) {
      throw new ForbiddenException({ code: 'TENANT_SCOPE_VIOLATION', message: 'Tenant context is missing' });
    }
    return true;
  }
}
`,
    tenancyModule: `import { Global, Module } from '@nestjs/common';
import { TenantGuard } from './tenant.guard';

@Global()
@Module({
  providers: [TenantGuard],
  exports: [TenantGuard],
})
export class TenancyModule {}
`,
  };
}

function healthFiles(ctx) {
  const checks = ["database"];
  if (ctx.has("cache")) checks.push("redis");
  if (ctx.has("messaging")) checks.push("rabbitmq");
  return `import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
${ctx.has("cache") ? "import { Inject } from '@nestjs/common';\nimport { CACHE_MANAGER } from '@nestjs/cache-manager';\nimport type { Cache } from 'cache-manager';\n" : ""}${ctx.has("messaging") ? "import { RabbitConnection } from '../../communication/messaging/rabbit.connection';\n" : ""}
/**
 * Liveness/readiness endpoint: \`${ctx.app.urlPrefix(false)}/health\`.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
${ctx.has("cache") ? "    @Inject(CACHE_MANAGER) private readonly cache: Cache,\n" : ""}${ctx.has("messaging") ? "    private readonly rabbit: RabbitConnection,\n" : ""}  ) {}

  @Get()
  async check() {
    const result: Record<string, { status: string; error?: string }> = {
      database: { status: 'up' },
${ctx.has("cache") ? "      redis: { status: 'up' },\n" : ""}${ctx.has("messaging") ? "      rabbitmq: { status: 'up' },\n" : ""}    };

    try {
      await this.prisma.$queryRaw\`SELECT 1\`;
    } catch (error) {
      result.database = { status: 'down', error: (error as Error).message };
    }

${
  ctx.has("cache")
    ? `    try {
      await this.cache.set('health:ping', 1, 5_000);
      const value = await this.cache.get<number>('health:ping');
      if (value !== 1) result.redis = { status: 'degraded', error: 'cache read/write mismatch' };
    } catch (error) {
      result.redis = { status: 'down', error: (error as Error).message };
    }
`
    : ""
}${
    ctx.has("messaging")
      ? `    if (!this.rabbit.getChannel()) {
      result.rabbitmq = { status: 'down', error: 'no AMQP channel' };
    }
`
      : ""
  }
    const healthy = Object.values(result).every((entry) => entry.status === 'up');
    const body = {
      status: healthy ? 'ok' : 'error',
      timestamp: new Date().toISOString(),
      checks: result,
    };
    if (!healthy) throw new ServiceUnavailableException(body);
    return body;
  }
}
`;
}

function healthModule() {
  return `import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

@Module({ controllers: [HealthController] })
export class HealthModule {}
`;
}

module.exports = {
  tsconfig,
  tsconfigBuild,
  nestCli,
  packageJson,
  gitignore,
  envExample,
  jestConfig,
  prismaConfig,
  seedScript,
  dockerfile,
  dockerCompose,
  sharedCommon,
  sharedJsonType,
  sharedPagination,
  sharedResult,
  sharedErrors,
  sharedFilters,
  sharedValidationFilter,
  sharedRequestContext,
  sharedRequestId,
  prismaService,
  databaseModule,
  unitOfWork,
  unitOfWorkModule,
  cacheModule,
  messagingFiles,
  outboxFiles,
  inboxFiles,
  sagaFiles,
  healthFiles,
  healthModule,
  pascal,
};
