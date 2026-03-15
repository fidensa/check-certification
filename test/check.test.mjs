import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  tierLevel,
  evaluateCapability,
  checkCapabilities,
  formatSummary,
  parseCapabilitiesList,
  parseConfigFile,
} from '../src/check.mjs';

// ── Helpers ─────────────────────────────────────────────────────────

function makeAttestation(overrides = {}) {
  return {
    schema_version: '1.0',
    capability_id: 'mcp-server-everything',
    version: '1.0.0',
    type: 'mcp_server',
    status: 'valid',
    tier: 'certified',
    maturity: 'Initial',
    trust_score: 91,
    grade: 'A',
    max_achievable_score: 95,
    supply_chain_status: 'clean',
    certified_at: '2026-03-10T00:00:00Z',
    expires_at: '2027-03-10T00:00:00Z',
    record_url: 'https://fidensa.com/certifications/mcp-server-everything',
    ...overrides,
  };
}

const DEFAULT_POLICY = {
  fail_on: ['suspended', 'revoked'],
  min_score: 0,
  min_tier: null,
};

function makeFetcher(responses) {
  return async (url) => {
    const match = responses[url];
    if (!match) {
      return { ok: false, status: 404, json: async () => ({ status: 'not_found' }) };
    }
    return { ok: true, status: 200, json: async () => match };
  };
}

// ── tierLevel ───────────────────────────────────────────────────────

describe('tierLevel', () => {
  it('returns correct ordering', () => {
    assert.ok(tierLevel('evaluated') < tierLevel('verified'));
    assert.ok(tierLevel('verified') < tierLevel('certified'));
  });

  it('is case-insensitive', () => {
    assert.equal(tierLevel('Certified'), tierLevel('certified'));
    assert.equal(tierLevel('VERIFIED'), tierLevel('verified'));
  });

  it('returns 0 for unknown tiers', () => {
    assert.equal(tierLevel('unknown'), 0);
    assert.equal(tierLevel(null), 0);
    assert.equal(tierLevel(undefined), 0);
  });
});

// ── evaluateCapability ──────────────────────────────────────────────

describe('evaluateCapability', () => {
  it('passes a valid certified capability with default policy', () => {
    const att = makeAttestation();
    const result = evaluateCapability(att, DEFAULT_POLICY);
    assert.equal(result.passed, true);
    assert.equal(result.violations.length, 0);
    assert.equal(result.capability_id, 'mcp-server-everything');
    assert.equal(result.status, 'valid');
    assert.equal(result.trust_score, 91);
  });

  it('fails when status is in fail_on list', () => {
    const att = makeAttestation({ status: 'suspended' });
    const result = evaluateCapability(att, DEFAULT_POLICY);
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.includes('suspended')));
  });

  it('fails on revoked status', () => {
    const att = makeAttestation({ status: 'revoked' });
    const result = evaluateCapability(att, DEFAULT_POLICY);
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.includes('revoked')));
  });

  it('does not fail on expired when expired is not in fail_on', () => {
    const att = makeAttestation({ status: 'expired' });
    const result = evaluateCapability(att, DEFAULT_POLICY);
    assert.equal(result.passed, true);
  });

  it('fails on expired when expired is in fail_on', () => {
    const att = makeAttestation({ status: 'expired' });
    const policy = { ...DEFAULT_POLICY, fail_on: ['expired'] };
    const result = evaluateCapability(att, policy);
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.includes('expired')));
  });

  it('fails when score is below min_score', () => {
    const att = makeAttestation({ trust_score: 55 });
    const policy = { ...DEFAULT_POLICY, min_score: 60 };
    const result = evaluateCapability(att, policy);
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.includes('score')));
  });

  it('passes when score equals min_score', () => {
    const att = makeAttestation({ trust_score: 60 });
    const policy = { ...DEFAULT_POLICY, min_score: 60 };
    const result = evaluateCapability(att, policy);
    assert.equal(result.passed, true);
  });

  it('fails when tier is below min_tier', () => {
    const att = makeAttestation({ tier: 'evaluated' });
    const policy = { ...DEFAULT_POLICY, min_tier: 'certified' };
    const result = evaluateCapability(att, policy);
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.includes('Tier')));
  });

  it('passes when tier equals min_tier', () => {
    const att = makeAttestation({ tier: 'verified' });
    const policy = { ...DEFAULT_POLICY, min_tier: 'verified' };
    const result = evaluateCapability(att, policy);
    assert.equal(result.passed, true);
  });

  it('passes when tier exceeds min_tier', () => {
    const att = makeAttestation({ tier: 'certified' });
    const policy = { ...DEFAULT_POLICY, min_tier: 'evaluated' };
    const result = evaluateCapability(att, policy);
    assert.equal(result.passed, true);
  });

  it('collects multiple violations', () => {
    const att = makeAttestation({ status: 'suspended', trust_score: 40, tier: 'evaluated' });
    const policy = { fail_on: ['suspended'], min_score: 60, min_tier: 'certified' };
    const result = evaluateCapability(att, policy);
    assert.equal(result.passed, false);
    assert.equal(result.violations.length, 3);
  });

  it('handles missing status (not_found) with fail_on missing', () => {
    const att = { capability_id: 'unknown-server', status: 'not_found' };
    const policy = { fail_on: ['missing'], min_score: 0, min_tier: null };
    const result = evaluateCapability(att, policy);
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.includes('not certified')));
  });

  it('passes missing capability when missing is not in fail_on', () => {
    const att = { capability_id: 'unknown-server', status: 'not_found' };
    const result = evaluateCapability(att, DEFAULT_POLICY);
    assert.equal(result.passed, true);
  });
});

