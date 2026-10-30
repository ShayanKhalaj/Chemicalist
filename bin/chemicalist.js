#!/usr/bin/env node
"use strict";

/**
 * Chemicalist CLI.
 *
 *   chemicalist validate <manifest.json...> [--json]
 *   chemicalist generate <manifest.json...> [--out <dir>] [--force] [--dry-run] [--quiet]
 *
 * Exit codes (stable, safe for CI):
 *   0  success
 *   1  generation finished but reported conflicts (files left untouched)
 *   2  invalid command line
 *   3  invalid manifest (or manifest could not be read)
 *   4  infrastructure error inside the generator
 */

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");

const pkg = require("../package.json");
const {
  ManifestError,
  loadAndValidateManifest,
  validateManifest,
  loadManifestFile,
} = require("../engine/manifest");
const {
  readRegistryFile,
  writeRegistryFile,
  buildContext,
  describeStudioForRegistry,
  DEFAULT_REGISTRY,
} = require("../engine/context");
const { OutputPlan } = require("../engine/writer");

const EXIT = {
  OK: 0,
  CONFLICT: 1,
  USAGE: 2,
  MANIFEST: 3,
  INTERNAL: 4,
};

const HELP = `Chemicalist ${pkg.version} — manifest-driven generator for modular NestJS backends

Usage:
  chemicalist validate <manifest.json...> [--json]
  chemicalist generate <manifest.json...> [--out <dir>] [--frontend-out <dir>]
                                 [--force] [--dry-run] [--quiet]
  chemicalist init <manifest.json...> [--out <dir>] [--frontend-out <dir>]
                                 [--force] [--no-install] [--verbose]
  chemicalist list [--out <dir>]

Options:
  --out <dir>   Backend (API) output directory
                (default: ./chemicalist.backend, or "app.outDir" from the manifest)
  --frontend-out <dir>
                Frontend (UI) output directory (default: ./chemicalist.frontend).
                Frontend files always go here, never into the backend directory.
  --force       Overwrite generator-owned files modified since the last generation
  --dry-run     Report what would change without writing anything
  --no-install  init only: skip npm install in generated projects
  --yes         init only: accept configuration defaults without prompts
  --verbose     init only: stream npm output
  --json        Machine-readable output (validate only)
  --quiet       Only print the summary
  -h, --help    Show this help
  -v, --version Show the version

Exit codes:
  0 success, 1 conflicts reported, 2 bad arguments, 3 invalid manifest, 4 internal error
`;

function parseArgs(argv) {
  const options = {
    command: undefined,
    manifests: [],
    out: undefined,
    frontendOut: undefined,
    force: false,
    dryRun: false,
    json: false,
    quiet: false,
    noInstall: false,
    verbose: false,
    yes: false,
    help: false,
    version: false,
  };

  const takeValue = (index, name) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw usageError("Missing value for " + name);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "-v" || arg === "--version") options.version = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--quiet") options.quiet = true;
    else if (arg === "--no-install") options.noInstall = true;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg === "--out") {
      options.out = takeValue(i, "--out");
      i += 1;
    } else if (arg.startsWith("--out="))
      options.out = arg.slice("--out=".length);
    else if (arg === "--frontend-out") {
      options.frontendOut = takeValue(i, "--frontend-out");
      i += 1;
    } else if (arg.startsWith("--frontend-out="))
      options.frontendOut = arg.slice("--frontend-out=".length);
    else if (arg.startsWith("-") && arg !== "-") {
      throw usageError("Unknown option: " + arg);
    } else if (!options.command) options.command = arg;
    else options.manifests.push(arg);
  }

  return options;
}

function usageError(message) {
  const error = new Error(message);
  error.code = "USAGE";
  return error;
}

