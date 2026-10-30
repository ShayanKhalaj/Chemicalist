
"use strict";

/**
 * Builds the immutable generation context.
 *
 * The context is the only thing templates receive, and it already contains:
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
  schemaName,
} = require("./naming");
const { tsType } = require("./ts");

const DEFAULT_REGISTRY = {
  schemaVersion: 1,
  generatorVersion: "2.0.0",
  app: null,
  studios: {},
};

const API_ROOT = "src/app";

/** PostgreSQL schema owned by the platform (identity, tenancy, audit, ...). */
const PLATFORM_SCHEMA = "public";

function readRegistryFile(filePath) {
  const fs = require("node:fs");

  if (!fs.existsSync(filePath)) {
    return { ...DEFAULT_REGISTRY, studios: {} };
  }

  const raw = fs.readFileSync(filePath, "utf8");
  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      "Registry file " + filePath + " is not valid JSON: " + error.message,
    );
  }

  return {
    ...DEFAULT_REGISTRY,
    ...parsed,
    studios: parsed.studios || {},
  };
}

function writeRegistryFile(filePath, registry) {
  const fs = require("node:fs");

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify(registry, null, 2) + "\n",
    "utf8",
  );
}

function rel(fromFilePath, toPathNoExt) {
  let relative = path.posix.relative(
    path.posix.dirname(fromFilePath),
    toPathNoExt,
  );

  if (!relative.startsWith(".")) {
    relative = "./" + relative;
  }

  return relative;
}

function importLine(from, to, names, kind = "named") {
  const target = rel(from, to);

  if (kind === "type") {
    return "import type { " + names + " } from '" + target + "';";
  }

  if (kind === "side") {
    return "import '" + target + "';";
  }

  return "import { " + names + " } from '" + target + "';";
}

/** Application studios, sorted by their Lab/Studio key. */
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

  const currentKey = studioKey(current);
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

  return entries.sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
}

/**
 * @param {object} current Validated manifest being generated.
 * @param {object} previousStudios Registry studios (raw descriptors).
 * @param {object} options { generatorVersion, registryPath }
 */
