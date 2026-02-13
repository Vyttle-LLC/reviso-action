import * as core from "@actions/core";

async function run(): Promise<void> {
  try {
    core.info("Reviso Action starting...");

    // TODO: Phase 1 — gather PR metadata, fetch diffs, call API
    // TODO: Phase 2 — post review comments on PR

    core.info("Reviso Action completed.");
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed("An unexpected error occurred");
    }
  }
}

run();
