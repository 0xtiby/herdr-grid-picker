#!/usr/bin/env node
/**
 * picker.js — the popup TUI. Two views:
 *   grid view   — pick an R x C grid; Enter applies it, Space picks an agent
 *   agent view  — choose which agent CLI to launch in every grid pane;
 *                 Enter confirms, Esc goes back to the grid view
 * The decision is written to the decision file and the process exits,
 * which closes the popup.
 */
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const os = require("node:os");

const stateDir = process.env.HERDR_PLUGIN_STATE_DIR || os.tmpdir();
// The action script hands us the exact decision/wait file paths so both
// sides agree even if state dirs differ (tests, multiple runs).
const decisionFile = process.env.GRID_DECISION_FILE || path.join(stateDir, "decision.json");
const waitFile = process.env.GRID_WAIT_FILE || path.join(stateDir, "decision.pid");
let finished = false;

// ---- announce ourselves so the action script can wait for our exit ----
fs.mkdirSync(path.dirname(decisionFile), { recursive: true });
fs.writeFileSync(waitFile, String(process.pid));

// ---- grid choices ----------------------------------------------------------
const choices = [
  { rows: 1, cols: 2, label: "1 x 2" },
  { rows: 1, cols: 3, label: "1 x 3" },
  { rows: 2, cols: 2, label: "2 x 2" },
  { rows: 2, cols: 3, label: "2 x 3" },
  { rows: 2, cols: 4, label: "2 x 4" },
  { rows: 3, cols: 3, label: "3 x 3" },
  { rows: 3, cols: 4, label: "3 x 4" },
  { rows: 4, cols: 4, label: "4 x 4" },
  { rows: 4, cols: 6, label: "4 x 6" },
  // Special option: close every other pane in the target's tab.
  { closeOthers: true, label: "close others" },
];

// ---- agent choices (passed in by open-picker.js as JSON) -------------------
let agents = [];
try {
  agents = JSON.parse(process.env.GRID_AGENTS || "[]");
} catch {}
if (!agents.length) {
  // Fallback if the action script did not pass the list.
  agents = ["pi", "claude", "codex", "gemini", "cursor", "devin", "opencode", "grok"]
    .map((kind) => ({ kind, onPath: false, integration: false }));
}

// ---- view state ------------------------------------------------------------
let view = "grid";        // "grid" | "agents"
let selected = 0;         // index in choices (grid view)
let agentIdx = 0;         // index in agents (agent view)
let pendingChoice = null; // grid choice that opened the agent view

// ---- terminal setup --------------------------------------------------------
process.stdout.write("\x1b[?25l"); // hide cursor
process.on("exit", () => {
  process.stdout.write("\x1b[?25h\x1b[0m"); // restore cursor + colors
});

function width() {
  return process.stdout.columns || 60;
}
function height() {
  return process.stdout.rows || 20;
}

function drawGrid() {
  const w = width();
  const lines = [];

  const title = "  Select a pane grid";
  const hint = "  \u2191\u2193\u2190\u2192 move \u00b7 Enter split \u00b7 Space pick agent \u00b7 Esc cancel";

  lines.push("\x1b[1m" + title + "\x1b[0m");
  lines.push("\x1b[2m" + hint.slice(0, w - 2) + "\x1b[0m");
  lines.push("");

  // Render the choices as a grid, up to 3 per row.
  const perRow = 3;
  for (let i = 0; i < choices.length; i += perRow) {
    const rowChoices = choices.slice(i, i + perRow);
    const cell = Math.max(10, Math.floor((w - 2) / perRow) - 2);
    let line = " ";
    for (let j = 0;  j < perRow; j++) {
      const c = rowChoices[j];
      let text = c ? c.label.padEnd(cell) : "".padEnd(cell);
      const isSel = c && i + j === selected;
      let styled;
      if (!c) {
        styled = "".padEnd(cell);
      } else if (isSel) {
        styled = c.closeOthers
          ? "\x1b[7;91m" + text + "\x1b[0m" // inverted + red
          : "\x1b[7m" + text + "\x1b[0m";
      } else {
        styled = c.closeOthers
          ? "\x1b[91m" + text + "\x1b[0m"
          : "\x1b[2m" + text + "\x1b[0m";
      }
      line += styled + "  ";
    }
    lines.push(line);
  }
  lines.push("");
  const name = process.env.GRID_TARGET_LABEL || process.env.GRID_TARGET_PANE || "(focused pane)";
  const sel = choices[selected];
  const footer = sel && sel.closeOthers
    ? "will close all other panes, keep: " + name
    : "will split: " + name + "  \u00b7  Space = choose agent CLI";
  lines.push("\x1b[2m  " + footer + "\x1b[0m");

  return lines;
}

