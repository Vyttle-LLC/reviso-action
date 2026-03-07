import * as core from "@actions/core";
import * as github from "@actions/github";
import type { ActionConfig, ReviewIssue, ReviewResponse, RevisoMeta, Severity } from "./types.js";

const SEVERITY_ORDER: Record<Severity, number> = { high: 3, medium: 2, low: 1 };
const SEVERITY_EMOJI: Record<Severity, string> = { high: "🔴", medium: "🟡", low: "🔵" };
const BOT_SIGNATURE = "<!-- reviso-review -->";
const META_REGEX = /<!-- reviso-meta:(.*?) -->/s;
const LAST_REVIEWED_SHA_REGEX = /<!-- reviso:last-reviewed-sha:([a-f0-9]+) -->/;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

// ── Rate Limit Handling ─────────────────────────────────────────

/**
 * Retry a GitHub API call with exponential backoff on rate limit (403/429).
 */
async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      const status = (error as { status?: number }).status;
      const isRateLimit = status === 403 || status === 429;

      if (!isRateLimit || attempt === MAX_RETRIES - 1) {
        throw error;
      }

      const delay = BASE_DELAY_MS * 2 ** attempt;
      core.warning(
        `Rate limited on ${label}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error(`Unreachable: ${label} retry loop exited without return or throw`);
}

// ── Severity Filtering ──────────────────────────────────────────

/**
 * Filter issues to only those at or above the configured severity threshold.
 */
export function filterBySeverity(issues: ReviewIssue[], threshold: Severity): ReviewIssue[] {
  const minLevel = SEVERITY_ORDER[threshold];
  return issues.filter((issue) => SEVERITY_ORDER[issue.severity] >= minLevel);
}

// ── Cost Metadata ──────────────────────────────────────────────

/**
 * Parse the reviso-meta JSON blob from a summary comment body.
 * Returns null if the metadata is missing or unparseable.
 */
export function parseRevisoMeta(commentBody: string): RevisoMeta | null {
  const match = commentBody.match(META_REGEX);
  if (!match?.[1]) return null;

  try {
    const parsed = JSON.parse(match[1]);

    // Basic shape validation
    if (!Array.isArray(parsed.reviews) || typeof parsed.total_cost !== "number") {
      return null;
    }

    return parsed as RevisoMeta;
  } catch {
    return null;
  }
}

/**
 * Serialize a RevisoMeta object into a hidden HTML comment string.
 */
export function serializeRevisoMeta(meta: RevisoMeta): string {
  return `<!-- reviso-meta:${JSON.stringify(meta)} -->`;
}

/**
 * Parse the last-reviewed SHA from a comment body.
 * Returns null if the marker is missing.
 */
export function parseLastReviewedSha(body: string): string | null {
  const match = body.match(LAST_REVIEWED_SHA_REGEX);
  return match?.[1] ?? null;
}

/**
 * Serialize a SHA into a hidden HTML comment marker.
 */
export function serializeLastReviewedSha(sha: string): string {
  return `<!-- reviso:last-reviewed-sha:${sha} -->`;
}

/**
 * Build a RevisoMeta by appending a new review entry to the previous meta.
 */
function buildUpdatedMeta(previous: RevisoMeta | null, reviewId: string, cost: number): RevisoMeta {
  const reviews = previous?.reviews ?? [];
  const entry = { id: reviewId, cost, timestamp: new Date().toISOString() };
  const updatedReviews = [...reviews, entry];
  const totalCost = updatedReviews.reduce((sum, r) => sum + r.cost, 0);

  return { reviews: updatedReviews, total_cost: totalCost };
}

// ── Comment Formatting ──────────────────────────────────────────

/**
 * Format a single issue as a markdown inline comment body.
 */
function formatIssueComment(issue: ReviewIssue): string {
  const emoji = SEVERITY_EMOJI[issue.severity];
  const header = `${emoji} **${issue.severity.toUpperCase()}** — ${issue.category}`;
  let body = `${header}\n\n${issue.message}`;

  if (issue.suggestion) {
    body += `\n\n**Suggestion:**\n\`\`\`\n${issue.suggestion}\n\`\`\``;
  }

  if (issue.confidence != null) {
    body += `\n\n<sub>Found by ${issue.model} (${issue.pass} pass) · confidence: ${(issue.confidence * 100).toFixed(0)}%</sub>`;
  } else {
    body += `\n\n<sub>Found by ${issue.model} (${issue.pass} pass)</sub>`;
  }

  return body;
}

/**
 * Build the summary comment body with metrics, cumulative cost, and issue overview.
 */
