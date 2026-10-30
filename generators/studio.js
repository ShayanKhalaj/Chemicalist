"use strict";

/**
 * Studio-level output: every file inside
 *   src/labs/<lab>/studios/<studio>/
 * plus the generator-owned sections of the app-owned helper scripts.
 */

const domain = require("./domain");
const application = require("./application");
const persistence = require("./persistence");
const presentation = require("./presentation");
const { generateStudioModule } = require("./studio-module");
const appT = require("../templates/backend/app.templates");
const { patchBlock } = require("../engine/patch");
const { kebab } = require("../engine/naming");

function addStudioFiles(plan, ctx) {
  const studio = ctx.studio;
  const owner = {
    owner: "studio",
    studio: studio.labSlug + "/" + studio.studioSlug,
  };
  const root = studio.root;
  const m = studio.manifest;

  plan.add(
    root + "/domain/enums/studio-enums.ts",
    domain.generateEnums(ctx),
    owner,
  );
  plan.add(
    root + "/domain/enums/business-enums.ts",
    domain.generateBusinessEnums(ctx),
    owner,
  );

  for (const model of studio.models) {
    plan.add(
      model.paths.domain + ".ts",
      domain.generateModel(ctx, model),
      owner,
    );
    plan.add(
      model.paths.schema + ".ts",
      application.generateSchemas(ctx, model),
      owner,
    );
    plan.add(
      model.paths.dto + ".ts",
      application.generateDtos(ctx, model),
      owner,
    );
    plan.add(
      model.paths.repositoryContract + ".ts",
      application.generateRepositoryContract(ctx, model),
      owner,
    );
    plan.add(
      model.paths.repositoryToken + ".ts",
      application.generateTokens(model),
      owner,
    );
    plan.add(
      model.paths.serviceContract + ".ts",
      application.generateServiceContract(ctx, model),
      owner,
    );
    plan.add(
      model.paths.mapper + ".ts",
      application.generateMapperContract(ctx, model),
      owner,
    );
    plan.add(
      model.paths.useCases + ".ts",
      application.generateUseCases(ctx, model),
      owner,
    );
    plan.add(
      model.paths.persistenceModel + ".ts",
      persistence.generatePersistenceModel(ctx, model),
      owner,
    );
    plan.add(
      model.paths.prismaMapper + ".ts",
      persistence.generateMapper(ctx, model),
      owner,
    );
    plan.add(
      model.paths.repository + ".ts",
      persistence.generateRepository(ctx, model),
      owner,
    );
    plan.add(
      model.paths.controller + ".ts",
      presentation.generateController(ctx, model),
      owner,
    );
    plan.add(
      model.paths.spec + ".ts",
      application.generateSpec(ctx, model),
      owner,
    );
    if (ctx.has("outbox")) {
      plan.add(
        model.paths.events + ".ts",
        application.generateEvents(ctx, model),
        owner,
      );
    }
  }

  plan.add(
    root + "/" + kebab(m.studio) + ".module.ts",
    generateStudioModule(ctx),
    owner,
  );
  plan.add(
    root + "/studio.manifest.json",
    JSON.stringify(strippedManifest(m, ctx), null, 2),
    owner,
  );
  plan.add(root + "/README.md", studioReadme(ctx), owner);
}

function strippedManifest(manifest, ctx) {
  return {
    lab: manifest.lab,
    studio: manifest.studio,
    description: manifest.description,
    app: {
      name: manifest.app.name,
      apiPrefix: manifest.app.api.prefix,
      apiVersion: manifest.app.api.version,
    },
    models: manifest.models.map((model) => model.name),
    generatedBy: "chemicalist " + ctx.generatorVersion,
    sourceManifest: manifest.filePath,
  };
}

function studioReadme(ctx) {
  const studio = ctx.studio;
  const lines = [
    "# " + studio.studio + " (" + studio.lab + " Lab)",
    "",
    studio.manifest.description ||
      "Studio generated from a Chemicalist manifest.",
    "",
    "## Generated structure",
    "",
    "```",
    "domain/            POJO models + enums (no NestJS / Prisma imports)",
    "application/       Zod schemas, DTOs, contracts, use cases, events",
    "persistence/       Prisma row types, mappers, repository implementations",
    "presentation/      HTTP controllers",
    studio.studioSlug + ".module.ts  NestJS module wiring",
    "```",
    "",
    "## Endpoints",
    "",
  ];
  for (const model of studio.models) {
    lines.push(
      "- `" +
        ctx.app.urlPrefix(false) +
        "/" +
        studio.labSlug +
        "/" +
        studio.studioSlug +
        "/" +
        model.route +
        "` — " +
        model.name +
        " (" +
        Object.entries(model.features)
          .filter(([, enabled]) => enabled)
          .map(([name]) => name)
          .join(", ") +
        ")",
    );
  }
  lines.push(
    "",
    '> This directory is generated. Re-run `chemicalist generate "<manifest>" --out "<app dir>"` after changing the manifest.',
    "",
  );
  return lines.join("\n");
}

/** Patches the *app-owned* demo script with generator-owned blocks. */
function patchAppOwnedFiles(plan, ctx) {
  const path = "scripts/apply-registry.ts";
  const fresh = appT.applyRegistryScript(ctx);

  plan.addOwned(path, (existing) => {
    if (!existing) return { content: fresh, wasCreated: true };
    let content = existing;
    const blockNames = ["models", "tenant-user", "scenario", "fixtures"];
    for (const name of blockNames) {
      const match = fresh.match(
        new RegExp(
          '// <chemicalist:block name="' +
            name +
            '">[\\s\\S]*?// </chemicalist:block>',
        ),
      );
      if (!match) continue;
      const body = match[0].split("\n").slice(1, -1).join("\n");
      content = patchBlock(content, name, body);
    }
    return { content, wasCreated: !existing };
  });
}

module.exports = { addStudioFiles, patchAppOwnedFiles };
