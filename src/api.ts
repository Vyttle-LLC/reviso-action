import * as core from "@actions/core";
import type { ActionConfig, ReviewRequest, ReviewResponse } from "./types.js";

const REQUEST_TIMEOUT_MS = 120_000; // 2 minutes — reviews can take a while

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
  const url = `${config.api_url}/v1/review`;

  core.info(`Calling Reviso API at ${config.api_url}...`);
  core.info(
    `Sending ${request.files.length} files for review (depth: ${request.options.review_depth})`,
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

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

    return data;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(
        `Reviso API request timed out after ${REQUEST_TIMEOUT_MS / 1000}s. The PR may be too large, or the API may be experiencing issues.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
