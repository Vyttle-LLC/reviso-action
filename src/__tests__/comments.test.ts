import { describe, expect, it } from "vitest";
import { filterBySeverity } from "../comments.js";
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
