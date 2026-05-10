#!/usr/bin/env node

/**
 * Migration Validation Script
 *
 * Validates a martech migration by comparing the migrated EDS site
 * against the captured baseline. Can be run standalone or invoked
 * by the migration-lifecycle hook.
 *
 * Usage:
 *   node validate-migration.js --baseline <baseline.json> --preview-url <url>
 *   node validate-migration.js --state  # Uses state file from current session
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

// ============================================================
// Validation Checks
// ============================================================

/**
 * Validation results structure
 */
function createValidationResult() {
  return {
    timestamp: new Date().toISOString(),
    checks: {},
    summary: {
      total: 0,
      passed: 0,
      failed: 0,
      warnings: 0
    },
    status: 'PENDING'
  };
}

/**
 * Check: AEP Edge calls present
 */
function checkAEPEdgeCalls(networkCalls) {
  const aepCalls = networkCalls.filter(c =>
    c.url && c.url.includes('edge.adobedc.net')
  );

  const interactCall = aepCalls.find(c => c.url.includes('/interact'));
  const collectCall = aepCalls.find(c => c.url.includes('/collect'));

  return {
    name: 'AEP Edge Calls',
    passed: interactCall !== undefined,
    details: {
      interactPresent: !!interactCall,
      interactTiming: interactCall?.timing || 'not found',
      collectPresent: !!collectCall,
      collectTiming: collectCall?.timing || 'not found',
      totalAEPCalls: aepCalls.length
    },
    recommendation: !interactCall
      ? 'No AEP Edge interact call detected. Check alloy configuration.'
      : null
  };
}

/**
 * Check: Launch container loads in delayed phase
 */
function checkLaunchTiming(networkCalls) {
  const launchCall = networkCalls.find(c =>
    c.url && c.url.includes('adobedtm.com')
  );

  if (!launchCall) {
    return {
      name: 'Launch Container Timing',
      passed: true, // May not have Launch
      details: { message: 'No Launch container detected (may be intentional)' },
      recommendation: null
    };
  }

  const timing = parseInt(launchCall.timing) || 0;
  const inDelayedPhase = timing >= 2500 && timing <= 6000;

  return {
    name: 'Launch Container Timing',
    passed: inDelayedPhase,
    details: {
      launchUrl: launchCall.url?.substring(0, 80) + '...',
      timing: launchCall.timing,
      expectedRange: '2500-6000ms'
    },
    recommendation: !inDelayedPhase
      ? `Launch container loaded at ${timing}ms. Expected 2500-6000ms (delayed phase).`
      : null
  };
}

/**
 * Check: No missing third-party calls vs baseline
 */
function checkNetworkRegression(baselineCalls, currentCalls) {
  const normalizeUrl = (url) => {
    try {
      const u = new URL(url);
      return u.hostname + u.pathname.split('?')[0];
    } catch {
      return url;
    }
  };

  const baselineNormalized = new Set(
    baselineCalls.map(c => normalizeUrl(c.url || c)).filter(Boolean)
  );
  const currentNormalized = new Set(
    currentCalls.map(c => normalizeUrl(c.url || c)).filter(Boolean)
  );

  const missing = [...baselineNormalized].filter(u => !currentNormalized.has(u));
  const added = [...currentNormalized].filter(u => !baselineNormalized.has(u));

  // Filter out known acceptable differences
  const significantMissing = missing.filter(u =>
    !u.includes('localhost') &&
    !u.includes('.aem.page') &&
    !u.includes('.aem.live')
  );

  return {
    name: 'Network Call Regression',
    passed: significantMissing.length === 0,
    details: {
      baselineCount: baselineCalls.length,
      currentCount: currentCalls.length,
      missingCount: significantMissing.length,
      addedCount: added.length,
      missing: significantMissing.slice(0, 10), // First 10
      added: added.slice(0, 10)
    },
    recommendation: significantMissing.length > 0
      ? `${significantMissing.length} network calls from baseline are missing. Review: ${significantMissing.slice(0, 3).join(', ')}`
      : null
  };
}

/**
 * Check: Personalization timing (interact before LCP)
 */
function checkPersonalizationTiming(metrics) {
  if (!metrics || !metrics.interactTiming || !metrics.lcp) {
    return {
      name: 'Personalization Timing',
      passed: true, // Can't verify without metrics
      details: { message: 'Timing metrics not available' },
      recommendation: 'Run validation with full metrics capture'
    };
  }

  const interactTime = parseInt(metrics.interactTiming) || 0;
  const lcpTime = parseInt(metrics.lcp) || 0;
  const beforeLCP = interactTime < lcpTime;

  return {
    name: 'Personalization Timing',
    passed: beforeLCP,
    details: {
      interactTiming: `${interactTime}ms`,
      lcpTiming: `${lcpTime}ms`,
      beforeLCP
    },
    recommendation: !beforeLCP
      ? `Personalization (interact) fired at ${interactTime}ms, after LCP (${lcpTime}ms). May cause flicker.`
      : null
  };
}

