"use strict";

/**
 * Platform layer output.
 *
 * The platform is the shared, non-commercial part of Chemicalist. It is always
 * generated (never a per-manifest optional interface): identity, authentication,
 * authorization, tenancy, audit, notification, files, workflow, module registry
 * & entitlements, feature flags, search, reporting, integration and internal
 * communication.
 *
 * Two files are *derived* from the registered manifests:
 *  - `authorization/permission-catalog.ts`: every permission key the application
 *    knows (platform operations + each studio resource/action),
 *  - `reporting/generated-reports.ts`: one read-only summary per business model.
 */

const { kebab, camel } = require("../engine/naming");
const platform = require("../templates/backend/platform.templates");
const runtime = require("../templates/backend/platform.runtime.templates");

const PLATFORM_PERMISSIONS = [
  ["platform.identity", ["read", "write"]],
  ["platform.authorization", ["read", "write"]],
  ["platform.audit", ["read"]],
  ["platform.location", ["read", "write"]],
  ["platform.tenant", ["read", "write"]],
  ["platform.notification", ["read", "write"]],
  ["platform.files", ["read", "write"]],
  ["platform.workflow", ["read", "write"]],
  ["platform.modules", ["read", "write"]],
  ["platform.flags", ["read", "write"]],
  ["platform.search", ["read"]],
  ["platform.reporting", ["read"]],
  ["platform.integration", ["read", "write"]],
];

function platformPermissionKeys() {
  return PLATFORM_PERMISSIONS.flatMap(([area, actions]) =>
    actions.map((action) => area + ":" + action),
  );
}

/** Stable permission keys of every generated studio operation. */
function businessPermissions(ctx) {
  const entries = [];
  for (const manifest of ctx.appManifests) {
    for (const model of manifest.models) {
      const base =
        manifest.labSlug + "." + manifest.studioSlug + "." + kebab(model.name);
      for (const action of model.operations) {
        entries.push({
          key: base + ":" + action,
          model: model.name,
          labSlug: manifest.labSlug,
          studioSlug: manifest.studioSlug,
          action,
        });
      }
    }
  }
  return entries;
}

function permissionCatalog(ctx) {
  const business = businessPermissions(ctx);
  const platformKeys = platformPermissionKeys();
  const all = [...platformKeys, ...business.map((entry) => entry.key)];
  return [
    "/**",
    " * Permission catalogue (generated).",
    " *",
    " * A permission is '<lab>.<studio>.<resource>:<action>' for business",
    " * operations and 'platform.<area>:<action>' for platform operations.",
    " * The catalogue is created by the identity bootstrap; roles are granted",
    " * subsets of it.",
    " */",
    "export const PLATFORM_PERMISSION_KEYS = [",
    ...platformKeys.map((key) => "  '" + key + "',"),
    "] as const;",
    "",
    "export const BUSINESS_PERMISSION_KEYS = [",
    ...business.map((entry) => "  '" + entry.key + "',"),
    "] as const;",
    "",
    "export const ALL_PERMISSION_KEYS: readonly string[] = [",
    "  ...PLATFORM_PERMISSION_KEYS,",
    "  ...BUSINESS_PERMISSION_KEYS,",
    "];",
    "",
    ...(all.length ? [] : []),
  ].join("\n");
}

function generatedReports(ctx) {
  const entries = [];
  for (const manifest of ctx.appManifests) {
    for (const model of manifest.models) {
      const delegate = camel(model.name);
      const key =
        manifest.labSlug + "." + manifest.studioSlug + "." + kebab(model.name) + ".summary";
      entries.push({
        key,
        title: (model.label || model.name) + " summary",
        scope: manifest.labSlug + "/" + manifest.studioSlug,
        delegate,
      });
    }
  }

  return [
    "/**",
    " * Generated read-only reports (one summary per business model).",
    " * Reporting aggregates data owned by a Lab; it never writes it.",
    " */",
    "import type { PrismaService } from '../../infrastructure/database/prisma.service';",
    "",
    "export interface ReportDescriptor {",
    "  key: string;",
    "  title: string;",
    "  scope: string;",
    "  run(prisma: PrismaService): Promise<Record<string, unknown>>;",
    "}",
    "",
    "export const generatedReports: ReportDescriptor[] = [",
    ...entries.map((entry) =>
      [
        "  {",
        "    key: " + JSON.stringify(entry.key) + ",",
        "    title: " + JSON.stringify(entry.title) + ",",
        "    scope: " + JSON.stringify(entry.scope) + ",",
        "    run: async (prisma: PrismaService) => ({",
        "      total: await prisma." + entry.delegate + ".count(),",
        "    }),",
        "  },",
      ].join("\n"),
    ),
    "];",
    "",
  ].join("\n");
}

