import * as core from "@actions/core";
import type { ActionConfig, ReviewRequest, ReviewResponse } from "./types.js";

const V1_TIMEOUT_MS = 300_000; // 5 minutes for multi-pass pipeline
const V2_TIMEOUT_MS = 300_000; // 5 minutes for agentic pipeline (multiple tool-use round-trips)

interface ApiError {
  error: string;
  message: string;
}

/**
 * Call the Reviso API with the review request payload.
 * Returns the parsed ReviewResponse on success.
 * Throws on unrecoverable errors (auth, malformed request, etc).
 */
export async function callRevisoApi(
  request: ReviewRequest,
  config: ActionConfig,
): Promise<ReviewResponse> {
  const url =
    config.review_engine === "v2"
      ? `${config.api_url}/v1/review/v2`
      : `${config.api_url}/v1/review`;

  core.info(`Calling Reviso API at ${config.api_url} (engine: ${config.review_engine})...`);
  core.info(
    `Sending ${request.files.length} files for review (depth: ${request.options.review_depth})`,
  );

  const timeoutMs = config.review_engine === "v2" ? V2_TIMEOUT_MS : V1_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.reviso_api_key}`,
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      let errorMessage: string;

      try {
        const errorData: ApiError = JSON.parse(body);
        errorMessage = errorData.message || errorData.error || body;
      } catch {
        errorMessage = body;
      }

      switch (response.status) {
        case 401:
          throw new Error(`Authentication failed: ${errorMessage}. Check your reviso_api_key.`);
        case 400:
          throw new Error(`Bad request: ${errorMessage}. Check your action inputs.`);
        case 429:
          throw new Error("Rate limited by Reviso API. Please try again later.");
        default:
          throw new Error(`Reviso API returned ${response.status}: ${errorMessage}`);
      }
    }

    const data = (await response.json()) as ReviewResponse;

    core.info(`Review complete: ${data.metrics.issues_found} issues found`);
    core.info(
      `Passes run: ${data.metrics.passes_run.join(", ")} | ` +
        `Estimated cost: $${data.metrics.estimated_cost_usd.toFixed(4)}`,
    );

    if (data.metrics.tool_calls != null) {
      core.info(
        `Tool calls: ${data.metrics.tool_calls} | ` +
          `Investigations: ${data.metrics.investigations ?? 0} | ` +
          `Discarded by confidence: ${data.metrics.discarded_by_confidence ?? 0}`,
      );
    }

    return data;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(
        `Reviso API request timed out after ${timeoutMs / 1000}s. The PR may be too large, or the API may be experiencing issues.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
