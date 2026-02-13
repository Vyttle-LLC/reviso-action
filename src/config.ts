import * as core from "@actions/core";
import type { ActionConfig, ReviewDepth, Severity } from "./types.js";

const VALID_REVIEW_DEPTHS: ReviewDepth[] = ["quick", "auto", "thorough"];
const VALID_SEVERITIES: Severity[] = ["high", "medium", "low"];

export function getConfig(): ActionConfig {
  const reviso_api_key = core.getInput("reviso_api_key", { required: true });
  const anthropic_api_key = core.getInput("anthropic_api_key", { required: true });
  const github_token = core.getInput("github_token") || process.env.GITHUB_TOKEN || "";

  // Review depth
  const review_depth = core.getInput("review_depth") || "auto";
  if (!VALID_REVIEW_DEPTHS.includes(review_depth as ReviewDepth)) {
    throw new Error(
      `Invalid review_depth "${review_depth}". Must be one of: ${VALID_REVIEW_DEPTHS.join(", ")}`,
    );
  }

  // Severity threshold
  const severity_threshold = core.getInput("severity_threshold") || "low";
  if (!VALID_SEVERITIES.includes(severity_threshold as Severity)) {
    throw new Error(
      `Invalid severity_threshold "${severity_threshold}". Must be one of: ${VALID_SEVERITIES.join(", ")}`,
    );
  }

  // Max files
  const max_files_raw = core.getInput("max_files") || "20";
  const max_files = Number.parseInt(max_files_raw, 10);
  if (Number.isNaN(max_files) || max_files < 1) {
    throw new Error(`Invalid max_files "${max_files_raw}". Must be a positive integer.`);
  }

  const custom_instructions = core.getInput("custom_instructions") || "";
  const api_url = core.getInput("api_url") || "https://api.reviso.dev";

  return {
    reviso_api_key,
    anthropic_api_key,
    review_depth: review_depth as ReviewDepth,
    severity_threshold: severity_threshold as Severity,
    custom_instructions,
    max_files,
    api_url: api_url.replace(/\/$/, ""), // strip trailing slash
    github_token,
  };
}