function addPlatform(plan, ctx) {
  const owner = { owner: "platform" };
  const add = (path, content) => plan.add(path, content, owner);

  // ---------------------------------------------------------------- config
  const configuration = platform.configurationFiles(ctx);
  add("src/platform/configuration/env.schema.ts", configuration.envSchema);
  add("src/platform/configuration/config.module.ts", configuration.configModule);

  // -------------------------------------------------------------- identity
  const identity = platform.identityFiles();
  add("src/platform/identity/identity.types.ts", identity.types);
  add("src/platform/identity/identity.service.ts", identity.service);
  add("src/platform/identity/identity.controller.ts", identity.controller);
  add("src/platform/identity/identity.module.ts", identity.module);

  // ---------------------------------------------------- authentication (JWT)
  const security = platform.securityFiles();
  add("src/platform/security/public.decorator.ts", security.publicDecorator);
  add(
    "src/platform/security/current-identity.decorator.ts",
    security.currentIdentityDecorator,
  );
  add("src/platform/security/token.service.ts", security.tokenService);
  add("src/platform/security/jwt-auth.guard.ts", security.jwtGuard);
  add("src/platform/security/auth/auth.service.ts", security.authService);
  add("src/platform/security/auth/auth.controller.ts", security.authController);
  add("src/platform/security/security.module.ts", security.module);

  // ------------------------------------------------------- authorization
  const authorization = platform.authorizationFiles();
  add("src/platform/authorization/permissions.ts", authorization.permissions);
  add(
    "src/platform/authorization/permission-catalog.ts",
    permissionCatalog(ctx),
  );
  add(
    "src/platform/authorization/permission.guard.ts",
    authorization.permissionGuard,
  );
  add("src/platform/authorization/policy.service.ts", authorization.policyService);
  add(
    "src/platform/authorization/authorization.module.ts",
    authorization.module,
  );

  // ------------------------------------------------------------- tenancy
  const tenancy = platform.tenancyFiles();
  add("src/platform/tenancy/tenant-context.ts", tenancy.tenantContext);
  add("src/platform/tenancy/tenant.guard.ts", tenancy.tenantGuard);
  add("src/platform/tenancy/tenancy.service.ts", tenancy.service);
  add("src/platform/tenancy/tenancy.controller.ts", tenancy.controller);
  add("src/platform/tenancy/tenancy.module.ts", tenancy.module);

  // --------------------------------------------------------------- audit
  const audit = runtime.auditFiles();
  add("src/platform/audit/audit.service.ts", audit.service);
  add("src/platform/audit/audit.interceptor.ts", audit.interceptor);
  add("src/platform/audit/audit.controller.ts", audit.controller);
  add("src/platform/audit/audit.module.ts", audit.module);

  // ------------------------------------------------------------ locations
  const locations = runtime.locationFiles();
  add("src/platform/location/location.service.ts", locations.service);
  add("src/platform/location/location.controller.ts", locations.controller);
  add("src/platform/location/location.module.ts", locations.module);

  // -------------------------------------------------------- notification
  const notification = runtime.notificationFiles();
  add("src/platform/notification/notification.types.ts", notification.types);
  add(
    "src/platform/notification/notification.service.ts",
    notification.service,
  );
  add(
    "src/platform/notification/notification.controller.ts",
    notification.controller,
  );
  add("src/platform/notification/notification.module.ts", notification.module);

  // --------------------------------------------------------------- files
  const files = runtime.filesFiles();
  add("src/platform/files/file-storage.ts", files.storage);
  add("src/platform/files/files.service.ts", files.service);
  add("src/platform/files/files.controller.ts", files.controller);
  add("src/platform/files/files.module.ts", files.module);

  // ------------------------------------------------------------ workflow
  const workflow = runtime.workflowFiles();
  add("src/platform/workflow/workflow.types.ts", workflow.types);
  add("src/platform/workflow/workflow.service.ts", workflow.service);
  add("src/platform/workflow/workflow.controller.ts", workflow.controller);
  add("src/platform/workflow/workflow.module.ts", workflow.module);

  // --------------------------------------------- module registry & licenses
  const modules = runtime.moduleRegistryFiles();
  add("src/platform/modules/module-registry.service.ts", modules.service);
  add(
    "src/platform/modules/module-registry.controller.ts",
    modules.controller,
  );
  add("src/platform/modules/module-registry.module.ts", modules.module);

  // ------------------------------------------------------- feature flags
  const flags = runtime.featureFlagFiles();
  add(
    "src/platform/configuration/feature-flag/feature-flag.service.ts",
    flags.service,
  );
  add(
    "src/platform/configuration/feature-flag/feature-flag.controller.ts",
    flags.controller,
  );
  add(
    "src/platform/configuration/feature-flag/feature-flag.module.ts",
    flags.module,
  );

  // --------------------------------------------------------------- search
  const search = runtime.searchFiles();
  add("src/platform/search/search.service.ts", search.service);
  add("src/platform/search/search.controller.ts", search.controller);
  add("src/platform/search/search.module.ts", search.module);

  // ------------------------------------------------------------ reporting
  const reporting = runtime.reportingFiles();
  add("src/platform/reporting/generated-reports.ts", generatedReports(ctx));
  add("src/platform/reporting/reporting.service.ts", reporting.service);
  add("src/platform/reporting/reporting.controller.ts", reporting.controller);
  add("src/platform/reporting/reporting.module.ts", reporting.module);

  // ---------------------------------------------------------- integration
  const integration = runtime.integrationFiles();
  add("src/platform/integration/integration.service.ts", integration.service);
  add(
    "src/platform/integration/integration.controller.ts",
    integration.controller,
  );
  add("src/platform/integration/integration.module.ts", integration.module);

  // -------------------------------------------------- communication (EDA)
  const communication = runtime.communicationFiles();
  add(
    "src/platform/communication/contracts/domain-event.ts",
    communication.domainEvent,
  );
  add("src/platform/communication/eda/event-bus.ts", communication.eventBus);
  add(
    "src/platform/communication/communication.module.ts",
    communication.module,
  );

  // ------------------------------------------------------ platform module
  add("src/platform/platform.module.ts", runtime.platformModule());
}

module.exports = {
  addPlatform,
  platformPermissionKeys,
  businessPermissions,
};
