const path = require("node:path");
const fs = require("node:fs");
const root = path.join(__dirname, "..", "..");
const { loadAndValidateManifests } = require(
  path.join(root, "engine/manifest"),
);
const { buildContext, describeStudioForRegistry, readRegistryFile } = require(
  path.join(root, "engine/context"),
);
const { generatePrismaSchema } = require(
  path.join(root, "generators/persistence"),
);

const file = path.join(root, "manifests/chemicalist.manifest.json");
const all = loadAndValidateManifests(file);

// Simulate exactly what runGenerate does: registry grows studio by studio.
const next = { studios: {} };
let ctx;
for (const manifest of all) {
  ctx = buildContext(manifest, next.studios);
  const descriptor = describeStudioForRegistry(manifest, ctx);
  next.studios[descriptor.key] = descriptor;
}
console.log("registry studios:", Object.keys(next.studios).length);
console.log("ctx.appManifests:", ctx.appManifests.length);
console.log("ctx.studios:", ctx.studios.length);
console.log("ctx.registeredStudios:", ctx.registeredStudios.length);
const schema = generatePrismaSchema(ctx);
const models = schema.match(/^model .*/gm) || [];
console.log(
  "models:",
  models.length,
  "business:",
  models.filter((x) => !x.includes("Chemicalist")).length,
);
console.log((schema.match(/^ {4}"[a-z_]+",$/gm) || []).join(" "));
fs.writeFileSync(path.join(__dirname, "schema.prisma"), schema);