function formatSummaryComment(
  response: ReviewResponse,
  filteredCount: number,
  meta: RevisoMeta,
  headSha: string,
): string {
  const { metrics, summary } = response;

  const costLine =
    meta.reviews.length > 1
      ? `| Estimated cost | $${metrics.estimated_cost_usd.toFixed(4)} (this review) · $${meta.total_cost.toFixed(4)} total across ${meta.reviews.length} reviews |`
      : `| Estimated cost | $${metrics.estimated_cost_usd.toFixed(4)} |`;

  const lines = [
    "## 🔍 Reviso Code Review",
    "",
    summary,
    "",
    "### Metrics",
    "",
    "| Metric | Value |",
    "|--------|-------|",
    `| Files reviewed | ${metrics.files_reviewed} |`,
    `| Files skipped | ${metrics.files_skipped} |`,
    `| Issues found | ${metrics.issues_found} |`,
    `| High severity | ${metrics.high_severity_count} |`,
    `| Medium severity | ${metrics.medium_severity_count} |`,
    `| Low severity | ${metrics.low_severity_count} |`,
    `| Passes run | ${metrics.passes_run.join(", ")} |`,
    `| Models used | ${metrics.models_used.join(", ")} |`,
    costLine,
    // Agentic metrics (v2 only)
    ...(metrics.tool_calls != null
      ? [
          `| Tool calls | ${metrics.tool_calls} |`,
          `| Investigations | ${metrics.investigations ?? 0} |`,
          `| Discarded by confidence | ${metrics.discarded_by_confidence ?? 0} |`,
        ]
      : []),
  ];

  if (filteredCount < metrics.issues_found) {
    lines.push(
      "",
      `> **Note:** ${metrics.issues_found - filteredCount} issues below the severity threshold were omitted from inline comments.`,
    );
  }

  lines.push("", serializeLastReviewedSha(headSha), serializeRevisoMeta(meta), BOT_SIGNATURE);

  return lines.join("\n");
}

// ── Idempotency ─────────────────────────────────────────────────

/**
 * Minimize (collapse) a comment via GitHub's GraphQL API.
 * Falls back silently on failure so we don't block the review.
 */
async function minimizeComment(
  octokit: ReturnType<typeof github.getOctokit>,
  nodeId: string,
): Promise<boolean> {
  try {
    await octokit.graphql(
      `mutation MinimizeComment($id: ID!) {
        minimizeComment(input: { subjectId: $id, classifier: OUTDATED }) {
          minimizedComment { isMinimized }
        }
      }`,
      { id: nodeId },
    );
    return true;
  } catch (error) {
    core.warning(`Failed to minimize comment (node ${nodeId}): ${error}`);
    return false;
  }
}

/**
 * Find existing Reviso summary comments on the PR.
 * Returns the previous cost metadata and node IDs of all old summaries
 * so they can be minimized.
 */
export async function findExistingSummaries(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<{ previousMeta: RevisoMeta | null; nodeIds: string[]; lastReviewedSha: string | null }> {
  let previousMeta: RevisoMeta | null = null;
  let lastReviewedSha: string | null = null;
  const nodeIds: string[] = [];
  let page = 1;

  while (true) {
    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
      page,
    });

    if (comments.length === 0) break;

    for (const comment of comments) {
      if (comment.body?.includes(BOT_SIGNATURE)) {
        nodeIds.push(comment.node_id);

        const meta = parseRevisoMeta(comment.body);
        if (meta && meta.reviews.length > (previousMeta?.reviews.length ?? 0)) {
          previousMeta = meta;
          lastReviewedSha = parseLastReviewedSha(comment.body);
          core.debug(
            `Found summary comment #${comment.id} with ${meta.reviews.length} reviews, $${meta.total_cost.toFixed(4)} total`,
          );
        }
      }
    }

    if (comments.length < 100) break;
    page++;
  }

  return { previousMeta, nodeIds, lastReviewedSha };
}

/**
 * Delete all Reviso inline review comments on the PR.
 *
 * We identify Reviso review comments by finding reviews whose body contains
 * our bot signature, then deleting each comment belonging to those reviews.
 * GitHub doesn't allow deleting or dismissing COMMENT-type reviews themselves,
 * but we can delete their individual comments.
 */
