"use strict";

/**
 * Application-level output: project configuration, shared kernel, database,
 * the platform layer and the optional transport capabilities (cache, RabbitMQ,
 * outbox, inbox, saga) plus bootstrap files.
 *
 * Architecture contract (docs/BACKEND_FOLDERING_RULES.md):
 *  - `src/shared` only holds genuinely business-agnostic primitives,
 *  - every reusable capability with its own responsibility lives in
 *    `src/platform/<area>`,
 *  - `src/infrastructure` holds only application infrastructure (Prisma, cache),
 *  - studio code lives in `src/labs/<lab>/studios/<studio>`.
 */

const sharedT = require("../templates/backend/shared.templates");
const appT = require("../templates/backend/app.templates");
const platform = require("./platform");

function addProjectFiles(plan, ctx) {
  const owner = { owner: "application" };
  plan.add("package.json", sharedT.packageJson(ctx), owner);
  plan.add("tsconfig.json", sharedT.tsconfig(), owner);
  plan.add("tsconfig.build.json", sharedT.tsconfigBuild(), owner);
  plan.add("nest-cli.json", sharedT.nestCli(), owner);
  plan.add(".gitignore", sharedT.gitignore(), owner);
  plan.add(".env.example", sharedT.envExample(ctx), owner);
  plan.add("prisma.config.ts", sharedT.prismaConfig(ctx), owner);
  plan.add("jest.config.json", sharedT.jestConfig(), owner);
  plan.add("test/app.e2e-spec.ts", appT.appFixtureTest(ctx), owner);
  plan.add("test/jest-e2e.json", appT.jestE2e(), owner);
  plan.add("prisma/seed.ts", sharedT.seedScript(ctx), owner);
  if (ctx.outputs.webservice) {
    plan.add("Dockerfile", sharedT.dockerfile(ctx), owner);
    plan.add("docker-compose.yml", sharedT.dockerCompose(ctx), owner);
    plan.add(
      ".dockerignore",
      "node_modules\nnpm-debug.log\ndist\ncoverage\n.env\n.git\n.chemicalist\n",
      owner,
    );
  }
}

function addSharedKernel(plan, ctx) {
  const owner = { owner: "shared" };
  plan.add("src/shared/types/api-error.ts", sharedT.sharedCommon(), owner);
  plan.add("src/shared/types/json.ts", sharedT.sharedJsonType(), owner);
  plan.add(
    "src/shared/pagination/pagination.ts",
    sharedT.sharedPagination(),
    owner,
  );
  plan.add(
    "src/shared/result/operation-result.ts",
    sharedT.sharedResult(),
    owner,
  );
  plan.add("src/shared/errors/domain.errors.ts", sharedT.sharedErrors(), owner);
  plan.add(
    "src/shared/filters/all-exceptions.filter.ts",
    sharedT.sharedFilters(),
    owner,
  );
  plan.add(
    "src/shared/filters/zod-validation-exception.filter.ts",
    sharedT.sharedValidationFilter(),
    owner,
  );
  plan.add(
    "src/shared/context/request-context.ts",
    sharedT.sharedRequestContext(),
    owner,
  );
  plan.add(
    "src/shared/middleware/request-id.middleware.ts",
    sharedT.sharedRequestId(),
    owner,
  );
  plan.add("src/shared/index.ts", sharedIndex(), owner);

  plan.add(
    "src/platform/observability/health/health.controller.ts",
    sharedT.healthFiles(ctx),
    owner,
  );
  plan.add(
    "src/platform/observability/health/health.module.ts",
    sharedT.healthModule(),
    owner,
  );
}

function sharedIndex() {
  return `export * from './types/api-error';
export * from './types/json';
export * from './pagination/pagination';
export * from './result/operation-result';
export * from './errors/domain.errors';
export * from './context/request-context';
`;
}

function addDatabase(plan, ctx) {
  const owner = { owner: "database" };
  plan.add(
    "src/infrastructure/database/prisma.service.ts",
    sharedT.prismaService(),
    owner,
  );
  plan.add(
    "src/infrastructure/database/database.module.ts",
    sharedT.databaseModule(),
    owner,
  );
  plan.add(
    "src/infrastructure/database/unit-of-work.service.ts",
    sharedT.unitOfWork(),
    owner,
  );
  plan.add(
    "src/infrastructure/database/unit-of-work.module.ts",
    sharedT.unitOfWorkModule(),
    owner,
  );
}

function addPlatform(plan, ctx) {
  platform.addPlatform(plan, ctx);
}

/** Cache, RabbitMQ, outbox, inbox and saga are the only opt-in capabilities. */
function addTransportCapabilities(plan, ctx) {
  const owner = { owner: "platform" };

  if (ctx.has("cache")) {
    plan.add("src/infrastructure/cache/cache.module.ts", sharedT.cacheModule(), owner);
  }

  if (ctx.has("messaging")) {
    const files = sharedT.messagingFiles(ctx.has("outbox"));
    plan.add(
      "src/platform/communication/messaging/rabbit.connection.ts",
      files.rabbitConnection,
      owner,
    );
    plan.add(
      "src/platform/communication/messaging/rabbit.publisher.ts",
      files.rabbitPublisher,
      owner,
    );
    plan.add(
      "src/platform/communication/messaging/messaging.module.ts",
      files.messagingModule,
      owner,
    );
  }

  if (ctx.has("outbox")) {
    const files = sharedT.outboxFiles();
    plan.add(
      "src/platform/communication/outbox/outbox.service.ts",
      files.outboxService,
      owner,
    );
    plan.add(
      "src/platform/communication/outbox/outbox.dispatcher.ts",
      files.dispatcher,
      owner,
    );
    plan.add(
      "src/platform/communication/outbox/outbox.module.ts",
      files.outboxModule,
      owner,
    );
  }

  if (ctx.has("inbox")) {
    const files = sharedT.inboxFiles();
    plan.add(
      "src/platform/communication/inbox/inbox.service.ts",
      files.inboxService,
      owner,
    );
    plan.add(
      "src/platform/communication/inbox/inbox.module.ts",
      files.inboxModule,
      owner,
    );
  }

  if (ctx.has("saga")) {
    const files = sharedT.sagaFiles();
    plan.add(
      "src/platform/communication/saga/saga.orchestrator.ts",
      files.saga,
      owner,
    );
    plan.add(
      "src/platform/communication/saga/saga.module.ts",
      files.sagaModule,
      owner,
    );
  }
}

function addBootstrap(plan, ctx) {
  plan.add("src/manifest-registry.ts", appT.manifestRegistry(ctx), {
    owner: "application",
  });
  plan.add("src/app.module.ts", appT.appModule(ctx), { owner: "application" });
  plan.add("src/main.ts", appT.main(ctx), { owner: "application" });
  plan.add(
    "prisma/schema.prisma",
    require("./persistence").generatePrismaSchema(ctx),
    { owner: "database" },
  );
}

module.exports = {
  addProjectFiles,
  addSharedKernel,
  addDatabase,
  addPlatform,
  addTransportCapabilities,
  addBootstrap,
};
