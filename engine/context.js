"use strict";

/**
 * Builds the immutable generation context.
 *
 * The context is the *only* thing templates receive, and it already contains:
 *  - validated manifests of every registered studio (current + previous ones)
 *  - the resolved application-wide capability set
 *  - every path, token, event name and import needed by the templates
 */

const path = require("node:path");

const { loadAndValidateManifest, validateManifest } = require("./manifest");
const { resolveCapabilities, isTruthy } = require("./capabilities");
const { studioRoot, modelPaths } = require("./app-model");
const {
  pascal,
  camel,
  kebab,
  kebabPlural,
  camelPlural,
  constant,
} = require("./naming");
const { tsType } = require("./ts");

const DEFAULT_REGISTRY = {
  schemaVersion: 1,
  generatorVersion: "2.0.0",
  app: null,
  studios: {},
};
const API_ROOT = "src/app";

function readRegistryFile(filePath) {
  const fs = require("node:fs");
  if (!fs.existsSync(filePath)) return { ...DEFAULT_REGISTRY, studios: {} };
  const raw = fs.readFileSync(filePath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      "Registry file " + filePath + " is not valid JSON: " + error.message,
    );
  }
  return { ...DEFAULT_REGISTRY, ...parsed, studios: parsed.studios || {} };
}

function writeRegistryFile(filePath, registry) {
  const fs = require("node:fs");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(registry, null, 2) + "\n", "utf8");
}

function rel(fromFilePath, toPathNoExt) {
  let relative = path.posix.relative(
    path.posix.dirname(fromFilePath),
    toPathNoExt,
  );
  if (!relative.startsWith(".")) relative = "./" + relative;
  return relative;
}

function importLine(from, to, names, kind = "named") {
  const target = rel(from, to);
  if (kind === "type")
    return "import type { " + names + " } from '" + target + "';";
  if (kind === "side") return "import '" + target + "';";
  return "import { " + names + " } from '" + target + "';";
}

