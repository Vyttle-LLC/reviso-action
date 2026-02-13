import * as core from "@actions/core";
import * as github from "@actions/github";
import type { ActionConfig, FileInfo, FileStatus, PrMetadata } from "./types.js";

// Binary file extensions to skip
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".svg",
  ".webp",
  ".bmp",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
  ".zip",
  ".tar",
  ".gz",
  ".pdf",
  ".mp4",
  ".mp3",
  ".mov",
  ".avi",
  ".lock",
]);

function isBinary(filename: string): boolean {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * Extract PR metadata from the GitHub Actions context.
 */
export function getPrMetadata(): PrMetadata {
  const { context } = github;
  const pr = context.payload.pull_request;

  if (!pr) {
    throw new Error("This action must be triggered by a pull_request event.");
  }

  return {
    number: pr.number,
    title: pr.title ?? "",
    description: pr.body ?? "",
    author: pr.user?.login ?? "",
    base_ref: pr.base?.ref ?? "",
    head_ref: pr.head?.ref ?? "",
    repo: `${context.repo.owner}/${context.repo.repo}`,
  };
}

/**
 * Fetch the list of changed files with their patches from the PR.
 * Handles pagination for PRs with > 100 files.
 */
export async function getChangedFiles(config: ActionConfig, prNumber: number): Promise<FileInfo[]> {
  const octokit = github.getOctokit(config.github_token);
  const { owner, repo } = github.context.repo;

  const allFiles: FileInfo[] = [];
  let page = 1;

  while (true) {
    const { data: files } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
      page,
    });

    if (files.length === 0) break;

    for (const file of files) {
      // Skip binary files
      if (isBinary(file.filename)) {
        core.debug(`Skipping binary file: ${file.filename}`);
        continue;
      }

      // Skip files with no patch (e.g., binary files GitHub couldn't diff)
      if (!file.patch) {
        core.debug(`Skipping file with no patch: ${file.filename}`);
        continue;
      }

      allFiles.push({
        filename: file.filename,
        status: (file.status as FileStatus) ?? "modified",
        patch: file.patch,
        contents: null, // populated separately
        additions: file.additions,
        deletions: file.deletions,
      });
    }

    if (files.length < 100) break;
    page++;
  }

  // Sort by total changes (descending) and take top max_files
  allFiles.sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));

  if (allFiles.length > config.max_files) {
    core.warning(
      `PR has ${allFiles.length} changed files, limiting to ${config.max_files}. ` +
        `Skipping ${allFiles.length - config.max_files} files with fewer changes.`,
    );
    return allFiles.slice(0, config.max_files);
  }

  return allFiles;
}

/**
 * Fetch full file contents for each file (used by Pass 2 context review).
 * Only fetches for non-deleted files. Mutates the files array in place.
 */
export async function populateFileContents(
  config: ActionConfig,
  files: FileInfo[],
  headRef: string,
): Promise<void> {
  const octokit = github.getOctokit(config.github_token);
  const { owner, repo } = github.context.repo;

  const fetchPromises = files.map(async (file) => {
    // Don't fetch contents for deleted files
    if (file.status === "removed") {
      return;
    }

    try {
      const { data } = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: file.filename,
        ref: headRef,
      });

      // getContent returns file data with content field when it's a file (not a directory)
      if ("content" in data && typeof data.content === "string") {
        file.contents = Buffer.from(data.content, "base64").toString("utf-8");
      }
    } catch (error) {
      core.debug(`Could not fetch contents for ${file.filename}: ${error}`);
      // Non-fatal — Pass 2 will work with reduced context
    }
  });

  await Promise.all(fetchPromises);
}
