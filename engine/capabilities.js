"use strict";

/**
 * Capability catalogue, dependency resolution and incompatibility checks.
 *
 * The Chemicalist platform itself (identity, authentication, authorization,
 * tenancy, audit, notification, files, workflow, module registry, feature
 * flags, search, reporting and integration) is *core*: it is part of every
 * generated application, exactly like `docs/RULES.md` describes. A manifest can
 * only opt into additional transport/performance capabilities (cache, RabbitMQ,
 * outbox, inbox, saga); it cannot switch the platform off.
 *
 * Legacy manifest names are still accepted:
 *  - `jwt`          -> `identity` (authentication is part of identity)
 *  - `tenantScope`  -> `tenancy`
 */

const CAPABILITY_DEFINITIONS = {
  // -------------------------------------------------------------------------
  // Core platform capabilities
  // -------------------------------------------------------------------------
  identity: {
    description:
      "Users, roles, permissions and sessions, plus JWT authentication (login, refresh, logout) and the global authentication guard.",
    core: true,
    requires: [],
    packages: [
      "@nestjs/jwt@^11",
      "bcryptjs@^3",
    ],
    env: {
      JWT_SECRET: "change-me-in-production",
      JWT_EXPIRES_IN: "1h",
      REFRESH_TOKEN_TTL_DAYS: "30",
      BOOTSTRAP_USER_EMAIL: "",
      BOOTSTRAP_USER_PASSWORD: "",
      BOOTSTRAP_TENANT_SLUG: "default",
      BOOTSTRAP_TENANT_NAME: "Default Tenant",
    },
  },
  authorization: {
    description:
      "Permission metadata (@RequirePermission), permission guard and policy service.",
    core: true,
    requires: ["identity"],
    packages: [],
    env: {},
  },
  tenancy: {
    description:
      "Tenant/organization context, tenant guard and tenant/organization management endpoints.",
    core: true,
    requires: ["identity"],
    packages: [],
    env: {},
  },
  audit: {
    description:
      "Audit trail: every HTTP action and denied authorization is recorded with actor, tenant, outcome and request id.",
    core: true,
    requires: [],
    packages: [],
    env: {},
  },
  notification: {
    description:
      "Notification service with persisted in-app notifications and a channel abstraction for email/SMS.",
    core: true,
    requires: [],
    packages: [],
    env: {},
  },
  files: {
    description:
      "File metadata registry plus a storage port with a local-disk adapter.",
    core: true,
    requires: [],
    packages: [],
    env: { FILE_STORAGE_DIR: ".storage/files" },
  },
  workflow: {
    description:
      "Generic, persisted workflow engine (definitions, instances, step transitions). Business decisions stay in the owning Lab.",
    core: true,
    requires: [],
    packages: [],
    env: {},
  },
  modules: {
    description:
      "Module registry (installed Labs/Studios) and commercial entitlements per tenant.",
    core: true,
    requires: [],
    packages: [],
    env: {},
  },
  flags: {
    description:
      "Feature flags and platform configuration persisted per tenant.",
    core: true,
    requires: [],
    packages: [],
    env: {},
  },
  search: {
    description:
      "Shared search document index and query API (no ownership of source data).",
    core: true,
    requires: [],
    packages: [],
    env: {},
  },
  reporting: {
    description:
      "Read-only reporting registry with generated per-model summaries.",
    core: true,
    requires: [],
    packages: [],
    env: {},
  },
  integration: {
    description:
      "Outbound integration endpoints with HMAC-signed webhook delivery and delivery log.",
    core: true,
    requires: [],
    packages: [],
    env: { INTEGRATION_TIMEOUT_MS: "10000" },
  },
  unitOfWork: {
    description:
      "Prisma interactive transaction client handed to repositories.",
    core: true,
    requires: [],
    packages: [],
    env: {},
  },

  // -------------------------------------------------------------------------
  // Optional capabilities (manifest opt-in)
  // -------------------------------------------------------------------------
  cache: {
    description:
      "Redis-backed cache adapter (@nestjs/cache-manager + Keyv Redis store).",
    requires: [],
    packages: [
      "@nestjs/cache-manager@^3",
      "cache-manager@^7",
      "@keyv/redis@^5",
    ],
    env: { REDIS_URL: "redis://localhost:6379" },
  },
  messaging: {
    description:
      "RabbitMQ publisher/consumer (amqplib) with reconnect and dead-letter support.",
    requires: [],
    packages: ["amqplib@^0.10", "@types/amqplib@^0.10"],
    env: { RABBITMQ_URL: "amqp://guest:guest@localhost:5672" },
  },
  outbox: {
    description:
      "Transactional outbox persisted in PostgreSQL and dispatched to RabbitMQ with retries.",
    requires: ["messaging"],
    packages: [],
    env: {},
  },
  inbox: {
    description:
      "Durable, idempotent message consumption backed by the chemicalist_processed_message table.",
    requires: ["messaging", "unitOfWork"],
    packages: [],
    env: {},
  },
  saga: {
    description:
      "Persisted saga orchestration with step execution, retries and compensation.",
    requires: ["messaging", "unitOfWork"],
    packages: [],
    env: {},
  },
};

