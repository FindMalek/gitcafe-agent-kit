#!/bin/sh
# Records a real turbo run against the cache server: cold miss, wipe local cache, remote hit. Writes out/demo.txt
set -e
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
W=$(mktemp -d); mkdir -p "$W/app/packages/app"; cd "$W/app"
echo '{"name":"tp","private":true,"packageManager":"npm@10.0.0","workspaces":["packages/*"],"devDependencies":{"turbo":"2.11.11"}}' > package.json
echo '{"tasks":{"build":{"outputs":["dist/**"]}}}' > turbo.json
echo '{"name":"app","version":"1.0.0","scripts":{"build":"node build.js"}}' > packages/app/package.json
cat > packages/app/build.js <<'JS'
const fs=require('fs');const t=Date.now();while(Date.now()-t<2500){}
fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/out.txt',String(Math.random()));console.log('built');
JS
npm i --silent >/dev/null 2>&1
CACHE_TOKENS=demo-token CACHE_DIR="$W/store" PORT=3955 node "$ROOT/packages/cache/src/main.ts" >/dev/null 2>&1 & S=$!
trap 'kill $S 2>/dev/null; rm -rf "$W"' EXIT; sleep 1.5
export TURBO_API=http://127.0.0.1:3955 TURBO_TOKEN=demo-token TURBO_TEAM=demo TURBO_TELEMETRY_DISABLED=1 NO_COLOR=1
OUT="$ROOT/out/demo.txt"; : > "$OUT"
say() { printf '%s\n' "$1" >> "$OUT"; }
run() { say "\$ $1"; /usr/bin/time -p sh -c "$1" 2>&1 | grep -E "cache (miss|hit)|Cached|Time:|Remote caching|real" | sed 's/^ *//' >> "$OUT"; }
run "npx turbo run build"
say ""; say "\$ rm -rf .turbo packages/app/dist   # wipe local cache"
rm -rf .turbo node_modules/.cache packages/app/dist packages/app/.turbo
say ""
run "npx turbo run build"
