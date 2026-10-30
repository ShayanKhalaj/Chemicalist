"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { pascal, kebab, camel } = require("./naming");
const { normalizeModel } = require("./field-types");
const { ACCEPTED_CAPABILITY_NAMES } = require("./capabilities");

const APP_NAME_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;
const LAB_PATTERN = /^[A-Za-z][A-Za-z0-9 _-]*$/;
const STUDIO_PATTERN = /^[A-Za-z][A-Za-z0-9 _-]*$/;
const MODEL_PATTERN = /^[A-Z][A-Za-z0-9]*$/;
const ENUM_PATTERN = /^[A-Z][A-Za-z0-9]*$/;
const CUSTOM_REPOSITORY_OPERATIONS = new Set([
  "findOneBy",
  "findManyBy",
  "countBy",
  "isExistedBy",
]);
const RESERVED_REPOSITORY_METHODS = new Set([
  "findById",
  "findMany",
  "create",
  "update",
  "delete",
  "exists",
  "createOne",
  "createMany",
  "updateOne",
  "updateMany",
  "hardDeleteOne",
  "hardDeleteMany",
  "softDeleteOne",
  "softDeleteMany",
  "restoreOne",
  "restoreMany",
  "getOneById",
  "getAll",
  "search",
  "checkDuplicate",
  "checkRelation",
  "isExisted",
]);

class ManifestError extends Error {
  constructor(filePath, issues) {
    super(
      "Manifest validation failed for " +
        filePath +
        ":\n" +
        issues.map((issue) => "  - " + issue).join("\n"),
    );
    this.name = "ManifestError";
    this.filePath = filePath;
    this.issues = issues;
  }
}

/** Read + parse a manifest file. Relative paths are resolved against `cwd`. */
function loadManifestFile(manifestPath, cwd = process.cwd()) {
  const absolutePath = path.resolve(cwd, manifestPath);

  let stats;
  try {
    stats = fs.statSync(absolutePath);
  } catch {
    throw new ManifestError(absolutePath, ["file not found"]);
  }
  if (!stats.isFile()) {
    throw new ManifestError(absolutePath, ["path is not a file"]);
  }

  let raw;
  try {
    raw = fs.readFileSync(absolutePath, "utf8");
  } catch (error) {
    throw new ManifestError(absolutePath, [
      "cannot read file: " + error.message,
    ]);
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new ManifestError(absolutePath, ["invalid JSON: " + error.message]);
  }

  return { absolutePath, json };
}

function projectFilesForManifest(manifestPath, options = {}) {
  const absolutePath = path.resolve(manifestPath);
  const suffix = ".manifest.json";
  const base = absolutePath.endsWith(suffix)
    ? absolutePath.slice(0, -suffix.length)
    : absolutePath.replace(/\.json$/i, "");
  const sibling = (name) => {
    const candidate = base + name;
    return fs.existsSync(candidate) ? candidate : undefined;
  };
  const readOptional = (filePath) => {
    if (!filePath) return undefined;
    const { json } = loadManifestFile(filePath);
    return json;
  };
  const configPath =
    options.configPath || sibling(".config.json") || base + ".config.json";
  const infrastructurePath =
    options.infrastructurePath ||
    sibling(".infrastructure.manifest.json") ||
    base + ".infrastructure.manifest.json";
  const frontendPath =
    options.frontendPath ||
    sibling(".frontend.manifest.json") ||
    base + ".frontend.manifest.json";
  const uiTemplatePath =
    options.uiTemplatePath ||
    (fs.existsSync(path.join(path.dirname(absolutePath), "ui.template.json"))
      ? path.join(path.dirname(absolutePath), "ui.template.json")
      : undefined);
  return {
    paths: {
      configPath,
      infrastructurePath,
      frontendPath,
      uiTemplatePath,
    },
    config: readOptional(configPath),
    infrastructure: readOptional(infrastructurePath),
    frontendManifest: readOptional(frontendPath),
    uiTemplate: readOptional(uiTemplatePath),
  };
}

