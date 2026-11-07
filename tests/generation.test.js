"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  slugifyProjectName,
  titleFromProjectName,
  applyInitManifestEdits,
} = require("../bin/chemicalist");
const { loadAndValidateManifests } = require("../engine/manifest");
const {
  buildContext,
  describeStudioForRegistry,
} = require("../engine/context");
const { plan } = require("../engine");
const { OutputPlan } = require("../engine/writer");
const { kebabPlural } = require("../engine/naming");

test("project names become package slugs and titles", () => {
  assert.equal(slugifyProjectName("Inventory Suite"), "inventory-suite");
  assert.equal(slugifyProjectName("inventory-suite"), "inventory-suite");
  assert.equal(slugifyProjectName("!!!"), "");
  assert.equal(
    titleFromProjectName("Inventory Suite", "inventory-suite"),
    "Inventory Suite",
  );
  assert.equal(
    titleFromProjectName("inventory-suite", "inventory-suite"),
    "Inventory Suite",
  );
  assert.equal(
    kebabPlural("FinanceProfitabilityAnalysis"),
    "finance-profitability-analyses",
  );
  assert.equal(kebabPlural("Forecast"), "forecasts");
});

test("existing JSON manifests are not rewritten", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chemicalist-manifests-"));
  const manifestPath = path.join(dir, "chemicalist.manifest.json");
  const configPath = path.join(dir, "chemicalist.config.json");
  const manifest = '{\n  "format": "chemicalist.catalog",\n  "version": 1,\n  "labs": []\n}\n';
  const config = '{\n  "app": { "name": "kept", "title": "Kept" }\n}\n';
  fs.writeFileSync(manifestPath, manifest);
  fs.writeFileSync(configPath, config);

  const wrote = applyInitManifestEdits(
    {
      keepExistingManifests: true,
      dryRun: false,
      manifests: [manifestPath],
    },
    {
      projectName: "replaced",
      projectTitle: "Replaced",
      capabilities: { rbac: true, tenancy: true, audit: true, notification: true },
      outputs: { frontend: true, api: true, webservice: true },
      database: "mongodb",
      schema: "public",
      services: { elasticsearch: true },
    },
  );

  assert.equal(wrote, false);
  assert.equal(fs.readFileSync(manifestPath, "utf8"), manifest);
  assert.equal(fs.readFileSync(configPath, "utf8"), config);
});

test("each generated screen talks to its own studio", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chemicalist-"));
  const app = {
    name: "acme-plant",
    title: "Acme Plant",
    apiPrefix: "api",
    apiVersion: "1",
    port: 3000,
    corsOrigin: "http://localhost:3030",
  };
  const write = (name, body) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(body, null, 2));
    return file;
  };
  const model = (name) => ({
    name,
    fields: [
      { name: "reference", type: "string", required: true },
      { name: "name", type: "string", required: true },
    ],
  });
  const shared = {
    app,
    outputs: { api: true, frontend: true, webservice: false },
  };
  const planning = write("planning.manifest.json", {
    ...shared,
    lab: "Planning",
    studio: "Demand Planning",
    ui: { enabled: true, title: "Demand Planning" },
    enums: [{ name: "RecordStatus", values: ["DRAFT", "ACTIVE"] }],
    models: [
      {
        ...model("Forecast"),
        fields: [
          { name: "reference", type: "string", required: true },
          { name: "name", type: "string", required: true },
          {
            name: "status",
            type: "enum",
            enum: "RecordStatus",
            required: true,
            default: "DRAFT",
          },
        ],
        dtos: {
          create: ["reference", "name"],
          update: ["name"],
          query: ["name", "status"],
        },
      },
    ],
    search: { Forecast: ["name", "status"] },
  });
  const inventory = write("inventory.manifest.json", {
    ...shared,
    lab: "Inventory",
    studio: "Stock",
    ui: { enabled: true, title: "Stock" },
    models: [model("Position")],
  });

  const manifests = [planning, inventory].flatMap((file) =>
    loadAndValidateManifests(file),
  );
  const registry = {};
  for (const manifest of manifests) {
    const descriptor = describeStudioForRegistry(manifest);
    registry[descriptor.key] = descriptor;
  }

  const output = new OutputPlan(path.join(dir, "backend"), {
    frontendRoot: path.join(dir, "frontend"),
  });
  for (const manifest of manifests) {
    plan(buildContext(manifest, registry, { generatorVersion: "2.0.0" }), output, {
      notes: [],
      frontend: "bootstrap",
    });
  }

  const page = output.files.get(
    "frontend:src/app/(secure)/inventory/stock/positions/page.tsx",
  );
  assert.ok(page, "stock list page is planned");
  assert.match(page.content, /\/inventory\/stock\/positions\?page=/);
  assert.match(page.content, /labs\/inventory\/stock\/features\/Position/);
  assert.doesNotMatch(page.content, /labs\/planning/);
  assert.doesNotMatch(page.content, /undefined/);

  const forecastUseCases = output.files.get(
    "backend:src/labs/planning/demand-planning/application/use-cases/forecast.use-cases.ts",
  );
  assert.match(forecastUseCases.content, /name: \{ contains: search, mode: 'insensitive' \}/);
  assert.match(forecastUseCases.content, /status: "DRAFT"/);
  assert.match(forecastUseCases.content, /search\.toLowerCase\(\) === "draft"/);
  assert.doesNotMatch(forecastUseCases.content, /status: \{ contains:/);

  const forecast = output.files.get(
    "frontend:src/app/(secure)/planning/demand-planning/forecasts/page.tsx",
  );
  assert.match(forecast.content, /ForecastSearch/);
  assert.match(forecast.content, /labs\/planning\/demand-planning\/features\/Forecast/);

  const createForecast = output.files.get(
    "frontend:src/app/(secure)/planning/demand-planning/forecasts/new/page.tsx",
  );
  assert.match(createForecast.content, /reference: ''/);
  assert.doesNotMatch(createForecast.content, /status:/);
  const editForecast = output.files.get(
    "frontend:src/app/(secure)/planning/demand-planning/forecasts/[id]/edit/page.tsx",
  );
  assert.match(editForecast.content, /name: ''/);
  assert.doesNotMatch(editForecast.content, /reference: ''/);

  const login = output.files.get("frontend:src/app/login/page.tsx");
  assert.match(login.content, /from '\.\.\/components\/LoginPage'/);
  assert.doesNotMatch(login.content, /from '\.\.\/\.\.\/components\/LoginPage'/);

  const auth = output.files.get("frontend:src/app/auth/AuthContext.tsx");
  assert.match(auth.content, /\/platform\/auth\/login/);
  assert.match(auth.content, /router\.refresh\(\)/);

  const client = output.files.get("frontend:src/app/api/client.ts");
  assert.match(client.content, /document\.cookie/);
  assert.match(client.content, /const apiPrefix = '\/api\/v1'/);

  const appModule = output.files.get("backend:src/app.module.ts");
  assert.match(appModule.content, /as InventoryStockModule/);
  assert.match(appModule.content, /as PlanningDemandPlanningModule/);

  const backendPackage = output.files.get("backend:package.json");
  assert.match(backendPackage.content, /"name": "acme-plant-backend"/);

  const shell = output.files.get("frontend:src/app/components/AppShell.tsx");
  assert.match(shell.content, /\/inventory\/stock\/positions/);
  assert.match(shell.content, /\/planning\/demand-planning\/forecasts/);

  const env = output.files.get("backend:.env.example");
  assert.match(env.content, /CORS_ORIGIN=http:\/\/localhost:3030/);
});
