#!/usr/bin/env bash
#
# The acceptance checklist. One command, same locally and in CI.
#
#   ./check.sh                build, artifact guarantees, model, browser
#
# Every phase must be able to fail. A phase that skips when its tool is missing
# is a phase that silently stops checking, so missing tools are failures here.
set -uo pipefail
cd "$(dirname "$0")"

FAILED=0
fail() { echo "FAIL: $1" >&2; FAILED=1; }
report() { echo; echo "== $1 =="; }

NODE=${NODE:-$(command -v node || true)}
if [[ -z $NODE ]]; then
  fail "node not found; run inside the pinned shell: nix develop --command ./check.sh"
fi

# ---- build ------------------------------------------------------------------
report "build"
if [[ -n $NODE ]]; then
  "$NODE" tools/build.mjs || fail "build"
fi

# ---- artifact guarantees ----------------------------------------------------
report "artifact guarantees"
ARTIFACT=index.html
if [[ ! -s $ARTIFACT ]]; then
  fail "no artifact to check"
else
  if grep -qE '<(script|link|img|source|iframe)[^>]+(src|href)="[^#d]' "$ARTIFACT"; then
    fail "artifact references an external file"
    grep -oE '<(script|link|img|source|iframe)[^>]+(src|href)="[^"]*"' "$ARTIFACT" | head -3 >&2
  else
    echo "  ok   no external file references"
  fi

  if grep -qE 'localStorage|sessionStorage|indexedDB|document\.cookie' "$ARTIFACT"; then
    fail "artifact references web storage"
  else
    echo "  ok   no web storage use"
  fi

  if grep -nE '^(import|export) ' "$ARTIFACT" | head -3 | grep -q .; then
    fail "ES module syntax survived into the bundled artifact"
  else
    echo "  ok   no module syntax in the bundle"
  fi
fi

# ---- model ------------------------------------------------------------------
# The physics: hull hydrostatics and the righting-arm curve, asserted as shape
# properties and closed-form cross-checks. Both files exit non-zero on failure.
report "model"
if [[ -n $NODE ]]; then
  "$NODE" tests/hydrostatics.test.mjs || fail "hydrostatics checks"
  "$NODE" tests/stability.test.mjs || fail "stability checks"
fi

# ---- browser ----------------------------------------------------------------
report "browser"
if [[ -z ${PLAYWRIGHT_ENTRY:-} || -z ${PLAYWRIGHT_BROWSERS_PATH:-} ]]; then
  fail "PLAYWRIGHT_ENTRY and PLAYWRIGHT_BROWSERS_PATH must be set; run inside the pinned shell"
elif [[ -n $NODE ]]; then
  "$NODE" tests/browser.test.mjs || fail "browser checks"
fi

echo
if [[ $FAILED -eq 0 ]]; then
  echo "ALL CHECKS PASSED"
else
  echo "checks failed"
  exit 1
fi