function drawAgents() {
  const w = width();
  const lines = [];
  const g = pendingChoice;
  lines.push("\x1b[1m  Agent for " + g.rows + "x" + g.cols + " grid\x1b[0m");
  lines.push("\x1b[2m  \u2191\u2193 select \u00b7 Enter open " + g.rows + "x" + g.cols + " with agent \u00b7 Esc back\x1b[0m");
  lines.push("");

  const marks = [];
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    const flags = [
      a.integration ? "\x1b[32m\u25cf\x1b[0m" : "\x1b[2m\u25cb\x1b[0m",
      a.onPath ? "\x1b[32m\u2713\x1b[0m" : "\x1b[31m\u2717\x1b[0m",
    ].join(" ");
    marks.push(flags);
    const cell = Math.max(12, Math.floor((w - 4) / 2));
    const isSel = i === agentIdx;
    const label = ("  " + a.kind).padEnd(cell);
    lines.push(
      (isSel ? "\x1b[7m" + label + "\x1b[0m" : "\x1b[2m" + label + "\x1b[0m") + "  " + flags
    );
  }
  lines.push("");
  lines.push("\x1b[2m  \u25cf integration installed   \u2713 binary on PATH   (\u25cb/\u2717 = not)\x1b[0m");

  return lines;
}

function draw() {
  const lines = view === "grid" ? drawGrid() : drawAgents();
  // Erase from top and redraw.
  process.stdout.write("\x1b[H\x1b[2J" + lines.slice(0, height()).join("\n") + "\n");
}

// ---- input -----------------------------------------------------------------
// popup panes receive terminal input; use keypress events on stdin.
readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);

process.stdin.on("keypress", (str, key) => {
  if (!key) return;
  if (key.ctrl && key.name === "c") return finish(null);

  if (view === "grid") {
    if (key.name === "escape" || key.name === "q") return finish(null);
    if (key.name === "up" || key.name === "k") {
      selected = (selected - 3 + choices.length) % choices.length;
    } else if (key.name === "down" || key.name === "j") {
      selected = (selected + 3) % choices.length;
    } else if (key.name === "left") {
      selected = (selected - 1 + choices.length) % choices.length;
    } else if (key.name === "right" || key.name === "tab") {
      selected = (selected + 1) % choices.length;
    } else if (key.name === "space") {
      const c = choices[selected];
      if (!c.closeOthers) {
        pendingChoice = c;
        view = "agents";
        agentIdx = 0;
      }
    } else if (key.name === "return") {
      const c = choices[selected];
      finish(c.closeOthers ? { closeOthers: true, label: c.label } : c);
    }
    draw();
  } else {
    // agents view
    if (key.name === "escape") {
      view = "grid";
      pendingChoice = null;
    } else if (key.name === "up" || key.name === "k" || key.name === "left") {
      agentIdx = (agentIdx - 1 + agents.length) % agents.length;
    } else if (key.name === "down" || key.name === "j" || key.name === "right" || key.name === "tab") {
      agentIdx = (agentIdx + 1) % agents.length;
    } else if (key.name === "return") {
      finish({ ...pendingChoice, agent: agents[agentIdx].kind });
    }
    draw();
  }
});

process.stdin.on("data", () => {}); // keep stdin flowing
// If the pty closes under us (popup closed externally), bail out cleanly.
process.stdin.on("end", () => finish(null));
process.stdin.on("close", () => finish(null));

function finish(choice) {
  if (finished) return;
  finished = true;
  try {
    if (choice) fs.writeFileSync(decisionFile, JSON.stringify(choice));
  } catch {}
  try { fs.rmSync(waitFile, { force: true }); } catch {}
  process.stdout.write("\x1b[?25h\x1b[0m");
  process.exit(choice ? 0 : 1);
}

draw();

// Test hook: pick immediately without interaction (used by automated e2e).
// Accepts "RxC", "closeOthers", or "RxC:agentKind".
if (process.env.GRID_AUTOPICK) {
  const raw = process.env.GRID_AUTOPICK;
  if (/^close(\s|-)?others?$/i.test(raw)) {
    finish({ closeOthers: true, label: "close others" });
  } else {
    const m = /^(\d+)\s*[x,]\s*(\d+)(?::(\w+))?$/.exec(raw);
    if (m) {
      const c = choices.find((c) => c.rows === +m[1] && c.cols === +m[2]) || choices[0];
      finish(m[3] ? { ...c, agent: m[3] } : c);
    } else finish(null);
  }
}
