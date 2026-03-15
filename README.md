# Fidensa Certification Check

A GitHub Action that checks [Fidensa](https://fidensa.com) certification status for AI capabilities (MCP servers, skills, rules files) in your CI/CD pipeline.

Fail or warn your build if a dependency's certification is missing, expired, suspended, or below your trust threshold.

## Quick Start

```yaml
- uses: fidensa/check-certification@v1
  with:
    capabilities: |
      mcp-server-filesystem
      mcp-server-everything
```

## Usage

### Inline capabilities list

```yaml
name: CI
on: [push, pull_request]

jobs:
  check-trust:
    runs-on: ubuntu-latest
    steps:
      - uses: fidensa/check-certification@v1
        with:
          capabilities: |
            mcp-server-filesystem
            mcp-server-everything
            docx-skill
```

### Config file (.fidensa.yml)

Create a `.fidensa.yml` in your repo root:

```yaml
capabilities:
  - mcp-server-filesystem
  - mcp-server-everything
  - docx-skill
```

Then reference it (or rely on the default path):

```yaml
- uses: fidensa/check-certification@v1
```

### With policy enforcement

```yaml
- uses: fidensa/check-certification@v1
  with:
    capabilities: mcp-server-filesystem, mcp-server-everything
    fail-on: suspended,revoked,expired,missing
    min-score: 70
    min-tier: verified
```

### Warn-only mode (don't fail the build)

```yaml
- uses: fidensa/check-certification@v1
  with:
    capabilities: mcp-server-filesystem
    warn-only: true
```

### Using outputs in subsequent steps

```yaml
- uses: fidensa/check-certification@v1
  id: fidensa
  with:
    capabilities: mcp-server-filesystem

- run: echo "Passed: ${{ steps.fidensa.outputs.passed }}"

- if: steps.fidensa.outputs.passed == 'false'
  run: echo "Some capabilities failed certification checks"
```

## Inputs

| Input | Description | Default |
|-------|-------------|---------|
| `capabilities` | Newline or comma-separated capability IDs | — |
| `config` | Path to `.fidensa.yml` config file | `.fidensa.yml` |
| `fail-on` | Statuses that cause failure (`suspended`, `revoked`, `expired`, `missing`) | `suspended,revoked` |
| `min-score` | Minimum trust score (0–100) | `0` |
| `min-tier` | Minimum tier (`evaluated`, `verified`, `certified`) | — |
| `warn-only` | Log warnings without failing | `false` |
| `api-url` | Fidensa API base URL | `https://fidensa.com` |

## Outputs

| Output | Description |
|--------|-------------|
| `passed` | `true` if all checks passed, `false` otherwise |
| `results` | JSON array of per-capability results |

## Policy Levels

Match your policy to your risk tolerance:

**Permissive** — only block actively problematic certifications:
```yaml
fail-on: suspended,revoked
```

**Standard** — also block expired and uncertified capabilities:
```yaml
fail-on: suspended,revoked,expired,missing
min-score: 60
```

**Strict** — require Certified tier with a high trust score:
```yaml
fail-on: suspended,revoked,expired,missing
min-score: 80
min-tier: certified
```

## Job Summary

The action writes a Markdown summary to the GitHub Actions job summary, showing a table of all checked capabilities with their status, score, grade, tier, and pass/fail result. Any violations are listed with details.

## How It Works

1. Reads capability IDs from the `capabilities` input or a `.fidensa.yml` config file
2. Queries the [Fidensa attestation API](https://fidensa.com/docs/api) for each capability (Open tier, no API key required)
3. Evaluates each response against your configured policy (fail-on statuses, minimum score, minimum tier)
4. Writes results to the job summary and sets outputs
5. Exits with code 1 if any capability fails policy checks (unless `warn-only` is true)

## No API Key Required

This action uses the Fidensa attestation endpoint, which is part of the Open tier — free and permanently available with no authentication. Basic trust checks should never be gated behind a paywall.

## Links

- [Fidensa](https://fidensa.com) — Independent AI certification authority
- [Certification Catalog](https://fidensa.com/certifications) — Browse all certifications
- [API Documentation](https://fidensa.com/docs/api) — Full API reference
- [@fidensa/mcp-server](https://www.npmjs.com/package/@fidensa/mcp-server) — MCP server for agent-native trust checks

## License

MIT
