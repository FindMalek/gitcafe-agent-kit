# Findings

Everything here was checked on 2026-11-19 against the public surface only (REST/OpenAPI, `cafe` CLI 0.13.0, MCP at `/mcp`, docs, `/llms.txt`), signed in as a free-plan account.
Each item says **Verified** (reproduced by me), **Documented only** (the docs say it, I did not exercise it) or **Not reproduced**.
No security-looking issue turned up. If one does, it goes to the team privately, not into this repo.

## Verified

### 1. The OpenAPI file is about 2.09M characters and its operationIds are path-derived
- Repro: `curl -s https://git.cafe/api/openapi/json | wc -c` (2,092,779 bytes, 2,092,751 chars on the run above), `jq '.paths | length'` (423 paths), `jq '[.paths[][]|select(type=="object")|.operationId]|length'` (547 operations; 72 more webhook events under `.webhooks`).
- Example id: `getApiReposByOwnerByRepoWebhooksByWebhookIdDeliveriesByDeliveryIdAttempts` (73 chars).
- Note: the brief said ~1.9M characters; it measures 2.09M today.
- Fix in this repo: `packages/openapi-slicer` (verb ids such as `listPullRequests`, per-tag slices, per-operation docs, a 59K-char index). See `packages/openapi-slicer/BEFORE_AFTER.md`. All 547 single-operation docs and 23 slices validate (swagger-parser, version string relabelled 3.1.2 to 3.1.1 because the parser does not know 3.1.2; the unsliced spec passes the same check).
- Even sliced, `listPullRequests` is about 11K tokens (chars/4) because response schemas are deep. That is a property of the schemas.

### 2. The CLI only runs under Bun
- Repro: `node "$(readlink -f "$(command -v cafe)")" --version` prints `ReferenceError: Bun is not defined`. The entry file starts with `#!/usr/bin/env bun`.
- Fix here: none (the CLI is closed). The task runner shells out to `cafe`, so it needs Bun on the box.

### 3. `--help` on a subcommand fails, `-h` works
- Repro: `cafe stack submit --help` returns `INVALID_INPUT: unknown command "stack submit"`; `cafe stack submit -h` prints the real help. `cafe stack --help` works. Same for `cafe issue view --help`.
- Why it matters: an agent that discovers flags with `--help` gets an error and no flag list.

### 4. Success responses carry the policy but never the remaining quota
- Repro: `cafe api /repos/versecafe/webls/pulls/ --response-headers` shows `ratelimit-policy: "api";q=1000;w=60` and no `RateLimit` header. 28 of 28 requests in `packages/rate-guard/bench` behaved the same.
- The docs state this on purpose ("The API does not report how many requests remain"), so it is a design limit, not a bug.
- Fix here: `packages/rate-guard`, a client-side sliding-window guard that learns the policy from `ratelimit-policy`, gives each agent a share, pauses all calls for `Retry-After` on a 429 and backs off on repeats.
- Benchmark (real account): 2 agents x 14 reads at a 10-per-60s share each, all 200, peak per-agent rate 10 in any 60s window. See `out/bench.json` after `node packages/rate-guard/bench/bench.ts`.

### 5. `create_issue` has no idempotency key on either surface
- Repro (MCP): `curl -s -X POST https://git.cafe/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` works without sign-in; the `create_issue` description says "There is no idempotency key".
- Repro (REST): the `POST /api/repos/{owner}/{repo}/issues/` body has `title, description, priority, dueDate, state, labelIds, assigneeIds, milestoneId` and no `requestId`.
- `requestId` does exist for branch and mirror operations (`docs/reference/api.md`), and on MCP `commit_changes`.
- Effect: a retry after an unknown outcome can create a duplicate issue. The task runner never retries issue creation.

