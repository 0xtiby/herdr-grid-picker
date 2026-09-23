#!/usr/bin/env node
/**
 * open-picker.js — the "pick" action.
 * Runs as a plugin ACTION (not a popup), so it still has the caller's
 * HERDR_PANE_ID context. It opens the "picker" popup pane pointed at the
 * calling pane, waits for the user's choice, then performs the splits.
 */
const { spawnSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");

const herdr = process.env.HERDR_BIN_PATH || "herdr";
const socketPath =
  process.env.HERDR_SOCKET_PATH ||
  require("node:path").join(process.env.HOME || "~", ".config/herdr/herdr.sock");

function context() {
  try {
    return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
  } catch {
    return {};
  }
}

function resolveTargetPane(ctx) {
  // Explicit override (also used by tests) beats inherited context.
  if (process.env.GRID_TARGET_PANE) return process.env.GRID_TARGET_PANE;
  if (process.env.HERDR_PANE_ID) return process.env.HERDR_PANE_ID;
  if (ctx.pane_id || ctx.focused_pane_id) return ctx.pane_id || ctx.focused_pane_id;
  // Last resort (e.g. keybinding invocation without pane context): ask the
  // server what is focused right now.
  try {
    const out = spawnSync(herdr, ["api", "snapshot"], { encoding: "utf8" });
    if (out.status === 0) {
      const snap = JSON.parse(out.stdout);
      const s = snap.result || snap;
      return s.focused_pane_id || s.snapshot?.focused_pane_id;
    }
  } catch {}
  return undefined;
}

function callSocket(method, params) {
  return new Promise((resolve, reject) => {
      const sock = net.connect(socketPath);
    let buf = "";
    const id = "req_" + Math.random().toString(36).slice(2);
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; sock.destroy(); reject(new Error("socket timeout: " + method)); }
    }, 10000);
    sock.on("connect", () => {
      sock.write(JSON.stringify({ id, method, params }) + "\n");
    });
    sock.on("data", (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            done = true;
            clearTimeout(timer);
            sock.end();
            if (msg.ok === false || msg.error) reject(new Error(JSON.stringify(msg)));
            else resolve(msg.result !== undefined ? msg.result : msg);
            return;
          }
        } catch { /* keep buffering */ }
      }
    });
    sock.on("error", (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
  });
}

function sh(args, opts = {}) {
  const r = spawnSync(herdr, args, { encoding: "utf8", ...opts });
  if (r.status !== 0) {
    throw new Error(`herdr ${args.join(" ")} failed (${r.status}): ${r.stderr || r.stdout}`);
  }
  return r.stdout ? JSON.parse(r.stdout) : null;
}

// ---- grid math -------------------------------------------------------------
// Splitting target T right/down with ratio r keeps r of T for the target and
// gives 1-r to the new pane (verified against herdr pane layout geometry).
function columnsRatios(c) {
  // Build C equal columns, right-to-left. First split keeps (C-1)/C,
  // then (C-2)/(C-1), ... each subsequent split keeps one fewer share.
  const ratios = [];
  for (let k = 1; k < c; k++) ratios.push((c - k) / (c - k + 1));
  return ratios; // e.g. C=3 -> [2/3, 1/2]
}

// ---- agent kinds -----------------------------------------------------------
// Keep in sync with `herdr agent start --kind` possible values.
const AGENT_KINDS = [
  "pi", "claude", "codex", "gemini", "cursor", "devin", "agy", "cline",
  "omp", "mastracode", "opencode", "copilot", "kimi", "kiro", "droid",
  "amp", "grok", "hermes", "kilo", "qodercli", "qwen", "maki", "muse",
];

function binExists(cmd) {
  // The action process runs with a minimal PATH, so ask a login shell (which
  // sources nvm, ~/.local/bin, etc.) whether the CLI is really launchable.
  try {
    const r = spawnSync(
      "bash",
      ["-lc", `command -v ${JSON.stringify(cmd)} >/dev/null 2>&1 && echo yes`],
      { encoding: "utf8" }
    );
    return r.status === 0 && r.stdout.includes("yes");
  } catch {
    return false;
  }
}

function agentList() {
  // Integration status marks CLIs whose herdr state-reporting hook is set up.
  const integration = {};
  try {
    const out = spawnSync(herdr, ["integration", "status"], { encoding: "utf8" });
    for (const line of out.stdout.split("\n")) {
      // "kind: installed (...)" or "kind: current (v8) (...)"
      const m = /^([\w-]+):\s+(?!not installed)/.exec(line);
      if (m) integration[m[1]] = true;
    }
  } catch {}
  return AGENT_KINDS.map((kind) => ({
    kind,
    onPath: binExists(kind),
    integration: !!integration[kind],
  }));
}