// ── checkCapabilities ───────────────────────────────────────────────

describe('checkCapabilities', () => {
  it('checks multiple capabilities and aggregates results', async () => {
    const fetcher = makeFetcher({
      'https://fidensa.com/v1/attestation/mcp-server-everything': makeAttestation(),
      'https://fidensa.com/v1/attestation/mcp-server-filesystem': makeAttestation({
        capability_id: 'mcp-server-filesystem',
        trust_score: 90,
      }),
    });

    const results = await checkCapabilities(
      ['mcp-server-everything', 'mcp-server-filesystem'],
      DEFAULT_POLICY,
      'https://fidensa.com',
      fetcher,
    );

    assert.equal(results.passed, true);
    assert.equal(results.results.length, 2);
    assert.ok(results.results.every((r) => r.passed));
  });

  it('fails overall when any capability fails', async () => {
    const fetcher = makeFetcher({
      'https://fidensa.com/v1/attestation/mcp-server-everything': makeAttestation(),
      'https://fidensa.com/v1/attestation/bad-server': makeAttestation({
        capability_id: 'bad-server',
        status: 'suspended',
      }),
    });

    const results = await checkCapabilities(
      ['mcp-server-everything', 'bad-server'],
      DEFAULT_POLICY,
      'https://fidensa.com',
      fetcher,
    );

    assert.equal(results.passed, false);
    assert.equal(results.results[0].passed, true);
    assert.equal(results.results[1].passed, false);
  });

  it('handles 404 as not_found', async () => {
    const fetcher = makeFetcher({}); // empty — everything 404s

    const policy = { fail_on: ['missing'], min_score: 0, min_tier: null };
    const results = await checkCapabilities(
      ['nonexistent-server'],
      policy,
      'https://fidensa.com',
      fetcher,
    );

    assert.equal(results.passed, false);
    assert.equal(results.results[0].status, 'not_found');
  });

  it('handles network errors gracefully', async () => {
    const fetcher = async () => {
      throw new Error('Network timeout');
    };

    const policy = { fail_on: ['missing'], min_score: 0, min_tier: null };
    const results = await checkCapabilities(
      ['mcp-server-everything'],
      policy,
      'https://fidensa.com',
      fetcher,
    );

    assert.equal(results.passed, false);
    assert.equal(results.results[0].status, 'error');
    assert.ok(results.results[0].violations.some((v) => v.includes('Network')));
  });

  it('deduplicates capability IDs', async () => {
    let callCount = 0;
    const fetcher = async (url) => {
      callCount++;
      return { ok: true, status: 200, json: async () => makeAttestation() };
    };

    await checkCapabilities(
      ['mcp-server-everything', 'mcp-server-everything'],
      DEFAULT_POLICY,
      'https://fidensa.com',
      fetcher,
    );

    assert.equal(callCount, 1);
  });

  it('trims whitespace from capability IDs', async () => {
    let calledUrl = null;
    const fetcher = async (url) => {
      calledUrl = url;
      return { ok: true, status: 200, json: async () => makeAttestation() };
    };

    await checkCapabilities(
      ['  mcp-server-everything  '],
      DEFAULT_POLICY,
      'https://fidensa.com',
      fetcher,
    );

    assert.equal(calledUrl, 'https://fidensa.com/v1/attestation/mcp-server-everything');
  });

  it('skips empty capability IDs', async () => {
    let callCount = 0;
    const fetcher = async () => {
      callCount++;
      return { ok: true, status: 200, json: async () => makeAttestation() };
    };

    const results = await checkCapabilities(
      ['', '  ', 'mcp-server-everything'],
      DEFAULT_POLICY,
      'https://fidensa.com',
      fetcher,
    );

    assert.equal(callCount, 1);
    assert.equal(results.results.length, 1);
  });
});

