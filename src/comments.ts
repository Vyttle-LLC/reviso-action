import * as core from "@actions/core";
import * as github from "@actions/github";
import type { ActionConfig, ReviewIssue, ReviewResponse, RevisoMeta, Severity } from "./types.js";

const SEVERITY_ORDER: Record<Severity, number> = { high: 3, medium: 2, low: 1 };
const SEVERITY_EMOJI: Record<Severity, string> = { high: "🔴", medium: "🟡", low: "🔵" };
const BOT_SIGNATURE = "<!-- reviso-review -->";
const META_REGEX = /<!-- reviso-meta:(.*?) -->/s;
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

  body += `\n\n<sub>Found by ${issue.model} (${issue.pass} pass)</sub>`;

  return body;
}

/**
 * Build the summary comment body with metrics, cumulative cost, and issue overview.
 */
function formatSummaryComment(
  response: ReviewResponse,
  filteredCount: number,
  meta: RevisoMeta,
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
  ];

  if (filteredCount < metrics.issues_found) {
    lines.push(
      "",
      `> **Note:** ${metrics.issues_found - filteredCount} issues below the severity threshold were omitted from inline comments.`,
    );
  }

  lines.push("", serializeRevisoMeta(meta), BOT_SIGNATURE);

  return lines.join("\n");
}

// ── Idempotency ─────────────────────────────────────────────────

/**
 * Find and delete any existing Reviso summary comments on the PR.
 * Extracts cost metadata from the most recent summary before deleting.
 * Returns the previous meta (if any) and whether a previous comment existed.
 */
async function deleteExistingSummary(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<{ hadPrevious: boolean; previousMeta: RevisoMeta | null }> {
  let hadPrevious = false;
  let previousMeta: RevisoMeta | null = null;
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
        // Extract cost metadata before deleting (use the latest one found)
        const meta = parseRevisoMeta(comment.body);
        if (meta) {
          previousMeta = meta;
          core.debug(
            `Extracted cost metadata: ${meta.reviews.length} previous reviews, $${meta.total_cost.toFixed(4)} total`,
          );
        }

        await withRetry(
          () => octokit.rest.issues.deleteComment({ owner, repo, comment_id: comment.id }),
          "delete comment",
        );
        hadPrevious = true;
        core.debug(`Deleted previous Reviso summary comment #${comment.id}`);
      }
    }

    if (comments.length < 100) break;
    page++;
  }

  return { hadPrevious, previousMeta };
}

/**
 * Delete any existing Reviso PR review (inline comments) on the PR.
 */
async function deleteExistingReviews(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<void> {
  const { data: reviews } = await octokit.rest.pulls.listReviews({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  for (const review of reviews) {
    // Check if this review's body contains our signature
    if (review.body?.includes(BOT_SIGNATURE)) {
      // We can't delete reviews, but we can dismiss them
      try {
        await octokit.rest.pulls.dismissReview({
          owner,
          repo,
          pull_number: prNumber,
          review_id: review.id,
          message: "Replaced by a new Reviso review.",
        });
        core.debug(`Dismissed previous Reviso review #${review.id}`);
      } catch {
        // Dismissal may fail if the review isn't approved/changes_requested
        core.debug(`Could not dismiss review #${review.id} — may be a COMMENT review`);
      }
    }
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
): Promise<void> {
  const octokit = github.getOctokit(config.github_token);
  const { owner, repo } = github.context.repo;

  // ── Idempotency: clean up previous Reviso comments + extract cost meta ──
  const { hadPrevious, previousMeta } = await deleteExistingSummary(octokit, owner, repo, prNumber);
  await deleteExistingReviews(octokit, owner, repo, prNumber);

  if (hadPrevious) {
    core.info("Replaced previous Reviso review (re-run detected).");
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
  let summaryBody = formatSummaryComment(response, filteredIssues.length, meta);

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