/** Names of the registered studios that are part of the app, sorted. */
function listStudios(registry, current) {
  const entries = Object.entries(registry.studios).map(([key, value]) => ({
    key,
    labSlug: value.labSlug,
    studioSlug: value.studioSlug,
    lab: value.lab,
    studio: value.studio,
    manifestPath: value.manifestPath,
    title: value.title,
    moduleName: value.moduleName,
    root: value.root,
  }));

  const currentKey = current.labSlug + "/" + current.studioSlug;
  const exists = entries.some((entry) => entry.key === currentKey);
  if (!exists) {
    entries.push({
      key: currentKey,
      labSlug: current.labSlug,
      studioSlug: current.studioSlug,
      lab: current.lab,
      studio: current.studio,
      manifestPath: current.filePath,
      title: current.ui.title,
      moduleName: current.studioModuleName,
      root: studioRoot(current),
    });
  }

  return entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * @param {object} current validated manifest being generated
 * @param {object} previousStudios registry.studios (raw descriptors)
 * @param {object} options { generatorVersion, registryPath }
 */
function buildContext(current, previousStudios = {}, options = {}) {
  // Re-validate registered manifests against the current generator so the
  // merged application (Prisma schema, app module, ...) can be rebuilt safely.
  const provenances = [];
  for (const [, descriptor] of Object.entries(previousStudios)) {
    if (!descriptor || !descriptor.manifestPath) continue;
    provenances.push(
      loadAndValidateManifest(descriptor.manifestPath, undefined, {
        catalogKey: descriptor.catalogKey,
        configPath: descriptor.configPath,
        infrastructurePath: descriptor.infrastructurePath,
        frontendPath: descriptor.frontendPath,
        uiTemplatePath: descriptor.uiTemplatePath,
      }),
    );
  }
  provenances.push(current);

  // A studio key must be unique across the application.
  const byKey = new Map();
  for (const manifest of provenances) {
    byKey.set(manifest.labSlug + "/" + manifest.studioSlug, manifest);
  }

  // An application has one shared configuration; conflicting manifests are rejected.
  const appManifests = [...byKey.values()];
  const names = new Set(appManifests.map((m) => m.app.name));
  if (names.size > 1) {
    throw new Error(
      "Incompatible application metadata: manifests declare different app.name values (" +
        [...names].join(", ") +
        "). Every studio generated into the same output directory must use the same app.name, apiPrefix, apiVersion and ui settings.",
    );
  }
  const reference = appManifests[0];
  if (
    appManifests.some(
      (manifest) => JSON.stringify(manifest.outputs) !== JSON.stringify(reference.outputs),
    )
  ) {
    throw new Error(
      "Incompatible output configuration: all manifests in one application must share the same outputs.",
    );
  }
  const persistenceKey = (m) =>
    JSON.stringify([
      m.persistence.provider,
      m.persistence.database,
      m.persistence.schema,
    ]);
  if (new Set(appManifests.map(persistenceKey)).size > 1) {
    throw new Error(
      "Incompatible persistence configuration: all studios in one application must share provider/database/schema.",
    );
  }

  // Enums must be identical if declared in more than one manifest.
  const enumMap = new Map();
  for (const manifest of appManifests) {
    for (const item of manifest.enums) {
      const existing = enumMap.get(item.name);
      if (
        existing &&
        JSON.stringify(existing.values) !== JSON.stringify(item.values)
      ) {
        throw new Error(
          "Conflicting enum definition `" +
            item.name +
            "` between manifests (" +
            manifest.filePath +
            ").",
        );
      }
      enumMap.set(item.name, item);
    }
  }

  // Model names are application-wide unique in the Prisma schema.
  const modelOwners = new Map();
  for (const manifest of appManifests) {
    for (const model of manifest.models) {
      const owner = modelOwners.get(model.name);
      if (owner && owner !== manifest.filePath) {
        throw new Error(
          "Model `" +
            model.name +
            "` is declared by both " +
            owner +
            " and " +
            manifest.filePath +
            ". Model names must be unique across an application.",
        );
      }
      modelOwners.set(model.name, manifest.filePath);
    }
  }

  const capabilities = resolveCapabilities(appManifests);
  const has = (name) => capabilities.has(name);
  const tenantRequired =
    [...byKey.values()].some((m) => isTruthy(m.capabilities.tenantScope)) ||
    isTruthy(current.capabilities.tenantScope);
  const tenantEnabled = tenantRequired || has("tenantScope");
  if (tenantEnabled) capabilities.add("tenantScope");

  const api = reference.app.api;
  const apiVersion = api.version;
  const urlPrefix = (versioned) =>
    "/" +
    [api.prefix, versioned ? "v" + apiVersion : null].filter(Boolean).join("/");

  const studios = listStudios(
    {
      studios: Object.fromEntries(
        [...byKey.entries()].map(([key, m]) => [
          key,
          {
            labSlug: m.labSlug,
            studioSlug: m.studioSlug,
            lab: m.lab,
            studio: m.studio,
            manifestPath: m.filePath,
            configPath: m.projectFiles.configPath,
            infrastructurePath: m.projectFiles.infrastructurePath,
            frontendPath: m.projectFiles.frontendPath,
            uiTemplatePath: m.projectFiles.uiTemplatePath,
            title: m.ui.title,
            moduleName: m.studioModuleName,
            root: studioRoot(m),
          },
        ]),
      ),
    },
    current,
  );

  const ctx = {
    generatorVersion:
      options.generatorVersion || DEFAULT_REGISTRY.generatorVersion,
    registryPath: options.registryPath,
    manifest: current,
    studios,
    app: {
      name: reference.app.name,
      title: reference.app.title,
      description: reference.app.description,
      api,
      hasVersioning: Boolean(api.version),
      urlPrefix,
      apiBase: urlPrefix(false),
      ui: reference.ui,
    },
    persistence: reference.persistence,
    services: Object.assign({}, ...appManifests.map((manifest) => manifest.services)),
    outputs: {
      webservice: appManifests.every((manifest) => manifest.outputs.webservice),
      api: appManifests.every((manifest) => manifest.outputs.api),
      frontend: appManifests.every((manifest) => manifest.outputs.frontend),
    },
    // The UI is application-wide: a backend-only app is declared by any
    // manifest that disables it, so those runs never touch the frontend.
    appUi: {
      ...reference.ui,
      enabled:
        appManifests.every((m) => m.ui.enabled !== false) &&
        appManifests.every((m) => m.outputs.frontend),
    },
    enums: [...enumMap.values()].sort((a, b) => (a.name < b.name ? -1 : 1)),
    capabilities,
    has,
    paths: {
      apiRoot: API_ROOT,
      prismaSchema: "prisma/schema.prisma",
      main: "src/main.ts",
      appModule: "src/app.module.ts",
    },
  };

  // Studio-level derived data. Relationships are collected once for the whole
  // application so cross-studio relations are rendered too.
  ctx.appManifests = appManifests;
  const relations = appManifests.flatMap((m) => m.relations || []);
  ctx.manifestRelations = relations;
  const studio = buildStudioDescriptor(current, ctx, relations);
  ctx.studio = studio;

  // Look a model up by name across the whole application (cross-studio refs).
  ctx.modelFileByName = (name) => {
    const manifest = appManifests.find((candidate) =>
      candidate.models.some((model) => model.name === name),
    );
    if (!manifest) {
      throw new Error("Unknown model `" + name + "` referenced from " + current.filePath);
    }
    return buildStudioDescriptor(manifest, ctx, relations).models.find(
      (model) => model.name === name,
    );
  };

  // Every model of the application, used for cross-studio imports.
  ctx.applicationModels = appManifests
    .slice()
    .sort((a, b) => (a.labSlug + a.studioSlug < b.labSlug + b.studioSlug ? -1 : 1))
    .flatMap((manifest) => buildStudioDescriptor(manifest, ctx, relations).models)
    .sort((a, b) => (a.name < b.name ? -1 : 1));

  ctx.modelByName = (name) => {
    const owned = studio.models.find((model) => model.name === name);
    if (!owned) {
      throw new Error('Unknown model `' + name + '` referenced from studio ' + studio.studioSlug);
    }
    return owned;
  };

  ctx.importLine = importLine;
  ctx.rel = rel;
  return ctx;
}

function buildStudioDescriptor(manifest, ctx, relations) {
  const root = studioRoot(manifest);
  const moduleName = manifest.studioModuleName;
  const enumByName = new Map((ctx.enums || []).map((item) => [item.name, item]));
  const allRelations = relations || ctx.manifestRelations || [];
  for (const model of manifest.models) {
    for (const field of model.fields) {
      if (field.enumName && enumByName.has(field.enumName)) {
        field.enumValues = enumByName.get(field.enumName).values;
      }
    }
  }

  const models = manifest.models.map((model) => {
    const paths = modelPaths(root, model);
    const idType = tsType(model.id);
    const createDtoType = "Create" + model.name + "Dto";
    const updateDtoType = "Update" + model.name + "Dto";
    const queryDtoType = model.name + "QueryDto";
    const serviceContractName = model.name + "ServiceContract";
    const repositoryContractName = model.name + "Repository";
    // Valid Prisma/TS identifier derived from the model name (never `P_R_O_D_U_C_T`).
    const token = constant(model.name) + "_REPOSITORY";

    // Relation metadata is part of the immutable context: the manifest's own
    // `relations` (outgoing references + incoming collections) plus references
    // to models owned by other studios.
    const references = [];
    const collections = [];
    for (const relation of model.relations || []) {
      if (relation.kind === "reference") {
        const target = manifest.models.find((m) => m.name === relation.to);
        references.push({
          kind: "reference",
          model: relation.to,
          field: relation.field,
          fieldName: relation.field.replace(/Id$/, ""),
          required: Boolean(target && relation.field),
        });
      } else if (relation.kind === "collection") {
        collections.push({
          kind: "collection",
          model: relation.to,
          field: relation.field,
          ownerField: relation.ownerField,
        });
      }
    }
    const ownNames = new Set(manifest.models.map((m) => m.name));
    for (const relation of allRelations.filter(
      (r) => r.from === model.name && !ownNames.has(r.to),
    )) {
      references.push({
        kind: "reference",
        model: relation.to,
        field: relation.field,
        fieldName: relation.field.replace(/Id$/, ""),
        required: relation.required,
        external: true,
      });
    }
    const externalCollections = allRelations
      .filter((r) => r.to === model.name && !ownNames.has(r.from))
      .map((r) => ({
        kind: "collection",
        model: r.from,
        field: r.collection,
        ownerField: r.field,
        external: true,
      }));

    return {
      ...model,
      references,
      collections: [...collections, ...externalCollections],
      manifest,
      root,
      route: kebabPlural(model.name),
      routeSingle: kebab(model.name),
      paths,
      names: {
        service: model.name + "Service",
        serviceContract: serviceContractName,
        repositoryContract: repositoryContractName,
        repositoryImpl: "Prisma" + model.name + "Repository",
        token,
        createDto: createDtoType,
        updateDto: updateDtoType,
        queryDto: queryDtoType,
        createSchema: "Create" + model.name + "Schema",
        updateSchema: "Update" + model.name + "Schema",
        querySchema: model.name + "QuerySchema",
        persistenceModel: model.name + "PersistenceModel",
        mapper: model.name + "PrismaMapper",
        events: model.name + 'Events',
        aggregate: model.name,
      },
      idType,
      features: {
        create: model.operations.includes("create"),
        read: model.operations.includes("read"),
        update: model.operations.includes("update"),
        delete: model.operations.includes("delete"),
      },
      imports: {
        domain: rel(paths.controller, paths.domain),
        service: rel(paths.controller, paths.useCases),
        useCases: paths.useCases,
      },
    };
  });

  return {
    manifest,
    lab: manifest.lab,
    labSlug: manifest.labSlug,
    studio: manifest.studio,
    studioSlug: manifest.studioSlug,
    studioPascal: pascal(manifest.studio),
    studioCamel: camel(manifest.studio),
    root,
    moduleName,
    modulePath: root + "/" + kebab(manifest.studio) + ".module",
    routes: {
      studioSegment: manifest.studioSlug,
      labSegment: manifest.labSlug,
    },
    models,
    enums: manifest.enums,
  };
}

function describeStudioForRegistry(manifest, context) {
  return {
    key: manifest.labSlug + "/" + manifest.studioSlug,
    lab: manifest.lab,
    labSlug: manifest.labSlug,
    studio: manifest.studio,
    studioSlug: manifest.studioSlug,
    title: manifest.ui.title,
    moduleName: manifest.studioModuleName,
    root: studioRoot(manifest),
    manifestPath: manifest.filePath,
    configPath: manifest.projectFiles.configPath,
    infrastructurePath: manifest.projectFiles.infrastructurePath,
    frontendPath: manifest.projectFiles.frontendPath,
    uiTemplatePath: manifest.projectFiles.uiTemplatePath,
    catalogKey: manifest.catalogKey,
    catalogMetadata: manifest.catalogMetadata,
    generatorVersion: context
      ? context.generatorVersion
      : DEFAULT_REGISTRY.generatorVersion,
    capabilities: Object.keys(manifest.capabilities).filter((key) =>
      isTruthy(manifest.capabilities[key]),
    ),
    models: manifest.models.map((model) => model.name),
  };
}

module.exports = {
  DEFAULT_REGISTRY,
  API_ROOT,
  buildContext,
  describeStudioForRegistry,
  readRegistryFile,
  writeRegistryFile,
  importLine,
  rel,
  validateManifest,
  constant,
};