// ── parseCapabilitiesList ───────────────────────────────────────────

describe('parseCapabilitiesList', () => {
  it('splits on newlines', () => {
    const result = parseCapabilitiesList('server-a\nserver-b\nserver-c');
    assert.deepEqual(result, ['server-a', 'server-b', 'server-c']);
  });

  it('handles Windows line endings', () => {
    const result = parseCapabilitiesList('server-a\r\nserver-b');
    assert.deepEqual(result, ['server-a', 'server-b']);
  });

  it('splits on commas', () => {
    const result = parseCapabilitiesList('server-a, server-b, server-c');
    assert.deepEqual(result, ['server-a', 'server-b', 'server-c']);
  });

  it('trims and filters empty entries', () => {
    const result = parseCapabilitiesList('  server-a \n\n  server-b  \n');
    assert.deepEqual(result, ['server-a', 'server-b']);
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(parseCapabilitiesList(''), []);
    assert.deepEqual(parseCapabilitiesList('   '), []);
  });
});

// ── parseConfigFile ───────────────────────────────────────────────────────

describe('parseConfigFile', () => {
  it('parses a standard config', () => {
    const content = `capabilities:\n  - mcp-server-everything\n  - mcp-server-filesystem\n  - docx-skill`;
    assert.deepEqual(parseConfigFile(content), [
      'mcp-server-everything',
      'mcp-server-filesystem',
      'docx-skill',
    ]);
  });

  it('ignores comments', () => {
    const content = `capabilities:\n  # this is a comment\n  - server-a\n  - server-b`;
    assert.deepEqual(parseConfigFile(content), ['server-a', 'server-b']);
  });

  it('stops at next non-list key', () => {
    const content = `capabilities:\n  - server-a\nother_key: value`;
    assert.deepEqual(parseConfigFile(content), ['server-a']);
  });

  it('handles empty file', () => {
    assert.deepEqual(parseConfigFile(''), []);
  });

  it('handles file with no capabilities key', () => {
    assert.deepEqual(parseConfigFile('version: 1\nfoo: bar'), []);
  });

  it('trims capability values', () => {
    const content = `capabilities:\n  -   spaced-server  `;
    assert.deepEqual(parseConfigFile(content), ['spaced-server']);
  });
});

// ── formatSummary ───────────────────────────────────────────────────

describe('formatSummary', () => {
  it('formats an all-pass summary', () => {
    const checkResult = {
      passed: true,
      results: [
        {
          capability_id: 'mcp-server-everything',
          status: 'valid',
          trust_score: 91,
          grade: 'A',
          tier: 'certified',
          passed: true,
          violations: [],
        },
      ],
    };
    const summary = formatSummary(checkResult);
    assert.ok(summary.includes('✅'));
    assert.ok(summary.includes('mcp-server-everything'));
    assert.ok(summary.includes('91'));
  });

  it('formats a failure summary with violations', () => {
    const checkResult = {
      passed: false,
      results: [
        {
          capability_id: 'bad-server',
          status: 'suspended',
          trust_score: 45,
          grade: 'F',
          tier: 'evaluated',
          passed: false,
          violations: ['Status is suspended'],
        },
      ],
    };
    const summary = formatSummary(checkResult);
    assert.ok(summary.includes('❌'));
    assert.ok(summary.includes('bad-server'));
    assert.ok(summary.includes('suspended'));
  });

  it('formats mixed results', () => {
    const checkResult = {
      passed: false,
      results: [
        {
          capability_id: 'good-server',
          status: 'valid',
          trust_score: 91,
          grade: 'A',
          tier: 'certified',
          passed: true,
          violations: [],
        },
        {
          capability_id: 'bad-server',
          status: 'not_found',
          trust_score: null,
          grade: null,
          tier: null,
          passed: false,
          violations: ['Capability is not certified by Fidensa'],
        },
      ],
    };
    const summary = formatSummary(checkResult);
    assert.ok(summary.includes('1 passed'));
    assert.ok(summary.includes('1 failed'));
  });
});
