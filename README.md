# herdr-grid-picker

A Herdr plugin that turns any pane into an R × C grid of **equal** panes —
with optional agent CLI pre-loading — via a popup menu.

Press `prefix+g` (or run `herdr plugin action invoke tiby.grid-picker.pick`)
and a popup appears with grid choices and agent options.

---

## Features

### 1. Grid splitting

Pick a grid (`1x2` … `4x6`) and press **Enter** — the pane you invoked the
command from is split into R rows × C columns of equal panes. The original
pane becomes the top-left cell; the rest of your tab is untouched.

### 2. Close others

The red **`close others`** entry closes every other pane **in the target's
tab** and keeps only the focused one. Other tabs and workspaces are never
touched. The popup footer previews exactly what will happen before you
commit (`will close all other panes, keep: …`).

### 3. Agent pre-loading (Space)

Press **Space** on any grid choice and the popup switches to an agent
picker. Selecting an agent with Enter builds the grid **and launches that
agent CLI in every pane of the grid**, all launched **concurrently** (not
one-by-one). `Esc` returns to the grid view without doing anything.

---

## Usage

| Key | Action |
|---|---|
| `prefix+g` | open the grid popup over the focused pane |
| `↑↓←→` / `j`·`k` | move selection |
| `Enter` | split the focused pane into the selected grid |
| `Space` (on a grid) | open the agent picker for that grid |
| `Enter` (in agent view) | open the grid with the selected agent in every pane |
| `Esc` | cancel (in agent view: go back to the grid view) |
| `q` (grid view) | cancel |

Or from any shell: `herdr plugin action invoke tiby.grid-picker.pick`

The popup footer always shows what will happen, e.g.
`will split: footer-test · shell` (workspace label · pane label, falling back
to the raw pane id like `w15:p1` when unlabeled).

---

## Install

### As a user (from GitHub)

```bash
herdr plugin install 0xtiby/herdr-grid-picker
```

This clones the repo, previews the source and commands before running,
then registers the plugin. No separate `plugin update` in plugin v1 —
reinstall to refresh to the latest default-branch revision:

```bash
herdr plugin uninstall tiby.grid-picker
herdr plugin install 0xtiby/herdr-grid-picker
```

### As a developer (local working tree)

```bash
herdr plugin link ~/ws/dev/herdr-grid-picker
```

For the GitHub-managed install:

```bash
herdr plugin install 0xtiby/herdr-grid-picker
```

Requires `node` reachable by the Herdr server (panes are spawned with a
minimal PATH — a symlink like
`sudo ln -sf ~/.nvm/versions/node/*/bin/node /usr/local/bin/node` may be
needed).

A linked plugin runs your working tree **live** — edit files and the next
invocation uses them, no reinstall. Note: installing the GitHub-managed
version over a linked plugin is refused; `herdr plugin unlink tiby.grid-picker`
first. Both installs are global to the user and available in every Herdr
session.

Keybinding (already added to `~/.config/herdr/config.toml`):

```toml
[[keys.command]]
key = "prefix+g"
type = "plugin_action"
command = "tiby.grid-picker.pick"
description = "Pick a pane grid and split"
```

### Requirements

- `node` reachable by the **Herdr server**, which spawns popup panes with a
  minimal PATH. With nvm installs, symlink it:
  `sudo ln -sf ~/.nvm/versions/node/<ver>/bin/node /usr/local/bin/node`
- No other dependencies (pure Node standard library).

---

## How it works

```
prefix+g ──► open-picker.js (plugin ACTION, still bound to your pane)
                │
                │  resolves the target pane (see below), then
                │  plugin.pane.open (raw socket JSON, placement: popup)
                ▼
             picker.js (popup TUI, receives keyboard input)
                │  writes {rows, cols[, agent]} to a decision file, exits
                ▼  (exit closes the popup automatically)
             open-picker.js reads the decision
                │
                ├─ grid:        pane split × N (see math below)
                ├─ closeOthers: pane close on every sibling in the tab
                └─ agent:       splits + herdr agent start × N (concurrent)
```

- `herdr-plugin.toml` — manifest: action `pick` + popup pane `picker`
- `open-picker.js` — the action: opens the popup, waits, performs the work
- `picker.js` — the popup TUI (grid view → agent view)

Notable mechanics:

- **The popup cannot split itself.** Popup panes have no pane ID and are
  invisible to pane APIs, so the action captures the caller's pane *before*
  opening the popup and passes it through env (`GRID_TARGET_PANE`).
- The **CLI cannot open popups** (`herdr plugin pane open` only accepts
  overlay/split/tab/zoomed), so the action talks raw newline-delimited JSON
  to `HERDR_SOCKET_PATH` with `method: "plugin.pane.open"`.
- The action and the popup exchange the result via **decision files** in the
  plugin state dir (`GRID_DECISION_FILE` / `GRID_WAIT_FILE`), because there
  is no other channel from a popup process back to the action.
- Target pane resolution fallback chain: explicit `GRID_TARGET_PANE` →
  inherited `HERDR_PANE_ID` → plugin context JSON → `herdr api snapshot`
  focused pane. Whatever is resolved is shown in the popup footer **before**
  Enter does anything.

