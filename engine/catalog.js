"use strict";

const { pascal } = require("./naming");

const CATALOG_FORMAT = "chemicalist.catalog";
const TEMPLATE_FORMAT = "chemicalist.studio-template";

function catalogError(filePath, issues) {
  const error = new Error(
    "Catalog validation failed for " +
      filePath +
      ":\n" +
      issues.map((issue) => "  - " + issue).join("\n"),
  );
  error.name = "CatalogError";
  error.filePath = filePath;
  error.issues = issues;
  return error;
}

function expandCatalog(catalog, studioTemplate, filePath) {
  const issues = [];
  if (!catalog || catalog.format !== CATALOG_FORMAT) {
    throw catalogError(filePath, ['format must be "' + CATALOG_FORMAT + '"']);
  }
  if (catalog.version !== 1) {
    issues.push("version: only catalog version 1 is supported");
  }
  if (!studioTemplate || studioTemplate.format !== TEMPLATE_FORMAT) {
    issues.push(
      'studio template format must be "' + TEMPLATE_FORMAT + '"',
    );
  }
  if (studioTemplate && studioTemplate.version !== 1) {
    issues.push("studio template version: only version 1 is supported");
  }
  if (!Array.isArray(catalog.labs) || catalog.labs.length === 0) {
    issues.push("labs: must be a non-empty array");
  }
  if (
    !studioTemplate ||
    !studioTemplate.profiles ||
    typeof studioTemplate.profiles !== "object" ||
    Array.isArray(studioTemplate.profiles)
  ) {
    issues.push("studio template profiles: must be an object");
  }
  if (issues.length) throw catalogError(filePath, issues);

  const enumNames = new Set(
    (Array.isArray(studioTemplate.enums) ? studioTemplate.enums : [])
      .filter((item) => item && typeof item.name === "string")
      .map((item) => item.name),
  );
  const baseFields = studioTemplate.baseFields;
  if (!Array.isArray(baseFields) || baseFields.length === 0) {
    throw catalogError(filePath, ["studio template baseFields must be non-empty"]);
  }

  const labNames = new Set();
  const labSlugs = new Set();
  const studioKeys = new Set();
  const manifests = [];

  for (const [labIndex, lab] of catalog.labs.entries()) {
    const labPath = "labs[" + labIndex + "]";
    if (!lab || typeof lab !== "object" || Array.isArray(lab)) {
      issues.push(labPath + ": must be an object");
      continue;
    }
    if (
      typeof lab.name !== "string" ||
      !/^[A-Za-z][A-Za-z0-9 _&-]*$/.test(lab.name)
    ) {
      issues.push(labPath + ".name: invalid Lab name");
      continue;
    }
    if (
      typeof lab.slug !== "string" ||
      !/^[a-z][a-z0-9-]*$/.test(lab.slug)
    ) {
      issues.push(labPath + ".slug: must be lowercase kebab-case");
      continue;
    }
    if (labNames.has(lab.name) || labSlugs.has(lab.slug)) {
      issues.push(labPath + ": Lab names and slugs must be unique");
      continue;
    }
    labNames.add(lab.name);
    labSlugs.add(lab.slug);
    if (!Array.isArray(lab.studios) || lab.studios.length === 0) {
      issues.push(labPath + ".studios: must be a non-empty array");
      continue;
    }

    for (const [studioIndex, studio] of lab.studios.entries()) {
      const studioPath = labPath + ".studios[" + studioIndex + "]";
      if (!studio || typeof studio !== "object" || Array.isArray(studio)) {
        issues.push(studioPath + ": must be an object");
        continue;
      }
      if (
        typeof studio.name !== "string" ||
        !/^[A-Za-z][A-Za-z0-9 &-]*$/.test(studio.name)
      ) {
        issues.push(studioPath + ".name: invalid Studio name");
        continue;
      }
      if (
        typeof studio.slug !== "string" ||
        !/^[a-z][a-z0-9-]*$/.test(studio.slug)
      ) {
        issues.push(studioPath + ".slug: must be lowercase kebab-case");
        continue;
      }
      const key = lab.slug + "/" + studio.slug;
      if (studioKeys.has(key)) {
        issues.push(studioPath + ": duplicate Studio key `" + key + "`");
        continue;
      }
      studioKeys.add(key);
      if (!Array.isArray(studio.entities) || studio.entities.length === 0) {
        issues.push(studioPath + ".entities: must be a non-empty array");
        continue;
      }

      const models = [];
      const operations = {};
      const search = {};
      const sort = {};
      for (const [entityIndex, entity] of studio.entities.entries()) {
        const entityPath = studioPath + ".entities[" + entityIndex + "]";
        if (!entity || typeof entity !== "object" || Array.isArray(entity)) {
          issues.push(entityPath + ": must be an object");
          continue;
        }
        if (
          typeof entity.name !== "string" ||
          !/^[A-Z][A-Za-z0-9]*$/.test(entity.name)
        ) {
          issues.push(entityPath + ".name: must be a PascalCase entity name");
          continue;
        }
        const profile = studioTemplate.profiles[entity.profile];
        if (!profile || typeof profile !== "object") {
          issues.push(
            entityPath +
              ".profile: unknown studio template profile `" +
              String(entity.profile) +
              "`",
          );
          continue;
        }
        const modelName = pascal(lab.slug) + pascal(entity.name);
        const profileFields = Array.isArray(profile.fields)
          ? profile.fields
          : [];
        const fields = [...baseFields, ...profileFields].map((field) => ({
          ...field,
        }));
        const profileFieldNames = profileFields.map((field) => field.name);
        const modelDto = {
          create: [
            "reference",
            "name",
            "description",
            ...(profile.createFields || profileFieldNames),
          ].filter((fieldName) => fields.some((field) => field.name === fieldName)),
          update: [
            "name",
            "description",
            ...(profile.updateFields || profileFieldNames),
          ].filter((fieldName) => fields.some((field) => field.name === fieldName)),
          query: fields
            .filter(
              (field) =>
                field.type !== "json" &&
                field.type !== "array" &&
                !String(field.type).endsWith("[]"),
            )
            .map((field) => field.name),
        };
        const model = {
          name: modelName,
          label: entity.label || entity.name,
          fields,
          dtos: modelDto,
          customMethods: [
            {
              name: "findOneByReference",
              operation: "findOneBy",
              fields: ["reference"],
            },
            {
              name: "isExistedByReference",
              operation: "isExistedBy",
              fields: ["reference"],
            },
          ],
        };
        models.push(model);
        operations[modelName] = profile.operations || [
          "create",
          "read",
          "update",
        ];
        search[modelName] = [
          "reference",
          "name",
          ...(profile.searchFields || []),
        ].filter((fieldName, index, values) => values.indexOf(fieldName) === index);
        sort[modelName] = [
          "createdAt",
          "updatedAt",
          ...(profile.sortFields || []),
        ].filter((fieldName, index, values) => values.indexOf(fieldName) === index);
      }

      manifests.push({
        lab: lab.name,
        labSlug: lab.slug,
        studio: studio.name,
        studioSlug: studio.slug,
        description: studio.description || "",
        enums: studioTemplate.enums,
        models,
        operations,
        search,
        sort,
        relationships: studio.relationships || [],
        capabilities: catalog.capabilities || {},
        studioMetadata: {
          ownership: lab.ownership || "",
          publicEvents: lab.publicEvents || [],
          dependencies: studio.dependencies || [],
          maturity: studio.maturity || "starter",
        },
      });
    }
  }

  const expectedLabCount = catalog.expected && catalog.expected.labs;
  const expectedStudioCount = catalog.expected && catalog.expected.studios;
  if (expectedLabCount !== undefined && expectedLabCount !== labNames.size) {
    issues.push(
      "expected.labs: declared " +
        expectedLabCount +
        " but found " +
        labNames.size,
    );
  }
  if (expectedStudioCount !== undefined && expectedStudioCount !== studioKeys.size) {
    issues.push(
      "expected.studios: declared " +
        expectedStudioCount +
        " but found " +
        studioKeys.size,
    );
  }
  if (!enumNames.has("StudioRecordStatus")) {
    issues.push("studio template must define the StudioRecordStatus enum");
  }
  if (issues.length) throw catalogError(filePath, issues);
  return manifests;
}

module.exports = {
  CATALOG_FORMAT,
  TEMPLATE_FORMAT,
  catalogError,
  expandCatalog,
};
