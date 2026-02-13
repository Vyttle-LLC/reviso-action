# Reviso — AI Code Review

A GitHub Action that sends PR diffs to the Reviso API for AI-powered, multi-pass code review using Claude.

## How it works

1. When a PR is opened or updated, the action collects the changed files and diffs
2. It sends them to the Reviso API along with your Anthropic API key
3. The API runs a multi-pass review pipeline:
   - **Pass 1 (Haiku):** Fast, line-level review of the diff for bugs, security issues, and error handling
   - **Pass 2 (Sonnet):** Deeper context review of full files for architecture, patterns, and cross-file implications (conditionally triggered)
4. The action posts the results as inline PR comments and a summary

## Quick Start

```yaml
# .github/workflows/reviso.yml
name: Reviso Code Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: Vyttle-LLC/reviso-action@v1
        with:
          reviso_api_key: ${{ secrets.REVISO_API_KEY }}
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `reviso_api_key` | Yes | — | API key for authenticating with the Reviso API |
| `anthropic_api_key` | Yes | — | Your Anthropic API key (used by Reviso to call Claude) |
| `github_token` | No | `${{ github.token }}` | GitHub token for reading PR data and posting comments |
| `review_depth` | No | `auto` | Review depth: `quick`, `auto`, or `thorough` |
| `severity_threshold` | No | `low` | Minimum severity to post: `high`, `medium`, or `low` |
| `custom_instructions` | No | `""` | Additional instructions for the review prompt |
| `max_files` | No | `20` | Maximum number of files to include in the review |
| `api_url` | No | `https://api.reviso.dev` | Reviso API base URL (for self-hosted or testing) |

## Outputs

| Output | Description |
|--------|-------------|
| `issues_count` | Total number of issues found |
| `high_severity_count` | Number of high-severity issues found |

## Review Depth

| Depth | What runs | When to use |
|-------|-----------|-------------|
| `quick` | Haiku diff review only | Fast feedback, small changes |
| `auto` | Haiku always, Sonnet when warranted | Default — balances speed and thoroughness |
| `thorough` | Both Haiku and Sonnet always | Critical PRs, security-sensitive changes |

**Auto mode** triggers the Sonnet context review when:
- More than 5 files are changed
- The diff exceeds ~10K tokens
- Changed files touch auth, security, payments, or infrastructure
- File types include migrations, configs, or CI/CD

## Severity Levels

| Severity | Description |
|----------|-------------|
| `high` | Likely bugs, security vulnerabilities, or data loss risks |
| `medium` | Could cause problems under certain conditions, or impacts maintainability |
| `low` | Style, convention, or minor improvement suggestions |

## Issue Categories

`security` · `bug` · `error-handling` · `performance` · `maintainability` · `best-practice` · `architecture`

## Cost Estimate

Reviews use **your own Anthropic API key**. Typical costs:

| PR Size | Est. Cost |
|---------|-----------|
| Small (1–2 files) | ~$0.01 |
| Medium (3–8 files) | ~$0.02 |
| Medium + context review | ~$0.06 |
| Large (10–20 files) | ~$0.10–0.15 |

## Advanced Configuration

### Only post high-severity issues

```yaml
- uses: Vyttle-LLC/reviso-action@v1
  with:
    reviso_api_key: ${{ secrets.REVISO_API_KEY }}
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    severity_threshold: high
```

### Thorough review with custom instructions

```yaml
- uses: Vyttle-LLC/reviso-action@v1
  with:
    reviso_api_key: ${{ secrets.REVISO_API_KEY }}
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    review_depth: thorough
    custom_instructions: "This is a financial application. Pay extra attention to data validation and auth flows."
```

### Fail the workflow on high-severity issues

```yaml
- uses: Vyttle-LLC/reviso-action@v1
  id: review
  with:
    reviso_api_key: ${{ secrets.REVISO_API_KEY }}
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}

- name: Check for critical issues
  if: steps.review.outputs.high_severity_count > 0
  run: |
    echo "::error::Reviso found ${{ steps.review.outputs.high_severity_count }} high-severity issues"
    exit 1
```

## License

MIT
