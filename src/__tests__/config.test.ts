import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getConfig } from "../config.js";

// Mock @actions/core by setting INPUT_ env vars (how GitHub Actions passes inputs)
function setInput(name: string, value: string) {
  process.env[`INPUT_${name.toUpperCase()}`] = value;
}

function clearEnvVar(key: string) {
  Reflect.deleteProperty(process.env, key);
}

function clearInputs() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("INPUT_")) {
      clearEnvVar(key);
    }
  }
  clearEnvVar("GITHUB_TOKEN");
}

describe("getConfig", () => {
  beforeEach(() => {
    clearInputs();
    // Set required inputs
    setInput("reviso_api_key", "rev_sk_test123");
    setInput("anthropic_api_key", "sk-ant-test123");
    setInput("github_token", "ghp_test123");
  });

  afterEach(() => {
    clearInputs();
  });

  it("reads required inputs", () => {
    const config = getConfig();
    expect(config.reviso_api_key).toBe("rev_sk_test123");
    expect(config.anthropic_api_key).toBe("sk-ant-test123");
  });

  it("uses defaults for optional inputs", () => {
    const config = getConfig();
    expect(config.review_depth).toBe("auto");
    expect(config.severity_threshold).toBe("low");
    expect(config.max_files).toBe(20);
    expect(config.custom_instructions).toBe("");
    expect(config.api_url).toBe("https://api.reviso.dev");
  });

  it("reads custom optional inputs", () => {
    setInput("review_depth", "thorough");
    setInput("severity_threshold", "high");
    setInput("max_files", "10");
    setInput("custom_instructions", "Focus on security");
    setInput("api_url", "https://custom.api.dev/");

    const config = getConfig();
    expect(config.review_depth).toBe("thorough");
    expect(config.severity_threshold).toBe("high");
    expect(config.max_files).toBe(10);
    expect(config.custom_instructions).toBe("Focus on security");
    expect(config.api_url).toBe("https://custom.api.dev"); // trailing slash stripped
  });

  it("throws on invalid review_depth", () => {
    setInput("review_depth", "invalid");
    expect(() => getConfig()).toThrow('Invalid review_depth "invalid"');
  });

  it("throws on invalid severity_threshold", () => {
    setInput("severity_threshold", "critical");
    expect(() => getConfig()).toThrow('Invalid severity_threshold "critical"');
  });

  it("throws on invalid max_files", () => {
    setInput("max_files", "abc");
    expect(() => getConfig()).toThrow('Invalid max_files "abc"');
  });

  it("throws on zero max_files", () => {
    setInput("max_files", "0");
    expect(() => getConfig()).toThrow('Invalid max_files "0"');
  });

  it("throws on negative max_files", () => {
    setInput("max_files", "-5");
    expect(() => getConfig()).toThrow('Invalid max_files "-5"');
  });

  it("falls back to GITHUB_TOKEN env var", () => {
    // Clear the input version
    clearEnvVar("INPUT_GITHUB_TOKEN");
    process.env.GITHUB_TOKEN = "ghp_env_token";

    const config = getConfig();
    expect(config.github_token).toBe("ghp_env_token");
  });
});
