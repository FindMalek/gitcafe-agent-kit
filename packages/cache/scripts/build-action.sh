#!/bin/sh
# The action directory must be self-contained (a runner only sees what is under it), so copy the shared sources in.
set -e
cd "$(dirname "$0")/.."
cp src/s3.ts src/action-lib.ts action/
echo "copied s3.ts and action-lib.ts into action/"
