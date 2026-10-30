'use strict';

/**
 * Naming utilities.
 *
 * Every generator must use the *purpose specific* helper below instead of
 * ad-hoc transforms (e.g. `name.toLowerCase()`), otherwise multi-word names
 * such as `PurchaseOrder` produce broken file names and import paths.
 */

const RESERVED_WORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete',
  'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if',
  'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw',
  'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'await',
  'implements', 'interface', 'package', 'private', 'protected', 'public', 'async', 'of'
]);

function splitWords(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

/** `purchaseOrder` / `purchase-order` -> `PurchaseOrder` */
function pascal(value) {
  return splitWords(value)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

/** `PurchaseOrder` / `purchase-order` -> `purchaseOrder` */
function camel(value) {
  const name = pascal(value);
  return name ? name.charAt(0).toLowerCase() + name.slice(1) : '';
}

/** `PurchaseOrder` -> `purchase-order` */
function kebab(value) {
  return splitWords(value).map((word) => word.toLowerCase()).join('-');
}

/** `PurchaseOrder` -> `PURCHASE_ORDER` (env keys, Prisma enums) */
function constant(value) {
  return splitWords(value).map((word) => word.toUpperCase()).join('_');
}

/** `PurchaseOrder` -> `purchase_orders` (Prisma models are mapped to snake_case tables) */
function snake(value) {
  return splitWords(value).map((word) => word.toLowerCase()).join('_');
}

/**
 * `supply-chain` -> `supply_chain` (PostgreSQL schema name of a Lab).
 * Every Lab owns exactly one schema; Studio slugs never take part in it.
 */
function schemaName(value) {
  return snake(value).replace(/[^a-z0-9_]/g, '_');
}

function pluralize(value) {
  const word = String(value);
  if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + 'ies';
  if (/(s|x|z|ch|sh)$/i.test(word)) return word + 'es';
  return word + 's';
}

/** `PurchaseOrder` -> `purchase-orders` (URL segment for a collection) */
function kebabPlural(value) {
  return pluralize(kebab(value));
}

/** `PurchaseOrder` -> `purchaseOrders` (Prisma client delegate, camelCase) */
function camelPlural(value) {
  return camel(pluralize(camel(value)));
}

/** TS variable/parameter safe name. */
function safeName(value) {
  const name = camel(value);
  return RESERVED_WORDS.has(name) ? name + 'Value' : name;
}

function assertIdentifier(value, label, pattern = /^[A-Za-z][A-Za-z0-9_]*$/) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error('Invalid ' + label + ': ' + JSON.stringify(value));
  }
  return value;
}

module.exports = {
  pascal,
  camel,
  kebab,
  constant,
  snake,
  schemaName,
  pluralize,
  kebabPlural,
  camelPlural,
  safeName,
  assertIdentifier,
  RESERVED_WORDS
};