function manifestError(filePath, issues) {
  return new ManifestError(filePath, issues);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function commandValidate(options, io) {
  if (options.manifests.length === 0) {
    throw usageError("validate requires at least one manifest path");
  }
  const report = [];
  let failed = false;

  for (const manifestPath of options.manifests) {
    try {
      const { absolutePath, json } = loadManifestFile(manifestPath);
      const manifest = validateManifest(json, { filePath: absolutePath });
      report.push({
        manifest: absolutePath,
        valid: true,
        lab: manifest.lab,
        studio: manifest.studio,
        models: manifest.models.map((model) => model.name),
      });
    } catch (error) {
      failed = true;
      if (error instanceof ManifestError) {
        report.push({
          manifest: path.resolve(manifestPath),
          valid: false,
          issues: error.issues,
        });
      } else {
        report.push({
          manifest: path.resolve(manifestPath),
          valid: false,
          issues: [error.message],
        });
      }
    }
  }

  if (options.json) {
    io.log(JSON.stringify({ valid: !failed, results: report }, null, 2));
  } else {
    for (const entry of report) {
      if (entry.valid) {
        io.log(
          "VALID   " +
            relativeToCwd(entry.manifest) +
            "  (" +
            entry.lab +
            " / " +
            entry.studio +
            "; " +
            entry.models.length +
            " model" +
            (entry.models.length === 1 ? "" : "s") +
            ")",
        );
      } else {
        io.log("INVALID " + relativeToCwd(entry.manifest));
        for (const issue of entry.issues) io.log("  - " + issue);
      }
    }
    io.log("");
    io.log(
      report.length +
        " manifest(s) checked: " +
        report.filter((entry) => entry.valid).length +
        " valid, " +
        report.filter((entry) => !entry.valid).length +
        " invalid.",
    );
  }

  return failed ? EXIT.MANIFEST : EXIT.OK;
}

function commandGenerate(options, io) {
  const { exitCode } = runGenerate(options, io, { frontend: "studios" });
  return exitCode;
}

/**
 * True when the frontend project has already been bootstrapped (its own
 * package.json exists and was produced by this generator).
 */
function frontendBootstrapped(frontendRoot) {
  const manifestFile = path.join(frontendRoot, "package.json");
  if (!fs.existsSync(manifestFile)) return false;
  try {
    JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {object} options parsed CLI options
 * @param {object} io
 * @param {{ frontend?: "none"|"bootstrap"|"studios" }} modeWhich
 */
function runGenerate(options, io, modeWhich = {}) {
  if (options.manifests.length === 0) {
    throw usageError("generate requires at least one manifest path");
  }

  // Validate everything before touching the filesystem: a broken manifest must
  // never leave a half-generated application behind.
  const manifests = options.manifests.map((manifestPath) =>
    loadAndValidateManifest(path.resolve(manifestPath), undefined, {
      overrides: options.overrides,
    }),
  );

  const first = manifests[0];
  // Three separate responsibilities: the generator CLI, the backend project and
  // the frontend project. The generator never writes UI files into the backend.
  const outRoot = path.resolve(
    options.out || first.app.outDir || "chemicalist.backend",
  );
  const frontendOutRoot = path.resolve(
    options.frontendOut || "chemicalist.frontend",
  );

  // A studio-only run must never (re)create the frontend project.
  let frontendMode = modeWhich.frontend || "none";
  if (frontendMode === "studios" && !frontendBootstrapped(frontendOutRoot)) {
    frontendMode = "bootstrap";
  }

  const registryPath = path.join(outRoot, ".chemicalist", "registry.json");
  const registry = readRegistryFile(registryPath);
  const nextRegistry = {
    ...DEFAULT_REGISTRY,
    ...registry,
    generatorVersion: pkg.version,
    app: {
      name: first.app.name,
      title: first.app.title,
      description: first.app.description,
      api: first.app.api,
      ui: first.ui,
    },
    studios: { ...registry.studios },
  };

  const { plan } = require("../engine");
  const outputPlan = new OutputPlan(outRoot, { frontendRoot: frontendOutRoot });
  const notes = [];
  const generated = [];

  // Generate every manifest in the same application context so app-wide files
  // (Prisma schema, app module, frontend routes) stay consistent.
  for (const manifest of manifests) {
    const ctx = buildContext(manifest, nextRegistry.studios, {
      generatorVersion: pkg.version,
      registryPath,
    });
    const descriptor = describeStudioForRegistry(manifest, ctx);
    nextRegistry.studios[descriptor.key] = descriptor;

    plan(ctx, outputPlan, { notes, frontend: frontendMode });
    generated.push({
      lab: manifest.lab,
      studio: manifest.studio,
      models: manifest.models.map((model) => model.name),
      key: descriptor.key,
    });
  }

  // One plan for both projects; the writer routes each file to its own root.
  const writer = require("../engine/writer");
  const planned = writer.plan(outRoot, outputPlan, { force: options.force });
  const allApplied = options.dryRun
    ? planned.results
    : writer.apply(outRoot, planned);
  const applied = allApplied.filter((file) => file.scope !== "frontend");
  const frontendApplied = allApplied.filter((file) => file.scope === "frontend");

  if (!options.dryRun) {
    writeRegistryFile(registryPath, nextRegistry);
    writeStudioManifests(outRoot, nextRegistry);
  }

  const summary = writer.summarize(applied);
  const frontendSummary = writer.summarize(frontendApplied);
  const studioSummary = generated.map((entry) => {
    const owned = applied.filter(
      (file) =>
        outputPlan.files.has("backend:" + file.path) &&
        outputPlan.files.get("backend:" + file.path).studio === entry.key,
    );
    const ownedFrontend = frontendApplied.filter(
      (file) =>
        outputPlan.files.has("frontend:" + file.path) &&
        outputPlan.files.get("frontend:" + file.path).studio === entry.key,
    );
    const counts = writer.summarize(owned.concat(ownedFrontend));
    return {
      key: entry.key,
      models: entry.models.length,
      files:
        counts.created +
        counts.updated +
        counts.overwritten +
        counts.unchanged +
        counts.preserved,
      created: counts.created,
      updated: counts.updated + counts.overwritten,
      unchanged: counts.unchanged,
    };
  });

  if (options.json) {
    io.log(
      JSON.stringify(
        {
          outDir: outRoot,
          frontendOutDir: frontendOutRoot,
          dryRun: options.dryRun,
          studios: studioSummary,
          files: summary,
          frontendFiles: frontendSummary,
          changes: applied
            .filter((file) => file.status !== "unchanged")
            .map((file) => ({ path: file.path, status: file.status }))
            .concat(
              frontendApplied
                .filter((file) => file.status !== "unchanged")
                .map((file) => ({
                  path: file.path,
                  status: file.status,
                  project: "frontend",
                })),
            ),
          conflicts: applied
            .filter((file) => file.status === "conflict")
            .map((file) => ({ path: file.path, reason: file.reason }))
            .concat(
              frontendApplied
                .filter((file) => file.status === "conflict")
                .map((file) => ({
                  path: file.path,
                  reason: file.reason,
                  project: "frontend",
                })),
            ),
        },
        null,
        2,
      ),
    );
  } else {
    if (!options.quiet) {
      for (const file of applied) {
        if (file.status === "unchanged") continue;
        const label = file.status.toUpperCase().padEnd(11);
        io.log(
          "  " +
            label +
            file.path +
            (file.reason ? "  (" + file.reason + ")" : ""),
        );
      }
      if (frontendApplied.length) {
        io.log("  -- frontend project: " + frontendOutRoot);
        for (const file of frontendApplied) {
          if (file.status === "unchanged") continue;
          const label = file.status.toUpperCase().padEnd(11);
          io.log(
            "  " +
              label +
              file.path +
              (file.reason ? "  (" + file.reason + ")" : ""),
          );
        }
      }
      for (const note of notes) io.log("  note: " + note);
      io.log("");
    }
    io.log(
      (options.dryRun ? "DRY RUN — " : "") +
        "Generated " +
        generated.length +
        " studio(s) into backend " +
        relativeToCwd(outRoot) +
        " (frontend: " +
        (frontendApplied.length === 0
          ? "untouched"
          : frontendMode === "bootstrap"
            ? "scaffold + UI pages"
            : "UI pages only") +
        " in " +
        relativeToCwd(frontendOutRoot) +
        ")",
    );
    for (const entry of studioSummary) {
      io.log(
        "  " +
          entry.key +
          ": " +
          entry.models +
          " model(s), " +
          entry.files +
          " file(s) (" +
          entry.created +
          " created, " +
          entry.updated +
          " updated, " +
          entry.unchanged +
          " unchanged)",
      );
    }
    io.log(
      "  total: " +
        summary.created +
        " created, " +
        (summary.updated + summary.overwritten) +
        " updated, " +
        summary.unchanged +
        " unchanged, " +
        summary.conflict +
        " conflict(s)",
    );
    if (frontendApplied.length) {
      io.log(
        "  frontend total: " +
          frontendSummary.created +
          " created, " +
          (frontendSummary.updated + frontendSummary.overwritten) +
          " updated, " +
          frontendSummary.unchanged +
          " unchanged, " +
          frontendSummary.conflict +
          " conflict(s)",
      );
    }
    if (summary.conflict + frontendSummary.conflict > 0) {
      io.log("");
      io.log(
        "Conflicts were left untouched. Review them, then re-run with --force to overwrite.",
      );
    } else if (!options.dryRun && generated.length) {
      io.log("");
      io.log("Next steps:");
      io.log("  backend:  cd " + relativeToCwd(outRoot));
      io.log("            npm install");
      io.log("            copy .env.example .env   # then set DATABASE_URL");
      io.log(
        "            npm run db:generate && npm run " +
          (first.persistence.database === "mongodb" ? "db:push" : "db:migrate"),
      );
      io.log("            npm run start:dev        # API on " + apiUrl(first));
      if (frontendApplied.length) {
        io.log("  frontend: cd " + relativeToCwd(frontendOutRoot));
        io.log("            npm install");
        io.log("            npm run dev              # UI");
      }
    }
  }

  return {
    exitCode:
      summary.conflict + frontendSummary.conflict > 0
        ? EXIT.CONFLICT
        : EXIT.OK,
    backend: { dir: outRoot, summary },
    frontend: { dir: frontendOutRoot, summary: frontendSummary },
  };
}

/**
 * Initial application bootstrap: creates the backend project and the frontend
 * project (scaffold + studio pages) and installs each project's own
 * dependencies.
 */
function color(code, text) {
  if (!stdout.isTTY || process.env.NO_COLOR || process.env.CI) return text;
  return "\u001b[" + code + "m" + text + "\u001b[0m";
}

function progress(io, current, total, label) {
  if (!stdout.isTTY) {
    io.log(label);
    return;
  }
  const width = 24;
  const filled = Math.round((current / total) * width);
  const bar = "[" + "█".repeat(filled) + "░".repeat(width - filled) + "]";
  io.log(color("36", bar) + " " + color("1", label));
}

async function configureInit(options, io) {
  const manifests = options.manifests.map((manifestPath) =>
    loadAndValidateManifest(path.resolve(manifestPath)),
  );
  const base = manifests[0];
  const interactive = stdin.isTTY && stdout.isTTY && !options.yes;
  const answers = {
    database: base.persistence.database,
    schema: base.persistence.schema || "public",
    services: { elasticsearch: base.services.elasticsearch },
    capabilities: {
      messaging: base.capabilities.messaging === true,
      cache: base.capabilities.cache === true,
      outbox: base.capabilities.outbox === true,
      inbox: base.capabilities.inbox === true,
      saga: base.capabilities.saga === true,
    },
    outputs: { ...base.outputs },
  };
  if (!interactive) return answers;

  const prompt = readline.createInterface({ input: stdin, output: stdout });
  const askYesNo = async (label, current) => {
    const hint = current ? "Y/n" : "y/N";
    const value = (await prompt.question("  " + label + " [" + hint + "]: ")).trim().toLowerCase();
    if (!value) return current;
    if (["y", "yes"].includes(value)) return true;
    if (["n", "no"].includes(value)) return false;
    io.log(color("33", "  Please answer yes or no."));
    return askYesNo(label, current);
  };
  try {
    io.log("");
    io.log(color("1", "Chemicalist project setup"));
    const database = (
      await prompt.question("  Database [postgres/mongodb] (" + answers.database + "): ")
    ).trim().toLowerCase();
    if (database) {
      if (!["postgres", "postgresql", "mongodb", "mongo"].includes(database)) {
        throw usageError("Database must be postgres or mongodb");
      }
      answers.database = ["mongo", "mongodb"].includes(database) ? "mongodb" : "postgres";
    }
    answers.services.elasticsearch = await askYesNo(
      "Include Elasticsearch",
      answers.services.elasticsearch,
    );
    answers.capabilities.messaging = await askYesNo("Include RabbitMQ", answers.capabilities.messaging);
    answers.capabilities.cache = await askYesNo("Include Redis", answers.capabilities.cache);
    answers.capabilities.outbox = await askYesNo("Enable outbox", answers.capabilities.outbox);
    answers.capabilities.inbox = await askYesNo("Enable inbox", answers.capabilities.inbox);
    answers.capabilities.saga = await askYesNo("Enable saga", answers.capabilities.saga);
    answers.outputs.webservice = await askYesNo("Generate web service / Docker files", answers.outputs.webservice);
    answers.outputs.api = await askYesNo("Generate backend API", answers.outputs.api);
    answers.outputs.frontend = await askYesNo("Generate admin frontend", answers.outputs.frontend);
    if ((answers.capabilities.outbox || answers.capabilities.inbox || answers.capabilities.saga) &&
        !answers.capabilities.messaging) {
      answers.capabilities.messaging = true;
      io.log(color("33", "  RabbitMQ enabled because outbox/inbox/saga requires messaging."));
    }
    if (!answers.outputs.api && answers.outputs.frontend) {
      answers.outputs.frontend = false;
      io.log(color("33", "  Frontend disabled because it requires the generated API."));
    }
    return answers;
  } finally {
    prompt.close();
  }
}

function persistInitConfig(manifestPath, answers) {
  const absolute = path.resolve(manifestPath);
  const base = absolute.endsWith(".manifest.json")
    ? absolute.slice(0, -".manifest.json".length)
    : absolute.replace(/\.json$/i, "");
  const mergeJson = (file, updates) => {
    let existing = {};
    if (fs.existsSync(file)) {
      existing = JSON.parse(fs.readFileSync(file, "utf8"));
    }
    const value = { ...existing };
    for (const [key, update] of Object.entries(updates)) {
      value[key] =
        update && typeof update === "object" && !Array.isArray(update)
          ? { ...(value[key] || {}), ...update }
          : update;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
  };
  mergeJson(base + ".config.json", { outputs: answers.outputs });
  mergeJson(base + ".infrastructure.manifest.json", {
    persistence: {
      provider: "prisma",
      database: answers.database,
      ...(answers.database === "postgres" ? { schema: answers.schema } : {}),
    },
    capabilities: answers.capabilities,
    services: answers.services,
  });
  mergeJson(base + ".frontend.manifest.json", { enabled: answers.outputs.frontend });
}

async function commandInit(options, io) {
  if (options.manifests.length === 0) {
    throw usageError("init requires at least one manifest path");
  }
  progress(io, 1, 4, "Loading manifests");
  const answers = await configureInit(options, io);
  options.overrides = {
    persistence: {
      database: answers.database,
      ...(answers.database === "postgres" ? { schema: answers.schema } : {}),
    },
    capabilities: answers.capabilities,
    services: answers.services,
    outputs: answers.outputs,
  };
  if (!options.dryRun) {
    for (const manifestPath of options.manifests) persistInitConfig(manifestPath, answers);
  }
  progress(io, 2, 4, "Preparing project configuration");
  const result = runGenerate(options, io, { frontend: "bootstrap" });
  progress(io, 3, 4, "Generating backend and admin UI");
  const { installDependencies } = require("../engine/install");

  const installs = [];
  // Only install into a project the generator actually wrote into.
  if (result.backend.summary.created + result.backend.summary.updated > 0)
    installs.push(result.backend.dir);
  if (result.frontend.summary.created + result.frontend.summary.updated > 0)
    installs.push(result.frontend.dir);

  const failures = [];
  for (const dir of installs) {
    if (options.dryRun || options.noInstall) continue;
    if (!options.quiet) progress(io, 4, 4, "Installing dependencies");
    const installed = installDependencies(dir, {
      verbose: options.verbose,
      log: (line) => io.log(line.trimEnd()),
    });
    if (installed.skipped) {
      io.log("  skipped npm install in " + dir + " (" + installed.error + ")");
    } else if (!installed.ok) {
      failures.push(installed);
      io.error("chemicalist: npm install failed in " + dir);
      io.error(installed.error || "");
    } else {
      io.log("  dependencies installed in " + dir);
    }
  }

  if (!options.dryRun && installs.length) {
    io.log("");
    io.log("Ready:");
    io.log("  backend:  cd " + relativeToCwd(result.backend.dir));
    io.log("            copy .env.example .env   # set DATABASE_URL, then npm run db:migrate");
    io.log("            npm run start:dev");
    io.log("  frontend: cd " + relativeToCwd(result.frontend.dir));
    io.log("            npm run dev");
  }

  if (failures.length) return EXIT.INTERNAL;
  return result.exitCode;
}

function commandList(options, io) {
  const outRoot = path.resolve(options.out || "chemicalist.backend");
  const registry = readRegistryFile(
    path.join(outRoot, ".chemicalist", "registry.json"),
  );
  const entries = Object.values(registry.studios);
  if (entries.length === 0) {
    io.log("No studios registered in " + relativeToCwd(outRoot));
    return EXIT.OK;
  }
  io.log("Studios registered in " + relativeToCwd(outRoot) + ":");
  for (const entry of entries) {
    io.log(
      "  " +
        entry.key.padEnd(28) +
        (entry.models || []).length +
        " model(s)  " +
        (entry.manifestPath || ""),
    );
  }
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeStudioManifests(outRoot, registry) {
  const dir = path.join(outRoot, ".chemicalist", "manifests");
  fs.mkdirSync(dir, { recursive: true });
  for (const descriptor of Object.values(registry.studios)) {
    const target = path.join(dir, descriptor.key.replace("/", "__") + ".json");
    const content = {
      lab: descriptor.lab,
      studio: descriptor.studio,
      manifestPath: descriptor.manifestPath,
      models: descriptor.models,
      capabilities: descriptor.capabilities,
      generatorVersion: descriptor.generatorVersion,
    };
    fs.writeFileSync(target, JSON.stringify(content, null, 2) + "\n", "utf8");
  }
}

function relativeToCwd(target) {
  const relative = path.relative(process.cwd(), target);
  return relative === "" ? "." : relative;
}

function apiUrl(manifest) {
  const api = manifest.app.api;
  return (
    "http://localhost:" +
    api.port +
    "/" +
    [api.prefix, api.version ? "v" + api.version : null]
      .filter(Boolean)
      .join("/")
  );
}

async function main(argv, io = console) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    io.error("chemicalist: " + error.message);
    io.error("Run `chemicalist --help` for usage.");
    return { exitCode: EXIT.USAGE };
  }

  if (options.version) {
    io.log(pkg.version);
    return { exitCode: EXIT.OK };
  }
  if (options.help || !options.command) {
    io.log(HELP);
    return { exitCode: options.help ? EXIT.OK : EXIT.USAGE };
  }

  try {
    switch (options.command) {
      case "validate":
        return { exitCode: commandValidate(options, io) };
      case "generate":
        return { exitCode: commandGenerate(options, io) };
      case "init":
        return { exitCode: await commandInit(options, io) };
      case "list":
        return { exitCode: commandList(options, io) };
      default:
        io.error("chemicalist: unknown command `" + options.command + "`");
        io.error("Run `chemicalist --help` for usage.");
        return { exitCode: EXIT.USAGE };
    }
  } catch (error) {
    if (error.code === "USAGE") {
      io.error("chemicalist: " + error.message);
      io.error("Run `chemicalist --help` for usage.");
      return { exitCode: EXIT.USAGE };
    }
    if (error instanceof ManifestError) {
      io.error("chemicalist: invalid manifest " + (error.filePath || ""));
      for (const issue of error.issues) io.error("  - " + issue);
      return { exitCode: EXIT.MANIFEST };
    }
    if (error.isFieldError) {
      io.error("chemicalist: invalid manifest — " + error.message);
      return { exitCode: EXIT.MANIFEST };
    }
    io.error("chemicalist: " + (error.stack || error.message));
    return { exitCode: EXIT.INTERNAL };
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((result) => {
      process.exitCode = result.exitCode;
    })
    .catch((error) => {
      console.error("chemicalist: " + (error.stack || error.message));
      process.exitCode = EXIT.INTERNAL;
    });
}

module.exports = { main, parseArgs, EXIT };
