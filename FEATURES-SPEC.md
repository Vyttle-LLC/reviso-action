# Feature Spec: Cumulative Cost, Summary Hiding, Auto-Resolve

**Date:** 2026-02-16
**Status:** Draft
**Scope:** `reviso-action` only (no API changes needed)

---

## Current State

Today, `postReview()` in `comments.ts`:
1. **Deletes** all previous Reviso summary comments (identified by `<!-- reviso-review -->`)
2. **Dismisses** all previous Reviso PR reviews
3. Posts new inline review comments via `pulls.createReview()`
4. Posts a new summary issue comment via `issues.createComment()`

This means previous reviews are fully wiped on re-run — no history is preserved, no cost is accumulated, and fixed issues are not resolved (they're deleted along with the review).

---

## Feature 1: Cumulative Cost Tracking

### Goal
Show users both the cost of the current review and the total cost of all reviews in the PR.

### Design

#### Metadata Format
Embed a JSON blob in the summary comment as a hidden HTML comment:

```html
<!-- reviso-meta:{"reviews":[{"id":"rev_abc","cost":0.065,"timestamp":"2026-02-16T10:00:00Z"},{"id":"rev_def","cost":0.042,"timestamp":"2026-02-16T12:00:00Z"}],"total_cost":0.107} -->
```

This sits right before the existing `<!-- reviso-review -->` signature.

#### Read/Write Flow

1. **Before cleanup** — scan PR comments for the existing Reviso summary (same loop we already use in `deleteExistingSummary`)
2. **Parse metadata** — extract `reviso-meta` JSON from the comment body. If missing or unparseable, start fresh with an empty array.
3. **Append current review** — push `{ id: response.review_id, cost: response.metrics.estimated_cost_usd, timestamp: new Date().toISOString() }` to the `reviews` array, recompute `total_cost`.
4. **Delete old summary** — proceed with existing cleanup.
5. **Post new summary** — include the updated metadata blob + display the cumulative cost in the metrics table.

#### Summary Table Changes

```
| Estimated cost (this review) | $0.0420 |
| Total cost (2 reviews)       | $0.1070 |
```

#### New Types

```typescript
interface ReviewCostEntry {
  id: string;            // review_id from API
  cost: number;          // estimated_cost_usd
  timestamp: string;     // ISO 8601
}

interface RevisoMeta {
  reviews: ReviewCostEntry[];
  total_cost: number;
}
```

#### Helper Functions

```typescript
const META_REGEX = /<!-- reviso-meta:(.*?) -->/s;

function parseRevisoMeta(commentBody: string): RevisoMeta | null
function serializeRevisoMeta(meta: RevisoMeta): string
```

#### Edge Cases

- **First review on PR** — no previous meta, start with empty `reviews[]`
- **Corrupted metadata** — log warning, start fresh (don't break the review)
- **Comment body edited by human** — regex won't match, start fresh
- **Multiple summary comments somehow exist** — use the most recent one's metadata

---

## Feature 2: Minimize Previous Summaries (Instead of Delete)

### Goal
When a new review runs, previous summaries should be collapsed as "outdated" rather than deleted. This preserves review history while keeping the PR timeline clean.

### Design

#### Behavior Change
Replace the current `deleteExistingSummary()` with `minimizePreviousSummaries()`:

- Instead of calling `issues.deleteComment()`, call the GraphQL `minimizeComment` mutation
- Reason: `OUTDATED`
- This collapses the comment in the PR timeline with a "This comment was marked as outdated" banner

#### GraphQL Mutation

```graphql
mutation MinimizeComment($id: ID!, $reason: ReportedContentClassifiers!) {
  minimizeComment(input: { subjectId: $id, classifier: $reason }) {
    minimizedComment {
      isMinimized
    }
  }
}
```

We need the **node ID** (not the numeric REST ID) for GraphQL. The REST API returns this as `comment.node_id`.

#### Implementation

```typescript
async function minimizePreviousSummaries(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<{ meta: RevisoMeta | null; minimizedCount: number }> {
  // 1. Paginate through comments (same as today)
  // 2. For each comment with BOT_SIGNATURE:
  //    a. Parse reviso-meta (for cost accumulation — Feature 1)
  //    b. Minimize via GraphQL using comment.node_id
  //    c. Track count
  // 3. Return parsed meta + count
}
```

This function now serves double duty: it handles both Feature 1 (extracting previous cost data) and Feature 2 (minimizing old summaries).

#### Handling Previous Reviews (Inline Comments)

For inline review comments (posted via `pulls.createReview`), the current `deleteExistingReviews()` dismisses them. We should keep this behavior — dismissed reviews are already collapsed with a "dismissed" banner. No change needed here.

#### Permissions

The `minimizeComment` mutation requires **write** access to the repository. The default `GITHUB_TOKEN` in Actions has this when the workflow has `pull-requests: write` — which we already require for posting comments. No new permissions needed.

#### Fallback

If the GraphQL minimize call fails (e.g., permissions issue), fall back to the current behavior: delete the comment. Log a warning.

---

## Feature 3: Auto-Resolve Fixed Issues

### Goal
When a new review runs, inline comments from previous reviews that no longer appear in the new results should be automatically resolved, signaling the author fixed them.

### Design

#### Metadata in Inline Comments

Embed issue identity metadata in each inline comment:

```html
<!-- reviso-issue:{"file":"src/auth.ts","category":"security","hash":"a1b2c3d4"} -->
```

Where `hash` is a short fingerprint derived from the issue's core identity (not line numbers, since those shift between commits).

#### Hash Computation

```typescript
function computeIssueHash(issue: ReviewIssue): string {
  // Hash the stable parts of an issue identity:
  // - file path
  // - category
  // - first N chars of the message (normalized)
  // Line numbers are explicitly excluded — they shift between commits.
  const input = `${issue.file}::${issue.category}::${normalizeMessage(issue.message)}`;
  return shortHash(input); // e.g., first 8 chars of SHA-256
}

function normalizeMessage(msg: string): string {
  // Lowercase, collapse whitespace, trim — make matching resilient to
  // minor message rephrasing between reviews
  return msg.toLowerCase().replace(/\s+/g, " ").trim();
}
```

We use a simple hash rather than storing the full message to keep the HTML comment compact.

#### Resolution Flow

After calling the API and before posting new comments:

1. **Collect previous inline comments** — List all review comments on the PR, find those with `<!-- reviso-issue:... -->` metadata.
2. **Build "previous issues" set** — Parse the metadata from each, creating a `Set<hash>` of previously flagged issues.
3. **Build "current issues" set** — Compute hashes for all issues in the new API response (before severity filtering).
4. **Diff** — Any hash in "previous" but not in "current" = fixed.
5. **Resolve threads** — For each fixed issue's review comment, find its thread and resolve it via GraphQL.

#### GraphQL: Resolve Thread

PR review comments live in threads. To resolve:

```graphql
mutation ResolveThread($id: ID!) {
  resolveReviewThread(input: { threadId: $id }) {
    thread {
      isResolved
    }
  }
}
```

We need the **thread node ID**. When listing PR review comments, each comment has a `node_id` that can be used to find/resolve its thread. Specifically, we'll use the `pullRequestReviewThreads` connection on the PR to match comments to threads.

#### Fetching Threads with Comments

Rather than trying to map REST comment IDs to GraphQL thread IDs, query threads directly:

```graphql
query GetReviewThreads($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          comments(first: 1) {
            nodes {
              body
            }
          }
        }
      }
    }
  }
}
```

For each thread, check if the first comment's body contains `<!-- reviso-issue:... -->`, parse the hash, and if it's in the "fixed" set, resolve the thread.

#### What Counts as "Fixed"?

An issue is considered fixed when its hash **does not appear** in the new review's full issue list (pre-severity-filter). We compare against the full list, not the filtered list, because a "fixed" issue truly shouldn't appear at any severity.

Important: we hash against the **full set of new issues from the API** — not just the ones above the severity threshold. If the API still flags the same issue, it's not fixed regardless of whether it passes the user's filter.

#### What About Issues Still Present but on Different Lines?

Since the hash excludes line numbers, an issue that moved to a different line but has the same file + category + message will still match. The old thread gets resolved, and a new inline comment gets posted at the new position. This is correct behavior — the old thread is stale (wrong line), the new one is accurate.

#### Edge Cases

- **First review on PR** — no previous threads, nothing to resolve
- **API returns different wording for same issue** — `normalizeMessage` handles minor rephrasing, but if the AI significantly rewords the message, it won't match. This is acceptable — false negatives (not auto-resolving) are much safer than false positives (resolving an unfixed issue).
- **Thread already resolved by human** — `isResolved` check: skip if already resolved
- **Non-reviso threads** — only match threads whose comment contains `<!-- reviso-issue:... -->`
- **Pagination** — PR review threads can exceed 100; paginate the GraphQL query

#### Updated Inline Comment Format

```typescript
function formatIssueComment(issue: ReviewIssue): string {
  const emoji = SEVERITY_EMOJI[issue.severity];
  const header = `${emoji} **${issue.severity.toUpperCase()}** — ${issue.category}`;
  let body = `${header}\n\n${issue.message}`;

  if (issue.suggestion) {
    body += `\n\n**Suggestion:**\n\`\`\`\n${issue.suggestion}\n\`\`\``;
  }

  body += `\n\n<sub>Found by ${issue.model} (${issue.pass} pass)</sub>`;

  // Issue identity metadata for auto-resolve (Feature 3)
  const meta = {
    file: issue.file,
    category: issue.category,
    hash: computeIssueHash(issue),
  };
  body += `\n<!-- reviso-issue:${JSON.stringify(meta)} -->`;

  return body;
}
```

---

## Revised `postReview()` Flow

Here's how the three features integrate into the existing flow:

```
postReview(config, prNumber, response)
│
├─ 1. MINIMIZE previous summaries + EXTRACT cost metadata  [F1 + F2]
│     └─ minimizePreviousSummaries() → { meta, minimizedCount }
│
├─ 2. DISMISS previous reviews (existing, unchanged)
│
├─ 3. COLLECT previous inline comments + COMPUTE fix set    [F3]
│     └─ findPreviousIssueHashes() → Map<hash, threadNodeId>
│     └─ computeCurrentHashes(response.issues) → Set<hash>
│     └─ fixedHashes = previous - current
│
├─ 4. RESOLVE threads for fixed issues                      [F3]
│     └─ resolveFixedThreads(fixedHashes)
│
├─ 5. FILTER issues by severity (existing, unchanged)
│
├─ 6. BUILD + POST inline comments with issue metadata      [F3]
│     └─ Each comment includes <!-- reviso-issue:{...} -->
│
├─ 7. BUILD + POST summary with cumulative cost metadata    [F1]
│     └─ Metrics table shows per-review + cumulative cost
│     └─ Body includes <!-- reviso-meta:{...} -->
│
└─ done
```

---

## Files Changed

| File | Changes |
|------|---------|
| `src/types.ts` | Add `ReviewCostEntry`, `RevisoMeta` interfaces |
| `src/comments.ts` | Major refactor — add minimize, cost tracking, hash computation, thread resolution |
| `src/index.ts` | No changes needed (postReview signature unchanged) |
| `src/api.ts` | No changes |
| `src/github.ts` | No changes |
| `src/config.ts` | No changes |
| `action.yml` | No changes (no new inputs required) |

All three features are self-contained within `comments.ts` + `types.ts`.

---

## Dependencies

- **No new npm packages** — we can use Node.js built-in `crypto` for SHA-256 hashing
- **No API changes** — the Reviso API response already includes everything we need
- **GraphQL** — `octokit.graphql()` is already available on the octokit instance (part of `@octokit/graphql` bundled with `@actions/github`)

---

## Testing Plan

### Unit Tests
- `parseRevisoMeta()` / `serializeRevisoMeta()` — round-trip, corrupted input, missing meta
- `computeIssueHash()` — deterministic, stable across line number changes, normalized message matching
- `filterBySeverity()` — existing tests, no changes needed

### Integration Tests (mock octokit)
- First review: no previous meta, posts with initial cost entry
- Re-run review: reads previous meta, accumulates cost, minimizes old summary
- Auto-resolve: previous issues not in new results → resolved; still-present issues → not resolved
- Mixed scenario: some issues fixed, some new, some unchanged

---

## Decisions

1. **Show "X issues resolved" line in the summary** — Yes. Positive feedback for the author.
2. **Comment on resolved threads** — Yes. Post a short bot comment (e.g., "This issue appears to be fixed.") before resolving the thread.
3. **Thread pagination** — Yes, paginate GraphQL review thread queries.
4. **Hash collision risk** — Accepted. 8-char hex (32 bits) is fine for typical PR sizes (<100 issues).