/**
 * Check: No duplicate analytics
 */
function checkDuplicateAnalytics(networkCalls) {
  const analyticsCalls = networkCalls.filter(c =>
    c.url && (
      c.url.includes('/collect') ||
      c.url.includes('/b/ss/') ||
      c.url.includes('google-analytics')
    )
  );

  // Group by endpoint
  const endpoints = {};
  analyticsCalls.forEach(c => {
    try {
      const u = new URL(c.url);
      const key = u.hostname + u.pathname;
      endpoints[key] = (endpoints[key] || 0) + 1;
    } catch {
      // Ignore
    }
  });

  const duplicates = Object.entries(endpoints)
    .filter(([_, count]) => count > 1)
    .map(([endpoint, count]) => ({ endpoint, count }));

  return {
    name: 'Duplicate Analytics',
    passed: duplicates.length === 0,
    details: {
      totalAnalyticsCalls: analyticsCalls.length,
      duplicates
    },
    recommendation: duplicates.length > 0
      ? `Duplicate analytics calls detected. Check container cleanup: ${duplicates.map(d => d.endpoint).join(', ')}`
      : null
  };
}

// ============================================================
// Main Validation Runner
// ============================================================

function runValidation(baseline, currentData) {
  const result = createValidationResult();

  // Run all checks
  const checks = [
    checkAEPEdgeCalls(currentData.networkCalls || []),
    checkLaunchTiming(currentData.networkCalls || []),
    checkNetworkRegression(baseline.scripts || [], currentData.networkCalls || []),
    checkPersonalizationTiming(currentData.metrics || {}),
    checkDuplicateAnalytics(currentData.networkCalls || [])
  ];

  // Aggregate results
  checks.forEach(check => {
    result.checks[check.name] = check;
    result.summary.total++;
    if (check.passed) {
      result.summary.passed++;
    } else {
      result.summary.failed++;
    }
  });

  // Overall status
  result.status = result.summary.failed === 0 ? 'PASS' : 'FAIL';

  return result;
}

// ============================================================
// CLI Interface
// ============================================================

function printUsage() {
  console.log(`
Migration Validation Script

Usage:
  node validate-migration.js --baseline <file> --current <file>
  node validate-migration.js --state

Options:
  --baseline <file>   JSON file with baseline network data
  --current <file>    JSON file with current (migrated) network data
  --state             Load from session state file
  --output <file>     Write results to file (default: stdout)
  --help              Show this help
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.length === 0) {
    printUsage();
    process.exit(0);
  }

  let baseline = null;
  let currentData = null;

  if (args.includes('--state')) {
    // Load from session state
    const sessionId = process.env.CLAUDE_SESSION_ID || 'default';
    const stateFile = path.join(os.tmpdir(), `backend-integration-state-${sessionId}.json`);

    if (!fs.existsSync(stateFile)) {
      console.error('Error: No session state found. Run audit first.');
      process.exit(1);
    }

    const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    baseline = state.baseline;

    if (!baseline) {
      console.error('Error: No baseline in session state.');
      process.exit(1);
    }

    console.log('Loaded baseline from session state.');
    console.log('Note: Current data must be provided or captured separately.\n');

    // Output baseline info for manual validation
    console.log(JSON.stringify({
      baselineUrl: baseline.url,
      baselineTimestamp: baseline.timestamp,
      baselineScripts: baseline.scripts?.length || 0,
      baselineGlobals: baseline.detectedGlobals || [],
      message: 'Run extraction scripts on migrated site and compare manually, or provide --current file'
    }, null, 2));

    process.exit(0);
  }

  // Load from files
  const baselineIdx = args.indexOf('--baseline');
  const currentIdx = args.indexOf('--current');

  if (baselineIdx >= 0 && args[baselineIdx + 1]) {
    baseline = JSON.parse(fs.readFileSync(args[baselineIdx + 1], 'utf-8'));
  }

  if (currentIdx >= 0 && args[currentIdx + 1]) {
    currentData = JSON.parse(fs.readFileSync(args[currentIdx + 1], 'utf-8'));
  }

  if (!baseline || !currentData) {
    console.error('Error: Both --baseline and --current are required.');
    printUsage();
    process.exit(1);
  }

  // Run validation
  const result = runValidation(baseline, currentData);

  // Output
  const outputIdx = args.indexOf('--output');
  if (outputIdx >= 0 && args[outputIdx + 1]) {
    fs.writeFileSync(args[outputIdx + 1], JSON.stringify(result, null, 2));
    console.log(`Results written to ${args[outputIdx + 1]}`);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }

  // Exit code based on status
  process.exit(result.status === 'PASS' ? 0 : 1);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
