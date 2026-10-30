"use strict";

/**
 * Application layer: Zod schemas, DTOs (nestjs-zod), repository contracts,
 * mapper interfaces, use cases (application services) and domain events.
 */

const {
  property,
  updateProperty,
  enumImports,
  tsType,
  usesJson,
} = require("../engine/ts");
const { pascal } = require("../engine/naming");

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

function zodExpression(field) {
  if (field.isArray) {
    const inner = zodScalar({ ...field, type: field.baseType, isArray: false });
    let expression = "z.array(" + inner + ")";
    if (!field.optional) expression += ".min(1)";
    return expression;
  }
  return zodScalar(field);
}

function zodScalar(field) {
  const base = field.baseType;
  switch (base) {
    case "string":
      return field.unique
        ? "z.string().min(1).max(191)"
        : "z.string().min(1).max(10000)";
    case "text":
      return "z.string().max(100000)";
    case "boolean":
      return "z.boolean()";
    case "int":
      return "z.number().int()";
    case "float":
      return "z.number()";
    case "decimal":
      return "z.number().multipleOf(0.0001)";
    case "uuid":
      return "z.string().uuid()";
    case "date":
      return "z.coerce.date()";
    case "datetime":
      return "z.coerce.date()";
    case "json":
      return "z.record(z.string(), z.unknown())";
    case "enum":
      if (!field.enumName)
        throw new Error("Enum field without enum name: " + field.name);
      return "z.nativeEnum(" + field.enumName + ")";
    default:
      throw new Error(
        "No Zod mapping for field type `" +
          field.type +
          "` (" +
          field.name +
          ")",
      );
  }
}

/** Required/optional and nullable are applied independently, in that order. */
function withModifiers(expression, field, options = {}) {
  let result = expression;
  if (field.nullable) result += ".nullable()";
  if (options.forceOptional || field.optional) result += ".optional()";
  return result;
}

function zodObject(fields) {
  return fields
    .map((line) => "  " + line.name + ": " + line.expression + ",")
    .join("\n");
}

function queryFilterSchema(field) {
  const scalar = zodScalar(field);
  const operators = [];
  if (["string", "text"].includes(field.baseType)) {
    operators.push(
      "eq: " + scalar + ".optional()",
      "ne: " + scalar + ".optional()",
      "in: z.array(" + scalar + ").optional()",
      "notIn: z.array(" + scalar + ").optional()",
      "contains: z.string().max(500).optional()",
      "startsWith: z.string().max(500).optional()",
      "endsWith: z.string().max(500).optional()",
    );
  } else if (["int", "float", "decimal", "date", "datetime"].includes(field.baseType)) {
    operators.push(
      "eq: " + scalar + ".optional()",
      "ne: " + scalar + ".optional()",
      "in: z.array(" + scalar + ").optional()",
      "notIn: z.array(" + scalar + ").optional()",
      "gt: " + scalar + ".optional()",
      "gte: " + scalar + ".optional()",
      "lt: " + scalar + ".optional()",
      "lte: " + scalar + ".optional()",
    );
  } else {
    operators.push(
      "eq: " + scalar + ".optional()",
      "ne: " + scalar + ".optional()",
      "in: z.array(" + scalar + ").optional()",
      "notIn: z.array(" + scalar + ").optional()",
    );
  }
  return "z.union([" + scalar + ", z.object({ " + operators.join(", ") + " }).strict()])";
}

