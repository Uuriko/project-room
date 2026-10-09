#!/usr/bin/env bash
# One-command verification for the guild22 Python SDK contract repair.
#
#   1. Materializes the SDK read-only from branch wave2000/guild-22
#      (git archive; the released guild-22 branch is never mutated).
#   2. Builds a PATCHED copy (applies fixes/guild22-sdk-contract-fixes.patch).
#   3. Runs the offline contract tests against the PATCHED SDK   -> all green.
#   4. Runs the SDK's own 61-test suite against the PATCHED SDK -> regression check.
#   5. NEGATIVE CONTROL: runs the contract tests against the UNPATCHED SDK ->
#      the five mismatch tests must FAIL (proving the tests detect the bugs).
#
# Stdlib python3 only. No network. Exit 0 only when every expectation holds.
set -u
cd "$(dirname "$0")"
GUILD="$(pwd)"
REPO="$(cd .. && pwd)"
WORK="$(mktemp -d /tmp/sdk-contract-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

SDK_BRANCH="wave2000/guild-22"
echo "== materialize SDK from $SDK_BRANCH (read-only) =="
git -C "$REPO" archive "$SDK_BRANCH" sdk-python | tar -x -C "$WORK"
rm -rf "$WORK/sdk-python/room_sdk/__pycache__"
SDK_SHA="$(git -C "$REPO" rev-parse "$SDK_BRANCH")"
echo "   sdk sha: $SDK_SHA"

mkdir -p "$WORK/patched" "$WORK/unpatched"
cp -r "$WORK/sdk-python" "$WORK/patched/sdk-python"
cp -r "$WORK/sdk-python" "$WORK/unpatched/sdk-python"
echo "== apply contract fixes to patched copy =="
patch -p1 -d "$WORK/patched" --quiet < "$GUILD/fixes/guild22-sdk-contract-fixes.patch" \
  || { echo "FAIL: patch did not apply"; exit 1; }
echo "   patch applied cleanly"

run_contract() { # $1 = label, $2 = sdk dir, $3 = log file
  echo "== contract tests: $1 =="
  ROOM_SDK_SRC="$2/sdk-python" python3 "$GUILD/tests/test_contract_compat.py" > "$3" 2>&1
  tail -6 "$3"
  echo "   (full log: $3)"
}

echo
run_contract "PATCHED" "$WORK/patched" "$WORK/patched.log"
PATCHED_FAILS="$(grep -cE "^(FAIL|ERROR):" "$WORK/patched.log" || true)"
echo
echo "== SDK's own test suite on PATCHED sdk (regression) =="
(cd "$WORK/patched/sdk-python" && python3 -m unittest discover -s tests -t . > "$WORK/own.log" 2>&1)
tail -4 "$WORK/own.log"
# The guild-22 suite encodes the OLD (wrong) contract in one place:
# test_reply_pins_thread_root asserts data["parentId"]. The fix changes the
# payload to replyToId, so exactly this test must now fail — with KeyError
# 'parentId' — and nothing else may. That is the expected, explained delta.
OWN_BAD="$(grep -E "^(FAIL|ERROR):" "$WORK/own.log" | sed 's/ (.*//' | sort | tr '\n' ' ')"
echo "   own-suite failures: [$OWN_BAD]"
if [ "$OWN_BAD" = "ERROR: test_reply_pins_thread_root " ] \
   && grep -q "KeyError: 'parentId'" "$WORK/own.log"; then
  echo "   -> only the known stale-contract test (asserts the old parentId payload); acceptable (see README)"
  OWN_FAILS=0
else
  OWN_FAILS=1
fi
echo
run_contract "UNPATCHED (negative control)" "$WORK/unpatched" "$WORK/unpatched.log"
NEG_FAILED_TESTS="$(grep -E "^(FAIL|ERROR):" "$WORK/unpatched.log" | sed 's/ (.*//' | sort)"

echo
echo "================ SUMMARY ================"
echo "patched contract tests failed:   $PATCHED_FAILS (expect 0)"
echo "patched own-suite failures:      $OWN_FAILS (expect 0)"
echo "negative-control failing tests:"
echo "$NEG_FAILED_TESTS"
NEG_COUNT="$(echo "$NEG_FAILED_TESTS" | grep -c . || true)"
for t in test_real_envelope_unwrapped test_continues_through_empty_filtered_page \
         test_stuck_cursor_fails_loudly test_canonical_record_names \
         test_reply_to_sends_replyToId test_retry_needs_full_envelope; do
  echo "$NEG_FAILED_TESTS" | grep -q "$t" \
    && echo "  [ok] $t fails unpatched" \
    || { echo "  [BAD] $t did NOT fail unpatched"; }
done
if [ "$PATCHED_FAILS" = "0" ] && [ "$OWN_FAILS" = "0" ] && [ "$NEG_COUNT" = "6" ]; then
  echo "RESULT: PASS — fixes verified, negative control holds, no regressions"
  exit 0
else
  echo "RESULT: FAIL — see above"
  exit 1
fi
