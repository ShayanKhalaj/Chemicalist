"use strict";

/**
 * Studio module: wires controllers, use cases and repository implementations.
 * Shared infrastructure (PrismaService, UnitOfWorkService, OutboxService) comes
 * from global modules, so it is never re-provided per studio.
 */

function generateStudioModule(ctx) {
  const studio = ctx.studio;
  const imports = ["import { Module } from '@nestjs/common';"];
  const providers = [];
  const controllers = [];
  const exportsList = [];
  const moduleImports = [];

  if (ctx.has("outbox")) {
    moduleImports.push("OutboxModule");
    imports.push(
      "import { OutboxModule } from '" +
        ctx.rel(ctx.studio.modulePath, 'src/platform/communication/outbox/outbox.module') +
        "';",
    );
  }

  for (const model of studio.models) {
    imports.push(
      "import { " +
        model.names.service +
        " } from './application/use-cases/" +
        model.routeSingle +
        ".use-cases';",
      "import { " +
        model.names.repositoryImpl +
        " } from './persistence/repositories/prisma-" +
        model.routeSingle +
        ".repository';",
      "import { " +
        model.names.token +
        " } from './application/contracts/" +
        model.routeSingle +
        ".tokens';",
    );
    if (
      model.features.read ||
      model.features.create ||
      model.features.update ||
      model.features.delete
    ) {
      imports.push(
        "import { " +
          model.name +
          "Controller } from './presentation/controllers/" +
          model.routeSingle +
          ".controller';",
      );
      controllers.push(model.name + "Controller");
    }
    providers.push(
      model.names.service,
      "{ provide: " +
        model.names.token +
        ", useClass: " +
        model.names.repositoryImpl +
        " }",
    );
    exportsList.push(model.names.service);
  }

  const formatList = (items) =>
    items
      .map(
        (item) => "    " + (typeof item === "string" ? item + "," : item + ","),
      )
      .join("\n");

  return [
    ...imports,
    "",
    "@Module({",
    ...(moduleImports.length
      ? ["  imports: [" + moduleImports.join(", ") + "],"]
      : []),
    "  controllers: [",
    formatList(controllers),
    "  ],",
    "  providers: [",
    formatList(providers),
    "  ],",
    "  exports: [",
    formatList(exportsList),
    "  ],",
    "})",
    "export class " + studio.moduleName + " {}",
    "",
  ].join("\n");
}

module.exports = { generateStudioModule };