function loadProjectInputs(manifestPath, options = {}) {
  const { absolutePath, json } = loadManifestFile(manifestPath);
  const projectFiles = projectFilesForManifest(absolutePath, options);
  return { absolutePath, json, ...projectFiles };
}

function validateModelOptions(json, models, modelNames, issues) {
  const rawModels = new Map(
    (Array.isArray(json.models) ? json.models : [])
      .filter((model) => model && typeof model.name === "string")
      .map((model) => [model.name, model]),
  );
  const defaults = (model) => ({
    create: model.writableFields
      .filter((field) => !field.generatedByRelation)
      .map((field) => field.name),
    update: model.writableFields
      .filter((field) => !field.generatedByRelation)
      .map((field) => field.name),
    query: model.writableFields
      .filter(
        (field) =>
          !field.isArray &&
          field.baseType !== "json" &&
          !field.generatedByRelation,
      )
      .map((field) => field.name),
  });

  for (const model of models) {
    const raw = rawModels.get(model.name) || {};
    const path = "models." + model.name;
    const rawDtos = raw.dtos === undefined ? {} : raw.dtos;
    if (!rawDtos || typeof rawDtos !== "object" || Array.isArray(rawDtos)) {
      issues.push(path + ".dtos: must be an object with create, update and query field arrays");
    }
    const dtoOptions =
      rawDtos && typeof rawDtos === "object" && !Array.isArray(rawDtos)
        ? rawDtos
        : {};
    const dtoDefaults = defaults(model);
    model.dtoFields = {};
    for (const kind of Object.keys(dtoDefaults)) {
      const requested =
        dtoOptions[kind] === undefined ? dtoDefaults[kind] : dtoOptions[kind];
      if (
        !Array.isArray(requested) ||
        requested.some((fieldName) => typeof fieldName !== "string")
      ) {
        issues.push(path + ".dtos." + kind + ": must be an array of field names");
        model.dtoFields[kind] = dtoDefaults[kind];
        continue;
      }
      if (new Set(requested).size !== requested.length) {
        issues.push(path + ".dtos." + kind + ": field names must be unique");
      }
      for (const fieldName of requested) {
        const field = model.writableFields.find(
          (candidate) => candidate.name === fieldName,
        );
        if (!field) {
          issues.push(path + ".dtos." + kind + ": unknown field `" + fieldName + "`");
        } else if (field.generatedByRelation && kind !== "query") {
          issues.push(path + ".dtos." + kind + ": relation field `" + fieldName + "` is not client-writable");
        } else if (
          kind === "query" &&
          (field.isArray || field.baseType === "json")
        ) {
          issues.push(path + ".dtos.query: field `" + fieldName + "` cannot be filtered");
        }
      }
      model.dtoFields[kind] = requested.filter((name) =>
        model.writableFields.some((field) => field.name === name),
      );
    }
    for (const key of Object.keys(dtoOptions)) {
      if (!Object.prototype.hasOwnProperty.call(dtoDefaults, key)) {
        issues.push(path + ".dtos." + key + ": unsupported DTO kind (allowed: create, update, query)");
      }
    }

    const customMethods = raw.customMethods === undefined ? [] : raw.customMethods;
    if (!Array.isArray(customMethods)) {
      issues.push(path + ".customMethods: must be an array");
      model.customMethods = [];
      continue;
    }
    const names = new Set();
    model.customMethods = [];
    customMethods.forEach((custom, index) => {
      const methodPath = path + ".customMethods[" + index + "]";
      if (!custom || typeof custom !== "object" || Array.isArray(custom)) {
        issues.push(methodPath + ": must be an object");
        return;
      }
      if (
        typeof custom.name !== "string" ||
        !/^[a-z][A-Za-z0-9]*$/.test(custom.name)
      ) {
        issues.push(methodPath + ".name: must be a camelCase method name");
        return;
      }
      if (names.has(custom.name)) {
        issues.push(methodPath + ".name: duplicate custom method `" + custom.name + "`");
        return;
      }
      names.add(custom.name);
      if (RESERVED_REPOSITORY_METHODS.has(custom.name)) {
        issues.push(methodPath + ".name: `" + custom.name + "` is a reserved repository method");
        return;
      }
      if (!CUSTOM_REPOSITORY_OPERATIONS.has(custom.operation)) {
        issues.push(methodPath + ".operation: must be one of " + [...CUSTOM_REPOSITORY_OPERATIONS].join(", "));
        return;
      }
      if (
        !Array.isArray(custom.fields) ||
        custom.fields.length === 0 ||
        custom.fields.some((field) => typeof field !== "string")
      ) {
        issues.push(methodPath + ".fields: must be a non-empty array of scalar model field names");
        return;
      }
      const fields = [];
      for (const fieldName of custom.fields) {
        const field = model.writableFields.find(
          (candidate) => candidate.name === fieldName,
        );
        if (!field || field.isArray || field.baseType === "json") {
          issues.push(methodPath + ".fields: unknown or unsupported field `" + fieldName + "`");
        } else if (!fields.includes(fieldName)) {
          fields.push(fieldName);
        }
      }
      if (fields.length === custom.fields.length) {
        model.customMethods.push({
          name: custom.name,
          operation: custom.operation,
          fields,
        });
      }
    });
  }

  const rawDtoModels = rawModels;
  for (const name of rawDtoModels.keys()) {
    if (!modelNames.has(name)) {
      issues.push("models." + name + ": DTO/customMethods configuration references an invalid model");
    }
  }
}

