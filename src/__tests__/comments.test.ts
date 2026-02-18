import { describe, expect, it } from "vitest";
import { filterBySeverity, parseRevisoMeta, serializeRevisoMeta } from "../comments.js";
import type { RevisoMeta } from "../types.js";
import { sampleIssues } from "./fixtures.js";

describe("filterBySeverity", () => {
  it("returns all issues when threshold is low", () => {
    const result = filterBySeverity(sampleIssues, "low");
    expect(result).toHaveLength(5);
  });

  it("filters out low severity when threshold is medium", () => {
    const result = filterBySeverity(sampleIssues, "medium");
    expect(result).toHaveLength(3);
    expect(result.every((i) => i.severity !== "low")).toBe(true);
  });

  it("returns only high severity when threshold is high", () => {
    const result = filterBySeverity(sampleIssues, "high");
    expect(result).toHaveLength(2);
    expect(result.every((i) => i.severity === "high")).toBe(true);
  });

  it("returns empty array when no issues match", () => {
    const lowOnly = sampleIssues.filter((i) => i.severity === "low");
    const result = filterBySeverity(lowOnly, "high");
    expect(result).toHaveLength(0);
  });

  it("returns empty array for empty input", () => {
    const result = filterBySeverity([], "low");
    expect(result).toHaveLength(0);
  });
});

describe("parseRevisoMeta", () => {
  const sampleMeta: RevisoMeta = {
    reviews: [
      { id: "rev_abc", cost: 0.065, timestamp: "2026-02-16T10:00:00Z" },
      { id: "rev_def", cost: 0.042, timestamp: "2026-02-16T12:00:00Z" },
    ],
    total_cost: 0.107,
  };

  it("parses valid metadata from a comment body", () => {
    const body = `Some markdown content\n${serializeRevisoMeta(sampleMeta)}\n<!-- reviso-review -->`;
    const result = parseRevisoMeta(body);
    expect(result).toEqual(sampleMeta);
  });

  it("returns null when no metadata is present", () => {
    const body = "Just a regular comment\n<!-- reviso-review -->";
    expect(parseRevisoMeta(body)).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    const body = "<!-- reviso-meta:{not valid json} -->\n<!-- reviso-review -->";
    expect(parseRevisoMeta(body)).toBeNull();
  });

  it("returns null when reviews is not an array", () => {
    const body = '<!-- reviso-meta:{"reviews":"bad","total_cost":0} -->\n<!-- reviso-review -->';
    expect(parseRevisoMeta(body)).toBeNull();
  });

  it("returns null when total_cost is not a number", () => {
    const body = '<!-- reviso-meta:{"reviews":[],"total_cost":"bad"} -->\n<!-- reviso-review -->';
    expect(parseRevisoMeta(body)).toBeNull();
  });
});

describe("serializeRevisoMeta", () => {
  it("round-trips through parse", () => {
    const meta: RevisoMeta = {
      reviews: [{ id: "rev_123", cost: 0.05, timestamp: "2026-02-16T10:00:00Z" }],
      total_cost: 0.05,
    };
    const serialized = serializeRevisoMeta(meta);
    const parsed = parseRevisoMeta(serialized);
    expect(parsed).toEqual(meta);
  });

  it("produces a hidden HTML comment", () => {
    const meta: RevisoMeta = { reviews: [], total_cost: 0 };
    const result = serializeRevisoMeta(meta);
    expect(result).toMatch(/^<!-- reviso-meta:.*-->$/);
  });
});
