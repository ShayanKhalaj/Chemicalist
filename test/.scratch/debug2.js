const path = require("node:path");
const root = path.join(__dirname, "..", "..");
const { loadAndValidateManifests } = require(
  path.join(root, "engine/manifest"),
);
const { buildContext } = require(path.join(root, "engine/context"));
const all = loadAndValidateManifests(
  path.join(root, "manifests/chemicalist.manifest.json"),
);
console.log(typeof buildContext);
const ctx = buildContext(all[0]);
console.log(
  "appManifests:",
  Array.isArray(ctx.appManifests)
    ? ctx.appManifests.length
    : typeof ctx.appManifests,
);
console.log("labSchemas size:", ctx.labSchemas && ctx.labSchemas.size);
console.log(
  "first names:",
  ctx.appManifests && ctx.appManifests.slice(0, 3).map((m) => m.labSlug),
);
