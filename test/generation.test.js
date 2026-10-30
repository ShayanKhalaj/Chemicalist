"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { buildContext } = require("../engine/context");
const { validateManifest, loadAndValidateManifest, ManifestError } = require("../engine/manifest");
const { OutputPlan, plan: classifyOutput } = require("../engine/writer");
const { plan } = require("../engine");
const { patchBlock } = require("../engine/patch");

function exampleManifest() {
  const file = path.join(__dirname, "..", "manifests", "example.manifest.json");
  return loadAndValidateManifest(file);
}

function generatedFiles(manifest) {
  const context = buildContext(manifest);
  const output = new OutputPlan(path.join(__dirname, ".generated-test"));
  plan(context, output, { frontend: "bootstrap" });
  return { context, files: output.files, output };
}

test("manifest DTOs and custom methods generate repository and query contracts", () => {
  const manifest = exampleManifest();
  const { context, files, output } = generatedFiles(manifest);
  const classified = classifyOutput(output.root, output).results;
  const markedContent = (scope, relativePath) =>
    classified.find((entry) => entry.scope === scope && entry.path === relativePath).content;
  const product = context.studio.models.find((model) => model.name === "Product");
  const content = (relativePath) => {
    const file = files.get("backend:" + relativePath);
    assert.ok(file, "expected generated file " + relativePath);
    return file.content;
  };
  const schema = content(product.paths.schema + ".ts");
  const repository = content(product.paths.repository + ".ts");
  const repositoryContract = content(product.paths.repositoryContract + ".ts");
  const persistenceModel = content(product.paths.persistenceModel + ".ts");
  const prismaSchema = content("prisma/schema.prisma");
  const backendPackage = JSON.parse(content("package.json"));

  assert.match(markedContent("backend", ".env.example"), /^# @generated/);
  assert.match(markedContent("backend", "docker-compose.yml"), /^# @generated/);
  assert.match(markedContent("backend", "Dockerfile"), /^# @generated/);
  assert.match(markedContent("frontend", "src/app/styles.css"), /^\/\* @generated/);
  assert.match(markedContent("frontend", "public/robots.txt"), /^User-agent:/);
  assert.deepEqual(product.dtoFields.create, [
    "name",
    "sku",
    "quantity",
    "price",
    "status",
    "isActive",
    "description",
  ]);
  assert.match(schema, /filterMode: z\.enum\(\['and', 'or'\]\)/);
  assert.match(schema, /\.max\(8\)\.default\(\[\{ field: 'createdAt', direction: 'desc' \}\]\)/);
  assert.match(schema, /contains: z\.string\(\)\.max\(500\)\.optional\(\)/);
  assert.match(repository, /async createOne\(/);
  assert.match(repository, /async createMany\(/);
  assert.match(repository, /async hardDeleteMany\(/);
  assert.match(repository, /async restoreMany\(/);
  assert.match(repository, /async getOneById\(/);
  assert.match(repository, /async search\(/);
  assert.match(repository, /async checkDuplicate\(/);
  assert.match(repository, /async findOneBySku\(sku: string\)/);
  assert.match(repository, /async findManyByStatus\(status: string\)/);
  assert.match(repository, /async countByStatus\(status: string\)/);
  assert.match(repository, /status: status as PrismaProductStatus/);
  assert.match(repository, /async isExistedBySku\(sku: string\)/);
  assert.match(repositoryContract, /findOneBySku\(sku: string\)/);
  assert.match(persistenceModel, /ProductStatus as PrismaProductStatus/);
  assert.match(prismaSchema, /enum ProductStatus \{\s+DRAFT\s+ACTIVE\s+ARCHIVED/);

  const audit = content("src/platform/audit/audit.interceptor.ts");
  assert.match(audit, /await this\.audit\.record/);
  assert.match(audit, /materialize\(\)/);
  assert.match(prismaSchema, /model ChemicalistUserCredential \{/);
  assert.match(prismaSchema, /model ChemicalistRoleGroup \{/);
  assert.match(prismaSchema, /model ChemicalistUserSession \{/);
  assert.match(content("Dockerfile"), /npm install --no-audit/);
  assert.match(content("docker-compose.yml"), /postgres:17-alpine/);
  assert.match(backendPackage.scripts["docker:setup"], /npm run db:migrate/);
  assert.equal(backendPackage["docker:setup"], undefined);
  assert.match(content("prisma/seed.ts"), /Admin@123456/);
  assert.match(content("prisma/seed.ts"), /ALL_PERMISSION_KEYS/);
  assert.match(files.get("frontend:src/app/styles.css").content, /--primary: #0f766e/);
  assert.match(content("Dockerfile").replace(/\r\n/g, "\n"), /EXPOSE 3000/);
});

test("manifest rejects invalid DTO fields and unsafe custom repository methods", () => {
  const source = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "manifests", "example.manifest.json"), "utf8"),
  );
  source.models[0].dtos.create = ["id"];

  assert.throws(
    () => validateManifest(source),
    (error) =>
      error instanceof ManifestError &&
      error.issues.some((issue) => issue.includes("unknown field `id`")),
  );

  source.models[0].dtos.create = ["name"];
  source.models[0].customMethods.push({
    name: "createOne",
    operation: "findOneBy",
    fields: ["sku"],
  });

  assert.throws(
    () => validateManifest(source),
    (error) =>
      error instanceof ManifestError &&
      error.issues.some((issue) => issue.includes("reserved repository method")),
  );
});

test("patching a later generated block replaces it instead of appending duplicates", () => {
  const source = [
    '// <chemicalist:block name="models">',
    "const models = [];",
    "// </chemicalist:block>",
    '  // <chemicalist:block name="tenant-user">',
    "return undefined;",
    "  // </chemicalist:block>",
  ].join("\n");
  const patched = patchBlock(source, "tenant-user", "return tenantId;");

  assert.equal((patched.match(/name="tenant-user"/g) || []).length, 1);
  assert.match(patched, /return tenantId;/);
  assert.doesNotMatch(patched, /return undefined;/);
  assert.match(patched, /\n  \/\/ <\/chemicalist:block>/);
});

test("MongoDB manifest output uses ObjectId and the UI template overrides theme tokens", () => {
  const file = path.join(__dirname, "..", "manifests", "example.manifest.json");
  const manifest = loadAndValidateManifest(file, undefined, {
    overrides: { persistence: { database: "mongodb" } },
    uiTemplate: {
      colors: { primary: "#123456" },
      typography: { baseFontSize: "16px" },
      radius: "12px",
    },
  });
  const { context, files } = generatedFiles(manifest);
  const product = context.studio.models.find((model) => model.name === "Product");
  const schema = files.get("backend:prisma/schema.prisma").content;
  const styles = files.get("frontend:src/app/styles.css").content;
  const compose = files.get("backend:docker-compose.yml").content;
  const backendPackage = JSON.parse(files.get("backend:package.json").content);

  assert.match(schema, /provider = "mongodb"/);
  assert.match(schema, /@default\(auto\(\)\) @map\("_id"\) @db\.ObjectId/);
  assert.doesNotMatch(schema, /schemas = \[/);
  assert.match(
    files.get("backend:" + product.paths.prismaMapper + ".ts").content,
    /toCreateData/,
  );
  assert.match(compose, /mongo:8/);
  assert.match(compose, /--replSet/);
  assert.match(compose, /mongodb-replica-init/);
  assert.match(compose, /service_completed_successfully/);
  assert.match(compose, /replicaSet=rs0/);
  assert.match(backendPackage.scripts["docker:setup"], /npm run db:push/);
  assert.match(styles, /--primary: #123456/);
  assert.match(styles, /--radius: 12px/);
  assert.match(styles, /font-size: 16px/);
});
