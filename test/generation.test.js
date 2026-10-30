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

function catalogStudioManifest(catalogKey = "product/product-catalog") {
  const file = path.join(__dirname, "..", "manifests", "chemicalist.manifest.json");
  return loadAndValidateManifest(file, undefined, { catalogKey });
}

function generatedFiles(manifest) {
  const context = buildContext(manifest);
  const output = new OutputPlan(path.join(__dirname, ".generated-test"));
  plan(context, output, { frontend: "bootstrap" });
  return { context, files: output.files, output };
}

test("manifest DTOs and custom methods generate repository and query contracts", () => {
  const manifest = catalogStudioManifest();
  const { context, files, output } = generatedFiles(manifest);
  const classified = classifyOutput(output.root, output).results;
  const markedContent = (scope, relativePath) =>
    classified.find((entry) => entry.scope === scope && entry.path === relativePath).content;
  const product = context.studio.models[0];
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
    "reference",
    "name",
    "description",
    "productCode",
    "grade",
    "revision",
    "lifecycleStatus",
    "effectiveFrom",
    "safetyDataSheetReference",
    "specifications",
    "formulaVersionReference",
    "hazardClass",
    "shelfLifeMonths",
    "storageConditions",
    "releasedAt",
    "casNumber",
    "ghsClassification",
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
  assert.match(repository, /async findOneByReference\(reference: string\)/);
  assert.match(repositoryContract, /findOneByReference\(reference: string\)/);
  assert.match(repository, /async isExistedByReference\(reference: string\)/);

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
  const manifest = catalogStudioManifest();
  const entityFields = manifest.models[0].fields
    .filter((field) => !["id", "createdAt", "updatedAt"].includes(field.name))
    .map((field) => ({
    name: field.name,
    type: field.baseType === "uuid" ? "uuid" : field.baseType,
    ...(field.enumName ? { enum: field.enumName } : {}),
    ...(field.required ? {} : { required: false }),
    ...(field.nullable ? { nullable: true } : {}),
  }));

  assert.throws(
    () =>
      validateManifest({
        lab: "Product",
        studio: "Catalog",
        enums: manifest.enums.map((item) => ({ name: item.name, values: item.values })),
        models: [{ name: "CatalogItem", fields: entityFields, dtos: { create: ["doesNotExist"] } }],
      }),
    (error) =>
      error instanceof ManifestError &&
      error.issues.some((issue) => issue.includes("unknown field `doesNotExist`")),
    "expected unknown-field validation error",
  );

  assert.throws(
    () =>
      validateManifest({
        lab: "Product",
        studio: "Catalog",
        enums: manifest.enums.map((item) => ({ name: item.name, values: item.values })),
        models: [
          {
            name: "CatalogItem",
            fields: entityFields,
            customMethods: [
              { name: "createOne", operation: "findOneBy", fields: ["productCode"] },
            ],
          },
        ],
      }),
    (error) =>
      error instanceof ManifestError &&
      error.issues.some((issue) => issue.includes("reserved repository method")),
    "expected reserved-method validation error",
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

test("platform identity, auth, RBAC, audit, tenancy, and location are tenant-scoped", () => {
  const { files } = generatedFiles(catalogStudioManifest());
  const backend = (relativePath) => {
    const result = files.get("backend:" + relativePath);
    assert.ok(result, "expected generated file " + relativePath);
    return result.content;
  };
  const schema = backend("prisma/schema.prisma");
  const identity = backend("src/platform/identity/identity.service.ts");
  const identityController = backend("src/platform/identity/identity.controller.ts");
  const authentication = backend("src/platform/security/jwt-auth.guard.ts");
  const tokenService = backend("src/platform/security/token.service.ts");
  const permissionGuard = backend("src/platform/authorization/permission.guard.ts");
  const audit = backend("src/platform/audit/audit.service.ts");
  const location = backend("src/platform/location/location.service.ts");
  const locationController = backend("src/platform/location/location.controller.ts");
  const tenancy = backend("src/platform/tenancy/tenancy.service.ts");
  const platformModule = backend("src/platform/platform.module.ts");
  const authService = backend("src/platform/security/auth/auth.service.ts");
  const authController = backend("src/platform/security/auth/auth.controller.ts");
  const envSchema = backend("src/platform/configuration/env.schema.ts");

  assert.doesNotMatch(identityController, /isPlatformAdmin: z\.boolean/);
  assert.match(identity, /isPlatformAdmin: false/);
  assert.match(identity, /assertTenantAccess/);
  assert.match(identity, /tenantId: user\.tenantId/);
  assert.match(identity, /return role\.id;\s+}\s+\n\s+async createRole/);
  assert.match(identity, /async revokeRoleGroup/);
  assert.match(identity, /async replaceRoleGroupRoles/);
  assert.match(identity, /async replacePermissionGroupPermissions/);
  assert.match(identity, /SYSTEM_ROLE_GROUP_IMMUTABLE/);
  assert.match(identity, /SYSTEM_PERMISSION_GROUP_IMMUTABLE/);
  assert.match(identityController, /@Delete\('users\/:id\/role-groups\/:groupKey'\)/);
  assert.match(identityController, /@Put\('role-groups\/:groupKey\/roles'\)/);
  assert.match(identityController, /@Put\('permission-groups\/:groupKey\/permissions'\)/);
  assert.match(identityController, /this\.tenantScope\(actor, requestedTenantId\)/);
  assert.match(tokenService, /sid: sessionId/);
  assert.match(authentication, /activeSessionIdentity\(claims\.sub, claims\.sid\)/);
  assert.match(authentication, /INACTIVE_ACCOUNT_OR_SESSION/);
  assert.doesNotMatch(permissionGuard, /if \(request\.user\.isPlatformAdmin\) return true/);
  assert.match(authService, /replacedById: replacement\.id/);
  assert.match(authService, /async logoutAll/);
  assert.match(authController, /@Delete\('sessions\/:sessionId'\)/);
  assert.match(authController, /@Post\('change-password'\)/);
  assert.match(envSchema, /development-only-secret-change-before-deploy/);
  assert.match(envSchema, /environment\.NODE_ENV === 'production'/);
  assert.match(audit, /actor\.tenantId \?\? null/);
  assert.match(tenancy, /Only platform administrators can create tenants/);
  assert.match(location, /tenantId: this\.tenant\(actor\)/);
  assert.match(location, /INVALID_LOCATION_HIERARCHY/);
  assert.match(location, /chemicalistCountry\.findFirst/);
  assert.match(location, /REGION_EXISTS/);
  assert.match(location, /CITY_EXISTS/);
  assert.match(locationController, /platform\.location:write/);
  assert.match(locationController, /me\/addresses/);
  assert.match(schema, /model ChemicalistCountry \{/);
  assert.match(schema, /model ChemicalistRegion \{/);
  assert.match(schema, /model ChemicalistCity \{/);
  assert.match(schema, /model ChemicalistUserAddress \{/);
  assert.equal((platformModule.match(/import \{ LocationModule \}/g) || []).length, 1);
});

test("MongoDB manifest output uses ObjectId and the UI template overrides theme tokens", () => {
  const manifest = loadAndValidateManifest(
    path.join(__dirname, "..", "manifests", "chemicalist.manifest.json"),
    undefined,
    {
      catalogKey: "product/product-catalog",
      overrides: { persistence: { database: "mongodb" } },
      uiTemplate: {
        colors: { primary: "#123456" },
        typography: { baseFontSize: "16px" },
        radius: "12px",
      },
    },
  );
  const { context, files } = generatedFiles(manifest);
  const product = context.studio.models[0];
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

