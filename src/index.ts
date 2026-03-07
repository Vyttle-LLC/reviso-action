import * as core from "@actions/core";
import { callRevisoApi } from "./api.js";
import { findExistingSummaries, postReview } from "./comments.js";
import { getConfig } from "./config.js";
import {
  getChangedFiles,
  getChangedFilesBetweenCommits,
  getPrMetadata,
  populateFileContents,
} from "./github.js";
import type { ReviewRequest } from "./types.js";

async function run(): Promise<void> {
  try {
    core.info("🔍 Reviso Action starting...");

    // ── Step 1: Read and validate inputs ──
    const config = getConfig();
    core.info(
      `Review depth: ${config.review_depth} | Severity threshold: ${config.severity_threshold}`,
    );

    // ── Step 2: Gather PR metadata ──
    const pr = getPrMetadata();
    core.info(`Reviewing PR #${pr.number}: ${pr.title}`);

    // ── Step 3: Fetch changed files and diffs ──
    const files = await getChangedFiles(config, pr.number);

    if (files.length === 0) {
      core.info("No reviewable files changed. Skipping review.");
      core.setOutput("issues_count", 0);
      core.setOutput("high_severity_count", 0);
      return;
    }

    core.info(`Found ${files.length} reviewable files`);

    // Fetch full file contents for context review (Pass 2)
    await populateFileContents(config, files, pr.head_ref);
    const filesWithContents = files.filter((f) => f.contents !== null).length;
    core.info(`Fetched full contents for ${filesWithContents}/${files.length} files`);

    // ── Step 3.5: Incremental review — only review files changed since last review ──
    const octokit = (await import("@actions/github")).getOctokit(config.github_token);
    const { owner, repo } = (await import("@actions/github")).context.repo;
    const existingSummaries = await findExistingSummaries(octokit, owner, repo, pr.number);

    let changedFiles: string[] | undefined;
    const prFilenames = files.map((f) => f.filename);

    if (existingSummaries.lastReviewedSha) {
      core.info(`Last reviewed SHA: ${existingSummaries.lastReviewedSha}`);
      const changedSince = await getChangedFilesBetweenCommits(
        config,
        existingSummaries.lastReviewedSha,
        pr.head_sha,
      );

      if (changedSince !== null) {
        const changedSet = new Set(changedSince);
        const intersected = prFilenames.filter((f) => changedSet.has(f));

        if (intersected.length === 0) {
          core.info("No files changed since last review. Skipping.");
          core.setOutput("issues_count", 0);
          core.setOutput("high_severity_count", 0);
          return;
        }

        if (intersected.length < files.length) {
          changedFiles = intersected;
          core.info(
            `Incremental review: ${intersected.length}/${files.length} files changed since last review.`,
          );
        } else {
          core.info("All PR files changed since last review — doing full review.");
        }
      } else {
        core.info("Could not compare commits — doing full review.");
      }
    } else {
      core.info("No previous review found — doing full review.");
    }

    // ── Step 4: Build the request payload ──
    const request: ReviewRequest = {
      pr,
      files,
      options: {
        review_depth: config.review_depth,
        severity_threshold: config.severity_threshold,
        custom_instructions: config.custom_instructions,
        max_files: config.max_files,
        ...(changedFiles ? { changed_files: changedFiles } : {}),
      },
      credentials: {
        anthropic_api_key: config.anthropic_api_key,
      },
    };

    // ── Step 5: Call the Reviso API ──
    const response = await callRevisoApi(request, config);

    // ── Step 6: Log summary ──
    core.info("\n📊 Review Summary:");
    core.info(response.summary);
    core.info(
      `  Files reviewed: ${response.metrics.files_reviewed} | ` +
        `Skipped: ${response.metrics.files_skipped}`,
    );
    core.info(
      `  Issues: ${response.metrics.issues_found} ` +
        `(${response.metrics.high_severity_count} high, ` +
        `${response.metrics.medium_severity_count} medium, ` +
        `${response.metrics.low_severity_count} low)`,
    );

    // ── Step 7: Set outputs ──
    core.setOutput("issues_count", response.metrics.issues_found);
    core.setOutput("high_severity_count", response.metrics.high_severity_count);

    // ── Step 8: Post review comments on PR ──
    await postReview(config, pr.number, response, existingSummaries, pr.head_sha);

    core.info("✅ Reviso Action completed.");
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed("An unexpected error occurred");
    }
  }
}

run();