/** Capabilities that every generated application has, regardless of the manifest. */
const CORE_CAPABILITIES = Object.keys(CAPABILITY_DEFINITIONS).filter(
  (name) => CAPABILITY_DEFINITIONS[name].core === true,
);

/** Manifest names kept for backwards compatibility. */
const CAPABILITY_ALIASES = {
  jwt: "identity",
  tenantScope: "tenancy",
};

const CAPABILITY_NAMES = Object.keys(CAPABILITY_DEFINITIONS);
const ACCEPTED_CAPABILITY_NAMES = [
  ...CAPABILITY_NAMES,
  ...Object.keys(CAPABILITY_ALIASES),
];

function isTruthy(value) {
  if (value === true) return true;
  if (value && typeof value === "object" && value.enabled === true) return true;
  return false;
}

function truthyKeys(object) {
  return Object.keys(object || {}).filter((key) => isTruthy(object[key]));
}

/**
 * Resolve the effective capability set for a whole application.
 * `manifests` is the list of registered normalized manifests.
 */
function resolveCapabilities(manifests) {
  const enabled = new Set(CORE_CAPABILITIES);

  for (const manifest of manifests) {
    for (const name of truthyKeys(manifest.capabilities)) {
      const canonical = CAPABILITY_ALIASES[name] || name;
      if (CAPABILITY_DEFINITIONS[canonical]) enabled.add(canonical);
    }
    if (needsMessagingForManifest(manifest)) enabled.add("messaging");
  }

  // Close over requirements until stable.
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of [...enabled]) {
      for (const requirement of CAPABILITY_DEFINITIONS[name].requires) {
        if (!enabled.has(requirement)) {
          enabled.add(requirement);
          changed = true;
        }
      }
    }
  }

  // Backwards-compatible aliases used by templates and by `ctx.has()`.
  if (enabled.has("identity")) enabled.add("jwt");
  if (enabled.has("tenancy")) enabled.add("tenantScope");

  return enabled;
}

function needsMessagingForManifest(manifest) {
  const c = manifest.capabilities || {};
  return (
    truthyKeys(c).some((key) => ["messaging", "outbox", "inbox", "saga"].includes(key))
  );
}

function capabilityPackages(enabledSet) {
  const packages = [];
  for (const name of enabledSet) {
    const definition = CAPABILITY_DEFINITIONS[name];
    if (!definition) continue;
    packages.push(...definition.packages);
  }
  return packages;
}

function capabilityEnv(enabledSet) {
  const env = {};
  for (const name of enabledSet) {
    const definition = CAPABILITY_DEFINITIONS[name];
    if (!definition) continue;
    Object.assign(env, definition.env);
  }
  return env;
}

/** Non-core capabilities, in dependency order, used by documentation/tests. */
function optionalCapabilities(enabledSet) {
  return [...enabledSet].filter((name) => !CAPABILITY_DEFINITIONS[name]?.core);
}

module.exports = {
  CAPABILITY_DEFINITIONS,
  CORE_CAPABILITIES,
  CAPABILITY_ALIASES,
  CAPABILITY_NAMES,
  ACCEPTED_CAPABILITY_NAMES,
  isTruthy,
  resolveCapabilities,
  capabilityPackages,
  capabilityEnv,
  optionalCapabilities,
};