### Equal-split math

`herdr pane split --ratio r` keeps `r` of the target's size and gives
`1 - r` to the new pane (verified against `herdr pane layout` geometry).
To make N equal parts, split the **same** pane repeatedly with ratios
`(N-1)/N, (N-2)/(N-1), … 1/2` — the target shrinks to one part while each
new pane takes exactly `1/N`:

1. **Columns**: split the target right `(C-1)/C, (C-2)/(C-1), … ½`
2. **Rows**: split each column's top pane down `(R-1)/R, … ½`

Verified: 1x3, 2x2, 3x3, 4x4, 4x6 (24 panes) all produce uniform rects.

### Agent launching

- The list mirrors `herdr agent start --kind` possible values (pi, claude,
  codex, gemini, cursor, devin, agy, cline, omp, mastracode, opencode,
  copilot, kimi, kiro, droid, amp, grok, hermes, kilo, qodercli, qwen,
  maki, muse).
- **Names must be unique per server**, so the plugin probes
  `herdr agent list` and allocates `kind`, `kind-2`, `kind-3`, … past any
  live collisions (e.g. your long-running `pi` agent means a pi grid gets
  `pi-2`, `pi-3`, …).
- Launches run in **parallel** (each `agent start` waits for readiness, so
  sequential launching would take minutes on big grids).
- Outcomes are reported per pane:
  - *started* — agent is ready (idle)
  - *started but not ready* — the agent launched but showed a startup
    prompt (e.g. claude's trust dialog); it exists and will be ready after
    you answer it
  - *failed* — e.g. binary missing; the pane remains a plain shell
- Caution: a 4×6 grid with agents = 24 concurrent CLI instances.

---

## Agent markers: integration vs binary

The agent list shows two independent indicators per agent:

| Marker | Meaning |
|---|---|
| `●` (filled) | **Herdr integration installed** — a small hook file Herdr placed inside the agent's config dir (e.g. `~/.pi/agent/extensions/herdr-agent-state.ts`, `~/.claude/hooks/herdr-agent-state.sh`). The agent reports its real lifecycle (`working`/`idle`/`blocked`/`done`) and native session info, enabling reliable state tracking and conversation restore. |
| `○` (open) | No integration — the agent runs fine but Herdr guesses its state from screen content (less reliable, no native session restore). |
| `✓` | **Binary on PATH** — the CLI itself is installed and launchable (checked via a login shell so nvm / `~/.local/bin` installs count). |
| `✗` | No binary — the agent cannot be launched; selecting it wastes the grid. |

Rule of thumb: `✗` = don't select it; `○ ✓` = works but with degraded state
tracking; `● ✓` = full experience.

Install a missing integration (only adds a hook file to that tool's config
dir; reversible):

```bash
herdr integration install claude
herdr integration uninstall claude   # to undo
```

Already-running agent instances only pick up a freshly installed
integration on their next start.

---

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs on every PR and on pushes
   to `main`:
- `node --check` syntax validation of both plugin scripts
- `scripts/validate-manifest.mjs` — checks `herdr-plugin.toml` required
  fields, id/version formats, platform values, and that every command file
  referenced by the manifest exists

The `lint` check is a **required status check** for merging into `main`
(branch protection: 1 approval, stale reviews dismissed, no force pushes,
strict up-to-date checks).

## Test hook

`open-picker.js` accepts `GRID_AUTOPICK` to pick without interaction
(used by the automated e2e checks):

```bash
GRID_AUTOPICK=3x3           # plain grid
GRID_AUTOPICK=closeOthers   # close-others option
GRID_AUTOPICK=2x2:claude    # grid + agent in every pane
```

Verified results (on a 408×78 terminal):

- 1x3 → 3 panes, all 136×78 · 2x2 → all 90×28 · 3x3 → all 136×26
- 4x4 → 16 panes, all 30×10 · 4x6 → 24 panes, all 20×10
- closeOthers: 3 panes → 1, target kept, other tabs untouched
- 2x2:claude → 4 equal panes + 4 claude agents (`claude`, `claude-2`, …)
- 1x2:pi → both panes launched concurrently, both idle in ~10s

`GRID_TARGET_PANE` overrides the split target (how the tests avoid touching
the real layout).

---

## Troubleshooting

- **Popup fails with "No viable candidates found in PATH"** — the server's
  PATH lacks `node`. Symlink it (see Requirements).
- **Popup opens, instantly closes, "Grid pick cancelled"** — the picker
  crashed; check `herdr plugin log list --plugin tiby.grid-picker` and that
  `node picker.js` runs standalone.
- **Popup refuses to open** (`ui_busy`) — Settings, copy mode, or another
  Herdr modal was active. Close it and retry.
- **Agent shows ✗ though it is installed** — the login-shell probe missed
  it; run `bash -lc 'command -v <cli>'` to see what your shell resolves.
- **Wrong split target?** The footer always shows the resolved pane before
  Enter; `Esc` cancels safely.
