"use strict";

/**
 * TypeScript type projection of a normalized field descriptor plus the
 * declaration helpers that enforce the required/optional/nullable rules.
 */

const TS_OF_BASE = {
  string: "string",
  text: "string",
  boolean: "boolean",
  int: "number",
  float: "number",
  decimal: "number",
  date: "Date",
  datetime: "Date",
  uuid: "string",
  json: "JsonValue",
};

/** Bare TypeScript type for a normalized field (arrays included). */
function tsType(field) {
  if (field.type === "enum") return field.enumName;
  if (field.isArray) {
    return tsType({ ...field, type: field.baseType, isArray: false }) + "[]";
  }
  return TS_OF_BASE[field.baseType] || "unknown";
}

/** Underlying value type: adds `| null` when nullable, never `?`. */
function tsValueType(field) {
  const base = tsType(field);
  return field.nullable ? base + " | null" : base;
}

/**
 * Class property declaration (domain model).
 *   required              -> `name!: T`
 *   required + nullable   -> `name!: T | null`
 *   optional              -> `name?: T`
 *   optional + nullable   -> `name?: T | null`
 */
function classProperty(field) {
  const assertion = field.optional ? "?" : "!";
  return "  " + field.name + assertion + ": " + tsValueType(field) + ";";
}

/**
 * Interface member / DTO property declaration (no definite assignment).
 *   required              -> `name: T`
 *   required + nullable   -> `name: T | null`
 *   optional              -> `name?: T`
 *   optional + nullable   -> `name?: T | null`
 */
function property(field, options = {}) {
  const optional = options.forceOptional === true || field.optional;
  const nullable = options.dropNullable ? false : field.nullable;
  const type = nullable ? tsType(field) + " | null" : tsType(field);
  return "  " + field.name + (optional ? "?" : "") + ": " + type + ";";
}

/** Update DTO: every field optional, value type unchanged (nullable preserved). */
function updateProperty(field) {
  return property(field, { forceOptional: true });
}

/** Enums used by a set of fields, sorted for deterministic output. */
function enumImports(fields) {
  const names = new Set();
  for (const field of fields) {
    if (field.enumName) names.add(field.enumName);
    if (field.isArray && field.baseType === "enum" && field.enumName)
      names.add(field.enumName);
  }
  return [...names].sort();
}

function usesJson(fields) {
  return fields.some((field) => field.baseType === "json");
}



module.exports = {
  tsType,
  tsValueType,
  classProperty,
  property,
  updateProperty,
  enumImports,
  usesJson,
};
