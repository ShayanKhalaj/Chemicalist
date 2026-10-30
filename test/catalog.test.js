"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  loadAndValidateManifest,
  loadAndValidateManifests,
} = require("../engine/manifest");
const {
  buildContext,
  describeStudioForRegistry,
} = require("../engine/context");

const catalogPath = path.join(
  __dirname,
  "..",
  "manifests",
  "chemicalist.manifest.json",
);

test("Chemicalist catalog expands all documented Labs and Studios", () => {
  const manifests = loadAndValidateManifests(catalogPath);
  const labs = new Set(manifests.map((manifest) => manifest.labSlug));
  const studioKeys = new Set(
    manifests.map((manifest) => manifest.labSlug + "/" + manifest.studioSlug),
  );
  const modelNames = manifests.flatMap((manifest) =>
    manifest.models.map((model) => model.name),
  );

  assert.equal(labs.size, 16);
  assert.equal(studioKeys.size, 93);
  assert.equal(manifests.length, 93);
  assert.equal(new Set(modelNames).size, modelNames.length);
  assert.ok(manifests.every((manifest) => manifest.app.name === "chemicalist-platform"));
  assert.ok(manifests.every((manifest) => manifest.persistence.database === "postgres"));
});

test("catalog Studio selection survives registry reload", () => {
  const [first, second] = loadAndValidateManifests(catalogPath);
  const firstContext = buildContext(first);
  const descriptor = describeStudioForRegistry(first, firstContext);
  const secondContext = buildContext(second, {
    [descriptor.key]: descriptor,
  });

  assert.equal(descriptor.catalogKey, descriptor.key);
  assert.equal(secondContext.studios.length, 2);
  assert.ok(
    secondContext.studios.some(
      (studio) =>
        studio.labSlug === first.labSlug &&
        studio.studioSlug === first.studioSlug,
    ),
  );
  assert.ok(
    secondContext.studios.some(
      (studio) =>
        studio.labSlug === second.labSlug &&
        studio.studioSlug === second.studioSlug,
    ),
  );
});
