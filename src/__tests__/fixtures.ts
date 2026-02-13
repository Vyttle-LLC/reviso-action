import type { ReviewIssue, ReviewMetrics, ReviewResponse } from "../types.js";

export const sampleIssues: ReviewIssue[] = [
  {
    file: "src/auth.ts",
    line: 23,
    severity: "high",
    category: "security",
    message: "JWT secret is hardcoded. Move to environment variable.",
    suggestion: "const secret = process.env.JWT_SECRET;",
    pass: "diff",
    model: "haiku-4.5",
  },
  {
    file: "src/auth.ts",
    line: 38,
    severity: "medium",
    category: "error-handling",
    message: "Token verification has no try/catch.",
    suggestion: null,
    pass: "diff",
    model: "haiku-4.5",
  },
  {
    file: "src/auth.ts",
    line: 1,
    severity: "low",
    category: "best-practice",
    message: "Consider using middleware pattern for consistency.",
    suggestion: null,
    pass: "context",
    model: "sonnet-4.5",
  },
  {
    file: "src/db.ts",
    line: 15,
    severity: "high",
    category: "bug",
    message: "SQL injection vulnerability via string concatenation.",
    suggestion: "Use parameterized queries instead.",
    pass: "diff",
    model: "haiku-4.5",
  },
  {
    file: "src/utils.ts",
    line: 5,
    severity: "low",
    category: "maintainability",
    message: "Consider extracting this into a helper function.",
    suggestion: null,
    pass: "diff",
    model: "haiku-4.5",
  },
];

export const sampleMetrics: ReviewMetrics = {
  files_reviewed: 3,
  files_skipped: 1,
  issues_found: 5,
  high_severity_count: 2,
  medium_severity_count: 1,
  low_severity_count: 2,
  passes_run: ["diff", "context"],
  models_used: ["haiku-4.5", "sonnet-4.5"],
  estimated_cost_usd: 0.065,
  total_input_tokens: 12400,
  total_output_tokens: 3200,
};

export const sampleResponse: ReviewResponse = {
  review_id: "rev_test123",
  summary:
    "Found 5 issues across 2 passes. Security vulnerabilities and missing error handling detected.",
  issues: sampleIssues,
  metrics: sampleMetrics,
};