// Allocate `count` unique agent names for one kind. Live agent names are
// unique per server, so probe the taken set and keep allocating past it.
function uniqueAgentNames(kind, count) {
  const taken = new Set();
  try {
    const out = spawnSync(herdr, ["agent", "list"], { encoding: "utf8" });
    const list = JSON.parse(out.stdout);
    for (const a of list.result?.agents || list.agents || []) {
      if (a.agent) taken.add(a.agent);
    }
  } catch {}
  const names = [];
  let n = 0;
  while (names.length < count) {
    n++;
    const name = n === 1 ? kind : `${kind}-${n}`;
    if (!taken.has(name) && name.length <= 32) {
      names.push(name);
      taken.add(name);
    }
    if (n > 1000) throw new Error("cannot allocate unique agent names");
  }
  return names;
}

function startAgents(kind, paneIds) {
  const names = uniqueAgentNames(kind, paneIds.length);
  // Launch every pane's agent concurrently: each `agent start` waits for the
  // agent to become ready, so running them one-by-one is slow for big grids.
  const startOne = (name, pane) => new Promise((resolve) => {
    const child = spawn(
      herdr,
      ["agent", "start", name, "--kind", kind, "--pane", pane, "--timeout", "20000"],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => resolve({ name, pane, blob: String(e) }));
    child.on("close", (code) => resolve({ name, pane, blob: out + err, code }));
  });

  return Promise.all(paneIds.map((p, i) => startOne(names[i], p))).then((results) => {
    const started = [];
    const pending = [];
    const failures = [];
    for (const r of results) {
      if (r.code === 0) {
        started.push(`${r.name} @ ${r.pane}`);
      } else if (/agent_not_ready/.test(r.blob)) {
        // The agent launched but did not reach ready/idle within the timeout
        // (e.g. showing a trust/approval prompt). It still exists.
        pending.push(`${r.name} @ ${r.pane}`);
      } else {
        failures.push(`${r.pane}: ${(r.blob.trim().split("\n")[0] || `exit ${r.code}`)}`);
      }
    }
    console.log(`Started ${started.length} x ${kind}: ${started.join(", ")}`);
    if (pending.length) console.error(`Started but not ready yet (may show a startup prompt): ${pending.join(", ")}`);
    if (failures.length) console.error("Agent start failures:\n  " + failures.join("\n  "));
    return { started, pending, failures };
  });
}

