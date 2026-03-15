#!/usr/bin/env node

/**
 * GitHub Actions entry point for the Fidensa certification check.
 *
 * Reads inputs from environment variables (INPUT_*),
 * writes outputs to $GITHUB_OUTPUT, and summary to $GITHUB_STEP_SUMMARY.
 *
 * Exit code 0 = all checks passed (or warn mode).
 * Exit code 1 = one or more checks failed.
 */

import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { checkCapabilities, parseCapabilitiesList, parseConfigFile, formatSummary } from './check.mjs';

// ── Input reading ───────────────────────────────────────────────────

function getInput(name, defaultValue = '') {
  return process.env[`INPUT_${name.toUpperCase().replace(/-/g, '_')}`] || defaultValue;
}

function parsePolicy() {
  const failOnRaw = getInput('fail-on', 'suspended,revoked');
  const fail_on = failOnRaw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);

  const minScoreRaw = getInput('min-score', '0');
  const min_score = parseInt(minScoreRaw, 10) || 0;

  const minTierRaw = getInput('min-tier', '').trim().toLowerCase();
  const min_tier = minTierRaw || null;

  return { fail_on, min_score, min_tier };
}

function resolveCapabilities() {
  // First try inline input
  const inline = getInput('capabilities', '');
  if (inline.trim()) {
    return parseCapabilitiesList(inline);
  }

  // Then try config file
  const configPath = getInput('config', '.fidensa.yml');
  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, 'utf-8');
      return parseConfigFile(content);
    } catch (err) {
      console.error(`Warning: Could not read config file ${configPath}: ${err.message}`);
    }
  }

  return [];
}

// ── Output writing ──────────────────────────────────────────────────

function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    appendFileSync(outputFile, `${name}=${value}\n`);
  }
}

function setSummary(markdown) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    appendFileSync(summaryFile, markdown + '\n');
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const capabilities = resolveCapabilities();

  if (capabilities.length === 0) {
    console.log('No capabilities to check. Provide them via the "capabilities" input or a .fidensa.yml config file.');
    setOutput('passed', 'true');
    setOutput('results', '[]');
    process.exit(0);
  }

  const policy = parsePolicy();
  const baseUrl = getInput('api-url', 'https://fidensa.com');
  const warnOnly = getInput('warn-only', 'false').toLowerCase() === 'true';

  console.log(`Checking ${capabilities.length} capabilities against Fidensa...`);
  console.log(`  Policy: fail_on=[${policy.fail_on.join(', ')}]` +
    (policy.min_score > 0 ? `, min_score=${policy.min_score}` : '') +
    (policy.min_tier ? `, min_tier=${policy.min_tier}` : ''));
  console.log(`  API: ${baseUrl}`);
  console.log('');

  const checkResult = await checkCapabilities(capabilities, policy, baseUrl, fetch);

  // Log individual results
  for (const r of checkResult.results) {
    const icon = r.passed ? '✅' : '❌';
    const score = r.trust_score != null ? `${r.trust_score}/100` : 'N/A';
    const tier = r.tier || 'N/A';
    console.log(`${icon} ${r.capability_id} — ${r.status} — ${score} — ${tier}`);
    for (const v of r.violations) {
      console.log(`   ⚠️  ${v}`);
    }
  }
  console.log('');

  // Write outputs
  setOutput('passed', String(checkResult.passed));
  setOutput('results', JSON.stringify(checkResult.results));

  // Write job summary
  const summary = formatSummary(checkResult);
  setSummary(summary);

  // Exit
  if (!checkResult.passed) {
    if (warnOnly) {
      console.log('⚠️  Certification check failed but warn-only mode is enabled. Continuing.');
      process.exit(0);
    } else {
      console.log('❌ Certification check failed.');
      process.exit(1);
    }
  } else {
    console.log('✅ All certification checks passed.');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
