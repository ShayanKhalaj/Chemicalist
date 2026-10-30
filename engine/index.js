"use strict";

/**
 * Generation pipeline.
 *
 * `plan(context, outputPlan)` is a pure function of the generation context: it
 * fills an {@link OutputPlan} with every file that belongs to the backend
 * application (project config, shared kernel, database, platform layer,
 * optional transport capabilities, bootstrap and every registered studio).
 * Nothing is written here; the writer decides what to create, update or leave
 * alone.
 *
 * The frontend is a separate project with its own lifecycle:
 *  - `bootstrap` writes the frontend scaffold exactly once,
 *  - `studios` only adds/updates the UI pages of studios that enable `ui`.
 */

const { addStudioFiles, patchAppOwnedFiles } = require("../generators/studio");
const shared = require("../generators/shared");
const frontend = require("../generators/frontend");

const FRONTEND_MODES = new Set(["none", "bootstrap", "studios"]);

/**
 * @param {object} ctx generation context from `buildContext`
 * @param {import("./writer").OutputPlan} outputPlan
 * @param {object} [options] { notes: string[], frontend?: "none"|"bootstrap"|"studios" }
 */
function plan(ctx, outputPlan, options = {}) {
  const notes = options.notes || [];
  const frontendMode = options.frontend || "none";
  if (!FRONTEND_MODES.has(frontendMode)) {
    throw new Error("Unknown frontend plan mode: " + frontendMode);
  }

  // When several manifests share one application, the app-wide project files,
  // platform layer and Prisma schema are identical for every studio: they are
  // generated once, on the first studio, and only that studio's own code and
  // UI pages are added per manifest.
  const isFirstStudioForApp = !outputPlan.appFilesPlanned;
  outputPlan.appFilesPlanned = true;

  if (!ctx.outputs.api) {
    notes.push("API output disabled by the project configuration");
  } else {
  if (isFirstStudioForApp) {
  shared.addProjectFiles(outputPlan, ctx);
  shared.addSharedKernel(outputPlan, ctx);
  shared.addDatabase(outputPlan, ctx);
  shared.addPlatform(outputPlan, ctx);
  shared.addTransportCapabilities(outputPlan, ctx);
  shared.addBootstrap(outputPlan, ctx);
  }

  addStudioFiles(outputPlan, ctx);
  if (isFirstStudioForApp) patchAppOwnedFiles(outputPlan, ctx);
  }

  if (!ctx.appUi.enabled || !ctx.outputs.frontend) {
    notes.push("frontend skipped: ui.enabled is false in the manifest");
  } else if (frontendMode === "bootstrap") {
    if (isFirstStudioForApp) frontend.addFrontendScaffold(outputPlan.forFrontend(), ctx);
    frontend.addFrontendPages(outputPlan.forFrontend(), ctx);
  } else if (frontendMode === "studios") {
    // The backend is always generated before the UI: a studio's screens are
    // only regenerated when the project itself has been bootstrapped.
    frontend.addFrontendPages(outputPlan.forFrontend(), ctx);
  }

  return outputPlan;
}

module.exports = { plan, FRONTEND_MODES };
