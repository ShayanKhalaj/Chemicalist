"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { sha256 } = require("./writer");

const FEATURES = [
  {
    key: "identity",
    source: "src/platform/identity",
    destination: "src/labs/security/runtime/identity",
    labSlug: "security",
    studioSlug: "identity",
    moduleName: "IdentityModule",
    moduleFile: "identity.module",
  },
  {
    key: "authentication",
    source: "src/platform/security",
    destination: "src/labs/security/runtime/authentication",
    labSlug: "security",
    studioSlug: "authentication",
    moduleName: "SecurityModule",
    moduleFile: "security.module",
  },
  {
    key: "authorization",
    source: "src/platform/authorization",
    destination: "src/labs/security/runtime/authorization",
    labSlug: "security",
    studioSlug: "authorization",
    moduleName: "AuthorizationModule",
    moduleFile: "authorization.module",
  },
  {
    key: "tenancy",
    source: "src/platform/tenancy",
    destination: "src/labs/organization/runtime/tenancy",
    labSlug: "organization",
    studioSlug: "tenancy",
    moduleName: "TenancyModule",
    moduleFile: "tenancy.module",
  },
  {
    key: "audit",
    source: "src/platform/audit",
    destination: "src/labs/logs/runtime/audit",
    labSlug: "logs",
    studioSlug: "audit",
    moduleName: "AuditModule",
    moduleFile: "audit.module",
  },
  {
    key: "notification",
    source: "src/platform/notification",
    destination: "src/labs/messages/runtime/notification",
    labSlug: "messages",
    studioSlug: "notifications",
    moduleName: "NotificationModule",
    moduleFile: "notification.module",
  },
  {
    key: "location",
    source: "src/platform/location",
    destination: "src/labs/security/location/runtime",
    labSlug: "security",
    studioSlug: "location",
    moduleName: "LocationModule",
    moduleFile: "location.module",
  },
];

function hasStudio(ctx, feature) {
  return (ctx.registeredStudios || ctx.studios || []).some(
    (studio) =>
      studio.labSlug === feature.labSlug &&
      studio.studioSlug === feature.studioSlug,
  );
}

function destinationPath(ctx, sourcePath) {
  const feature = FEATURES.find(
    (entry) =>
      hasStudio(ctx, entry) &&
      (sourcePath === entry.source ||
        sourcePath.startsWith(entry.source + "/")),
  );
  return feature
    ? feature.destination + sourcePath.slice(feature.source.length)
    : sourcePath;
}

function platformModuleFeatures(ctx) {
  return Object.fromEntries(
    FEATURES.map((feature) => [feature.key, hasStudio(ctx, feature)]),
  );
}

function studioRuntimeModules(ctx, labSlug, studioSlug) {
  return FEATURES.filter(
    (feature) =>
      feature.labSlug === labSlug &&
      feature.studioSlug === studioSlug &&
      hasStudio(ctx, feature),
  );
}

function pruneSupersededPlatformFiles(root, ctx) {
  const statePath = path.join(root, ".chemicalist", "state.json");
  if (!fs.existsSync(statePath)) return { removed: [], preserved: [] };
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  if (!state.files || typeof state.files !== "object") {
    throw new Error("Invalid Chemicalist generation state: files must be an object");
  }

  const sourceRoots = FEATURES.filter((feature) => hasStudio(ctx, feature)).map(
    (feature) => feature.source + "/",
  );
  const removed = [];
  const preserved = [];
  let stateChanged = false;
  for (const [relativePath, previous] of Object.entries(state.files)) {
    if (!sourceRoots.some((source) => relativePath.startsWith(source))) continue;
    const absolutePath = path.resolve(root, relativePath);
    if (!absolutePath.startsWith(path.resolve(root) + path.sep)) {
      throw new Error("Unsafe stale generated path in state: " + relativePath);
    }
    if (!fs.existsSync(absolutePath)) {
      delete state.files[relativePath];
      stateChanged = true;
      continue;
    }
    const content = fs.readFileSync(absolutePath, "utf8").replace(/\r\n/g, "\n");
    if (previous && previous.hash === sha256(content)) {
      fs.unlinkSync(absolutePath);
      delete state.files[relativePath];
      removed.push(relativePath);
      stateChanged = true;
    } else {
      preserved.push(relativePath);
    }
  }

  if (stateChanged) {
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
  }
  return { removed, preserved };
}

module.exports = {
  FEATURES,
  destinationPath,
  hasStudio,
  platformModuleFeatures,
  studioRuntimeModules,
  pruneSupersededPlatformFiles,
};
