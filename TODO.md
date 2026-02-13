# Reviso Action — Development Task List

## Phase 0: Project Scaffolding

- [x] Initialize Node.js project — `package.json`, `.gitignore`, TypeScript config
- [x] Set up TypeScript tooling — `tsconfig.json`, build scripts, `@vercel/ncc` bundler
- [x] Create `action.yml` — GitHub Action metadata (inputs, outputs, runs config)
- [x] Set up linting/formatting — Biome

## Phase 1: Core Action Logic

- [x] Gather PR metadata — Use `@actions/github` to extract PR number, title, description, author, refs, repo
- [x] Fetch changed files & diffs — GitHub API to get changed files with patches + optional full contents
- [x] Build the request payload — Assemble `POST /v1/review` body matching the API spec
- [x] Call the Reviso API — HTTP POST with auth header and payload
- [x] Parse the response — Validate and deserialize structured review response

## Phase 2: PR Comment Posting

- [x] Post inline review comments — Map issues to GitHub PR review comments (file + line)
- [x] Post review summary comment — Summary + metrics as top-level PR comment or review body
- [x] Severity filtering — Only post issues at or above configured `severity_threshold`
- [x] Idempotency — On re-runs, update/replace existing Reviso comments instead of duplicating

## Phase 3: Configuration & Inputs

- [x] Define action inputs — `anthropic_api_key`, `reviso_api_key`, `github_token`, `review_depth`, `severity_threshold`, `custom_instructions`, `max_files`, `api_url`
- [x] Input validation — Required secrets present, enums valid, etc.
- [x] Action outputs — Expose `issues_count`, `high_severity_count` for downstream steps

## Phase 4: Error Handling & Edge Cases

- [x] Handle API errors gracefully — 401, 400, 429, 500, timeouts with clear log messages
- [x] Handle large PRs — Respect `max_files`, skip binaries, warn on skipped files
- [x] Handle empty diffs — Skip review if no reviewable files changed
- [x] GitHub API rate limiting — Retry with exponential backoff on 403/429

## Phase 5: Testing & CI

- [x] Unit tests — Config validation, severity filtering (14 tests passing)
- [x] Integration test fixtures — Sample API responses for testing
- [x] CI workflow — GitHub Actions workflow for lint, test, build on push
- [x] Bundle & commit dist — Build action bundle to `dist/`

## Phase 6: Documentation & Release

- [x] Write README — Usage examples, inputs/outputs, config guide, cost info
- [x] Add example workflow — included in README quick start
- [ ] Publish v1 release — Tag and release for `uses: Vyttle-LLC/reviso-action@v1`

---

## Reviso API Tasks (separate repo)

- [ ] Scaffold Cloudflare Worker — `wrangler.toml`, TypeScript, routing
- [ ] Implement `POST /v1/review` — Request validation, auth check
- [ ] Build Pass 1 (Diff Review) — Haiku prompt, Anthropic API call, structured output parsing
- [ ] Build Pass 2 (Context Review) — Sonnet prompt, trigger logic, Anthropic API call
- [ ] Pipeline orchestrator — Run passes, merge/deduplicate issues
- [ ] Implement `GET /v1/health` — Health check endpoint
- [ ] Error handling — Retries, partial results, graceful degradation
- [ ] Token estimation — 1 token ≈ 4 chars for routing and cost estimates
- [ ] Prompt templates — Versioned prompt files for each pass
- [ ] Deploy & test — Deploy to Cloudflare, end-to-end test with real PR
