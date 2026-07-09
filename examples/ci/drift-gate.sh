#!/bin/sh

# Copyable SpecMarten drift gate for any CI system.
# Layer 1 is deterministic and needs no AI agent or credentials.
# Layer 2 is opt-in: set SPECMARTEN_GATE_CHANGE to run semantic drift checks.

set -u

echo "SpecMarten deterministic gate: validate"
if ! specmarten validate; then
  echo "SpecMarten deterministic gate failed: specmarten validate returned non-zero."
  exit 1
fi

echo "SpecMarten deterministic gate: reconcile"
specmarten reconcile

if [ "${SPECMARTEN_GATE_CHANGE:-}" = "" ]; then
  echo "SpecMarten semantic gate skipped: SPECMARTEN_GATE_CHANGE is not set."
  exit 0
fi

echo "SpecMarten semantic gate: check $SPECMARTEN_GATE_CHANGE"
set +e
specmarten check "$SPECMARTEN_GATE_CHANGE" --headless
code=$?
set -e

case "$code" in
  0)
    echo "SpecMarten semantic gate: PASS"
    exit 0
    ;;
  10)
    echo "SpecMarten semantic gate: WARN"
    if [ "${SPECMARTEN_GATE_STRICT_WARN:-0}" = "1" ]; then
      echo "SpecMarten semantic gate failed: SPECMARTEN_GATE_STRICT_WARN=1."
      exit 10
    fi
    echo "SpecMarten semantic gate did not fail because WARN is advisory by default."
    exit 0
    ;;
  2)
    echo "SpecMarten semantic gate failed: BLOCK"
    exit 2
    ;;
  *)
    echo "SpecMarten semantic gate failed with unexpected exit code: $code"
    exit "$code"
    ;;
esac
