/**
 * Core certification check logic.
 *
 * Pure functions with no side effects or framework dependencies.
 * The fetch function is injected for testability.
 */

// ── Tier ordering ───────────────────────────────────────────────────

const TIER_LEVELS = {
  evaluated: 1,
  verified: 2,
  certified: 3,
};

/**
 * Convert a tier string to a numeric level for comparison.
 * Returns 0 for unknown or null tiers.
 */
export function tierLevel(tier) {
  if (!tier) return 0;
  return TIER_LEVELS[tier.toLowerCase()] || 0;
}

// ── Input parsing ───────────────────────────────────────────────────

/**
 * Parse a capabilities list from a string.
 * Supports newline-separated and comma-separated formats.
 * Trims whitespace and filters empty entries.
 */
export function parseCapabilitiesList(input) {
  if (!input || !input.trim()) return [];

  // Split on newlines or commas
  const items = input.split(/[\n\r,]+/);

  return items.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Parse a .fidensa.yml config file.
 * Supports a simple YAML subset — no full parser dependency needed.
 * Format:
 *   capabilities:
 *     - mcp-server-everything
 *     - mcp-server-filesystem
 */
export function parseConfigFile(content) {
  const capabilities = [];
  let inCapabilities = false;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    if (trimmed === 'capabilities:') {
      inCapabilities = true;
      continue;
    }

    if (inCapabilities) {
      if (trimmed.startsWith('- ')) {
        capabilities.push(trimmed.slice(2).trim());
      } else if (trimmed.length > 0 && !trimmed.startsWith('#')) {
        // Non-list item, non-comment — end of capabilities block
        inCapabilities = false;
      }
    }
  }

  return capabilities;
}

// ── Single capability evaluation ────────────────────────────────────

/**
 * Evaluate a single attestation response against a policy.
 *
 * @param {object} attestation - Attestation response (or a not_found / error stub)
 * @param {object} policy - { fail_on: string[], min_score: number, min_tier: string|null }
 * @returns {{ capability_id, status, trust_score, grade, tier, passed, violations }}
 */
export function evaluateCapability(attestation, policy) {
  const violations = [];
  const capId = attestation.capability_id || 'unknown';
  const status = attestation.status || 'unknown';
  const trustScore = attestation.trust_score ?? null;
  const grade = attestation.grade ?? null;
  const tier = attestation.tier ?? null;

  // Check status-based failures
  if (status === 'not_found' && policy.fail_on.includes('missing')) {
    violations.push('Capability is not certified by Fidensa');
  } else if (status === 'error' && policy.fail_on.includes('missing')) {
    violations.push(`Network error checking certification: ${attestation.error_message || 'unknown'}`);
  } else if (status !== 'not_found' && status !== 'error') {
    // Check status against fail_on list
    if (policy.fail_on.includes(status)) {
      violations.push(`Status is ${status}`);
    }

    // Check minimum score
    if (policy.min_score > 0 && trustScore != null && trustScore < policy.min_score) {
      violations.push(
        `Trust score ${trustScore} is below minimum ${policy.min_score}`,
      );
    }

    // Check minimum tier
    if (policy.min_tier && tierLevel(tier) < tierLevel(policy.min_tier)) {
      violations.push(
        `Tier "${tier || 'none'}" is below minimum "${policy.min_tier}"`,
      );
    }
  }

  return {
    capability_id: capId,
    status,
    trust_score: trustScore,
    grade,
    tier,
    passed: violations.length === 0,
    violations,
  };
}

// ── Multi-capability check orchestration ────────────────────────────

/**
 * Check multiple capabilities against a policy.
 *
 * @param {string[]} capabilities - Array of capability IDs
 * @param {object} policy - Policy configuration
 * @param {string} baseUrl - Fidensa API base URL
 * @param {Function} fetchFn - Fetch function (injected for testability)
 * @returns {{ passed: boolean, results: object[] }}
 */
export async function checkCapabilities(capabilities, policy, baseUrl, fetchFn) {
  // Deduplicate, trim, filter empties
  const unique = [...new Set(capabilities.map((c) => c.trim()).filter((c) => c.length > 0))];

  const results = [];

  for (const capId of unique) {
    const url = `${baseUrl}/v1/attestation/${capId}`;

    let attestation;
    try {
      const response = await fetchFn(url);

      if (!response.ok) {
        attestation = {
          capability_id: capId,
          status: 'not_found',
        };
      } else {
        attestation = await response.json();
      }
    } catch (err) {
      attestation = {
        capability_id: capId,
        status: 'error',
        error_message: err.message,
      };
    }

    results.push(evaluateCapability(attestation, policy));
  }

  const passed = results.every((r) => r.passed);

  return { passed, results };
}

// ── Summary formatting ──────────────────────────────────────────────

/**
 * Format check results as a human-readable Markdown summary.
 * Designed for GitHub Actions job summary output.
 */
export function formatSummary(checkResult) {
  const { passed, results } = checkResult;
  const passCount = results.filter((r) => r.passed).length;
  const failCount = results.filter((r) => !r.passed).length;

  const lines = [];

  // Header
  if (passed) {
    lines.push(`## ✅ Fidensa Certification Check Passed`);
    lines.push('');
    lines.push(`All ${results.length} capabilities passed certification policy checks.`);
  } else {
    lines.push(`## ❌ Fidensa Certification Check Failed`);
    lines.push('');
    lines.push(`${passCount} passed, ${failCount} failed out of ${results.length} capabilities.`);
  }

  lines.push('');

  // Results table
  lines.push('| Capability | Status | Score | Grade | Tier | Result |');
  lines.push('|------------|--------|-------|-------|------|--------|');

  for (const r of results) {
    const icon = r.passed ? '✅' : '❌';
    const score = r.trust_score != null ? String(r.trust_score) : '—';
    const grade = r.grade || '—';
    const tier = r.tier || '—';
    lines.push(`| ${r.capability_id} | ${r.status} | ${score} | ${grade} | ${tier} | ${icon} |`);
  }

  // Violations detail
  const failures = results.filter((r) => !r.passed);
  if (failures.length > 0) {
    lines.push('');
    lines.push('### Violations');
    lines.push('');
    for (const f of failures) {
      lines.push(`**${f.capability_id}:**`);
      for (const v of f.violations) {
        lines.push(`- ${v}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}
