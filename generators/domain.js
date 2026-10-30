'use strict';

/**
 * Domain layer: enums + POJO models.
 *
 * Models are plain TypeScript classes that do not depend on NestJS or Prisma.
 */

const { classProperty, enumImports } = require('../engine/ts');

function enumBlock(item) {
  return (
    'export enum ' + item.name + ' {\n' +
    item.values.map((value) => "  " + value + " = '" + value + "',").join('\n') +
    '\n}'
  );
}

function generateEnums(ctx) {
  const owned = ctx.studio.manifest.enums;
  if (owned.length === 0) {
    return '// This studio does not declare its own enums.\nexport {};\n';
  }
  return (
    '// Enums owned by this studio (declared in its manifest).\n\n' +
    owned.map(enumBlock).join('\n\n') +
    '\n'
  );
}

function generateBusinessEnums(ctx) {
  const owned = ctx.studio.manifest.enums;
  const ownedNames = new Set(owned.map((item) => item.name));
  const shared = ctx.enums.filter((item) => !ownedNames.has(item.name));
  const seen = new Set();
  const blocks = [];

  for (const item of shared) {
    if (seen.has(item.name)) continue;
    seen.add(item.name);
    blocks.push(enumBlock(item));
  }
  for (const item of owned) {
    blocks.push(
      '// `' + item.name + '` is declared in ./studio-enums and re-exported here.\n' +
        'export { ' + item.name + " } from './studio-enums';"
    );
  }

  if (blocks.length === 0) {
    return '// No business enums are used by this application.\nexport {};\n';
  }
  return (
    '// Application business enums. Declared exactly once and imported by every studio.\n\n' +
    blocks.join('\n\n') +
    '\n'
  );
}

function generateModel(ctx, model) {
  const enums = enumImports(model.writableFields);
  const usesJson = model.fields.some((field) => field.baseType === 'json');
  const related = [];
  for (const reference of model.references || []) {
    if (related.includes(reference.model)) continue;
    related.push(reference.model);
  }
  for (const collection of model.collections || []) {
    if (related.includes(collection.model)) continue;
    related.push(collection.model);
  }

  const lines = [];

  if (enums.length) {
    lines.push("import { " + enums.join(', ') + " } from '../enums/business-enums';", '');
  }
  if (usesJson) {
    lines.push(
      "import type { JsonValue } from '" +
        ctx.rel(model.paths.domain, 'src/shared/types/json') +
        "';",
      '',
    );
  }
  // Relations are typed but imported lazily: `import type` keeps this file free
  // of runtime dependencies (no import cycles between studios).
  for (const name of related) {
    const target = ctx.modelFileByName(name);
    lines.push(
      "import type { " + target.name + " } from '" + ctx.rel(model.paths.domain, target.paths.domain) + "';",
    );
  }
  if (related.length) lines.push('');

  lines.push(
    '/**',
    ' * ' + model.name + ' domain model.',
    ' *',
    ' * Required properties use definite assignment (`!`), optional properties use `?`,',
    ' * and nullable properties are typed `T | null` (nullability is not optionality).',
    ' */',
    'export class ' + model.name + ' {'
  );

  for (const field of model.fields) {
    lines.push(classProperty(field));
  }

  if ((model.references || []).length) {
    lines.push('');
    for (const reference of model.references) {
      const target = ctx.modelFileByName(reference.model);
      lines.push(
        '  /** Related ' + target.name + ' (populated via Prisma include). */',
        '  ' + reference.fieldName + (reference.required ? '!' : '?') + ': ' + target.name + ' | null;',
      );
    }
  }
  if (model.collections && model.collections.length) {
    lines.push('');
    for (const collection of model.collections) {
      const target = ctx.modelFileByName(collection.model);
      lines.push(
        "  /** " + collection.model + " rows referencing this record (populated via Prisma include). */",
        '  ' + collection.field + '?: ' + target.name + '[];'
      );
    }
  }

  lines.push('}', '');
  return lines.join('\n');
}

module.exports = { generateEnums, generateBusinessEnums, generateModel };
