#!/bin/sh
# Needs: rclone. Starts a local S3 (SigV4-checked), then runs the action's restore/save entrypoints like a runner would.
set -e
D=$(mktemp -d); mkdir -p "$D/s3/bkt" "$D/work/node_modules/pkg"
rclone serve s3 "$D/s3" --auth-key AKIATEST,SECRETTEST --addr 127.0.0.1:9411 >/dev/null 2>&1 & R=$!
trap 'kill $R 2>/dev/null; rm -rf "$D"' EXIT; sleep 1.5
A="$(cd "$(dirname "$0")/../action" && pwd)"
KEY=deps-v1; SECRET=SECRETTEST; BUCKET=bkt
run() { # $1=entrypoint
  : > "$D/out"; : > "$D/state"
  (cd "$D/work" && env INPUT_PATH=node_modules "INPUT_KEY=$KEY" "INPUT_RESTORE-KEYS=deps-" "INPUT_BUCKET=$BUCKET" \
    INPUT_ENDPOINT=http://127.0.0.1:9411 INPUT_REGION=auto "INPUT_ACCESS-KEY-ID=AKIATEST" "INPUT_SECRET-ACCESS-KEY=$SECRET" \
    GITHUB_OUTPUT="$D/out" GITHUB_STATE="$D/state" $EXTRA node "$A/$1.ts")
}
echo hello > "$D/work/node_modules/pkg/index.js"
echo "--- 1 restore (empty bucket)"; run main; cat "$D/out"
echo "--- 2 post save"; run post
rm -rf "$D/work/node_modules"
echo "--- 3 restore exact"; run main; cat "$D/out"; test "$(cat "$D/work/node_modules/pkg/index.js")" = hello && echo CONTENT_OK
rm -rf "$D/work/node_modules"; KEY=deps-v2
echo "--- 4 restore via restore-key prefix"; run main; cat "$D/out"; test -f "$D/work/node_modules/pkg/index.js" && echo CONTENT_OK
echo "--- 5 bad creds must warn, not fail"; SECRET=WRONG; run main; echo "exit=$?"; SECRET=SECRETTEST
echo "--- 6 no creds -> disabled"; BUCKET=; run main; echo "exit=$?"