function buildContext(current, previousStudios = {}, options = {}) {
  // Re-validate registered manifests against the current generator.
  const provenances = [];

  for (const [, descriptor] of Object.entries(previousStudios)) {
    if (!descriptor || !descriptor.manifestPath) {
      continue;
    }

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
    const key = studioKey(manifest);
    byKey.set(key, manifest);
  }

  const appManifests = [...byKey.values()];

  if (appManifests.length === 0) {
    throw new Error(
      "Cannot build generation context: no Studio manifests were registered.",
    );
  }

  // All manifests must belong to the same application.
  const names = new Set(appManifests.map((m) => m.app.name));

  if (names.size > 1) {
    throw new Error(
      "Incompatible application metadata: manifests declare different app.name values (" +
        [...names].join(", ") +
        "). Every studio generated into the same output directory must use the same app.name, apiPrefix, apiVersion and ui settings.",
    );
  }

  const reference = appManifests[0];

  // Output configuration must be shared by every Studio.
  if (
    appManifests.some(
      (manifest) =>
        JSON.stringify(manifest.outputs) !==
        JSON.stringify(reference.outputs),
    )
  ) {
    throw new Error(
      "Incompatible output configuration: all manifests in one application must share the same outputs.",
    );
  }

  // Persistence configuration must be shared by every Studio.
  const persistenceKey = (manifest) =>
    JSON.stringify([
      manifest.persistence.provider,
      manifest.persistence.database,
      manifest.persistence.schema,
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
    [...byKey.values()].some((manifest) =>
      isTruthy(manifest.capabilities.tenantScope),
    ) || isTruthy(current.capabilities.tenantScope);

  const tenantEnabled = tenantRequired || has("tenantScope");

  if (tenantEnabled) {
    capabilities.add("tenantScope");
  }

  const api = reference.app.api;
  const apiVersion = api.version;

  const urlPrefix = (versioned) =>
    "/" +
    [api.prefix, versioned ? "v" + apiVersion : null]
      .filter(Boolean)
      .join("/");

  const registryForList = {
    studios: Object.fromEntries(
      [...byKey.entries()].map(([key, manifest]) => [
        key,
        {
          labSlug: manifest.labSlug,
          studioSlug: manifest.studioSlug,
          lab: manifest.lab,
          studio: manifest.studio,
          manifestPath: manifest.filePath,
          configPath: manifest.projectFiles.configPath,
          infrastructurePath: manifest.projectFiles.infrastructurePath,
          frontendPath: manifest.projectFiles.frontendPath,
          uiTemplatePath: manifest.projectFiles.uiTemplatePath,
          title: manifest.ui.title,
          moduleName: manifest.studioModuleName,
          root: studioRoot(manifest),
        },
      ]),
    ),
  };

  const studios = listStudios(registryForList, current);

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

    services: Object.assign(
      {},
      ...appManifests.map((manifest) => manifest.services),
    ),

    outputs: {
      webservice: appManifests.every(
        (manifest) => manifest.outputs.webservice,
      ),
      api: appManifests.every((manifest) => manifest.outputs.api),
      frontend: appManifests.every(
        (manifest) => manifest.outputs.frontend,
      ),
    },

    // UI is application-wide.
    appUi: {
      ...reference.ui,
      enabled:
        appManifests.every((manifest) => manifest.ui.enabled !== false) &&
        appManifests.every((manifest) => manifest.outputs.frontend),
    },

    enums: [...enumMap.values()].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    ),

    capabilities,
    has,

    paths: {
      apiRoot: API_ROOT,
      prismaSchema: "prisma/schema.prisma",
      main: "src/main.ts",
      appModule: "src/app.module.ts",
    },
  };

  // Application-wide validated manifests.
  ctx.appManifests = appManifests;

  ctx.platformSchema = PLATFORM_SCHEMA;

  // One PostgreSQL schema per Lab, shared by all Studios inside that Lab.
  ctx.studioSchemas = buildStudioSchemas(appManifests);

  // Relationships are collected application-wide, including cross-Studio
  // relationships.
  const relations = appManifests.flatMap(
    (manifest) => manifest.relations || [],
  );

  ctx.manifestRelations = relations;

  const studio = buildStudioDescriptor(current, ctx, relations);
  ctx.studio = studio;

  // Resolve a model by name across the entire application.
  ctx.modelFileByName = (name) => {
    const manifest = appManifests.find((candidate) =>
      candidate.models.some((model) => model.name === name),
    );

    if (!manifest) {
      throw new Error(
        "Unknown model `" + name + "` referenced from " + current.filePath,
      );
    }

    return buildStudioDescriptor(manifest, ctx, relations).models.find(
      (model) => model.name === name,
    );
  };

  // Every model of the application, used for cross-Studio imports.
  ctx.applicationModels = appManifests
    .slice()
    .sort((a, b) => {
      const keyA = studioKey(a);
      const keyB = studioKey(b);
      return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
    })
    .flatMap((manifest) =>
      buildStudioDescriptor(manifest, ctx, relations).models,
    )
    .sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );

  // Every registered Studio with its models.
  ctx.registeredStudios = buildRegisteredStudios(ctx);

  ctx.modelByName = (name) => {
    const owned = studio.models.find((model) => model.name === name);

    if (!owned) {
      throw new Error(
        "Unknown model `" +
          name +
          "` referenced from studio " +
          studio.studioSlug,
      );
    }

    return owned;
  };

  ctx.importLine = importLine;
  ctx.rel = rel;

  return ctx;
}

/**
 * Studio descriptor of every registered Studio.
 */
function buildRegisteredStudios(ctx) {
  const known = new Map(
    (ctx.appManifests || []).map((manifest) => [
      studioKey(manifest),
      manifest,
    ]),
  );

  const ordered = [];

  for (const entry of ctx.studios || []) {
    const manifest = known.get(
      entry.labSlug + "/" + entry.studioSlug,
    );

    if (manifest && !ordered.includes(manifest)) {
      ordered.push(manifest);
    }
  }

  for (const manifest of ctx.appManifests || []) {
    if (!ordered.includes(manifest)) {
      ordered.push(manifest);
    }
  }

  return ordered.map((manifest) =>
    buildStudioDescriptor(
      manifest,
      ctx,
      ctx.manifestRelations || [],
    ),
  );
}

/** Application-wide unique key of a Studio. */
function studioKey(manifest) {
  return manifest.labSlug + "/" + manifest.studioSlug;
}

/**
 * Map<studioKey, postgresSchema>
 *
 * Every Lab owns exactly one PostgreSQL schema.
 * All Studios belonging to the same Lab share that schema.
 *
 * Example:
 *   laboratory/sample-management -> laboratory
 *   laboratory/test-execution    -> laboratory
 *   laboratory/test-methods      -> laboratory
 *   ehs/chemical-safety          -> ehs
 *
 * Schema names are derived from labSlug.
 */
