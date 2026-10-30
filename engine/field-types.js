"use strict";

/**
 * THE single source of truth for how a manifest field is interpreted.
 *
 * Every generator (domain, DTOs, Zod, Prisma, repository, frontend) derives
 * its output from the normalized field descriptor produced here, so the
 * required / optional / nullable semantics can never drift between layers.
 *
 * Semantics:
 *   required=true  (default) -> consumer must send the property
 *   required=false           -> property may be omitted (`?` in TS declarations)
 *   nullable=true            -> value may be `null`
 *
 * `nullable` and optional are independent:
 *   required + nullable          -> `field!: T | null`
 *   optional + nullable          -> `field?: T | null`
 *   optional + not nullable      -> `field?: T`
 *   required + not nullable      -> `field!: T`  (classes) / `field: T` (interfaces & DTOs)
 */

const FIELD_TYPES = [
  "string",
  "text",
  "boolean",
  "int",
  "float",
  "decimal",
  "date",
  "datetime",
  "uuid",
  "json",
  "enum",
  "string[]",
  "array",
];

const ID_TYPES = new Set(["uuid", "string", "int"]);

/** Name of the implicit primary key column added to every model. */
const ID_FIELD = "id";

function normalizationError(path, message) {
  const error = new Error(path + ": " + message);
  error.isFieldError = true;
  return error;
}

/**
 * Normalize a raw manifest field into the canonical descriptor.
 * Throws an actionable error (with the field path) for invalid definitions.
 */
function normalizeField(rawField, path, enums) {
  if (!rawField || typeof rawField !== "object" || Array.isArray(rawField)) {
    throw normalizationError(path, "field definition must be an object");
  }

  const name = rawField.name;
  if (typeof name !== "string" || !/^[a-z][A-Za-z0-9]*$/.test(name)) {
    throw normalizationError(
      path + ".name",
      "field name must be camelCase and start with a letter",
    );
  }
  if (name === ID_FIELD) {
    throw normalizationError(
      path + ".name",
      "the primary key field `id` is generated automatically; remove it from the manifest",
    );
  }

  const fieldPath = path + "." + name;
  let type = rawField.type;
  if (type === "array") {
    const item = rawField.items || rawField.itemType;
    if (typeof item !== "string" || !item) {
      throw normalizationError(
        fieldPath + ".items",
        "`array` fields require `items` (the item type)",
      );
    }
    if (item === "enum") {
      throw normalizationError(
        fieldPath + ".items",
        "arrays of enums are not supported; use a JSON field or a separate model",
      );
    }
    type = item + "[]";
  }

  if (!FIELD_TYPES.includes(type)) {
    throw normalizationError(
      fieldPath + ".type",
      "unsupported type `" +
        String(rawField.type) +
        "`; expected one of: " +
        FIELD_TYPES.join(", "),
    );
  }

  if (type.endsWith("[]") && !(rawField.items || rawField.itemType)) {
    // Explicit `string[]` is allowed; validate the item type exists.
    const item = type.slice(0, -2);
    if (
      !FIELD_TYPES.includes(item) ||
      item.endsWith("[]") ||
      item === "enum" ||
      item === "array"
    ) {
      throw normalizationError(
        fieldPath + ".type",
        "unsupported array item type `" + item + "`",
      );
    }
  }

  if (
    typeof rawField.required !== "boolean" &&
    rawField.required !== undefined
  ) {
    throw normalizationError(fieldPath + ".required", "must be a boolean");
  }
  if (
    typeof rawField.nullable !== "boolean" &&
    rawField.nullable !== undefined
  ) {
    throw normalizationError(fieldPath + ".nullable", "must be a boolean");
  }

  const required = rawField.required !== false;
  const nullable = rawField.nullable === true;

  if (
    rawField.primaryKey === true ||
    rawField.unique === true ||
    rawField.index === true
  ) {
    // supported flags
  }

  let enumName = null;
  if (type === "enum" || type === "enum[]") {
    enumName = rawField.enum;
    if (typeof enumName !== "string" || !enumName) {
      throw normalizationError(
        fieldPath + ".enum",
        "enum fields require `enum` (the enum name)",
      );
    }
    if (enums && !enums.has(enumName)) {
      throw normalizationError(
        fieldPath + ".enum",
        "undefined enum `" + enumName + "`",
      );
    }
  }

  const positional = ["id", "createdAt", "updatedAt"];
  if (positional.includes(name)) {
    throw normalizationError(
      fieldPath + ".name",
      "`" + name + "` is reserved and generated automatically",
    );
  }

  return {
    name,
    path: fieldPath,
    type,
    isArray: type.endsWith("[]"),
    baseType: type.endsWith("[]") ? type.slice(0, -2) : type,
    enumName,
    required,
    optional: !required,
    nullable,
    unique: rawField.unique === true,
    index: rawField.index === true,
    primaryKey: false,
    default: rawField.default,
    label:
      typeof rawField.label === "string" && rawField.label
        ? rawField.label
        : humanize(name),
    description:
      typeof rawField.description === "string"
        ? rawField.description
        : undefined,
  };
}

function humanize(name) {
  const spaced = String(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The implicit `id` field (UUID primary key) present on every model. */
function idField() {
  return {
    name: ID_FIELD,
    path: "id",
    type: "uuid",
    isArray: false,
    baseType: "uuid",
    enumName: null,
    required: true,
    optional: false,
    nullable: false,
    unique: true,
    index: false,
    primaryKey: true,
    label: "Id",
  };
}

/** The implicit timestamp fields (managed by the database). */
function systemFields() {
  const base = {
    isArray: false,
    enumName: null,
    required: true,
    optional: false,
    nullable: false,
    unique: false,
    index: false,
    primaryKey: false,
    baseType: "datetime",
    type: "datetime",
  };
  return [
    { ...base, name: "createdAt", path: "createdAt", label: "Created At" },
    { ...base, name: "updatedAt", path: "updatedAt", label: "Updated At" },
  ];
}

/** Fields that are user-writable (excludes system-managed columns). */
function userFields(model) {
  return model.fields.filter((field) => !field.primaryKey && !field.readOnly);
}

/** Build a normalized model descriptor. */
function normalizeModel(rawModel, index, enums) {
  const path = "models[" + index + "]";
  if (!rawModel || typeof rawModel !== "object" || Array.isArray(rawModel)) {
    throw normalizationError(path, "model definition must be an object");
  }

  const fields = Array.isArray(rawModel.fields) ? rawModel.fields : null;
  if (!fields || fields.length === 0) {
    throw normalizationError(path + ".fields", "must be a non-empty array");
  }

  const seen = new Set([ID_FIELD, "createdAt", "updatedAt"]);
  const normalizedFields = fields.map((field, fieldIndex) => {
    const normalized = normalizeField(
      field,
      path + ".fields[" + fieldIndex + "]",
      enums,
    );
    if (seen.has(normalized.name)) {
      throw normalizationError(
        normalized.path + ".name",
        "duplicate field name `" + normalized.name + "`",
      );
    }
    seen.add(normalized.name);
    return normalized;
  });

  return {
    name: rawModel.name,
    label: rawModel.label || humanize(rawModel.name),
    path,
    id: idField(),
    fields: [idField(), ...normalizedFields, ...systemFields()],
    writableFields: normalizedFields,
    relations: [],
    searchFields: [],
    sortFields: [],
  };
}

module.exports = {
  FIELD_TYPES,
  ID_TYPES,
  ID_FIELD,
  normalizeField,
  normalizeModel,
  userFields,
  humanize,
};
