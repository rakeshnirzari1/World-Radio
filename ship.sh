#!/usr/bin/env bash
# One command for a whole deploy: build, regenerate, gate, upload.
#
# Written because a deploy had to be split across calls to fit a tool timeout, and two
# splits timed out mid-flight. It also gates: a generator pass that silently did not run
# once shipped a build 1566 files short, so this refuses to deploy a build that is.
set -euo pipefail
R="C:/Users/Rakesh Patel/AppData/Local/Temp/worldradio"
S="C:/Users/Rakesh Patel/AppData/Local/hermes/cache/scratch"
MIN_FILES=${MIN_FILES:-15000}
cd "$R"
export REACT_APP_PROXY_URL="https://radio-melody-relay.rvpnrp.workers.dev"
export CI=false
export PUBLIC_URL=/
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "== build"
  ( cd frontend && npm run build > "$S/ship-build.log" 2>&1 ) || { echo "BUILD FAILED"; tail -20 "$S/ship-build.log"; exit 1; }
fi
echo "== place the committed share cards back (a build wipes them)"
python -c "import shutil, pathlib; src=pathlib.Path(chr(102)+chr(114)+chr(111)+chr(110)+chr(116)+chr(101)+chr(110)+chr(100)+chr(47)+chr(112)+chr(117)+chr(98)+chr(108)+chr(105)+chr(99)+chr(47)+chr(111)+chr(103)); dst=pathlib.Path(chr(102)+chr(114)+chr(111)+chr(110)+chr(116)+chr(101)+chr(110)+chr(100)+chr(47)+chr(98)+chr(117)+chr(105)+chr(108)+chr(100)+chr(47)+chr(111)+chr(103)); dst.mkdir(parents=True, exist_ok=True); shutil.copytree(src, dst, dirs_exist_ok=True); print(chr(111)+chr(103), sum(1 for _ in dst.rglob(chr(42)) if _.is_file()))"
echo "== station index"
BUILD_DIR=frontend/build node tools/station-index.mjs > "$S/ship-index.log" 2>&1 || { echo "INDEX FAILED"; tail -20 "$S/ship-index.log"; exit 1; }
echo "== prerender"
BUILD_DIR=frontend/build node tools/prerender.mjs > "$S/ship-prerender.log" 2>&1 || { echo "PRERENDER FAILED"; tail -20 "$S/ship-prerender.log"; exit 1; }
N=$(find frontend/build -type f | wc -l)
IDX=$(find frontend/build/station-index -type f 2>/dev/null | wc -l)
OG=$(find frontend/build/og -type f 2>/dev/null | wc -l)
BUNDLE=$(grep -o "main\.[a-f0-9]*\.js" frontend/build/index.html | head -1)
echo "== gate: files=$N index=$IDX og=$OG bundle=$BUNDLE"
[ "$N" -ge "$MIN_FILES" ] || { echo "REFUSING TO DEPLOY: only $N files"; exit 1; }
[ "$IDX" -ge 500 ] || { echo "REFUSING TO DEPLOY: station index missing"; exit 1; }
[ "$OG" -ge 1500 ] || { echo "REFUSING TO DEPLOY: share cards missing"; exit 1; }
[ -n "$BUNDLE" ] || { echo "REFUSING TO DEPLOY: no bundle in index.html"; exit 1; }
grep -q "$BUNDLE" "$(find frontend/build/station -name index.html | head -1)" || { echo "REFUSING TO DEPLOY: pages carry a stale bundle"; exit 1; }
echo "== deploy"
npx --yes wrangler pages deploy frontend/build --project-name=worldradio --branch=main --commit-dirty=true 2>&1 | tail -2
