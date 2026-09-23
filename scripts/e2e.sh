#!/usr/bin/env bash
# rust-e2e.sh — end-to-end checks for the Rust core (ported from the bash
# suite, CONTRACTS.md e2e expectations). Every run uses scratch workspaces
# created and closed by this script; never touches the live session layout.
#
# Cases: 3x3 4x6 2x2 1x3 4x4 grids, closeOthers, 1x2:pi agents.
set -u
cd "$(dirname "$0")/.." || exit 1
bin=(node open-picker.js)
herdr="${HERDR_BIN_PATH:-herdr}"
pass=0; fail=0
failed_names=()

say()  { printf '%s\n' "$*"; }
ok()   { pass=$(( pass + 1 )); say "PASS: $*"; }
bad()  { fail=$(( fail + 1 )); failed_names+=("$*"); say "FAIL: $*"; }

check() { # $1 = "1"/"0" condition result, $2 = label
  if [[ "$1" == 1 ]]; then ok "$2"; else bad "$2"; fi
}

new_workspace() {
  local out
  out=$("$herdr" workspace create --label rust-e2e --cwd /tmp 2>&1) || { say "workspace create failed: $out"; return 1; }
  printf '%s %s' \
    "$(printf '%s' "$out" | grep -o '"workspace_id":"[^"]*"' | head -1 | cut -d'"' -f4)" \
    "$(printf '%s' "$out" | grep -o '"pane_id":"[^"]*"' | head -1 | cut -d'"' -f4)"
}

close_workspace() {
  "$herdr" workspace close "$1" >/dev/null 2>&1
}

pane_count() { # $1 = any pane in the tab
  "$herdr" pane layout --pane "$1" 2>/dev/null | python3 -c '
import json, sys
try:
    print(len(json.load(sys.stdin)["result"]["layout"]["panes"]))
except Exception:
    print(-1)'
}

rects_uniform() { # $1 = any pane in the tab; prints 1 if all rects are uniform ±1px
  "$herdr" pane layout --pane "$1" 2>/dev/null | python3 -c '
import json, sys
try:
    layout = json.load(sys.stdin)["result"]["layout"]
    rects = [p["rect"] for p in layout["panes"]]
    assert rects
    for dim in ("width", "height"):
        vals = [r[dim] for r in rects]
        assert max(vals) - min(vals) <= 1, (dim, vals)
        assert len({r[dim] for r in rects}) <= 2, (dim, vals)
    print(1)
except Exception:
    print(0)'
}

agents_in_workspace() { # $1 = workspace_id; prints "idle total"
  "$herdr" agent list 2>/dev/null | python3 -c '
import json, sys
ws = sys.argv[1]
try:
    agents = json.load(sys.stdin)["result"]["agents"]
except Exception:
    agents = []
mine = [a for a in agents if a.get("workspace_id") == ws]
idle = [a for a in mine if a.get("agent_status") == "idle"]
print(f"{len(idle)} {len(mine)}")' "$1"
}

dup_agent_names() { # $1 = workspace_id; prints duplicated agent names, if any
  "$herdr" agent list 2>/dev/null | python3 -c '
import json, sys
ws = sys.argv[1]
try:
    agents = [a for a in json.load(sys.stdin)["result"]["agents"] if a.get("workspace_id") == ws]
except Exception:
    agents = []
names = [a["agent"] for a in agents]
seen, dups = set(), set()
for n in names:
    if n in seen: dups.add(n)
    seen.add(n)
print(",".join(sorted(dups)))' "$1"
}

# ---- grid cases -----------------------------------------------------------------
grid_case() { # $1 = autopick value ("3x3"), $2 = rows, $3 = cols
  local rows=$2 cols=$3 expect
  expect=$(( rows * cols ))
  local ws root out code count uni
  ws_root=$(new_workspace) || { bad "grid $1: workspace create"; return; }
  ws=${ws_root%% *}; root=${ws_root#* }
  out=$(GRID_TARGET_PANE="$root" GRID_AUTOPICK="$1" "${bin[@]}" 2>&1); code=$?
  check $([[ $code == 0 ]] && echo 1 || echo 0) "grid $1: open exited 0 (out: $out)"
  count=$(pane_count "$root")
  check $([[ "$count" == "$expect" ]] && echo 1 || echo 0) "grid $1: pane count == $expect (got $count)"
  uni=$(rects_uniform "$root")
  check "$uni" "grid $1: rects uniform (±1px)"
  close_workspace "$ws"
  say "  grid $1 summary: $out"
}

grid_case 3x3 3 3
grid_case 4x6 4 6
grid_case 2x2 2 2
grid_case 1x3 1 3
grid_case 4x4 4 4

# ---- close others -----------------------------------------------------------------
ws_root=$(new_workspace)
ws=${ws_root%% *}; root=${ws_root#* }
"$herdr" pane split "$root" --direction right --ratio 0.5 >/dev/null 2>&1
"$herdr" pane split "$root" --direction right --ratio 0.666667 >/dev/null 2>&1
before=$(pane_count "$root")
out=$(GRID_TARGET_PANE="$root" GRID_AUTOPICK=closeOthers "${bin[@]}" 2>&1); code=$?
check $([[ $code == 0 ]] && echo 1 || echo 0) "closeOthers: open exited 0 (out: $out)"
check $([[ "$before" == 3 ]] && echo 1 || echo 0) "closeOthers: pre-split had 3 panes (got $before)"
after=$(pane_count "$root")
check $([[ "$after" == 1 ]] && echo 1 || echo 0) "closeOthers: 3 panes -> 1 (got $after)"
left=$("$herdr" pane list --workspace "$ws" 2>/dev/null | grep -o '"pane_id":"[^"]*"' | cut -d'"' -f4)
check $([[ "$left" == "$root" ]] && echo 1 || echo 0) "closeOthers: kept target $root (left: ${left:-none})"
close_workspace "$ws"

# ---- 1x2 with pi agents -------------------------------------------------------------
ws_root=$(new_workspace)
ws=${ws_root%% *}; root=${ws_root#* }
out=$(GRID_TARGET_PANE="$root" GRID_AUTOPICK=1x2:pi "${bin[@]}" 2>&1); code=$?
check $([[ $code == 0 ]] && echo 1 || echo 0) "1x2:pi: open exited 0 (out: $out)"
count=$(pane_count "$root")
check $([[ "$count" == 2 ]] && echo 1 || echo 0) "1x2:pi: 2 panes (got $count)"
say "  1x2:pi summary: $out"

# agents become idle within ~10s; poll up to 60s
idle=0; total=0
for i in $(seq 1 60); do
  read -r idle total <<<"$(agents_in_workspace "$ws")"
  if [[ "${idle:-0}" == 2 && "${total:-0}" == 2 ]]; then break; fi
  sleep 1
done
check $([[ "${idle:-0}" == 2 && "${total:-0}" == 2 ]] && echo 1 || echo 0) "1x2:pi: 2 agents idle in workspace (last: ${idle:-?}/${total:-?})"
# Name uniqueness is enforced server-side by `agent start` (a collision
# fails the launch); `agent list` reports the kind label, not the unique
# name, so per-name dup checks are not observable. Assert no failures and
# distinct panes instead.
check $([[ "$out" == *"started:2"* && "$out" == *"failed:0"* ]] && echo 1 || echo 0) "1x2:pi: both agent starts succeeded (started:2, failed:0)"
close_workspace "$ws"

say ""
say "rust-e2e: $pass passed, $fail failed"
if (( fail > 0 )); then
  printf 'failed: %s\n' "${failed_names[*]}"
  exit 1
fi
exit 0
