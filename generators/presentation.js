'use strict';

/**
 * Presentation layer: HTTP controllers (NestJS) for every model.
 *
 * The global authentication guard already protects every route; controllers add
 * the tenant guard (studio data is always tenant-scoped) and declare the
 * permission required by each operation.
 */

const { enumImports } = require('../engine/ts');
const { kebab } = require('../engine/naming');

function permissionKey(model, action) {
  const manifest = model.manifest;
  return manifest.labSlug + '.' + manifest.studioSlug + '.' + kebab(model.name) + ':' + action;
}

function generateController(ctx, model) {
  const enums = enumImports(model.writableFields);

  const nestImports = [
    'Body',
    'Controller',
    'Delete',
    'Get',
    'HttpCode',
    'Param',
    'ParseUUIDPipe',
    'Patch',
    'Post',
    'Query',
    'UseGuards',
  ];

  const lines = ["import { " + nestImports.join(', ') + " } from '@nestjs/common';"];

  if (enums.length) {
    lines.push(
      "import { " +
        enums.join(', ') +
        " } from '" +
        ctx.rel(
          model.paths.controller,
          'src/labs/' +
            model.manifest.labSlug +
            '/studios/' +
            model.manifest.studioSlug +
            '/domain/enums/business-enums',
        ) +
        "';",
    );
  }

  lines.push(
    "import { RequirePermission } from '" +
      ctx.rel(model.paths.controller, 'src/platform/authorization/permissions') +
      "';",
    "import { TenantGuard } from '" +
      ctx.rel(model.paths.controller, 'src/platform/tenancy/tenant.guard') +
      "';",
    "import { " +
      model.names.service +
      " } from '" +
      ctx.rel(model.paths.controller, model.paths.useCases) +
      "';",
    'import {',
    '  ' + model.names.createDto + ',',
    '  ' + model.names.queryDto + ',',
    '  ' + model.names.updateDto + ',',
    "} from '" + ctx.rel(model.paths.controller, model.paths.dto) + "';",
    '',
    '/**',
    ' * REST API for ' + model.name + '.',
    ' *',
    ' * Mounted under the application prefix, lab and studio segments:',
    ' *   ' +
      ctx.app.urlPrefix(false) +
      '/' +
      ctx.studio.routes.labSegment +
      '/' +
      ctx.studio.routes.studioSegment +
      '/' +
      model.route,
    ' *',
    ' * Authentication is enforced globally; this controller adds tenant scoping',
    ' * and the per-operation permission of the ' + model.name + ' resource.',
    ' */',
    "@Controller('" +
      ctx.studio.routes.labSegment +
      '/' +
      ctx.studio.routes.studioSegment +
      '/' +
      model.route +
      "')",
    '@UseGuards(TenantGuard)',
    'export class ' + model.name + 'Controller {',
    '  constructor(private readonly service: ' + model.names.service + ') {}',
    ''
  );

  if (model.features.read) {
    lines.push(
      '  /** Paginated list with search, filtering and sorting (see the query DTO). */',
      '  @Get()',
      "  @RequirePermission('" + permissionKey(model, 'read') + "')",
      '  findAll(@Query() query: ' + model.names.queryDto + ') {',
      '    return this.service.findAll(query);',
      '  }',
      '',
      "  @Get(':id')",
      "  @RequirePermission('" + permissionKey(model, 'read') + "')",
      "  findOne(@Param('id') id: string) {",
      '    return this.service.findById(id);',
      '  }',
      ''
    );
  }
  if (model.features.create) {
    lines.push(
      '  @Post()',
      "  @RequirePermission('" + permissionKey(model, 'create') + "')",
      '  create(@Body() body: ' + model.names.createDto + ') {',
      '    return this.service.create(body);',
      '  }',
      ''
    );
  }
  if (model.features.update) {
    lines.push(
      "  @Patch(':id')",
      "  @RequirePermission('" + permissionKey(model, 'update') + "')",
      '  update(',
      "    @Param('id') id: string,",
      '    @Body() body: ' + model.names.updateDto + ',',
      '  ) {',
      '    return this.service.update(id, body);',
      '  }',
      ''
    );
  }
  if (model.features.delete) {
    lines.push(
      "  @Delete(':id')",
      '  @HttpCode(200)',
      "  @RequirePermission('" + permissionKey(model, 'delete') + "')",
      "  remove(@Param('id') id: string) {",
      '    return this.service.remove(id);',
      '  }'
    );
  }

  lines.push('}', '');
  return lines.join('\n');
}

module.exports = { generateController, permissionKey };