// ---- main ------------------------------------------------------------------
async function main() {
  const ctx = context();
  const targetPane = resolveTargetPane(ctx);
  if (!targetPane) {
    console.error("No pane context available; run this from inside a pane.");
    process.exit(1);
  }

  // Remember which workspace/tab the target lives in so the popup result is
  // applied even if the user's focus moved meanwhile.
  const paneInfo = sh(["pane", "get", targetPane]);
  const pane = paneInfo.result?.pane || paneInfo.pane || paneInfo;
  const tabId = pane.tab_id || paneInfo.result?.tab_id;

  // Resolve friendly display names for the popup footer.
  let targetLabel = null;
  try {
    let wsLabel = null;
    if (pane.workspace_id) {
      const wsInfo = sh(["workspace", "get", pane.workspace_id]);
      wsLabel = (wsInfo.result?.workspace || wsInfo.workspace)?.label || null;
    }
    const paneLabel = pane.label || null;
    targetLabel = [wsLabel, paneLabel].filter(Boolean).join(" · ") || null;
  } catch {}

  // 1. Open the picker popup, passing the target pane id and the decision
  // file paths so the picker and this script agree on where results land.
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR || os.tmpdir();
  fs.mkdirSync(stateDir, { recursive: true });
  const decisionFile = path.join(stateDir, `decision-${process.pid}.json`);
  const waitFile = path.join(stateDir, `decision-${process.pid}.pid`);
  await callSocket("plugin.pane.open", {
    plugin_id: process.env.HERDR_PLUGIN_ID,
    entrypoint: "picker",
    placement: "popup",
    width: "44%",
    height: 16,
    env: {
      GRID_TARGET_PANE: targetPane,
      GRID_DECISION_FILE: decisionFile,
      GRID_WAIT_FILE: waitFile,
      GRID_AGENTS: JSON.stringify(agentList()),
      ...(targetLabel ? { GRID_TARGET_LABEL: targetLabel } : {}),
      // Test hook: auto-select without interaction (used by automated e2e).
      ...(process.env.GRID_AUTOPICK ? { GRID_AUTOPICK: process.env.GRID_AUTOPICK } : {}),
    },
    focus: true,
  });

  // 2. Wait for the picker to finish — poll the DECISION file directly.
  // (Fix ported from the Rust rewrite: waiting for the pid file first races
  // the picker — with auto-pick it writes its decision and exits within a
  // few ms, between two polls — and then burned the full 5s "may have
  // failed" cap on every invocation. Poll the decision file; fall back to
  // pid-exit detection for the cancel path.)
  await new Promise((resolve) => {
    const t0 = Date.now();
    let pickerPid = null;
    const tick = () => {
      try {
        if (fs.existsSync(decisionFile)) return resolve(); // decision written
      } catch {}
      if (pickerPid === null) {
        try {
          const pid = fs.readFileSync(waitFile, "utf8").trim();
          if (pid) pickerPid = parseInt(pid, 10);
        } catch {}
      }
      if (pickerPid !== null) {
        try {
          process.kill(pickerPid, 0);
        } catch {
          return resolve(); // picker exited (cancel: no decision file)
        }
      }
      if (Date.now() - t0 > 10 * 60 * 1000) return resolve(); // hard cap
      setTimeout(tick, 50);
    };
    tick();
  });

  let decision = null;
  try { decision = JSON.parse(fs.readFileSync(decisionFile, "utf8")); } catch {}
  fs.rmSync(decisionFile, { force: true });
  fs.rmSync(waitFile, { force: true });

  if (!decision || (!decision.closeOthers && (!decision.rows || !decision.cols))) {
    console.log("Grid pick cancelled.");
    return;
  }

  // 3. Verify the target pane still exists.
  try {
    sh(["pane", "get", targetPane]);
  } catch {
    console.error(`Target pane ${targetPane} is gone; nothing to do.`);
    process.exit(1);
  }

  if (decision.closeOthers) {
    closeOthers(targetPane, pane.workspace_id, tabId);
    return;
  }

  // 4. Build the R x C grid.
  const { rows, cols } = decision;
  const colRatios = columnsRatios(cols);

  // First pass: equal columns, right-to-left. The target keeps getting
  // split (it shrinks to one column); each new pane is the next column.
  const colHeads = [targetPane];
  const allPanes = [targetPane];
  for (const ratio of colRatios) {
    const res = sh(["pane", "split", targetPane, "--direction", "right", "--ratio", String(ratio)]);
    const head = res.result?.pane?.pane_id || res.pane?.pane_id;
    colHeads.push(head);
    allPanes.push(head);
  }

  // Second pass: split each column's top pane down into the remaining rows.
  const rowRatios = columnsRatios(rows);
  for (const head of colHeads) {
    for (const ratio of rowRatios) {
      const res = sh(["pane", "split", head, "--direction", "down", "--ratio", String(ratio)]);
      allPanes.push(res.result?.pane?.pane_id || res.pane?.pane_id);
    }
  }

  // 5. Launch the selected agent CLI in every grid pane (Space in the popup).
  if (decision.agent) await startAgents(decision.agent, allPanes);
  else console.log(`Created ${rows}x${cols} grid (${rows * cols} panes) from ${targetPane}.`);
}

// ---- close others ----------------------------------------------------------
// Close every pane in the target pane's tab except the target itself.
function closeOthers(targetPane, workspaceId, tabId) {
  const res = sh(["pane", "list", ...(workspaceId ? ["--workspace", workspaceId] : [])]);
  const panes = (res.result?.panes || res.panes || []).filter((p) => p.pane_id !== targetPane);
  const scoped = tabId ? panes.filter((p) => p.tab_id === tabId) : panes;

  if (scoped.length === 0) {
    console.log("No other panes to close.");
    return;
  }

  let closed = 0;
  const failures = [];
  for (const p of scoped) {
    try {
      sh(["pane", "close", p.pane_id]);
      closed++;
    } catch (e) {
      failures.push(`${p.pane_id}: ${e.message.split("\n")[0]}`);
    }
  }

  console.log(`Kept ${targetPane}; closed ${closed} pane(s).`);
  if (failures.length) console.error("Failed to close:\n  " + failures.join("\n  "));
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