function buildStudioSchemas(appManifests) {
  const schemas = new Map();
  const owners = new Map();

  for (const manifest of appManifests) {
    const key = studioKey(manifest);

    if (!manifest.labSlug) {
      throw new Error(
        "Studio `" +
          key +
          "` has no labSlug. A Lab slug is required to determine its PostgreSQL schema.",
      );
    }

    const schema = schemaName(manifest.labSlug);

    if (!schema || schema === PLATFORM_SCHEMA) {
      throw new Error(
        "Lab `" +
          manifest.labSlug +
          "` would map to PostgreSQL schema `" +
          PLATFORM_SCHEMA +
          "`, which is reserved for the Chemicalist platform. Rename the Lab.",
      );
    }

    const existingOwner = owners.get(schema);

    if (existingOwner && existingOwner !== manifest.labSlug) {
      throw new Error(
        "Labs `" +
          existingOwner +
          "` and `" +
          manifest.labSlug +
          "` both map to PostgreSQL schema `" +
          schema +
          "`. Lab slugs must stay unique after normalization.",
      );
    }

    owners.set(schema, manifest.labSlug);

    // Each Studio keeps its own key but points to its Lab's shared schema.
    schemas.set(key, schema);
  }

  return schemas;
}

/**
 * PostgreSQL schema of a model.
 *
 * Platform models stay in public.
 * Every business model belongs to the schema of its owning Lab.
 */
function schemaForModel(ctx, modelName) {
  for (const manifest of ctx.appManifests || []) {
    if (
      manifest.models.some((model) => model.name === modelName)
    ) {
      return ctx.studioSchemas.get(studioKey(manifest));
    }
  }

  return PLATFORM_SCHEMA;
}

function buildStudioDescriptor(manifest, ctx, relations) {
  const root = studioRoot(manifest);
  const moduleName = manifest.studioModuleName;

  const enumByName = new Map(
    (ctx.enums || []).map((item) => [item.name, item]),
  );

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

    const token = constant(model.name) + "_REPOSITORY";

    // Relation metadata includes local and cross-Studio references.
    const references = [];
    const collections = [];

    for (const relation of model.relations || []) {
      if (relation.kind === "reference") {
        const target = manifest.models.find(
          (item) => item.name === relation.to,
        );

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

    const ownNames = new Set(
      manifest.models.map((item) => item.name),
    );

    for (const relation of allRelations.filter(
      (item) =>
        item.from === model.name &&
        !ownNames.has(item.to),
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
      .filter(
        (item) =>
          item.to === model.name &&
          !ownNames.has(item.from),
      )
      .map((item) => ({
        kind: "collection",
        model: item.from,
        field: item.collection,
        ownerField: item.field,
        external: true,
      }));

    return {
      ...model,

      references,
      collections: [
        ...collections,
        ...externalCollections,
      ],

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
        events: model.name + "Events",
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

    // Shared PostgreSQL schema of the owning Lab.
    studioSchema: ctx.studioSchemas
      ? ctx.studioSchemas.get(studioKey(manifest))
      : undefined,

    studioPascal: pascal(manifest.studio),
    studioCamel: camel(manifest.studio),

    root,
    moduleName,

    modulePath:
      root + "/" + kebab(manifest.studio) + ".module",

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
    key: studioKey(manifest),

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

    // Registry stores the shared Lab schema for this Studio.
    studioSchema:
      context && context.studioSchemas
        ? context.studioSchemas.get(studioKey(manifest))
        : schemaName(manifest.labSlug),

    generatorVersion: context
      ? context.generatorVersion
      : DEFAULT_REGISTRY.generatorVersion,

    capabilities: Object.keys(manifest.capabilities).filter(
      (key) => isTruthy(manifest.capabilities[key]),
    ),

    models: manifest.models.map((model) => model.name),
  };
}

module.exports = {
  DEFAULT_REGISTRY,
  API_ROOT,
  PLATFORM_SCHEMA,

  buildContext,
  buildRegisteredStudios,
  buildStudioSchemas,
  studioKey,
  schemaForModel,

  describeStudioForRegistry,

  readRegistryFile,
  writeRegistryFile,

  importLine,
  rel,

  validateManifest,
  constant,
};
