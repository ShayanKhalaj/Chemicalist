
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/*
 * Chemicalist Backend Generator Bootstrap
 *
 * Run:
 *   node script.js
 *
 * Optional:
 *   node script.js --root ./backend-generator
 *   node script.js --force
 *
 * This script creates the generator project, not the generated backend.
 * The generated CLI reads JSON manifests and generates Studio source files.
 */

const args = process.argv.slice(2);
const force = args.includes('--force');
const rootIndex = args.indexOf('--root');

const ROOT = path.resolve(
  __dirname,
  rootIndex >= 0 && args[rootIndex + 1]
    ? args[rootIndex + 1]
    : '../backend-generator'
);

const files = {
  'package.json': `{
  "name": "chemicalist-backend-generator",
  "version": "1.0.0",
  "private": true,
  "description": "Manifest-driven modular backend code generator",
  "scripts": {
    "generate": "node backend-foldering-generators.js",
    "validate": "node backend-foldering-generators.js --validate",
    "generate:all": "node backend-foldering-generators.js --all manifests"
  },
  "engines": {
    "node": ">=18"
  }
}
`,

  'domain-models.config.js': `
'use strict';

module.exports = {
  fieldTypes: [
    'string',
    'text',
    'boolean',
    'int',
    'float',
    'decimal',
    'date',
    'datetime',
    'uuid',
    'json',
    'enum'
  ],

  layers: [
    'domain',
    'application',
    'persistence',
    'webservice',
    'infrastructure',
    'presentation',
    'testing'
  ],

  capabilities: [
    'unitOfWork',
    'outbox',
    'inbox',
    'saga',
    'cache',
    'messaging',
    'jwt',
    'tenantScope'
  ]
};
`,

  'engine/naming.js': `
'use strict';

function pascal(value) {
  return String(value)
    .replace(/(^|[-_\\s])([a-z])/g, (_, __, c) => c.toUpperCase())
    .replace(/[^A-Za-z0-9]/g, '');
}

function camel(value) {
  const result = pascal(value);
  return result ? result[0].toLowerCase() + result.slice(1) : 'item';
}

function kebab(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function validateIdentifier(value, label) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z][A-Za-z0-9_-]*$/.test(value)
  ) {
    throw new Error('Invalid ' + label + ': ' + String(value));
  }

  return value;
}

module.exports = { pascal, camel, kebab, validateIdentifier };
`,

  'engine/manifest-loader.js': `
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function loadManifest(filePath) {
  const absolutePath = path.resolve(filePath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error('Manifest not found: ' + absolutePath);
  }

  let manifest;

  try {
    manifest = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    throw new Error(
      'Invalid JSON in ' + absolutePath + ': ' + error.message
    );
  }

  return { manifest, absolutePath };
}

module.exports = { loadManifest };
`,

  'engine/manifest-validator.js': `
'use strict';

const config = require('../domain-models.config');
const { validateIdentifier } = require('./naming');

function validateManifest(m) {
  const errors = [];

  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    throw new Error('Manifest must be a JSON object.');
  }

  for (const key of ['lab', 'studio']) {
    try {
      validateIdentifier(m[key], key);
    } catch (error) {
      errors.push(error.message);
    }
  }

  if (!Array.isArray(m.models) || m.models.length === 0) {
    errors.push('models must be a non-empty array.');
  }

  const modelNames = new Set();
  const enumNames = new Set();
  const enums = Array.isArray(m.enums) ? m.enums : [];

  for (const item of enums) {
    if (!item || !/^[A-Z][A-Za-z0-9]*$/.test(item.name || '')) {
      errors.push('Enum names must be PascalCase.');
      continue;
    }

    if (enumNames.has(item.name)) {
      errors.push('Duplicate enum: ' + item.name);
    }

    enumNames.add(item.name);

    if (
      !Array.isArray(item.values) ||
      item.values.length === 0 ||
      item.values.some(value => typeof value !== 'string')
    ) {
      errors.push('Enum must contain string values: ' + item.name);
    }
  }

  for (const model of m.models || []) {
    if (!model || !/^[A-Z][A-Za-z0-9]*$/.test(model.name || '')) {
      errors.push('Model names must be PascalCase.');
      continue;
    }

    if (modelNames.has(model.name)) {
      errors.push('Duplicate model: ' + model.name);
    }

    modelNames.add(model.name);

    if (!Array.isArray(model.fields) || model.fields.length === 0) {
      errors.push(model.name + '.fields must be a non-empty array.');
      continue;
    }

    const fieldNames = new Set();

    for (const field of model.fields) {
      if (!field || !/^[a-z][A-Za-z0-9]*$/.test(field.name || '')) {
        errors.push(model.name + ' has an invalid field name.');
        continue;
      }

      if (fieldNames.has(field.name)) {
        errors.push('Duplicate field: ' + model.name + '.' + field.name);
      }

      fieldNames.add(field.name);

      if (!config.fieldTypes.includes(field.type)) {
        errors.push(
          'Unsupported type: ' + model.name + '.' + field.name
        );
      }

      if (field.type === 'enum' && !enumNames.has(field.enum)) {
        errors.push(
          'Undefined enum: ' + model.name + '.' + field.name
        );
      }
    }
  }

  for (const key of ['operations', 'services', 'repositories']) {
    if (m[key] !== undefined && !Array.isArray(m[key])) {
      errors.push(key + ' must be an array.');
    }
  }

  if (
    m.capabilities !== undefined &&
    (typeof m.capabilities !== 'object' || Array.isArray(m.capabilities))
  ) {
    errors.push('capabilities must be an object.');
  }

  if (errors.length) {
    throw new Error(
      'Manifest validation failed:\\n- ' + errors.join('\\n- ')
    );
  }

  return true;
}

module.exports = { validateManifest };
`,

  'engine/file-writer.js': `
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MARKER = '// @generated by chemicalist-backend-generator';

function writeGeneratedFile(root, relativePath, content, options = {}) {
  const absoluteRoot = path.resolve(root);
  const target = path.resolve(absoluteRoot, relativePath);

  if (
    target !== absoluteRoot &&
    !target.startsWith(absoluteRoot + path.sep)
  ) {
    throw new Error('Output path escapes target directory: ' + relativePath);
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });

  const output = MARKER + '\\n' + content.trim() + '\\n';

  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target, 'utf8');

    if (existing === output) return 'unchanged';

    if (!options.force && !existing.startsWith(MARKER)) {
      const conflict = target + '.generator-conflict';
      fs.writeFileSync(conflict, output, 'utf8');
      return 'conflict';
    }

    if (!options.force && existing.startsWith(MARKER)) {
      fs.writeFileSync(target + '.generator-backup', existing, 'utf8');
    }
  }

  fs.writeFileSync(target, output, 'utf8');
  return 'written';
}

module.exports = { writeGeneratedFile };
`,

  'engine/dependency-resolver.js': `
'use strict';

function resolveDependencies(manifest) {
  const c = manifest.capabilities || {};

  const enabled = key => {
    const value = c[key];
    return value === true || (value && value.enabled === true);
  };

  return {
    unitOfWork: enabled('unitOfWork'),
    outbox: enabled('outbox'),
    inbox: enabled('inbox'),
    saga: enabled('saga'),
    cache: enabled('cache'),
    messaging: enabled('messaging') ||
      enabled('outbox') ||
      enabled('inbox') ||
      enabled('saga'),
    jwt: enabled('jwt'),
    tenantScope: enabled('tenantScope'),
    prisma: manifest.persistence?.provider === 'prisma' ||
      manifest.persistence?.provider === undefined,
    postgres: manifest.persistence?.database === 'postgres' ||
      manifest.persistence?.database === undefined
  };
}

module.exports = { resolveDependencies };
`,

  'engine/generation-planner.js': `
'use strict';

function createPlan(manifest) {
  return [
    'domain',
    'application',
    'persistence',
    'infrastructure',
    'webservice',
    'presentation',
    'testing',
    'module'
  ].map(layer => ({
    layer,
    lab: manifest.lab,
    studio: manifest.studio,
    models: (manifest.models || []).map(model => model.name)
  }));
}

module.exports = { createPlan };
`,

  'generators/domain/domain-generator.js': `
'use strict';

const { pascal } = require('../../engine/naming');

function typeOf(field) {
  if (field.type === 'enum') return pascal(field.enum);

  return ({
    string: 'string',
    text: 'string',
    boolean: 'boolean',
    int: 'number',
    float: 'number',
    decimal: 'number',
    uuid: 'string',
    date: 'Date',
    datetime: 'Date',
    json: 'Record<string, unknown>'
  })[field.type] || 'unknown';
}

function generateDomain(model) {
  const fields = model.fields
    .filter(field => field.name !== 'id')
    .map(field =>
      '  ' + field.name +
      (field.required === false ? '?' : '') +
      (field.nullable ? '?: ' : ': ') +
      typeOf(field) +
      (field.nullable ? ' | null' : '') +
      ';'
    )
    .join('\\n');

  return [
    'export class ' + model.name + ' {',
    '  id!: string;',
    fields,
    '}',
    ''
  ].join('\\n');
}

module.exports = { generateDomain };
`,

  'generators/application/dto-generator.js': `
'use strict';

function generateCreateDto(model) {
  const fields = model.fields
    .filter(field => field.name !== 'id')
    .map(field =>
      '  ' + field.name +
      (field.required === false ? '?' : '') +
      ': ' + tsType(field) + ';'
    )
    .join('\\n');

  return 'export class Create' + model.name + 'Dto {\\n' +
    fields + '\\n}\\n';
}

function generateUpdateDto(model) {
  const fields = model.fields
    .filter(field => field.name !== 'id')
    .map(field =>
      '  ' + field.name + '?: ' + tsType(field) + ';'
    )
    .join('\\n');

  return 'export class Update' + model.name + 'Dto {\\n' +
    fields + '\\n}\\n';
}

function tsType(field) {
  return ({
    string: 'string',
    text: 'string',
    boolean: 'boolean',
    int: 'number',
    float: 'number',
    decimal: 'number',
    uuid: 'string',
    date: 'Date',
    datetime: 'Date',
    json: 'Record<string, unknown>',
    enum: field.enum
  })[field.type] || 'unknown';
}

module.exports = { generateCreateDto, generateUpdateDto };
`,

  'generators/application/validator-generator.js': `
'use strict';

function generateValidator(model) {
  const fields = model.fields.map(field => {
    const types = {
      string: 'z.string()',
      text: 'z.string()',
      boolean: 'z.boolean()',
      int: 'z.number().int()',
      float: 'z.number()',
      decimal: 'z.number()',
      uuid: 'z.string().uuid()',
      date: 'z.coerce.date()',
      datetime: 'z.coerce.date()',
      json: 'z.record(z.string(), z.unknown())',
      enum: 'z.nativeEnum(' + field.enum + ')'
    };

    let expression = types[field.type] || 'z.unknown()';

    if (field.nullable) expression += '.nullable()';
    if (field.required === false) expression += '.optional()';

    return '  ' + field.name + ': ' + expression + ',';
  }).join('\\n');

  return "import { z } from 'zod';\\n\\n" +
    'export const ' + model.name + 'Schema = z.object({\\n' +
    fields + '\\n});\\n\\n' +
    'export type ' + model.name + 'Input = z.infer<typeof ' +
    model.name + 'Schema>;\\n';
}

module.exports = { generateValidator };
`,

  'generators/application/repository-contract-generator.js': `
'use strict';

function generateRepositoryContract(model) {
  return 'export interface ' + model.name + 'Repository {\\n' +
    '  findById(id: string): Promise<' + model.name + ' | null>;\\n' +
    '  findMany(input: { skip: number; take: number }): Promise<{ items: ' +
      model.name + '[]; total: number }>;\\n' +
    '  create(input: ' + model.name + '): Promise<' + model.name + '>;\\n' +
    '  update(id: string, input: Partial<' + model.name +
      '): Promise<' + model.name + ' | null>;\\n' +
    '  delete(id: string): Promise<boolean>;\\n' +
    '}\\n';
}

module.exports = { generateRepositoryContract };
`,

  'generators/application/service-contract-generator.js': `
'use strict';

function generateServiceContract(model) {
  return 'import type { Create' + model.name + 'Dto } from ' +
    "'../dtos/create-" + model.name.toLowerCase() + ".dto';\\n" +
    'import type { Update' + model.name + 'Dto } from ' +
    "'../dtos/update-" + model.name.toLowerCase() + ".dto';\\n\\n" +
    'export interface ' + model.name + 'ServiceContract {\\n' +
    '  findById(id: string): Promise<' + model.name + ' | null>;\\n' +
    '  findMany(skip: number, take: number): Promise<{ items: ' +
      model.name + '[]; total: number }>;\\n' +
    '  create(input: Create' + model.name + 'Dto): Promise<' +
      model.name + '>;\\n' +
    '  update(id: string, input: Update' + model.name +
      'Dto): Promise<' + model.name + ' | null>;\\n' +
    '  delete(id: string): Promise<boolean>;\\n' +
    '}\\n';
}

module.exports = { generateServiceContract };
`,

  'generators/application/mapper-generator.js': `
'use strict';

function generateMapper(model) {
  const fields = model.fields.map(field =>
    '      ' + field.name + ': source.' + field.name + ','
  ).join('\\n');

  return 'import type { ' + model.name + ' } from ' +
    "'../../domain/models/" + model.name.toLowerCase() + ".model';\\n\\n" +
    'export class ' + model.name + 'Mapper {\\n' +
    '  static toDomain(source: Record<string, unknown>): ' +
      model.name + ' {\\n' +
    '    return {\\n' + fields + '\\n    } as ' + model.name + ';\\n' +
    '  }\\n\\n' +
    '  static toPersistence(entity: ' + model.name +
      '): Record<string, unknown> {\\n' +
    '    return { ...entity };\\n' +
    '  }\\n\\n' +
    '  static toResponse(entity: ' + model.name +
      '): Record<string, unknown> {\\n' +
    '    return { ...entity };\\n' +
    '  }\\n' +
    '}\\n';
}

module.exports = { generateMapper };
`,

  'generators/application/service-generator.js': `
'use strict';

function generateService(model) {
  const lower = model.name.toLowerCase();

  return "import { Inject, Injectable, NotFoundException } from '@nestjs/common';\\n" +
    "import type { " + model.name + "Repository } from '../contracts/repositories/" +
      lower + ".repository.contract';\\n" +
    "import type { Create" + model.name + "Dto } from '../dtos/create-" +
      lower + ".dto';\\n" +
    "import type { Update" + model.name + "Dto } from '../dtos/update-" +
      lower + ".dto';\\n\\n" +
    '@Injectable()\\n' +
    'export class ' + model.name + 'Service {\\n' +
    '  constructor(\\n' +
    "    @Inject('" + model.name + "Repository')\\n" +
    '    private readonly repository: ' + model.name + 'Repository\\n' +
    '  ) {}\\n\\n' +
    '  findById(id: string) {\\n' +
    '    return this.repository.findById(id);\\n' +
    '  }\\n\\n' +
    '  findMany(skip = 0, take = 20) {\\n' +
    '    return this.repository.findMany({ skip, take });\\n' +
    '  }\\n\\n' +
    '  create(input: Create' + model.name + 'Dto) {\\n' +
    '    return this.repository.create(input as ' + model.name + ');\\n' +
    '  }\\n\\n' +
    '  async update(id: string, input: Update' + model.name + 'Dto) {\\n' +
    '    const result = await this.repository.update(id, input);\\n' +
    '    if (!result) throw new NotFoundException("' + model.name + ' not found");\\n' +
    '    return result;\\n' +
    '  }\\n\\n' +
    '  async delete(id: string) {\\n' +
    '    const deleted = await this.repository.delete(id);\\n' +
    '    if (!deleted) throw new NotFoundException("' + model.name + ' not found");\\n' +
    '    return { deleted: true };\\n' +
    '  }\\n' +
    '}\\n';
}

module.exports = { generateService };
`,

  'generators/persistence/prisma-schema-generator.js': `
'use strict';

function prismaType(field) {
  if (field.type === 'enum') return field.enum;

  return ({
    string: 'String',
    text: 'String',
    boolean: 'Boolean',
    int: 'Int',
    float: 'Float',
    decimal: 'Decimal',
    uuid: 'String',
    date: 'DateTime',
    datetime: 'DateTime',
    json: 'Json'
  })[field.type] || 'String';
}

function generatePrismaSchema(manifest) {
  const enumBlocks = (manifest.enums || []).map(item =>
    'enum ' + item.name + ' {\\n' +
    item.values.map(value => '  ' + value).join('\\n') + '\\n}'
  );

  const models = manifest.models.map(model => {
    const fields = model.fields.map(field => {
      let type = prismaType(field);
      const isId = field.name === 'id';

      if (field.type === 'uuid' && isId) {
        return '  id String @id @default(uuid())';
      }

      if (isId && field.type === 'string') {
        return '  id String @id @default(cuid())';
      }

      if (isId) return '  ' + field.name + ' ' + type + ' @id';

      if (field.type === 'decimal') type += ' @db.Decimal(18, 4)';

      if (field.required === false) type += '?';

      if (field.nullable && !type.endsWith('?')) type += '?';

      return '  ' + field.name + ' ' + type;
    });

    return 'model ' + model.name + ' {\\n' +
      fields.join('\\n') + '\\n' +
      '  createdAt DateTime @default(now())\\n' +
      '  updatedAt DateTime @updatedAt\\n' +
      '}';
  });

  return [
    'generator client {',
    '  provider = "prisma-client-js"',
    '}',
    '',
    'datasource db {',
    '  provider = "postgresql"',
    '  url      = env("DATABASE_URL")',
    '}',
    '',
    ...enumBlocks,
    ...models
  ].join('\\n\\n') + '\\n';
}

module.exports = { generatePrismaSchema };
`,

  'generators/persistence/prisma-repository-generator.js': `
'use strict';

function generatePrismaRepository(model) {
  const lower = model.name.toLowerCase();

  return "import { Injectable } from '@nestjs/common';\\n" +
    "import { PrismaService } from '../../infrastructure/prisma/prisma.service';\\n" +
    "import type { " + model.name + "Repository } from '../../application/contracts/repositories/" +
      lower + ".repository.contract';\\n" +
    "import type { " + model.name + " } from '../../domain/models/" +
      lower + ".model';\\n\\n" +
    '@Injectable()\\n' +
    'export class Prisma' + model.name + 'Repository implements ' +
      model.name + 'Repository {\\n' +
    '  constructor(private readonly prisma: PrismaService) {}\\n\\n' +
    '  async findById(id: string): Promise<' + model.name + ' | null> {\\n' +
    '    return this.prisma.' + lower + '.findUnique({ where: { id } }) as Promise<' +
      model.name + ' | null>;\\n' +
    '  }\\n\\n' +
    '  async findMany(input: { skip: number; take: number }) {\\n' +
    '    const [items, total] = await this.prisma.$transaction([\\n' +
    '      this.prisma.' + lower + '.findMany(input),\\n' +
    '      this.prisma.' + lower + '.count()\\n' +
    '    ]);\\n' +
    '    return { items: items as ' + model.name + '[], total };\\n' +
    '  }\\n\\n' +
    '  async create(input: ' + model.name + '): Promise<' + model.name + '> {\\n' +
    '    return this.prisma.' + lower + '.create({ data: input as never }) as Promise<' +
      model.name + '>;\\n' +
    '  }\\n\\n' +
    '  async update(id: string, input: Partial<' + model.name +
      '>): Promise<' + model.name + ' | null> {\\n' +
    '    const existing = await this.findById(id);\\n' +
    '    if (!existing) return null;\\n' +
    '    return this.prisma.' + lower + '.update({ where: { id }, data: input as never }) as Promise<' +
      model.name + '>;\\n' +
    '  }\\n\\n' +
    '  async delete(id: string): Promise<boolean> {\\n' +
    '    const existing = await this.findById(id);\\n' +
    '    if (!existing) return false;\\n' +
    '    await this.prisma.' + lower + '.delete({ where: { id } });\\n' +
    '    return true;\\n' +
    '  }\\n' +
    '}\\n';
}

module.exports = { generatePrismaRepository };
`,

  'generators/persistence/unit-of-work-generator.js': `
'use strict';

function generateUnitOfWorkContract() {
  return 'export interface UnitOfWorkContract {\\n' +
    '  execute<T>(work: () => Promise<T>): Promise<T>;\\n' +
    '}\\n';
}

function generatePrismaUnitOfWork() {
  return "import { Injectable } from '@nestjs/common';\\n" +
    "import { PrismaService } from '../prisma/prisma.service';\\n" +
    "import type { UnitOfWorkContract } from './unit-of-work.contract';\\n\\n" +
    '@Injectable()\\n' +
    'export class PrismaUnitOfWork implements UnitOfWorkContract {\\n' +
    '  constructor(private readonly prisma: PrismaService) {}\\n\\n' +
    '  async execute<T>(work: () => Promise<T>): Promise<T> {\\n' +
    '    return this.prisma.$transaction(async () => work());\\n' +
    '  }\\n' +
    '}\\n';
}

module.exports = { generateUnitOfWorkContract, generatePrismaUnitOfWork };
`,

  'generators/infrastructure/prisma-service-generator.js': `
'use strict';

function generatePrismaService() {
  return "import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';\\n" +
    "import { PrismaClient } from '@prisma/client';\\n\\n" +
    '@Injectable()\\n' +
    'export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {\\n' +
    '  async onModuleInit(): Promise<void> {\\n' +
    '    await this.$connect();\\n' +
    '  }\\n\\n' +
    '  async onModuleDestroy(): Promise<void> {\\n' +
    '    await this.$disconnect();\\n' +
    '  }\\n' +
    '}\\n';
}

module.exports = { generatePrismaService };
`,

  'generators/infrastructure/cache-generator.js': `
'use strict';

function generateCacheContract() {
  return 'export interface CacheContract {\\n' +
    '  get<T>(key: string): Promise<T | null>;\\n' +
    '  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;\\n' +
    '  delete(key: string): Promise<void>;\\n' +
    '}\\n';
}

module.exports = { generateCacheContract };
`,

  'generators/infrastructure/messaging-generator.js': `
'use strict';

function generateMessagingContracts() {
  return 'export interface MessagePublisher {\\n' +
    '  publish(routingKey: string, payload: Record<string, unknown>): Promise<void>;\\n' +
    '}\\n\\n' +
    'export interface MessageHandler<T = unknown> {\\n' +
    '  handle(message: T): Promise<void>;\\n' +
    '}\\n';
}

function generateOutboxContract() {
  return 'export interface OutboxMessage {\\n' +
    '  id: string;\\n' +
    '  eventName: string;\\n' +
    '  payload: Record<string, unknown>;\\n' +
    '  occurredAt: Date;\\n' +
    '}\\n\\n' +
    'export interface OutboxStore {\\n' +
    '  append(message: OutboxMessage): Promise<void>;\\n' +
    '}\\n';
}

function generateInboxContract() {
  return 'export interface InboxStore {\\n' +
    '  hasProcessed(messageId: string): Promise<boolean>;\\n' +
    '  markProcessed(messageId: string): Promise<void>;\\n' +
    '}\\n';
}

module.exports = {
  generateMessagingContracts,
  generateOutboxContract,
  generateInboxContract
};
`,

  'generators/infrastructure/saga-generator.js': `
'use strict';

function generateSagaContract() {
  return 'export type SagaStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";\\n\\n' +
    'export interface SagaStep<TContext> {\\n' +
    '  execute(context: TContext): Promise<void>;\\n' +
    '  compensate?(context: TContext): Promise<void>;\\n' +
    '}\\n\\n' +
    'export interface SagaDefinition<TContext> {\\n' +
    '  name: string;\\n' +
    '  steps: SagaStep<TContext>[];\\n' +
    '}\\n';
}

module.exports = { generateSagaContract };
`,

  'generators/webservice/controller-generator.js': `
'use strict';

const { kebab } = require('../../engine/naming');

function generateController(model) {
  const route = kebab(model.name);

  return "import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';\\n" +
    "import { " + model.name + "Service } from '../../application/services/" +
      route + ".service';\\n" +
    "import { Create" + model.name + "Dto } from '../../application/dtos/create-" +
      route + ".dto';\\n" +
    "import { Update" + model.name + "Dto } from '../../application/dtos/update-" +
      route + ".dto';\\n\\n" +
    "@Controller('" + route + "')\\n" +
    'export class ' + model.name + 'Controller {\\n' +
    '  constructor(private readonly service: ' + model.name + 'Service) {}\\n\\n' +
    '  @Get()\\n' +
    '  list(@Query("page") page = "1", @Query("pageSize") pageSize = "20") {\\n' +
    '    const p = Math.max(1, Number(page) || 1);\\n' +
    '    const size = Math.min(100, Math.max(1, Number(pageSize) || 20));\\n' +
    '    return this.service.findMany((p - 1) * size, size);\\n' +
    '  }\\n\\n' +
    '  @Get(":id")\\n' +
    '  findById(@Param("id") id: string) {\\n' +
    '    return this.service.findById(id);\\n' +
    '  }\\n\\n' +
    '  @Post()\\n' +
    '  create(@Body() body: Create' + model.name + 'Dto) {\\n' +
    '    return this.service.create(body);\\n' +
    '  }\\n\\n' +
    '  @Patch(":id")\\n' +
    '  update(@Param("id") id: string, @Body() body: Update' +
      model.name + 'Dto) {\\n' +
    '    return this.service.update(id, body);\\n' +
    '  }\\n\\n' +
    '  @Delete(":id")\\n' +
    '  delete(@Param("id") id: string) {\\n' +
    '    return this.service.delete(id);\\n' +
    '  }\\n' +
    '}\\n';
}

module.exports = { generateController };
`,

  'generators/module/studio-module-generator.js': `
'use strict';

const { pascal, kebab } = require('../../engine/naming');

function generateModule(manifest) {
  const providers = [];
  const controllers = [];
  const exports = [];

  for (const model of manifest.models) {
    const route = kebab(model.name);

    providers.push(
      '    ' + model.name + 'Service,',
      '    { provide: "' + model.name + 'Repository", useClass: Prisma' +
        model.name + 'Repository },'
    );

    controllers.push('    ' + model.name + 'Controller,');
    exports.push('    ' + model.name + 'Service,');
  }

  return "import { Module } from '@nestjs/common';\\n" +
    "import { PrismaService } from './infrastructure/prisma/prisma.service';\\n" +
    manifest.models.map(model =>
      "import { " + model.name + "Service } from './application/services/" +
      kebab(model.name) + ".service';\\n" +
      "import { Prisma" + model.name + "Repository } from './persistence/repositories/prisma-" +
      kebab(model.name) + ".repository';\\n" +
      "import { " + model.name + "Controller } from './webservice/controllers/" +
      kebab(model.name) + ".controller';"
    ).join('\\n') + '\\n\\n' +
    '@Module({\\n' +
    '  controllers: [\\n' + controllers.join('\\n') + '\\n  ],\\n' +
    '  providers: [\\n' +
    '    PrismaService,\\n' + providers.join('\\n') + '\\n  ],\\n' +
    '  exports: [\\n' + exports.join('\\n') + '\\n  ]\\n' +
    '})\\n' +
    'export class ' + pascal(manifest.studio) + 'Module {}\\n';
}

module.exports = { generateModule };
`,

  'generators/testing/test-generator.js': `
'use strict';

const { kebab } = require('../../engine/naming');

function generateServiceSpec(model) {
  return "import { Test } from '@nestjs/testing';\\n" +
    "import { " + model.name + "Service } from '../services/" +
      kebab(model.name) + ".service';\\n\\n" +
    "describe('" + model.name + "Service', () => {\\n" +
    '  it("can be instantiated with a repository mock", async () => {\\n' +
    '    const moduleRef = await Test.createTestingModule({\\n' +
    '      providers: [\\n' +
    '        ' + model.name + 'Service,\\n' +
    '        {\\n' +
    '          provide: "' + model.name + 'Repository",\\n' +
    '          useValue: {\\n' +
    '            findById: jest.fn(), findMany: jest.fn(),\\n' +
    '            create: jest.fn(), update: jest.fn(), delete: jest.fn()\\n' +
    '          }\\n' +
    '        }\\n' +
    '      ]\\n' +
    '    }).compile();\\n' +
    '    expect(moduleRef.get(' + model.name + 'Service)).toBeDefined();\\n' +
    '  });\\n' +
    '});\\n';
}

module.exports = { generateServiceSpec };
`,

  'engine/generation-orchestrator.js': `
'use strict';

const path = require('node:path');
const { writeGeneratedFile } = require('./file-writer');
const { resolveDependencies } = require('./dependency-resolver');
const { createPlan } = require('./generation-planner');
const { kebab } = require('./naming');

const { generateDomain } = require('../generators/domain/domain-generator');
const {
  generateCreateDto,
  generateUpdateDto
} = require('../generators/application/dto-generator');
const { generateValidator } = require('../generators/application/validator-generator');
const {
  generateRepositoryContract
} = require('../generators/application/repository-contract-generator');
const {
  generateServiceContract
} = require('../generators/application/service-contract-generator');
const { generateMapper } = require('../generators/application/mapper-generator');
const { generateService } = require('../generators/application/service-generator');
const {
  generatePrismaSchema
} = require('../generators/persistence/prisma-schema-generator');
const {
  generatePrismaRepository
} = require('../generators/persistence/prisma-repository-generator');
const {
  generateUnitOfWorkContract,
  generatePrismaUnitOfWork
} = require('../generators/persistence/unit-of-work-generator');
const {
  generatePrismaService
} = require('../generators/infrastructure/prisma-service-generator');
const { generateCacheContract } = require('../generators/infrastructure/cache-generator');
const {
  generateMessagingContracts,
  generateOutboxContract,
  generateInboxContract
} = require('../generators/infrastructure/messaging-generator');
const { generateSagaContract } = require('../generators/infrastructure/saga-generator');
const { generateController } = require('../generators/webservice/controller-generator');
const { generateModule } = require('../generators/module/studio-module-generator');
const { generateServiceSpec } = require('../generators/testing/test-generator');

function generateManifest(manifest, backendRoot, options = {}) {
  const output = manifest.output
    ? path.resolve(backendRoot, manifest.output)
    : path.join(
        backendRoot,
        'src',
        'labs',
        kebab(manifest.lab),
        'studios',
        kebab(manifest.studio)
      );

  const capabilities = resolveDependencies(manifest);
  const results = [];

  function write(relativePath, content) {
    const status = writeGeneratedFile(output, relativePath, content, options);
    results.push({ file: relativePath, status });
  }

  for (const model of manifest.models) {
    const name = kebab(model.name);

    write('domain/models/' + name + '.model.ts', generateDomain(model));

    write(
      'application/dtos/create-' + name + '.dto.ts',
      generateCreateDto(model)
    );

    write(
      'application/dtos/update-' + name + '.dto.ts',
      generateUpdateDto(model)
    );

    write(
      'application/validators/' + name + '.schema.ts',
      generateValidator(model)
    );

    write(
      'application/contracts/repositories/' + name + '.repository.contract.ts',
      generateRepositoryContract(model)
    );

    write(
      'application/contracts/services/' + name + '.service.contract.ts',
      generateServiceContract(model)
    );

    write(
      'application/mappers/' + name + '.mapper.ts',
      generateMapper(model)
    );

    write(
      'application/services/' + name + '.service.ts',
      generateService(model)
    );

    write(
      'webservice/controllers/' + name + '.controller.ts',
      generateController(model)
    );

    write(
      'testing/' + name + '.service.spec.ts',
      generateServiceSpec(model)
    );

    if (capabilities.prisma) {
      write(
        'persistence/repositories/prisma-' + name + '.repository.ts',
        generatePrismaRepository(model)
      );
    }
  }

  if (capabilities.prisma) {
    write(
      'infrastructure/prisma/prisma.service.ts',
      generatePrismaService()
    );

    write(
      'prisma/' + kebab(manifest.studio) + '.schema.prisma',
      generatePrismaSchema(manifest)
    );
  }

  if (capabilities.unitOfWork) {
    write(
      'application/contracts/unit-of-work.contract.ts',
      generateUnitOfWorkContract()
    );

    if (capabilities.prisma) {
      write(
        'persistence/unit-of-work/prisma-unit-of-work.ts',
        generatePrismaUnitOfWork()
      );
    }
  }

  if (capabilities.cache) {
    write(
      'application/contracts/cache.contract.ts',
      generateCacheContract()
    );
  }

  if (capabilities.messaging) {
    write(
      'application/contracts/messaging.contract.ts',
      generateMessagingContracts()
    );
  }

  if (capabilities.outbox) {
    write(
      'application/contracts/outbox.contract.ts',
      generateOutboxContract()
    );
  }

  if (capabilities.inbox) {
    write(
      'application/contracts/inbox.contract.ts',
      generateInboxContract()
    );
  }

  if (capabilities.saga) {
    write(
      'application/contracts/saga.contract.ts',
      generateSagaContract()
    );
  }

  write('studio.module.ts', generateModule(manifest));

  write('README.md', [
    '# ' + manifest.studio + ' Studio',
    '',
    manifest.description || '',
    '',
    'Generated from a JSON manifest.',
    '',
    '## Review before production',
    '',
    '- Configure application-level validation and authorization.',
    '- Review generated DTO and domain mapping.',
    '- Add transaction boundaries and error handling for your use cases.',
    '- Configure Prisma migrations and database connection.',
    '- Configure RabbitMQ/Redis adapters if those capabilities are enabled.',
    '- Generated contracts do not automatically provide broker workers or a durable outbox processor.'
  ].join('\\n'));

  return {
    output,
    plan: createPlan(manifest),
    results
  };
}

module.exports = { generateManifest };
`,

  'backend-foldering-generators.js': `
#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { loadManifest } = require('./engine/manifest-loader');
const { validateManifest } = require('./engine/manifest-validator');
const { generateManifest } = require('./engine/generation-orchestrator');

function collectJsonFiles(directory) {
  const result = [];

  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, item.name);

    if (item.isDirectory()) {
      result.push(...collectJsonFiles(full));
    } else if (item.isFile() && item.name.endsWith('.json')) {
      result.push(full);
    }
  }

  return result.sort();
}

function parseArgs(argv) {
  const options = {
    validateOnly: false,
    allDirectory: null,
    manifest: null,
    force: false,
    out: null
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--validate') {
      options.validateOnly = true;
    } else if (arg === '--all') {
      options.allDirectory = argv[++i];
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--out') {
      options.out = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (!arg.startsWith('--') && !options.manifest) {
      options.manifest = arg;
    } else {
      throw new Error('Unknown or incomplete argument: ' + arg);
    }
  }

  return options;
}

function printHelp() {
  console.log(
    'Chemicalist Backend Generator\\n\\n' +
    'Usage:\\n' +
    '  node backend-foldering-generators.js <manifest.json>\\n' +
    '  node backend-foldering-generators.js --validate <manifest.json>\\n' +
    '  node backend-foldering-generators.js --all ./manifests\\n' +
    '  node backend-foldering-generators.js <manifest.json> --out ./output\\n' +
    '  node backend-foldering-generators.js <manifest.json> --force\\n'
  );
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  let manifestPaths = [];

  if (options.allDirectory) {
    const directory = path.resolve(options.allDirectory);

    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
      throw new Error('--all requires an existing manifest directory.');
    }

    manifestPaths = collectJsonFiles(directory);
  } else if (options.manifest) {
    manifestPaths = [path.resolve(options.manifest)];
  } else {
    printHelp();
    process.exitCode = 1;
    return;
  }

  if (!manifestPaths.length) {
    throw new Error('No JSON manifests found.');
  }

  const backendRoot = options.out
    ? path.resolve(options.out)
    : path.resolve(process.cwd(), 'chemicalist.backend');

  let failures = 0;

  for (const manifestPath of manifestPaths) {
    try {
      const { manifest } = loadManifest(manifestPath);
      validateManifest(manifest);

      if (options.validateOnly) {
        console.log('VALID ' + manifestPath);
        continue;
      }

      const result = generateManifest(manifest, backendRoot, {
        force: options.force
      });

      console.log('\\nGENERATED ' + manifestPath);
      console.log('Output: ' + result.output);
      console.log('Files: ' + result.results.length);

      for (const item of result.results) {
        console.log('  ' + item.status.toUpperCase() + ' ' + item.file);
      }
    } catch (error) {
      failures++;
      console.error('\\nFAILED ' + manifestPath);
      console.error(error.stack || error.message);
    }
  }

  if (failures) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
`,

  'manifests/example.json': `{
  "lab": "inventory",
  "studio": "catalog",
  "description": "Example inventory catalog Studio",
  "persistence": {
    "provider": "prisma",
    "database": "postgres"
  },
  "capabilities": {
    "unitOfWork": { "enabled": true },
    "outbox": { "enabled": true },
    "inbox": { "enabled": true },
    "saga": { "enabled": true },
    "cache": { "enabled": true },
    "messaging": { "enabled": true },
    "jwt": { "enabled": true },
    "tenantScope": { "enabled": true }
  },
  "enums": [
    {
      "name": "ProductStatus",
      "values": ["DRAFT", "ACTIVE", "ARCHIVED"]
    }
  ],
  "models": [
    {
      "name": "Product",
      "fields": [
        { "name": "id", "type": "uuid", "required": true },
        { "name": "name", "type": "string", "required": true },
        { "name": "sku", "type": "string", "required": true },
        { "name": "quantity", "type": "int", "required": true },
        { "name": "price", "type": "decimal", "required": true },
        { "name": "status", "type": "enum", "enum": "ProductStatus", "required": true },
        { "name": "description", "type": "text", "required": false, "nullable": true },
        { "name": "isActive", "type": "boolean", "required": true }
      ]
    }
  ]
}
`,

  'README.md': `
# Chemicalist Backend Generator

A Node.js-based, manifest-driven source generator.

## 1. Validate a manifest

\`\`\`bash
node backend-foldering-generators.js --validate manifests/example.json
\`\`\`

## 2. Generate a Studio

\`\`\`bash
node backend-foldering-generators.js manifests/example.json
\`\`\`

By default, generated output goes to \`./chemicalist.backend\` under the current working directory.

## 3. Generate all manifests

\`\`\`bash
node backend-foldering-generators.js --all manifests
\`\`\`

## 4. Set an output directory

\`\`\`bash
node backend-foldering-generators.js manifests/example.json --out ../my-backend
\`\`\`

## 5. Overwrite generator-owned files

\`\`\`bash
node backend-foldering-generators.js manifests/example.json --force
\`\`\`

Without \`--force\`, the generator preserves non-generated files and writes a
\`.generator-conflict\` file when a generated path conflicts with a manually
maintained file.

## Important

This project generates a source-code baseline. Enabling a capability does not
magically configure its infrastructure. Redis adapters, RabbitMQ consumers,
durable Outbox/Inbox workers, Saga persistence/compensation, JWT guards,
tenant authorization, migrations, and production-grade validation must be
implemented and wired before deployment.
`
};

function writeFile(relativePath, content) {
  const target = path.resolve(ROOT, relativePath);

  if (!target.startsWith(ROOT + path.sep)) {
    throw new Error('Unsafe path: ' + relativePath);
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });

  if (fs.existsSync(target) && !force) {
    console.log('SKIP existing file: ' + relativePath);
    return;
  }

  fs.writeFileSync(target, content.trimStart(), 'utf8');
  console.log((fs.existsSync(target) ? 'WROTE ' : 'CREATED ') + relativePath);
}

function main() {
  fs.mkdirSync(ROOT, { recursive: true });

  for (const [relativePath, content] of Object.entries(files)) {
    writeFile(relativePath, content);
  }

  console.log('\\nGenerator bootstrap completed.');
  console.log('Generator root: ' + ROOT);
  console.log('Manifest example: ' + path.join(ROOT, 'manifests', 'example.json'));
  console.log('Run the generated CLI from the generator root.');
  console.log('Existing files are preserved unless --force is specified.');
}

main();