### 6. Turborepo-compatible remote cache and a cache action (my work, not a GitCafe gap)
- Server: real `turbo` 2.11.11 against `packages/cache`: cold miss uploads, a wiped local cache then hits remotely with identical restored content, a bad token degrades with a warning, and `remoteCache.signature` round-trips (a wrong signing key is a miss). Verified with filesystem storage and with an S3 backend (rclone `serve s3`, SigV4 checked).
- Turborepo's published spec lists `/artifacts/...` but real clients call `/v8/artifacts/...` (their docs say "all versions of turbo are compatible with the v8 endpoints").
- Action: restore, save, exact hit, restore-key prefix fallback, graceful failure on bad credentials and no-op without credentials, all against a local SigV4-checked S3.

### 7. Task runner against a real repo (private sandbox `findmalek/gitcafe-agent-kit-sandbox`)
- Real run, twice: claim by `issue assign`, `git worktree add`, scripted agent commit, `stack submit --dry-run`, real `stack submit`, `pr link --type closes`, provenance comment. The linked PR and the comment agree on the second run.
- Real-world shapes the docs do not state: `--json` results are wrapped as `data.resource`; an issue's body field is `description`; open/closed is `closedAt` (null when open) plus `stateType`; stack PRs sit on branches named `cafe/<--name>/<n>`.
- Bug the first real run caught in my own code: I guessed PR numbers out of the `stack submit` JSON and posted `#3, #2` when only `#2` existed. Fixed to list PRs by their `cafe/<name>/` branch and only report links that succeeded. The wrong comment is still on sandbox issue #1.
- There is no claim lease: `issue assign` then re-read is best effort, two agents can both assign.

### 8. Hosted CI is not available to an ordinary account
- Repro: `cafe ci enable -R <repo>` prints `Admitted: No`; a `workflow_dispatch` run of a `runs-on: ubuntu-latest` workflow stayed `Queued` for several minutes with nothing to run it. Consistent with the docs ("GitCafe-hosted runners are in beta for organizations GitCafe admits").
- So I could not run `actions/cache` or `upload-artifact` to see their failure mode, and could not run `gitcafe-cache` on a runner.

### 9. `cafe repo create` defaults to public
- `cafe repo create -h`: "create as private (the CLI default is public)". The raw API defaults to private. An agent that forgets `--private` publishes the repo.

## Documented only (not exercised)

- **No `actions/cache`, no artifacts.** `docs/ci/workflow-syntax.md` marks `actions/cache` "Not yet. No cache service." and `upload-artifact@v4`/`download-artifact@v4` "Not yet. The actions refuse servers other than github.com." The failure mode is unseen because no runner picks the job up (item 8).
- **Credential silos.** `docs/agent-workflows.md`: "an MCP token does not work for the REST API, and a REST token does not work for MCP." Exercising it needs an MCP OAuth consent, which is a browser step.
- **One shared budget per account.** `docs/reference/rate-limits.md`: "Every credential of one account ... shares one count." I only have one credential, so I could not show one agent starving another.
- **Remote actions come from github.com only.** `uses: owner/repo@ref` downloads from public github.com, so the cache action has to be copied into a repo and used as `./path` until it is published there.

## Not reproduced

- **"MCP can't create branches or commits" contradicting `commit_changes`.** I searched all 54 pages in `/llms.txt`. `docs/account/mcp-connections.md` says `commit_changes` can create a branch (`expectedOid: null`) and the live `tools/list` agrees. No page says the opposite today. The brief may predate a docs fix.
- **Link header versus `next` cursor mismatch.** Live `GET /api/repos` returns both `link: </api/repos?after=...>; rel="next"` and body `next` with the same cursor. The spec declares the `Link` header on 82 of 258 GET operations and says the body `next` carries the same cursor. It is declared on some list endpoints only, which may be what the brief saw, but the two do not disagree.

## Unverified

- Multi-commit stacks and `--base` other than `main` in the task runner (only one-commit stacks were run).
- Cloudflare R2 specifics (SigV4 and `UNSIGNED-PAYLOAD` streaming PUT are standard, but I only ran against rclone).
- Whether a GitCafe runner can run the action (Node 24 with type stripping, outbound HTTPS to the bucket): no runner was available.
- A real 429: the guard's 429 path is unit-tested only. Provoking one would breach the acceptable-use policy ("evade quotas or rate limits, generate excessive automated traffic").