/**
 * Validate + normalize a manifest object. Returns a frozen normalized manifest.
 * This function has no side effects on the filesystem; generation happens later.
 */
function validateManifest(json, options = {}) {
  const issues = [];

  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new ManifestError(options.filePath || "manifest", [
      "root must be a JSON object",
    ]);
  }

  const projectConfig = options.config || {};
  const infrastructure = options.infrastructure || {};
  const frontendManifest = options.frontendManifest || {};
  const uiTemplate = options.uiTemplate || (json.ui && json.ui.theme) || {};
  json = {
    ...json,
    app: { ...(json.app || {}), ...(projectConfig.app || {}) },
    persistence: {
      ...(json.persistence || {}),
      ...(infrastructure.persistence || {}),
    },
    capabilities: {
      ...(json.capabilities || {}),
      ...(infrastructure.capabilities || {}),
    },
    services: {
      ...(json.services || {}),
      ...(infrastructure.services || {}),
    },
    outputs: projectConfig.outputs || json.outputs || {},
    ui: {
      ...(json.ui || {}),
      enabled:
        frontendManifest.enabled === undefined
          ? json.ui && json.ui.enabled
          : frontendManifest.enabled,
      theme: uiTemplate,
    },
  };
  if (options.overrides) {
    const overrides = options.overrides;
    json.persistence = { ...json.persistence, ...(overrides.persistence || {}) };
    json.capabilities = { ...json.capabilities, ...(overrides.capabilities || {}) };
    json.services = { ...json.services, ...(overrides.services || {}) };
    json.outputs = { ...json.outputs, ...(overrides.outputs || {}) };
  }

  const lab = json.lab;
  const studio = json.studio;

  if (typeof lab !== "string" || !LAB_PATTERN.test(lab)) {
    issues.push(
      'lab: must be a non-empty identifier (letters, digits, space, "-", "_")',
    );
  }
  if (typeof studio !== "string" || !STUDIO_PATTERN.test(studio)) {
    issues.push(
      'studio: must be a non-empty identifier (letters, digits, space, "-", "_")',
    );
  }

  // ---- application metadata ------------------------------------------------
  const rawApp = json.app && typeof json.app === "object" ? json.app : {};
  const appName =
    typeof rawApp.name === "string"
      ? rawApp.name
      : typeof lab === "string"
        ? kebab(lab)
        : undefined;
  if (appName !== undefined && !APP_NAME_PATTERN.test(appName)) {
    issues.push(
      'app.name: must be lowercase kebab-case (e.g. "inventory-studio")',
    );
  }
  const api = {
    prefix:
      typeof rawApp.apiPrefix === "string"
        ? rawApp.apiPrefix.replace(/^\/+|\/+$/g, "")
        : "api",
    version:
      typeof rawApp.apiVersion === "string" ? rawApp.apiVersion : undefined,
    port: Number.isInteger(rawApp.port) ? rawApp.port : 3000,
    corsOrigin:
      typeof rawApp.corsOrigin === "string"
        ? rawApp.corsOrigin
        : "http://localhost:5173",
  };
  if (
    rawApp.apiVersion !== undefined &&
    !/^[0-9]+(\.[0-9]+)?$/.test(String(rawApp.apiVersion))
  ) {
    issues.push('app.apiVersion: must be numeric (e.g. "1")');
  }
  if (
    rawApp.outDir !== undefined &&
    (typeof rawApp.outDir !== "string" || rawApp.outDir.trim() === "")
  ) {
    issues.push("app.outDir: must be a non-empty path");
  }

  // ---- persistence ---------------------------------------------------------
  const rawPersistence =
    json.persistence && typeof json.persistence === "object"
      ? json.persistence
      : {};
  const provider =
    rawPersistence.provider === undefined ? "prisma" : rawPersistence.provider;
  const database = rawPersistence.database === undefined
    ? "postgres"
    : rawPersistence.database === "mongo"
      ? "mongodb"
      : rawPersistence.database;
  const schema =
    rawPersistence.schema === undefined ? "public" : rawPersistence.schema;
  if (provider !== "prisma") {
    issues.push('persistence.provider: only "prisma" is supported');
  }
  if (!["postgres", "mongodb"].includes(database)) {
    issues.push('persistence.database: must be "postgres" or "mongodb"');
  }
  if (
    database === "postgres" &&
    (typeof schema !== "string" || !/^[a-z][a-z0-9_]*$/.test(schema))
  ) {
    issues.push("persistence.schema: must be a lowercase postgres schema name");
  }

  // ---- enums ---------------------------------------------------------------
  const enums = new Map();
  if (json.enums !== undefined && !Array.isArray(json.enums)) {
    issues.push("enums: must be an array");
  }
  (Array.isArray(json.enums) ? json.enums : []).forEach((item, index) => {
    const prefix = "enums[" + index + "]";
    if (!item || typeof item !== "object") {
      issues.push(prefix + ": must be an object");
      return;
    }
    if (typeof item.name !== "string" || !ENUM_PATTERN.test(item.name)) {
      issues.push(prefix + ".name: enum name must be PascalCase");
      return;
    }
    if (enums.has(item.name)) {
      issues.push(prefix + ".name: duplicate enum `" + item.name + "`");
      return;
    }
    const values = item.values;
    if (!Array.isArray(values) || values.length === 0) {
      issues.push(
        prefix + ".values: must be a non-empty array of unique names",
      );
      return;
    }
    if (!Array.isArray(item.values)) return;
    if (
      item.values.some(
        (v) => typeof v !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v),
      )
    ) {
      issues.push(
        prefix +
          ".values: enum values must be identifiers (letters, digits, underscore)",
      );
      return;
    }
    if (new Set(values).size !== values.length) {
      issues.push(prefix + ".values: values must be unique");
      return;
    }
    enums.set(item.name, { name: item.name, values: [...values] });
  });

  // ---- models --------------------------------------------------------------
  const models = [];
  const modelNames = new Set();

  if (!Array.isArray(json.models) || json.models.length === 0) {
    issues.push("models: must be a non-empty array");
  }

  (Array.isArray(json.models) ? json.models : []).forEach((rawModel, index) => {
    const prefix = "models[" + index + "]";
    if (!rawModel || typeof rawModel !== "object") {
      issues.push(prefix + ": must be an object");
      return;
    }
    if (
      typeof rawModel.name !== "string" ||
      !MODEL_PATTERN.test(rawModel.name)
    ) {
      issues.push(prefix + ".name: model name must be PascalCase");
      return;
    }
    if (modelNames.has(rawModel.name)) {
      issues.push(prefix + ".name: duplicate model `" + rawModel.name + "`");
      return;
    }
    modelNames.add(rawModel.name);

    let normalized;
    try {
      normalized = normalizeModel(rawModel, index, enums);
    } catch (error) {
      issues.push(error.message);
      return;
    }

    models.push(normalized);
  });

  // ---- CRUD / operations / search / sorting --------------------------------
  const operations = json.operations;
  if (
    operations !== undefined &&
    (!operations || typeof operations !== "object" || Array.isArray(operations))
  ) {
    issues.push("operations: must be an object keyed by model name");
  }
  const DEFAULT_OPERATIONS = ["create", "read", "update", "delete"];

  for (const model of models) {
    const requested = (operations && operations[model.name]) || undefined;
    let enabled = DEFAULT_OPERATIONS;
    if (requested !== undefined) {
      if (
        !Array.isArray(requested) ||
        requested.some((op) => typeof op !== "string")
      ) {
        issues.push(
          "operations." + model.name + ": must be an array of operation names",
        );
        enabled = DEFAULT_OPERATIONS;
      } else if (requested.length === 0) {
        issues.push(
          "operations." + model.name + ": must enable at least one operation",
        );
        enabled = DEFAULT_OPERATIONS;
      } else {
        const invalid = requested.filter(
          (op) =>
            !DEFAULT_OPERATIONS.includes(op) &&
            op !== "list" &&
            op !== "search",
        );
        if (invalid.length) {
          issues.push(
            "operations." +
              model.name +
              ": unsupported operations " +
              invalid.map((op) => "`" + op + "`").join(", ") +
              " (allowed: create, read, update, delete)",
          );
        }
        enabled = DEFAULT_OPERATIONS.filter((op) => requested.includes(op));
        if (enabled.length === 0) enabled = ["read"];
      }
    }
    model.operations = enabled;
  }

  if (
    operations &&
    typeof operations === "object" &&
    !Array.isArray(operations)
  ) {
    for (const key of Object.keys(operations)) {
      if (!modelNames.has(key)) {
        issues.push("operations." + key + ": unknown model");
      }
    }
  }

  const rawSearch = json.search;
  const rawSort = json.sort;
  if (
    rawSearch !== undefined &&
    (!rawSearch || typeof rawSearch !== "object" || Array.isArray(rawSearch))
  ) {
    issues.push("search: must be an object keyed by model name");
  }
  if (
    rawSort !== undefined &&
    (!rawSort || typeof rawSort !== "object" || Array.isArray(rawSort))
  ) {
    issues.push("sort: must be an object keyed by model name");
  }
  for (const model of models) {
    const searchFields = (rawSearch && rawSearch[model.name]) || [];
    if (!Array.isArray(searchFields)) {
      issues.push("search." + model.name + ": must be an array of fields");
    } else {
      for (const fieldName of searchFields) {
        const field = model.writableFields.find((f) => f.name === fieldName);
        if (!field) {
          issues.push(
            "search." + model.name + ": unknown field `" + fieldName + "`",
          );
        } else if (
          field.isArray ||
          !["string", "text"].includes(field.baseType)
        ) {
          issues.push(
            "search." +
              model.name +
              ": `" +
              fieldName +
              "` is not a text-searchable field",
          );
        }
      }
      model.searchFields = searchFields.filter((f) =>
        model.writableFields.some(
          (field) =>
            field.name === f &&
            !field.isArray &&
            ["string", "text"].includes(field.baseType),
        ),
      );
    }

    const sortFields = (rawSort && rawSort[model.name]) || [];
    if (!Array.isArray(sortFields)) {
      issues.push("sort." + model.name + ": must be an array of fields");
    } else {
      for (const fieldName of sortFields) {
        if (!model.fields.some((f) => f.name === fieldName)) {
          issues.push(
            "sort." + model.name + ": unknown field `" + fieldName + "`",
          );
        }
      }
      model.sortFields = sortFields.filter((f) =>
        model.fields.some((field) => field.name === f),
      );
    }
  }
  if (rawSearch && typeof rawSearch === "object") {
    for (const key of Object.keys(rawSearch)) {
      if (!modelNames.has(key))
        issues.push("search." + key + ": unknown model");
    }
  }
  if (rawSort && typeof rawSort === "object") {
    for (const key of Object.keys(rawSort)) {
      if (!modelNames.has(key)) issues.push("sort." + key + ": unknown model");
    }
  }

  // ---- relationships -------------------------------------------------------
  const rawRelations =
    json.relationships === undefined ? [] : json.relationships;
  if (!Array.isArray(rawRelations)) {
    issues.push("relationships: must be an array");
  }
  const relations = [];
  (Array.isArray(rawRelations) ? rawRelations : []).forEach((rel, index) => {
    const prefix = "relationships[" + index + "]";
    if (!rel || typeof rel !== "object") {
      issues.push(prefix + ": must be an object");
      return;
    }
    const from = models.find((m) => m.name === rel.from);
    const to = models.find((m) => m.name === rel.to);
    if (!from) {
      issues.push(prefix + ".from: unknown model `" + String(rel.from) + "`");
      return;
    }
    if (!to) {
      issues.push(prefix + ".to: unknown model `" + String(rel.to) + "`");
      return;
    }
    const fieldName =
      rel.field || to.name.charAt(0).toLowerCase() + to.name.slice(1) + "Id";
    if (!/^[a-z][A-Za-z0-9]*$/.test(fieldName)) {
      issues.push(prefix + ".field: must be camelCase");
      return;
    }
    const fromField = from.writableFields.find((f) => f.name === fieldName);
    if (fromField) {
      if (fromField.type !== "uuid") {
        issues.push(
          prefix +
            ".field: `" +
            from.name +
            "." +
            fieldName +
            "` must be of type uuid",
        );
      }
    } else {
      // Generate the foreign key column automatically.
      from.writableFields.push({
        name: fieldName,
        path: "relationships[" + index + "].field",
        type: "uuid",
        isArray: false,
        baseType: "uuid",
        enumName: null,
        required: rel.required === true,
        optional: rel.required !== true,
        nullable: rel.required !== true,
        unique: false,
        index: true,
        primaryKey: false,
        label: to.label + " Id",
        generatedByRelation: true,
      });
      const idIndex = from.fields.findIndex((f) => f.name === "createdAt");
      from.fields.splice(
        idIndex,
        0,
        from.writableFields[from.writableFields.length - 1],
      );
    }
    if (
      relations.some(
        (existing) =>
          existing.from === from.name && existing.field === fieldName,
      )
    ) {
      issues.push(
        prefix +
          ".field: duplicate relationship field `" +
          from.name +
          "." +
          fieldName +
          "`",
      );
      return;
    }
    relations.push({
      from: from.name,
      to: to.name,
      field: fieldName,
      required: rel.required === true,
      collection:
        rel.collection ||
        to.name.charAt(0).toLowerCase() + to.name.slice(1) + "s",
    });
  });

  for (const rel of relations) {
    const to = models.find((m) => m.name === rel.to);
    const from = models.find((m) => m.name === rel.from);
    if (!/^[a-z][A-Za-z0-9]*$/.test(rel.collection)) {
      issues.push(
        "relationships: invalid collection name `" + rel.collection + "`",
      );
      continue;
    }
    if (
      from.writableFields.some((f) => f.name === rel.collection) ||
      to.fields.some((f) => f.name === rel.field)
    ) {
      issues.push(
        "relationships: generated relation name collides with a field on " +
          rel.from +
          " or " +
          rel.to,
      );
    }
    to.relations = to.relations || [];
    to.relations.push({
      kind: "collection",
      field: rel.collection,
      to: rel.from,
      ownerField: rel.field,
    });
    from.relations = from.relations || [];
    from.relations.push({ kind: "reference", field: rel.field, to: rel.to });
  }

  validateModelOptions(json, models, modelNames, issues);

  // ---- capabilities --------------------------------------------------------
  const capabilities = {};
  if (json.capabilities !== undefined) {
    if (
      !json.capabilities ||
      typeof json.capabilities !== "object" ||
      Array.isArray(json.capabilities)
    ) {
      issues.push("capabilities: must be an object");
    }
  }
  for (const [key, value] of Object.entries(json.capabilities || {})) {
    if (!ACCEPTED_CAPABILITY_NAMES.includes(key)) {
      issues.push(
        "capabilities." +
          key +
          ": unknown capability (allowed: " +
          ACCEPTED_CAPABILITY_NAMES.join(", ") +
          ")",
      );
      continue;
    }
    if (
      typeof value !== "boolean" &&
      (typeof value !== "object" || value === null || Array.isArray(value))
    ) {
      issues.push(
        "capabilities." + key + ': must be a boolean or { "enabled": boolean }',
      );
      continue;
    }
    capabilities[key] = value;
  }

  // ---- UI ------------------------------------------------------------------
  const rawUi = json.ui && typeof json.ui === "object" ? json.ui : {};
  if (rawUi.enabled !== undefined && typeof rawUi.enabled !== "boolean") {
    issues.push("frontend.enabled: must be a boolean");
  }
  const outputs = json.outputs && typeof json.outputs === "object" ? json.outputs : {};
  const targets = {
    webservice: outputs.webservice !== false,
    api: outputs.api !== false,
    frontend: outputs.frontend !== false && rawUi.enabled !== false,
  };
  if (json.outputs !== undefined && (!json.outputs || typeof json.outputs !== "object" || Array.isArray(json.outputs))) {
    issues.push("outputs: must be an object");
  }
  for (const [name, enabled] of Object.entries(outputs)) {
    if (!["webservice", "api", "frontend"].includes(name)) {
      issues.push("outputs." + name + ": unsupported output (allowed: webservice, api, frontend)");
    } else if (typeof enabled !== "boolean") {
      issues.push("outputs." + name + ": must be a boolean");
    }
  }
  if (targets.frontend && !targets.api) {
    issues.push("outputs.frontend: requires outputs.api to be enabled");
  }
  const rawServices = json.services && typeof json.services === "object" ? json.services : {};
  const services = {
    elasticsearch: rawServices.elasticsearch === true,
  };
  if (json.services !== undefined && (!json.services || typeof json.services !== "object" || Array.isArray(json.services))) {
    issues.push("services: must be an object");
  }
  for (const [name, enabled] of Object.entries(rawServices)) {
    if (name !== "elasticsearch") {
      issues.push("services." + name + ": unsupported infrastructure service");
    } else if (typeof enabled !== "boolean") {
      issues.push("services." + name + ": must be a boolean");
    }
  }
  const rawTheme = rawUi.theme && typeof rawUi.theme === "object" ? rawUi.theme : {};
  const rawColors = rawTheme.colors && typeof rawTheme.colors === "object" ? rawTheme.colors : {};
  const rawTypography =
    rawTheme.typography && typeof rawTheme.typography === "object"
      ? rawTheme.typography
      : {};
  const colorNames = [
    "background",
    "surface",
    "surfaceMuted",
    "border",
    "text",
    "textMuted",
    "primary",
    "primaryHover",
    "danger",
    "dangerBackground",
    "success",
    "successBackground",
    "warning",
    "warningBackground",
  ];
  const theme = { colors: {}, typography: {}, radius: "10px" };
  for (const [name, value] of Object.entries(rawColors)) {
    if (!colorNames.includes(name) || typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value)) {
      issues.push("ui.template.colors." + name + ": must be a supported six-digit hex color");
    } else {
      theme.colors[name] = value;
    }
  }
  const fontFamily = rawTypography.fontFamily;
  if (
    fontFamily !== undefined &&
    (typeof fontFamily !== "string" ||
      fontFamily.length > 200 ||
      !/^[A-Za-z0-9 ,'"-]+$/.test(fontFamily))
  ) {
    issues.push("ui.template.typography.fontFamily: contains unsupported characters");
  } else if (fontFamily) {
    theme.typography.fontFamily = fontFamily;
  }
  const fontSize = rawTypography.baseFontSize;
  if (fontSize !== undefined && (typeof fontSize !== "string" || !/^\d{1,2}px$/.test(fontSize))) {
    issues.push("ui.template.typography.baseFontSize: must be a size like `15px`");
  } else if (fontSize) {
    theme.typography.baseFontSize = fontSize;
  }
  const radius = rawTheme.radius;
  if (radius !== undefined && (typeof radius !== "string" || !/^\d{1,2}px$/.test(radius))) {
    issues.push("ui.template.radius: must be a size like `10px`");
  } else if (radius) {
    theme.radius = radius;
  }
  const ui = {
    enabled: rawUi.enabled !== false,
    title:
      typeof rawUi.title === "string" && rawUi.title
        ? rawUi.title
        : typeof studio === "string"
          ? studio + " Studio"
          : "Studio",
    apiBaseUrl:
      typeof rawUi.apiBaseUrl === "string" && rawUi.apiBaseUrl
        ? rawUi.apiBaseUrl
        : "http://localhost:3000",
    theme,
  };

  if (issues.length > 0) {
    throw new ManifestError(options.filePath || "manifest", issues);
  }

  const normalized = {
    filePath: options.filePath,
    app: {
      name: appName,
      title:
        typeof rawApp.title === "string" && rawApp.title
          ? rawApp.title
          : appName,
      description:
        typeof rawApp.description === "string" ? rawApp.description : "",
      outDir:
        typeof rawApp.outDir === "string" && rawApp.outDir.trim()
          ? rawApp.outDir.trim()
          : undefined,
      api,
    },
    lab,
    labSlug: kebab(lab),
    studio,
    studioSlug: kebab(studio),
    description: typeof json.description === "string" ? json.description : "",
    persistence: { provider, database, schema: database === "postgres" ? schema : undefined },
    services,
    outputs: targets,
    capabilities,
    enums: [...enums.values()],
    models,
    relations,
    ui,
    _modelNames: [...modelNames],
    projectFiles: options.projectFiles || {},
  };

  normalized.studioModuleName = pascal(studio) + "Module";
  normalized.studioCamel = camel(studio);
  return normalized;
}

function loadAndValidateManifest(manifestPath, cwd, options = {}) {
  const { absolutePath, json } = loadManifestFile(manifestPath, cwd);
  const files = projectFilesForManifest(absolutePath, options);
  const merge = (base, override) => ({ ...(base || {}), ...(override || {}) });
  return validateManifest(json, {
    filePath: absolutePath,
    config: merge(files.config, options.config),
    infrastructure: merge(files.infrastructure, options.infrastructure),
    frontendManifest: merge(files.frontendManifest, options.frontendManifest),
    uiTemplate: options.uiTemplate || files.uiTemplate,
    overrides: options.overrides,
    projectFiles: files.paths,
  });
}

module.exports = {
  ManifestError,
  loadManifestFile,
  loadProjectInputs,
  loadAndValidateManifest,
  validateManifest,
};