async function deleteExistingReviewComments(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<void> {
  // Step 1: Find Reviso review IDs
  const { data: reviews } = await octokit.rest.pulls.listReviews({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  const revisoReviewIds = new Set<number>();
  for (const review of reviews) {
    if (review.body?.includes(BOT_SIGNATURE)) {
      revisoReviewIds.add(review.id);
    }
  }

  if (revisoReviewIds.size === 0) return;

  // Step 2: List all review comments and delete those belonging to Reviso reviews
  let page = 1;
  let deletedCount = 0;

  while (true) {
    const { data: comments } = await octokit.rest.pulls.listReviewComments({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
      page,
    });

    if (comments.length === 0) break;

    for (const comment of comments) {
      if (comment.pull_request_review_id && revisoReviewIds.has(comment.pull_request_review_id)) {
        await withRetry(
          () =>
            octokit.rest.pulls.deleteReviewComment({
              owner,
              repo,
              comment_id: comment.id,
            }),
          "delete review comment",
        );
        deletedCount++;
      }
    }

    if (comments.length < 100) break;
    page++;
  }

  if (deletedCount > 0) {
    core.debug(`Deleted ${deletedCount} previous Reviso inline comments.`);
  }
}

// ── Posting ─────────────────────────────────────────────────────

/**
 * Parse a diff patch to find valid comment positions.
 * Returns a map from line number → diff position (1-indexed offset in the patch).
 */
function buildPositionMap(patch: string): Map<number, number> {
  const map = new Map<number, number>();
  const lines = patch.split("\n");
  let position = 0;
  let lineNumber = 0;

  for (const line of lines) {
    // Hunk header: @@ -old,count +new,count @@
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunkMatch) {
      lineNumber = Number.parseInt(hunkMatch[1], 10) - 1;
      position++;
      continue;
    }

    position++;

    if (line.startsWith("+") || line.startsWith(" ")) {
      lineNumber++;
      map.set(lineNumber, position);
    }
    // Lines starting with '-' don't increment the new file line number
  }

  return map;
}

/**
 * Post the review: inline comments on specific lines + summary comment.
 */
export async function postReview(
  config: ActionConfig,
  prNumber: number,
  response: ReviewResponse,
  existingSummaries: { previousMeta: RevisoMeta | null; nodeIds: string[] },
  headSha: string,
): Promise<void> {
  const octokit = github.getOctokit(config.github_token);
  const { owner, repo } = github.context.repo;

  // ── Idempotency: use pre-computed summaries ──
  const { previousMeta, nodeIds: oldSummaryNodeIds } = existingSummaries;
  await deleteExistingReviewComments(octokit, owner, repo, prNumber);

  // Minimize (collapse) old summary comments so the new one is the visible one
  if (oldSummaryNodeIds.length > 0) {
    core.info(`Minimizing ${oldSummaryNodeIds.length} previous summary comment(s).`);
    for (const nodeId of oldSummaryNodeIds) {
      await minimizeComment(octokit, nodeId);
    }
  }

  // ── Build cumulative cost metadata ──
  const meta = buildUpdatedMeta(
    previousMeta,
    response.review_id,
    response.metrics.estimated_cost_usd,
  );
  core.info(
    `Cost: $${response.metrics.estimated_cost_usd.toFixed(4)} this review${meta.reviews.length > 1 ? ` · $${meta.total_cost.toFixed(4)} total (${meta.reviews.length} reviews)` : ""}`,
  );

  // ── Filter issues by severity threshold ──
  const filteredIssues = filterBySeverity(response.issues, config.severity_threshold);
  core.info(
    `Posting ${filteredIssues.length}/${response.issues.length} issues ` +
      `(threshold: ${config.severity_threshold})`,
  );

  // ── Build inline review comments ──
  // We need the diff patches to compute positions for inline comments.
  // Fetch them fresh since we need the patch to compute positions.
  const { data: prFiles } = await octokit.rest.pulls.listFiles({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  // Build position maps for each file
  const positionMaps = new Map<string, Map<number, number>>();
  for (const file of prFiles) {
    if (file.patch) {
      positionMaps.set(file.filename, buildPositionMap(file.patch));
    }
  }

  // Build the review comments array
  const comments: Array<{
    path: string;
    position: number;
    body: string;
  }> = [];

  const skippedIssues: ReviewIssue[] = [];

  for (const issue of filteredIssues) {
    const posMap = positionMaps.get(issue.file);
    const position = posMap?.get(issue.line);

    if (position) {
      comments.push({
        path: issue.file,
        position,
        body: formatIssueComment(issue),
      });
    } else {
      // Line isn't in the diff — can't post inline, will include in summary
      skippedIssues.push(issue);
      core.debug(
        `Issue at ${issue.file}:${issue.line} not in diff — will include in summary instead.`,
      );
    }
  }

  // ── Post the PR review with inline comments ──
  if (comments.length > 0) {
    try {
      await withRetry(
        () =>
          octokit.rest.pulls.createReview({
            owner,
            repo,
            pull_number: prNumber,
            event: "COMMENT",
            body: BOT_SIGNATURE,
            comments,
          }),
        "create review",
      );
      core.info(`Posted ${comments.length} inline review comments.`);
    } catch (error) {
      core.warning(`Failed to post inline comments: ${error}. Falling back to summary only.`);
      // Move all to skipped so they appear in summary
      skippedIssues.push(
        ...filteredIssues.filter((issue) => !skippedIssues.some((s) => s === issue)),
      );
    }
  }

  // ── Post summary comment ──
  let summaryBody = formatSummaryComment(response, filteredIssues.length, meta, headSha);

  // Append any issues that couldn't be posted inline
  if (skippedIssues.length > 0) {
    const skippedSection = [
      "",
      "### Issues not in diff (posted here instead)",
      "",
      ...skippedIssues.map(
        (issue) =>
          `- ${SEVERITY_EMOJI[issue.severity]} **${issue.file}:${issue.line}** — ${issue.message}`,
      ),
    ];
    // Insert before the bot signature
    summaryBody = summaryBody.replace(
      BOT_SIGNATURE,
      `${skippedSection.join("\n")}\n\n${BOT_SIGNATURE}`,
    );
  }

  await withRetry(
    () =>
      octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body: summaryBody,
      }),
    "create summary comment",
  );
  core.info("Posted review summary comment.");
}
