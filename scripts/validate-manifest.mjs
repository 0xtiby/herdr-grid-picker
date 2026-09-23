#!/usr/bin/env node
/**
 * validate-manifest.mjs — CI check for herdr-plugin.toml.
 * Verifies required fields, id/version formats, platform values, and that
 * every command referenced by the manifest exists in the repo.
 */
import { readFileSync, accessSync, constants } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(path.join(root, "herdr-plugin.toml"), "utf8");

const errors = [];

// --- simple line-based TOML field extraction (sufficient for this manifest) --
function field(name) {
  const m = new RegExp(`^\\s*${name}\\s*=\\s*"([^"]*)"`, "m").exec(src);
  return m ? m[1] : undefined;
}

const required = ["id", "name", "version", "min_herdr_version"];
for (const key of required) {
  if (!field(key)) errors.push(`missing required field: ${key}`);
}

// id: ASCII letters, digits, dot, colon, underscore, hyphen
const id = field("id");
if (id && !/^[A-Za-z0-9.:-]+$/.test(id)) {
  errors.push(`invalid plugin id: ${id}`);
}

// version + min_herdr_version: semver-ish
for (const key of ["version", "min_herdr_version"]) {
  const v = field(key);
  if (v && !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v)) {
    errors.push(`${key} is not semver-like: ${v}`);
  }
}

// platforms (optional): must be a subset of known values
const platMatch = /^platforms\s*=\s*\[([^\]]*)\]/m.exec(src);
if (platMatch) {
  const known = new Set(["linux", "macos", "windows"]);
  const plats = platMatch[1].split(",").map((s) => s.trim().replaceAll('"', "")).filter(Boolean);
  for (const p of plats) {
    if (!known.has(p)) errors.push(`unknown platform: ${p}`);
  }
}

// every manifest command must reference an existing file
// every manifest command's program must exist (first token); remaining
// tokens are argv arguments, not files
const commandArrays = [...src.matchAll(/command\s*=\s*\[([^\]]*)\]/g)].map((m) =>
  m[1].split(",").map((s) => s.trim().replaceAll('"', "")).filter(Boolean)
);
const argvLaunchers = new Set(["node", "bash", "sh", "python3", "lua"]);
// bin/grid-picker is produced by the [[build]] step (cargo build or release
// download) — not committed to the repo.
const generatedArtifacts = new Set(["./bin/grid-picker"]);
for (const cmd of commandArrays) {
  const file = cmd[0];
  if (!file) continue;
  if (argvLaunchers.has(file)) {
    // interpreter: validate the script path it points at, if it looks local
    const arg = cmd[1];
    if (arg && /^[-\w.]+\.(sh|js|py|lua|mjs)$/.test(arg)) {
      try {
        accessSync(path.join(root, arg), constants.F_OK);
      } catch {
        errors.push(`manifest references missing script: ${arg}`);
      }
    }
    continue;
  }
  if (generatedArtifacts.has(file)) continue; // built at install time
  try {
    accessSync(path.join(root, file), constants.F_OK);
  } catch {
    errors.push(`manifest references missing file: ${file}`);
  }
}

// the manifest must declare at least one action or pane
if (!/\[\[actions\]\]/.test(src) && !/\[\[panes\]\]/.test(src)) {
  errors.push("manifest declares no [[actions]] and no [[panes]]");
}

if (errors.length) {
  console.error("herdr-plugin.toml validation failed:");
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}

console.log("herdr-plugin.toml OK:", field("id"), field("version"));
