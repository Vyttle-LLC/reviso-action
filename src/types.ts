// ── Enums / Unions ──────────────────────────────────────────────

export type ReviewDepth = "quick" | "auto" | "thorough";
export type Severity = "high" | "medium" | "low";
export type IssueCategory =
  | "security"
  | "bug"
  | "error-handling"
  | "performance"
  | "maintainability"
  | "best-practice"
  | "architecture";
export type FileStatus = "added" | "modified" | "removed" | "renamed";
export type ReviewPass = "diff" | "context";

// ── Request Types ───────────────────────────────────────────────

export interface PrMetadata {
  number: number;
  title: string;
  description: string;
  author: string;
  base_ref: string;
  head_ref: string;
  repo: string;
}

export interface FileInfo {
  filename: string;
  status: FileStatus;
  patch: string;
  contents: string | null;
  additions: number;
  deletions: number;
}

export interface ReviewOptions {
  review_depth: ReviewDepth;
  severity_threshold: Severity;
  custom_instructions: string;
  max_files: number;
}

export interface ReviewCredentials {
  anthropic_api_key: string;
}

export interface ReviewRequest {
  pr: PrMetadata;
  files: FileInfo[];
  options: ReviewOptions;
  credentials: ReviewCredentials;
}

// ── Response Types ──────────────────────────────────────────────

export interface ReviewIssue {
  file: string;
  line: number;
  severity: Severity;
  category: IssueCategory;
  message: string;
  suggestion: string | null;
  pass: ReviewPass;
  model: string;
}

export interface ReviewMetrics {
  files_reviewed: number;
  files_skipped: number;
  issues_found: number;
  high_severity_count: number;
  medium_severity_count: number;
  low_severity_count: number;
  passes_run: ReviewPass[];
  models_used: string[];
  estimated_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
}

export interface ReviewResponse {
  review_id: string;
  summary: string;
  issues: ReviewIssue[];
  metrics: ReviewMetrics;
}

// ── Cost Tracking ──────────────────────────────────────────────

export interface ReviewCostEntry {
  id: string;
  cost: number;
  timestamp: string;
}

export interface RevisoMeta {
  reviews: ReviewCostEntry[];
  total_cost: number;
}

// ── Config ──────────────────────────────────────────────────────

export interface ActionConfig {
  reviso_api_key: string;
  anthropic_api_key: string;
  review_depth: ReviewDepth;
  severity_threshold: Severity;
  custom_instructions: string;
  max_files: number;
  api_url: string;
  github_token: string;
}