function generateSchemas(ctx, model) {
  const fields = model.writableFields;
  const createFields = fields.filter((field) => model.dtoFields.create.includes(field.name));
  const updateFields = fields.filter((field) => model.dtoFields.update.includes(field.name));
  const queryFields = fields.filter((field) => model.dtoFields.query.includes(field.name));
  const dtoFieldNames = new Set([
    ...model.dtoFields.create,
    ...model.dtoFields.update,
    ...model.dtoFields.query,
  ]);
  const enums = enumImports(fields.filter((field) => dtoFieldNames.has(field.name)));
  const lines = [];
  const enumsPath = ctx.rel(
    model.paths.schema,
    "src/labs/" +
      model.manifest.labSlug +
      "/studios/" +
      model.manifest.studioSlug +
      "/domain/enums/business-enums",
  );

  lines.push("import { z } from 'zod';");
  if (enums.length) {
    lines.push("import { " + enums.join(", ") + " } from '" + enumsPath + "';");
  }
  if (model.collections && model.collections.length) {
    lines.push(
      "import type { " +
        model.name +
        " } from '" +
        ctx.rel(model.paths.schema, model.paths.domain) +
        "';",
    );
  }
  lines.push("");

  const readable =
    model.collections && model.collections.length
      ? ", " + model.collections.map((c) => c.field).join(", ")
      : "";
  lines.push(
    "/** Write schema used by create/update requests. */",
    "export const " + model.names.createSchema + " = z.object({",
    zodObject(
      createFields.map((field) => ({
        name: field.name,
        expression: withModifiers(zodExpression(field), field),
      })),
    ),
    "}).strict();",
    "",
    "export type " +
      model.name +
      "CreateInput = z.infer<typeof " +
      model.names.createSchema +
      ">;",
    "",
    "export const " + model.names.updateSchema + " = z",
    "  .object({",
    zodObject(
      updateFields.map((field) => ({
        name: field.name,
        expression: withModifiers(zodExpression(field), field, {
          forceOptional: true,
        }),
      })),
    ),
    "  })",
    "  .strict()",
    "  .refine((value) => Object.keys(value).length > 0, {",
    "    message: 'At least one field must be provided',",
    "  });",
    "",
    "export type " +
      model.name +
      "UpdateInput = z.infer<typeof " +
      model.names.updateSchema +
      ">;",
    "",
  );

  const sortable = model.sortFields.length
    ? model.sortFields
    : ["createdAt"];
  const defaultSort = sortable.includes("createdAt") ? "createdAt" : sortable[0];
  lines.push(
    "export const " +
      model.name +
      "SORTABLE_FIELDS = [" +
      sortable.map((f) => "'" + f + "'").join(", ") +
      "] as const;",
    "",
    "/** Query schema: pagination, free-text search, filtering and sorting. */",
    "export const " + model.names.querySchema + " = z.object({",
    "  page: z.coerce.number().int().min(1).default(1),",
    "  pageSize: z.coerce.number().int().min(1).max(100).default(20),",
    "  search: z.string().trim().max(200).optional(),",
    "  filters: z.preprocess((value) => {",
    "    if (typeof value !== 'string') return value;",
    "    try { return JSON.parse(value); } catch { return value; }",
    "  }, z.object({",
    ...queryFields.map(
      (field) =>
        "    " + field.name + ": " + queryFilterSchema(field) + ".optional(),",
    ),
    "  }).strict()).optional(),",
    "  filterMode: z.enum(['and', 'or']).default('and'),",
    "  sort: z.preprocess((value) => {",
    "    if (typeof value !== 'string') return value;",
    "    try { return JSON.parse(value); } catch {",
    "      return value.split(',').filter(Boolean).map((part) => {",
    "        const [field, direction = 'asc'] = part.split(':');",
    "        return { field, direction };",
    "      });",
    "    }",
    "  }, z.array(z.object({",
    "    field: z.enum(" + model.name + "SORTABLE_FIELDS),",
    "    direction: z.enum(['asc', 'desc']),",
    "  }).strict()).min(1).max(8).default([{ field: '" + defaultSort + "', direction: 'desc' }])),",
    "// Backward-compatible single-field sorting.",
    "  sortBy: z.enum(" + model.name + "SORTABLE_FIELDS).optional(),",
    "  sortDir: z.enum(['asc', 'desc']).optional(),",
  );

  for (const field of queryFields) {
    if (field.isArray || field.type === "json") {
      // Filtering an array/JSON column by equality is not supported.
      continue;
    }
    if (field.baseType === "boolean") {
      lines.push(
        "  " +
          field.name +
          ": z.enum(['true', 'false']).transform((value) => value === 'true').optional(),",
      );
    } else if (
      field.baseType === "int" ||
      field.baseType === "float" ||
      field.baseType === "decimal"
    ) {
      lines.push("  " + field.name + ": z.coerce.number().optional(),");
    } else if (field.baseType === "uuid" && !field.enumName) {
      lines.push("  " + field.name + ": z.string().uuid().optional(),");
    } else if (field.baseType === "date" || field.baseType === "datetime") {
      lines.push("  " + field.name + ": z.coerce.date().optional(),");
    } else if (field.baseType === "enum") {
      lines.push(
        "  " +
          field.name +
          ": z.nativeEnum(" +
          field.enumName +
          ").optional(),",
      );
    } else {
      lines.push("  " + field.name + ": z.string().max(500).optional(),");
    }
  }

  lines.push(
    "});",
    "",
    "export type " +
      model.name +
      "Query = z.infer<typeof " +
      model.names.querySchema +
      ">;",
    "",
    "export interface " + model.name + "Filter {",
    "  skip: number;",
    "  take: number;",
    "  search?: string;",
    "  orderBy: Array<Partial<Record<(typeof " + model.name + "SORTABLE_FIELDS)[number], 'asc' | 'desc'>>>;",
    "  where: Record<string, unknown>;",
    "}",
    "",
  );

  if (readable) {
    lines.push(
      "export type " +
        model.name +
        "WithRelations = " +
        model.name +
        " & { " +
        readable.trimStart().slice(2) +
        "?: unknown };",
      "",
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// DTO classes (nestjs-zod createZodDto)
// ---------------------------------------------------------------------------

function generateDtos(ctx, model) {
  const dtoFields = new Set([
    ...model.dtoFields.create,
    ...model.dtoFields.update,
    ...model.dtoFields.query,
  ]);
  const enums = enumImports(model.writableFields.filter((field) => dtoFields.has(field.name)));
  const lines = ["import { createZodDto } from 'nestjs-zod';"];
  if (enums.length) {
    lines.push(
      "import { " +
        enums.join(", ") +
        " } from '" +
        ctx.rel(
          model.paths.dto,
          "src/labs/" +
            model.manifest.labSlug +
            "/studios/" +
            model.manifest.studioSlug +
            "/domain/enums/business-enums",
        ) +
        "';",
    );
  }
  lines.push(
    "import {",
    "  " + model.names.createSchema + ",",
    "  " + model.names.querySchema + ",",
    "  " + model.names.updateSchema + ",",
    "} from '../validators/" + model.routeSingle + ".schemas';",
    "",
    "/** Request body for POST /" +
      model.route +
      " (validated by ZodValidationPipe). */",
    "export class " +
      model.names.createDto +
      " extends createZodDto(" +
      model.names.createSchema +
      ") {}",
    "",
    "/** Request body for PATCH /" +
      model.route +
      "/:id. Every field is optional. */",
    "export class " +
      model.names.updateDto +
      " extends createZodDto(" +
      model.names.updateSchema +
      ") {}",
    "",
    "/** Query string for GET /" + model.route + ". */",
    "export class " +
      model.names.queryDto +
      " extends createZodDto(" +
      model.names.querySchema +
      ") {}",
    "",
  );
  return lines.join("\n");
}

/** Plain DTO classes kept for consumers that prefer classic class DTOs. */
function generatePlainDtos(ctx, model) {
  const enums = enumImports(model.writableFields);
  const lines = [];
  if (enums.length) {
    lines.push(
      "import { " +
        enums.join(", ") +
        " } from '../../domain/enums/business-enums';",
      "",
    );
  }
  lines.push(
    "export class " + model.names.createDto + " {",
    model.writableFields.map((field) => property(field)).join("\n"),
    "}",
    "",
    "export class " + model.names.updateDto + " {",
    model.writableFields.map((field) => updateProperty(field)).join("\n"),
    "}",
    "",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

function generateRepositoryContract(ctx, model) {
  const enums = enumImports(model.writableFields);
  const idType = ctx.modelByName(model.name).idType;
  const duplicateFieldType = model.writableFields.length
    ? model.writableFields.map((field) => "'" + field.name + "'").join(" | ")
    : "never";
  const relationFields = (model.relations || [])
    .filter((relation) => relation.kind === "reference")
    .map((relation) => relation.field);
  const relationFieldType = relationFields.length
    ? relationFields.map((field) => "'" + field + "'").join(" | ")
    : "never";
  const lines = [];
  if (enums.length) {
    lines.push(
      "import type { " +
        enums.join(", ") +
        " } from '../../domain/enums/business-enums';",
    );
  }
  lines.push(
    "import type { " +
      model.name +
      " } from '../../domain/models/" +
      model.routeSingle +
      ".model';",
    "import type { " +
      model.name +
      "Filter } from '../validators/" +
      model.routeSingle +
      ".schemas';",
    "",
    "/**",
    " * Repository contract owned by the application layer.",
    " * The persistence layer implements it; the application layer never imports Prisma.",
    " */",
    "export interface " + model.names.repositoryContract + " {",
    "  findById(id: " + idType + "): Promise<" + model.name + " | null>;",
    "  findMany(filter: " +
      model.name +
      "Filter): Promise<{ items: " +
      model.name +
      "[]; total: number }>;",
    "  create(entity: " + model.name + "): Promise<" + model.name + ">;",
    "  update(id: " +
      idType +
      ", changes: Partial<" +
      model.name +
      ">): Promise<" +
      model.name +
      " | null>;",
    "  delete(id: " + idType + "): Promise<boolean>;",
    "  exists(id: " + idType + "): Promise<boolean>;",
    "  createOne(entity: " + model.name + "): Promise<" + model.name + ">;",
    "  createMany(entities: " + model.name + "[]): Promise<number>;",
    "  updateOne(id: " + idType + ", changes: Partial<" + model.name + ">): Promise<" + model.name + " | null>;",
    "  updateMany(where: Record<string, unknown>, changes: Partial<" + model.name + ">): Promise<number>;",
    "  hardDeleteOne(id: " + idType + "): Promise<boolean>;",
    "  hardDeleteMany(ids: " + idType + "[]): Promise<number>;",
    "  softDeleteOne(id: " + idType + "): Promise<boolean>;",
    "  softDeleteMany(ids: " + idType + "[]): Promise<number>;",
    "  restoreOne(id: " + idType + "): Promise<boolean>;",
    "  restoreMany(ids: " + idType + "[]): Promise<number>;",
    "  getOneById(id: " + idType + "): Promise<" + model.name + " | null>;",
    "  getAll(filter: " + model.name + "Filter): Promise<{ items: " + model.name + "[]; total: number }>;",
    "  search(filter: " + model.name + "Filter): Promise<{ items: " + model.name + "[]; total: number }>;",
    "  checkDuplicate(field: " + duplicateFieldType + ", value: unknown, excludeId?: " + idType + "): Promise<boolean>;",
    "  checkRelation(field: " + relationFieldType + ", relatedId: " + idType + "): Promise<boolean>;",
    "  isExisted(id: " + idType + "): Promise<boolean>;",
    ...model.customMethods.map((custom) => {
      const parameters = custom.fields
        .map((fieldName) => {
          const field = model.writableFields.find((candidate) => candidate.name === fieldName);
          return fieldName + ": " + repositoryContractFieldType(field);
        })
        .join(", ");
      const result =
        custom.operation === "findOneBy"
          ? "Promise<" + model.name + " | null>"
          : custom.operation === "findManyBy"
            ? "Promise<" + model.name + "[]>"
            : custom.operation === "countBy"
              ? "Promise<number>"
              : "Promise<boolean>";
      return "  " + custom.name + "(" + parameters + "): " + result + ";";
    }),
    "}",
    "",
  );
  return lines.join("\n");
}

function repositoryContractFieldType(field) {
  switch (field.baseType) {
    case "string":
    case "text":
    case "uuid":
    case "enum":
      return "string";
    case "boolean":
      return "boolean";
    case "int":
    case "float":
    case "decimal":
      return "number";
    case "date":
    case "datetime":
      return "Date";
    default:
      return "unknown";
  }
}

function generateTokens(model) {
  return (
    "/** DI token for the " +
    model.name +
    " repository implementation. */\n" +
    "export const " +
    model.names.token +
    " = Symbol('" +
    model.names.repositoryContract +
    "');\n"
  );
}

function generateServiceContract(ctx, model) {
  const enums = enumImports(model.writableFields);
  const lines = [];
  if (enums.length) {
    lines.push(
      "import type { " +
        enums.join(", ") +
        " } from '../../domain/enums/business-enums';",
    );
  }
  lines.push(
    "import type { " +
      model.name +
      " } from '../../domain/models/" +
      model.routeSingle +
      ".model';",
    "import type { " +
      model.names.createDto +
      ", " +
      model.names.queryDto +
      ", " +
      model.names.updateDto +
      " } from '../dtos/" +
      model.routeSingle +
      ".dto';",
    "",
    "export interface " + model.names.serviceContract + " {",
    "  findById(id: string): Promise<" + model.name + ">;",
    "  findAll(query: " + model.names.queryDto + "): Promise<{",
    "    items: " + model.name + "[];",
    "    total: number;",
    "    pageSize: number;",
    "    totalPages: number;",
    "  }>;",
    "  create(input: " +
      model.names.createDto +
      "): Promise<" +
      model.name +
      ">;",
    "  update(id: string, input: " +
      model.names.updateDto +
      "): Promise<" +
      model.name +
      ">;",
    "  remove(id: string): Promise<{ deleted: true; id: string }>;",
    "}",
    "",
  );
  return lines.join("\n");
}

function generateMapperContract(ctx, model) {
  return (
    "import type { " +
    model.name +
    " } from '" +
    ctx.rel(model.paths.mapper, model.paths.domain) +
    "';\n\n" +
    "/** Maps a persistence row to the domain model. */\n" +
    "export interface " +
    model.name +
    "MapperContract {\n" +
    "  toDomain(row: unknown): " +
    model.name +
    ";\n" +
    "  toCreateData(entity: " +
    model.name +
    "): Record<string, unknown>;\n" +
    "  toUpdateData(changes: Partial<" +
    model.name +
    ">): Record<string, unknown>;\n" +
    "}\n"
  );
}

// ---------------------------------------------------------------------------
// Use cases / application service
// ---------------------------------------------------------------------------

function generateUseCases(ctx, model) {
  const enums = enumImports(model.writableFields);
  const root = model.root;
  const lines = [];
  if (enums.length) {
    lines.push(
      "import { " +
        enums.join(", ") +
        " } from '../../domain/enums/business-enums';",
    );
  }
  lines.push(
    "import { Inject, Injectable, NotFoundException } from '@nestjs/common';",
    "import { randomUUID } from 'node:crypto';",
    "import { " +
      model.name +
      " } from '../../domain/models/" +
      model.routeSingle +
      ".model';",
    "import type { " +
      model.name +
      "Filter } from '../validators/" +
      model.routeSingle +
      ".schemas';",
    "import type { " +
      model.names.repositoryContract +
      " } from '../contracts/" +
      model.routeSingle +
      ".repository.contract';",
    "import { " +
      model.names.token +
      " } from '../contracts/" +
      model.routeSingle +
      ".tokens';",
    "import { " +
      model.names.createDto +
      ", " +
      model.names.queryDto +
      ", " +
      model.names.updateDto +
      " } from '../dtos/" +
      model.routeSingle +
      ".dto';",
    "import type { " +
      model.names.serviceContract +
      " } from '../contracts/" +
      model.routeSingle +
      ".service.contract';",
  );

  lines.push(
    "import { RequestContext } from '" +
      ctx.rel(model.paths.useCases, "src/shared/context/request-context") +
      "';",
  );
  if (ctx.has("cache")) {
    lines.push(
      "import { CACHE_MANAGER } from '@nestjs/cache-manager';",
      "import type { Cache } from 'cache-manager';",
    );
  }
  if (ctx.has("outbox")) {
    lines.push(
      "import { OutboxService } from '" +
        ctx.rel(model.paths.useCases, "src/platform/communication/outbox/outbox.service") +
        "';",
      "import { " +
        model.name +
        "CreatedEvent, " +
        model.name +
        "UpdatedEvent, " +
        model.name +
        "DeletedEvent } from '../events/" +
        model.routeSingle +
        ".events';",
    );
  }

  const hasTenant = true;

  const filterLines = [
    "  private toFilter(query: " +
      model.names.queryDto +
      "): " +
      model.name +
      "Filter {",
    "    const where: Record<string, unknown> = {};",
  ];
  for (const field of model.writableFields.filter((item) =>
    model.dtoFields.query.includes(item.name),
  )) {
    if (field.isArray || field.baseType === "json") continue;
    filterLines.push(
      "    if (query." +
        field.name +
        " !== undefined) where." +
        field.name +
        " = query." +
        field.name +
        ";",
      "    const " +
        field.name +
        "Filter = query.filters?." +
        field.name +
        ";",
      "    if (" +
        field.name +
        "Filter !== undefined) {",
      "      if (typeof " +
        field.name +
        "Filter === 'object' && " +
        field.name +
        "Filter !== null) {",
      "        const operators = { ...(" +
        field.name +
        "Filter as Record<string, unknown>) };",
      "        if ('eq' in operators) { operators.equals = operators.eq; delete operators.eq; }",
      "        if ('ne' in operators) { operators.not = operators.ne; delete operators.ne; }",
      ...(field.baseType === "string" || field.baseType === "text"
        ? [
            "        if ('contains' in operators || 'startsWith' in operators || 'endsWith' in operators) operators.mode = 'insensitive';",
          ]
        : []),
      "        where." +
        field.name +
        " = operators;",
      "      } else {",
      "        where." +
        field.name +
        " = " +
        field.name +
        "Filter;",
      "      }",
      "    }",
    );
  }
  if (model.searchFields.length) {
    filterLines.push(
      "    const search = query.search;",
      "    if (search) {",
      "      where.OR = [",
      ...model.searchFields.map(
        (name) =>
          "        { " +
          name +
          ": { contains: search, mode: 'insensitive' } },",
      ),
      "      ];",
      "    }",
    );
  } else {
    filterLines.push("    void query.search;");
  }
  filterLines.push(
    "    if (query.filterMode === 'or') {",
    "      const filterEntries = Object.entries(where).filter(([key]) => key !== 'OR');",
    "      const searchConditions = where.OR;",
    "      delete where.OR;",
    "      const conditions: Record<string, unknown>[] = [];",
    "      if (searchConditions) conditions.push({ OR: searchConditions });",
    "      if (filterEntries.length > 0) {",
    "        conditions.push({ OR: filterEntries.map(([field, value]) => ({ [field]: value })) });",
    "        for (const [field] of filterEntries) delete where[field];",
    "      }",
    "      if (conditions.length > 0) where.AND = conditions;",
    "    }",
    "    return {",
    "      skip: (query.page - 1) * query.pageSize,",
    "      take: query.pageSize,",
    "      search: query.search,",
    "      orderBy: query.sortBy",
    "        ? [{ [query.sortBy]: query.sortDir ?? 'desc' }]",
    "        : query.sort.map(({ field, direction }) => ({ [field]: direction })),",
    "      where,",
    "    };",
    "  }",
    "",
  );

  const createBody = [];
  if (ctx.has("cache")) {
    createBody.push("    await this.invalidateListCache();");
  }
  if (ctx.has("outbox")) {
    createBody.push(
      "    const event = new " +
        model.name +
        "CreatedEvent(randomUUID(), entity.id, { " +
        model.writableFields
          .filter((f) => !f.generatedByRelation)
          .slice(0, 6)
          .map((f) => f.name + ": entity." + f.name)
          .join(", ") +
        " });",
      "    await this.outbox.record(event);",
    );
  }

  const updateBody = [];
  if (ctx.has("cache")) {
    updateBody.push("    await this.invalidateListCache();");
  }
  if (ctx.has("outbox")) {
    updateBody.push(
      "    await this.outbox.record(new " +
        model.name +
        "UpdatedEvent(randomUUID(), updated.id, Object.keys(input)));",
    );
  }

  const cacheHeader = ctx.has("cache")
    ? [
        "  private listCacheKey(query: " + model.names.queryDto + "): string {",
        "    const scope = RequestContext.tenantId() ?? 'global';",
        "    return ['" +
          model.routeSingle +
          "', scope, JSON.stringify(query)].join(':');",
        "  }",
        "",
        "  private async invalidateListCache(): Promise<void> {",
        "    const scope = RequestContext.tenantId() ?? 'global';",
        "    await this.cache.del(this.cachePrefix + scope);",
        "  }",
        "",
      ]
    : [];

  lines.push(
    "",
    "@Injectable()",
    "export class " +
      model.names.service +
      " implements " +
      model.names.serviceContract +
      " {",
    "  constructor(",
    "    @Inject(" + model.names.token + ")",
    "    private readonly repository: " + model.names.repositoryContract + ",",
    ...(ctx.has("cache")
      ? ["    @Inject(CACHE_MANAGER) private readonly cache: Cache,"]
      : []),
    ...(ctx.has("outbox")
      ? ["    private readonly outbox: OutboxService,"]
      : []),
    "  ) {}",
    "",
    ...(ctx.has("cache")
      ? ["  private readonly cachePrefix = '" + model.routeSingle + "::';", ""]
      : []),
    ...cacheHeader,
    ...filterLines,
    "  /** Read one " + model.name + " or fail with 404. */",
    "  async findById(id: string): Promise<" + model.name + "> {",
    "    const entity = await this.repository.findById(id);",
    '    if (!entity) throw new NotFoundException({ code: "RESOURCE_NOT_FOUND", message: "' +
      model.name +
      ' " + id + " not found" });',
    "    return entity;",
    "  }",
    "",
    "  async findAll(query: " + model.names.queryDto + ") {",
    ...(ctx.has("cache")
      ? [
          "    const key = this.listCacheKey(query);",
          "    const cached = await this.cache.get<{ items: " +
            model.name +
            "[]; total: number }>(key);",
          "    const result = cached ?? (await this.repository.findMany(this.toFilter(query)));",
          "    if (!cached) await this.cache.set(key, result, 15_000);",
          "    const totalPages = Math.max(1, Math.ceil(result.total / query.pageSize));",
          "    return { ...result, page: query.page, pageSize: query.pageSize, totalPages };",
        ]
      : [
          "    const result = await this.repository.findMany(this.toFilter(query));",
          "    const totalPages = Math.max(1, Math.ceil(result.total / query.pageSize));",
          "    return { ...result, page: query.page, pageSize: query.pageSize, totalPages };",
        ]),
    "  }",
    "",
    "  async create(input: " +
      model.names.createDto +
      "): Promise<" +
      model.name +
      "> {",
    "    const entity = new " + model.name + "();",
    "    Object.assign(entity, { id: randomUUID() }, this.copyWritable(input));",
    hasTenant
      ? "    // tenantId is never taken from the request body; it comes from the verified identity.\n    delete (entity as unknown as Record<string, unknown>).tenantId;"
      : null,
    "    const created = await this.repository.create(entity);",
    ...createBody,
    "    return created;",
    "  }",
    "",
    "  async update(id: string, input: " +
      model.names.updateDto +
      "): Promise<" +
      model.name +
      "> {",
    "    await this.findById(id);",
    "    const changes = Object.fromEntries(",
    "      Object.entries(input).filter(([, value]) => value !== undefined),",
    "    ) as Partial<" + model.name + ">;",
    "    const updated = await this.repository.update(id, changes);",
    '    if (!updated) throw new NotFoundException({ code: "RESOURCE_NOT_FOUND", message: "' +
      model.name +
      ' " + id + " not found" });',
    ...updateBody,
    "    return updated;",
    "  }",
    "",
    "  async remove(id: string): Promise<{ deleted: true; id: string }> {",
    "    const deleted = await this.repository.delete(id);",
    '    if (!deleted) throw new NotFoundException({ code: "RESOURCE_NOT_FOUND", message: "' +
      model.name +
      ' " + id + " not found" });',
    ...(ctx.has("cache") ? ["    await this.invalidateListCache();"] : []),
    ...(ctx.has("outbox")
      ? [
          "    await this.outbox.record(new " +
            model.name +
            "DeletedEvent(randomUUID(), id));",
        ]
      : []),
    "    return { deleted: true, id };",
    "  }",
    "",
    "  /** Copies only manifest-declared writable fields; unknown keys are ignored. */",
    "  private copyWritable(input: " +
      model.names.createDto +
      "): Record<string, unknown> {",
    "    const source = input as unknown as Record<string, unknown>;",
    "    const target: Record<string, unknown> = {};",
    "    for (const key of " +
      JSON.stringify(
        model.writableFields
          .filter((f) => !f.generatedByRelation)
          .map((f) => f.name),
      ) +
      ") {",
    "      if (source[key] !== undefined) target[key] = source[key];",
    "    }",
    "    return target;",
    "  }",
    "}",
    "",
  );

  return lines.filter((line) => line !== null).join("\n");
}

// ---------------------------------------------------------------------------
// Domain events (outbox)
// ---------------------------------------------------------------------------

function generateEvents(ctx, model) {
  const eventName = (suffix) => model.name + suffix;
  const domainEventPath = ctx.rel(
    model.paths.events,
    "src/platform/communication/contracts/domain-event",
  );
  return ["import { DomainEvent } from '" + domainEventPath + "';",
  "\n",
  "export class " + eventName("CreatedEvent") + " extends DomainEvent {",
  "  readonly eventType = '" + model.name + "Created' as const;",
  "  constructor(eventId: string, aggregateId: string, readonly payload: Record<string, unknown>) {",
  "    super(eventId, aggregateId, '" + model.name + "');",
  "  }",
  "}",
  "",
  "export class " + eventName("UpdatedEvent") + " extends DomainEvent {",
  "  readonly eventType = '" + model.name + "Updated' as const;",
  "  constructor(eventId: string, aggregateId: string, readonly changedFields: string[]) {",
  "    super(eventId, aggregateId, '" + model.name + "');",
  "  }",
  "  get payload(): unknown { return { changedFields: this.changedFields }; }",
  "}",
  "",
  "export class " + eventName("DeletedEvent") + " extends DomainEvent {",
  "  readonly eventType = '" + model.name + "Deleted' as const;",
  "  constructor(eventId: string, aggregateId: string) {",
  "    super(eventId, aggregateId, '" + model.name + "');",
  "  }",
  "  get payload(): unknown { return {}; }",
  "}",
  ""]
    .join("\n")
    .replace("\n\n\n", "\n\n");
}

function generateSpec(ctx, model) {
  return (
    "import { Test } from '@nestjs/testing';",
    "import { " +
      model.names.service +
      " } from './" +
      model.routeSingle +
      ".use-cases';",
    "import { " +
      model.names.token +
      " } from '../contracts/" +
      model.routeSingle +
      ".tokens';",
    "",
    "describe('" + model.names.service + "', () => {",
    '  it("is instantiable with a repository double", async () => {',
    "    const moduleRef = await Test.createTestingModule({",
    "      providers: [",
    "        " + model.names.service + ",",
    "        {",
    "          provide: " + model.names.token + ",",
    "          useValue: {",
    "            findById: jest.fn(),",
    "            findMany: jest.fn(),",
    "            create: jest.fn(),",
    "            update: jest.fn(),",
    "            delete: jest.fn(),",
    "            exists: jest.fn(),",
    "          },",
    "        },",
    "      ],",
    "    }).compile();",
    "",
    "    expect(moduleRef.get(" + model.names.service + ")).toBeDefined();",
    "  });",
    "});",
    ""
  );
}

module.exports = {
  generateSchemas,
  generateDtos,
  generatePlainDtos,
  generateRepositoryContract,
  generateTokens,
  generateServiceContract,
  generateMapperContract,
  generateUseCases,
  generateEvents,
  generateSpec,
};
