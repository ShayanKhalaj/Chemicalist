"use strict";

/**
 * Dependency installation for the generated projects.
 *
 * The backend (NestJS) and the frontend (React/Vite) are two independent
 * projects, each with its own package.json, so each one gets its own
 * `npm install`.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function hasPackageJson(dir) {
  return fs.existsSync(path.join(dir, "package.json"));
}

/**
 * Runs `npm install` in `dir`.
 * @returns {{ dir: string, ok: boolean, skipped?: boolean, error?: string }}
 */
function installDependencies(dir, options = {}) {
  const root = path.resolve(dir);
  if (!hasPackageJson(root)) {
    return { dir: root, ok: false, skipped: true, error: "no package.json" };
  }
  if (options.dryRun) {
    return { dir: root, ok: true, skipped: true };
  }

  const isWindows = process.platform === "win32";
  const npm = isWindows ? "npm.cmd" : "npm";
  const args = ["install", "--no-audit", "--no-fund"];
  if (options.ci && fs.existsSync(path.join(root, "package-lock.json"))) {
    args[0] = "ci";
  }

  const log = options.log || ((line) => process.stdout.write(line));
  log("> installing dependencies in " + root + "\n");

  const result = spawnSync(npm, args, {
    cwd: root,
    stdio: options.verbose ? "inherit" : ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      npm_config_fund: "false",
      npm_config_audit: "false",
    },
  });

  if (result.error) {
    return { dir: root, ok: false, error: result.error.message };
  }
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    const tail = output.split(/\r?\n/).slice(-25).join("\n");
    return {
      dir: root,
      ok: false,
      error: tail || "npm exited " + result.status,
    };
  }
  return { dir: root, ok: true };
}

module.exports = { installDependencies, hasPackageJson };
