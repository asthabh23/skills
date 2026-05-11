# Agentic Martech Migration & Optimization Loop

When migrating a customer site to Edge Delivery Services, martech integrations must be restructured to align with EDS performance best practices. This workflow defines the agentic optimization cycle that automates the bulk of that migration — detecting the existing stack, extracting only what needs to move, applying the changes, and iterating until performance improves and no third-party call regressions exist.

A developer always reviews and approves the result before it ships.

## Extraction Boundary (Critical Constraint)

This skill does **not** decompose the entire container. Only two categories are extracted from the container into EDS code:

| What | Where it goes in EDS | Why |
|------|----------------------|-----|
| **Personalization** (Target / AJO propositions) | `scripts.js` → `loadEager` | Must fire before first paint to prevent content flicker |
| **Analytics page view beacon** | `scripts.js` → `loadLazy` | Fires after LCP without blocking rendering |

Everything else — cookie consent, social pixels, RUM, remaining analytics events, marketing tags — **stays inside the original container** and loads in `scripts/delayed.js` as a black box. The container URL is preserved; only its timing changes (moved to delayed).

**EDS loading phases:**

| Phase | What loads | Mechanism |
|-------|-----------|-----------|
| Eager | Personalization (alloy.js / WebSDK propositions) | `await` in `loadEager` |
| Lazy | Analytics page view beacon (`sendEvent`) | `loadLazy` after LCP |
| Delayed | Container URL + everything else | `requestIdleCallback` or `setTimeout(3s)` |

## Overview

![Agentic optimization loop — overview](agentic-loop-overview.png)

```
┌──────────────────────── ONE-TIME SETUP ────────────────────────┐
│                                                                 │
│  Phase 0: Baseline          Phase 1: Container Analysis         │
│  ┌────────────────┐         ┌────────────────────────────┐      │
│  │ Network calls  │         │ GTM API / Reactor API       │      │
│  │ Deep-PSI score │──────▶  │ Classify tags & rules       │      │
│  └────────────────┘         └────────────────────────────┘      │
│                                       │                         │
│                          Phase 2: Strategy Selection            │
│                          ┌────────────────────────────┐         │
│                          │ aem-martech · gtm-martech   │         │
│                          │ delayed.js · dual pattern   │         │
│                          └────────────────────────────┘         │
└─────────────────────────────────────────────────────────────────┘
                                   │
                  ┌────────────────▼────────────────┐
                  │    OPTIMIZATION LOOP (max N)     │
                  │                                  │
                  │  Phase 3         Phase 4         │
                  │  ┌──────┐       ┌──────────┐    │
                  │  │APPLY │──────▶│ DEPLOY & │    │
                  │  │Instr.│       │ MEASURE  │    │
                  │  └──────┘       └──────────┘    │
                  │      ▲               │           │
                  │      │          Phase 5          │
                  │      │          ┌──────────┐     │
                  │      │          │  VERIFY  │     │
                  │      │          │ Regress. │     │
                  │      │          └──────────┘     │
                  │      │               │           │
                  │      │          Phase 6          │
                  │      │          ┌──────────┐     │
                  │      │          │ EVALUATE │     │
                  │      │          │ & DECIDE │     │
                  │      │          └──────────┘     │
                  │      │         /    |    \        │
                  │  PARTIAL  REGRESS.  │  SUCCESS   │
                  │  Optimize  Fix      │  ──────────┼──▶ Phase 7
                  │      └─────────────┘             │    Human
                  │                                  │    Review
                  └──────────────────────────────────┘
```

## Prerequisites

### Required Access

| Access | Purpose | Notes |
|--------|---------|-------|
| Customer `scripts.js` | Detect container type and URL | **Always required** — primary input |
| Customer Codebase | Apply instrumentation changes | Git repository access |
| Deep-PSI Tool | Measure performance | https://tools.aem.live/tools/deep-psi/deep-psi.html |

### Optional: Container API Access (Phase 2 capability)

When API access is available, the agent can read the container programmatically for richer analysis. If not available, fall back to **source code analysis** of `scripts.js` and the loaded container JS.

| API | Purpose | How to Obtain |
|-----|---------|---------------|
| GTM API v2 | Read tags, rules, triggers | Google Cloud Console → Enable Tag Manager API → Service Account |
| Launch Reactor API | Read rules, data elements | Adobe Developer Console → Create Project → Add Reactor API |

**Fallback (no API access):** Fetch the container URL, parse the minified JS, and infer tag classifications from function names, URLs, and patterns in the bundle.

### Reference Resources

| Resource | URL |
|----------|-----|
| aem-martech plugin | https://github.com/adobe-rnd/aem-martech/ |
| aem-gtm-martech plugin | https://github.com/adobe-rnd/aem-gtm-martech/ |
| EDS Martech Integration Guide | https://www.aem.live/developer/martech-integration |
| EDS Target Integration Guide | https://www.aem.live/developer/target-integration |
| WKND Martech Hybrid (reference project) | https://github.com/hlxsites/wknd/blob/adobe-martech-hybrid/scripts/scripts.js#L28-L61 |
| Deep-PSI | https://tools.aem.live/tools/deep-psi/deep-psi.html |

> **Test baseline:** Use the [WKND martech hybrid](https://adobe-martech-hybrid--wknd--hlxsites.aem.live/) project as the integration test reference. It includes a real Launch container, dummy IMS Org ID, and Datastream ID wired to the Sites Internal Org (Target, AEP, Analytics).

---

## Phase 0: Baseline Capture

Before any changes, capture the baseline state.

### Step 0.1: Capture Network Call Baseline

Use Playwright to intercept all third-party requests on the original site, then categorize by type (analytics, personalization, consent, social, other).

**Implementation:** See [`references/extraction-scripts.md`](../references/extraction-scripts.md) for the full `captureNetworkBaseline`, `isAnalyticsCall`, `isPersonalizationCall`, `categorizeCall`, and related functions.

**Output:** `baseline-network-calls.json`

### Step 0.2: Capture Performance Baseline

Deep PSI (`https://tools.aem.live/tools/deep-psi/deep-psi.html`) runs multiple PSI iterations and applies t-tests for statistical reliability. Use Playwright to drive it — it has no public API endpoint.

```javascript
// Installs Playwright + Chromium on demand. Both steps are no-ops when
// already present, so calling this at loop startup is safe.
async function ensurePlaywright() {
  const { execSync } = require('child_process');
  try { require.resolve('playwright'); }
  catch { execSync('npm install --no-save playwright', { stdio: 'inherit' }); }
  execSync('npx playwright install chromium', { stdio: 'inherit' });
  return require('playwright');
}

// Drives deep-PSI via Playwright and parses metrics from page text. We match
// on text rather than DOM selectors because the tool's markup is not a stable
// contract. Throws on parse failure so the caller falls back instead of
// feeding bogus zeros into the optimization loop.
async function captureDeepPsi(url, label = 'baseline') {
  const { chromium } = await ensurePlaywright();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('https://tools.aem.live/tools/deep-psi/deep-psi.html');
    await page.fill('input[type="url"], input[name="url"]', url);
    await page.click('button[type="submit"], button:has-text("Run"), button:has-text("Submit")');
    // Deep-PSI runs several Lighthouse passes; the results text appears when done.
    await page.waitForFunction(
      () => /Largest Contentful Paint/i.test(document.body.innerText),
      { timeout: 300000 },
    );
    const text = await page.evaluate(() => document.body.innerText);
    const find = (re) => {
      const m = text.match(re);
      return m ? parseFloat(m[1]) : NaN;
    };
    const metrics = {
      lcp: find(/Largest Contentful Paint[^0-9]*([0-9.]+)/i),
      cls: find(/Cumulative Layout Shift[^0-9]*([0-9.]+)/i),
      tbt: find(/Total Blocking Time[^0-9]*([0-9.]+)/i),
      fcp: find(/First Contentful Paint[^0-9]*([0-9.]+)/i),
      performanceScore: find(/Performance\s*Score[^0-9]*([0-9.]+)/i),
    };
    if (Object.values(metrics).every(Number.isNaN)) {
      throw new Error('DEEP_PSI_EXTRACTION_FAILED: no metrics parsed');
    }
    return { label, url, timestamp: Date.now(), source: 'deep-psi', ...metrics };
  } finally {
    await browser.close();
  }
}
```

> **Fallback:** On failure, `measurePerformance` falls back to `captureGooglePsiAveraged` — multiple PSI API calls averaged — so baseline and iteration measurements remain comparable. A single PSI sample is too noisy to use directly.

**Capture:**
- LCP (Largest Contentful Paint)
- CLS (Cumulative Layout Shift)
- TBT (Total Blocking Time)
- FCP (First Contentful Paint)
- Performance Score (0–100)

**Output:** `baseline-performance.json`

---

## Phase 1: Container Analysis

Container analysis has two paths depending on available access. Use the API path when credentials are available; otherwise fall back to source code analysis.

### Path A: Source Code Analysis (Always Available)

```javascript
async function analyzeFromSource(scriptsJsContent, containerUrl) {
  // 1. Detect container type from scripts.js
  const containerType = detectContainerType(scriptsJsContent);
  // Patterns: assets.adobedtm.com → launch, googletagmanager.com → gtm

  // 2. Fetch and parse the container bundle
  const containerSource = await fetch(containerUrl).then(r => r.text());

  // 3. Infer personalization presence
  const hasPersonalization = /alloy|at\.js|target|ajo|decisioning/i.test(containerSource);

  // 4. Infer analytics presence
  const hasAnalytics = /s\.t\(\)|sendEvent.*pageView|ga4.*page_view|AppMeasurement/i.test(containerSource);

  return { containerType, hasPersonalization, hasAnalytics, confidence: 'medium' };
}

function detectContainerType(scriptsJs) {
  if (/assets\.adobedtm\.com/i.test(scriptsJs) && /googletagmanager\.com/i.test(scriptsJs)) return 'both';
  if (/assets\.adobedtm\.com/i.test(scriptsJs)) return 'launch';
  if (/googletagmanager\.com/i.test(scriptsJs)) return 'gtm';
  return 'unknown';
}
```

> **Flag for human review** any tags with `confidence: 'low'` — i.e., custom-named tags that don't match known patterns.

### Path B: Container API Analysis (When Credentials Available)

Authenticate to the GTM or Launch Reactor API, fetch all tags/rules, and classify each into: `personalization`, `analytics_pageview`, `analytics_events`, `consent`, `social`, `other`.

**Implementation:** See [`references/container-analysis-scripts.md`](../references/container-analysis-scripts.md) for `authenticateGTM`, `authenticateLaunch`, `analyzeGTMContainer`, `analyzeLaunchContainer`, `classifyTag`, `classifyLaunchRule`, and `isPageViewTrigger`.

> Also identifies rules that become **redundant after migration** (personalization/analytics now handled in EDS code) — flag these for cleanup inside the container.

**Output:** `container-analysis.json`

---

## Phase 2: Strategy Selection

Based on the container analysis output, select the appropriate migration approach before writing any code.

### Extraction Rule

Regardless of strategy, the extraction boundary is always the same:

- **Extract → EDS code:** personalization tags + analytics page view beacon only
- **Leave in container → delayed phase:** consent, social pixels, RUM, all other analytics events, any ambiguous tags
- **Flag for human review:** any tags that cannot be confidently classified

### Strategy Decision Tree

```yaml
decision_tree:
  - if: personalization tags detected AND analytics detected
    then: Use aem-martech plugin (Approach 1 — full eager/lazy/delayed)

  - if: GTM with GA4 only (no personalization)
    then: Use aem-gtm-martech plugin

  - if: Launch with analytics only (no Target)
    then: Approach 2 — Launch container in delayed.js only

  - if: Both GTM and Launch
    then: Dual martech pattern (both containers in delayed.js, consent-gated)
```

**Output:** `migration-plan.json` — records the chosen approach, plugin type, config variables extracted, what is being extracted vs left in the container, and any items flagged for human review.

---

## Phase 3: Apply Instrumentation

### Step 3.1: Generate Instrumentation Code

Select the plugin template for the chosen strategy and populate config variables from the container analysis output.

**Templates:** See [`references/aem-martech-plugin-template.md`](../references/aem-martech-plugin-template.md) for complete `scripts.js`, `delayed.js`, and `head.html` patterns for both `aem-martech` (Adobe stack) and `aem-gtm-martech` (Google stack).

> All current EDS repos use `aem.js` — confirm with `detectBoilerplate(scriptsJs)` before generating code. See [Boilerplate Compatibility](#boilerplate-compatibility).

### Step 3.1a: Re-implement Consent Gating (Required)

**This is not optional.** Consent checks that previously lived inside the container no longer protect the personalization and analytics calls we just extracted into `scripts.js`. Without re-implementing them, martech calls will fire before the user has given consent — a GDPR/CCPA violation.

For every extraction:

1. Identify the consent tool in use (OneTrust, Cookiebot, custom) from Phase 0 baseline.
2. Gate the eager alloy init on `hasPersonalizationConsent()`.
3. Gate the lazy page-view beacon on `hasAnalyticsConsent()`.
4. Subscribe to the consent tool's change event so calls fire after late-granted consent.

**Implementation:** See [`references/consent-gated-architecture.md`](../references/consent-gated-architecture.md) for `hasAnalyticsConsent`, `hasPersonalizationConsent`, OneTrust event listener patterns, and the complete consent-gated `loadEager` structure.

### Step 3.2: Apply Changes to Codebase

```javascript
async function applyInstrumentation(repoPath, migrationPlan) {
  // 1. Modify scripts/scripts.js
  await modifyScriptsJS(repoPath, migrationPlan.scriptsChanges);
  
  // 2. Modify scripts/delayed.js
  await modifyDelayedJS(repoPath, migrationPlan.delayedChanges);
  
  // 3. Add head.html preconnects
  await modifyHeadHTML(repoPath, migrationPlan.preconnects);
  
  // 4. Add martech plugin files if needed
  if (migrationPlan.requiresPlugin) {
    await copyPluginFiles(repoPath, migrationPlan.pluginType);
  }
  
  // 5. Run lint
  await runLint(repoPath);
  
  // 6. Commit changes
  await gitCommit(repoPath, 'Apply martech instrumentation (iteration ${iteration})');
}
```

---

## Phase 4: Deploy & Measure

### Step 4.1: Deploy to Preview

```bash
git push origin martech-migration
# Wait for AEM Code Sync (~30s)
sleep 30
```

### Step 4.2: Run Deep-PSI

Use the same `captureDeepPsi` function defined in Phase 0 — it drives the deep-PSI web UI via Playwright for statistically reliable multi-run results.

```javascript
async function measurePerformance(previewUrl, label = 'iteration') {
  try {
    return await captureDeepPsi(previewUrl, label);
  } catch (e) {
    console.warn(`Deep-PSI failed (${e.message}); falling back to averaged PSI`);
    return await captureGooglePsiAveraged(previewUrl, label);
  }
}

// Averages N PSI API calls. A single PSI run is too noisy to drive the loop;
// deep-PSI averages ~9 runs, so 5 here is a reasonable trade-off between
// noise smoothing and API quota.
async function captureGooglePsiAveraged(url, label, runs = 5) {
  const keys = ['lcp', 'cls', 'tbt', 'fcp', 'performanceScore'];
  const sums = Object.fromEntries(keys.map((k) => [k, 0]));
  for (let i = 0; i < runs; i++) {
    const res = await fetch(
      `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile`,
    );
    if (!res.ok) throw new Error(`PSI_API_FAILED: HTTP ${res.status}`);
    const { lighthouseResult: lhr } = await res.json();
    sums.lcp += lhr.audits['largest-contentful-paint'].numericValue;
    sums.cls += lhr.audits['cumulative-layout-shift'].numericValue;
    sums.tbt += lhr.audits['total-blocking-time'].numericValue;
    sums.fcp += lhr.audits['first-contentful-paint'].numericValue;
    sums.performanceScore += lhr.categories.performance.score * 100;
  }
  const avg = Object.fromEntries(keys.map((k) => [k, sums[k] / runs]));
  return { label, url, timestamp: Date.now(), source: 'psi-api-averaged', runs, ...avg };
}
```

### Step 4.3: Calculate Performance Delta

```javascript
// Deltas with a 5% noise tolerance — PSI run-to-run variance is ~5%, so
// changes within that band are treated as flat, not improvement/regression.
function calculatePerformanceDelta(baseline, current) {
  const NOISE = 0.05;
  const assess = (key) => {
    const delta = current[key] - baseline[key];
    const floor = Math.abs(baseline[key]) * NOISE;
    return {
      baseline: baseline[key],
      current: current[key],
      delta,
      improved: delta < -floor,
      regressed: delta > floor,
    };
  };
  const lcp = assess('lcp');
  const cls = assess('cls');
  const tbt = assess('tbt');
  return {
    lcp,
    cls,
    tbt,
    overallImproved: (lcp.improved || cls.improved || tbt.improved)
      && !(lcp.regressed || cls.regressed || tbt.regressed),
  };
}
```

---

## Phase 5: Verify Regressions

### Step 5.1: Capture Post-Migration Network Calls

```javascript
async function capturePostMigrationCalls(previewUrl) {
  // Same as baseline capture
  return await captureNetworkBaseline(previewUrl);
}
```

### Step 5.2: Compare Network Calls

```javascript
function compareNetworkCalls(baseline, current) {
  const report = {
    analytics: compareCallCategory(baseline.analytics, current.analytics),
    personalization: compareCallCategory(baseline.personalization, current.personalization),
    consent: compareCallCategory(baseline.consent, current.consent),
    social: compareCallCategory(baseline.social, current.social),
    other: compareCallCategory(baseline.other, current.other),
    
    // Summary
    totalBaseline: baseline.all.length,
    totalCurrent: current.all.length,
    missingCalls: [],
    newCalls: [],
    hasRegressions: false
  };
  
  // Find missing calls (CRITICAL - these are regressions)
  for (const baselineCall of baseline.all) {
    const found = current.all.some(c => callsMatch(baselineCall, c));
    if (!found) {
      report.missingCalls.push(baselineCall);
      report.hasRegressions = true;
    }
  }
  
  // Find new calls (informational)
  for (const currentCall of current.all) {
    const found = baseline.all.some(c => callsMatch(currentCall, c));
    if (!found) {
      report.newCalls.push(currentCall);
    }
  }
  
  return report;
}

// Determines whether two network calls represent the same event. Ignoring
// query strings entirely collapses distinct beacons (e.g., two different
// Analytics event types hitting /b/ss/rsid) into a single match and hides real
// regressions. We match on hostname + pathname plus a small set of identifying
// query params that mark what the call actually is.
//
// IDENTIFYING_PARAMS is conservative: only params known to distinguish event
// type for common martech endpoints. Timestamps, session IDs, and cache
// busters are deliberately excluded so run-to-run jitter doesn't cause false
// positive regressions.
const IDENTIFYING_PARAMS = [
  'en',         // GA4 event_name
  't',          // GA classic hit type (pageview, event, ...)
  'pe',         // Adobe Analytics event type
  'events',     // Adobe Analytics events list
  'type',       // WebSDK event type (e.g., "decisioning.propositionDisplay")
  'eventType',  // alternate casing
  'tid',        // GA tracking id
  'rsid',       // Adobe Analytics report suite id
];

function callsMatch(call1, call2) {
  const url1 = new URL(call1.url);
  const url2 = new URL(call2.url);
  if (url1.hostname !== url2.hostname) return false;
  if (url1.pathname !== url2.pathname) return false;

  // For endpoints where the path alone doesn't identify the event (Analytics,
  // GA, WebSDK all use a single endpoint for many event types), require the
  // identifying params to also match.
  for (const param of IDENTIFYING_PARAMS) {
    const v1 = url1.searchParams.get(param);
    const v2 = url2.searchParams.get(param);
    if (v1 !== v2) return false;
  }
  return true;
}
```

### Step 5.3: Generate Regression Report

```javascript
function generateRegressionReport(comparison) {
  return {
    status: comparison.hasRegressions ? 'FAILED' : 'PASSED',
    
    summary: {
      baselineCalls: comparison.totalBaseline,
      currentCalls: comparison.totalCurrent,
      missingCount: comparison.missingCalls.length,
      newCount: comparison.newCalls.length
    },
    
    critical: comparison.missingCalls.map(c => ({
      url: c.url,
      category: categorizeCall(c.url),
      impact: 'MISSING - This call was present in baseline but not in migrated version'
    })),
    
    informational: comparison.newCalls.map(c => ({
      url: c.url,
      category: categorizeCall(c.url),
      note: 'NEW - This call was not present in baseline'
    })),
    
    recommendation: comparison.hasRegressions 
      ? 'Investigate missing calls before proceeding'
      : 'No regressions detected - safe to continue'
  };
}
```

---

## Phase 6: Evaluate & Decide

### Step 6.1: Evaluate Results

```javascript
function evaluateIteration(performanceDelta, regressionReport, iteration) {
  const decision = {
    iteration,
    performanceImproved: performanceDelta.overallImproved,
    noRegressions: !regressionReport.hasRegressions,
    
    // Overall status
    status: null,
    nextAction: null
  };
  
  if (decision.noRegressions && decision.performanceImproved) {
    decision.status = 'SUCCESS';
    decision.nextAction = 'PROCEED_TO_HUMAN_REVIEW';
  } else if (decision.noRegressions && !decision.performanceImproved) {
    decision.status = 'PARTIAL';
    decision.nextAction = 'ATTEMPT_OPTIMIZATION';
  } else if (!decision.noRegressions) {
    decision.status = 'REGRESSION';
    decision.nextAction = 'FIX_REGRESSIONS';
  }
  
  return decision;
}
```

### Step 6.2: Optimization Strategies

When performance hasn't improved, try these adjustments:

```javascript
const fs = require('fs');
const path = require('path');

// Each strategy mutates project files and returns { changed, file? }.
// Strategies are idempotent: the condition checks inside guarantee that
// running the same strategy twice is a no-op.
const OPTIMIZATION_STRATEGIES = [
  {
    name: 'defer_non_critical_tags',
    description: 'Switch delayed.js from setTimeout(3000) to requestIdleCallback',
    apply: async (repoPath) => {
      const file = path.join(repoPath, 'scripts/delayed.js');
      const src = fs.readFileSync(file, 'utf8');
      if (src.includes('requestIdleCallback')) return { changed: false };
      const next = src.replace(
        /setTimeout\(\s*([A-Za-z_$][\w$]*)\s*,\s*3000\s*\)/,
        `('requestIdleCallback' in window ? requestIdleCallback($1, { timeout: 5000 }) : setTimeout($1, 3000))`,
      );
      if (next === src) return { changed: false };
      fs.writeFileSync(file, next);
      return { changed: true, file: 'scripts/delayed.js' };
    },
  },
  {
    name: 'add_preconnects',
    description: 'Add preconnect hints to head.html for the top third-party domains by call volume',
    // Skipped if no network calls were captured in the current iteration.
    condition: (ctx) => ctx.networkCalls?.length > 0,
    apply: async (repoPath, { networkCalls }) => {
      // Rank domains by call count — preconnecting the busiest ones gives the
      // biggest DNS/TLS savings for the delayed phase.
      const counts = networkCalls.reduce((acc, c) => {
        const host = new URL(c.url).hostname;
        acc.set(host, (acc.get(host) ?? 0) + 1);
        return acc;
      }, new Map());
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

      const file = path.join(repoPath, 'head.html');
      const src = fs.readFileSync(file, 'utf8');
      const tags = top
        .filter(([host]) => !src.includes(`href="https://${host}"`))
        .map(([host]) => `<link rel="preconnect" href="https://${host}" crossorigin>`);
      if (tags.length === 0) return { changed: false };
      fs.writeFileSync(file, `${src}\n${tags.join('\n')}\n`);
      return { changed: true, file: 'head.html', added: tags.length };
    },
  },
];
```

> Additional strategies (`lazy_load_alloy`, `reduce_data_layer_payload`) require project-specific markers or data-layer schema we don't yet emit consistently. They're deferred until the aem-martech template adds stable anchors — tracking under **Open Questions & Risks**.

### Step 6.3: Regression Fixes

When regressions are detected:

```javascript
const fsp = require('fs/promises');

// Returns a list of human-readable findings per missing call. We don't
// auto-mutate on regression — regressions almost always signal an error in the
// extracted instrumentation, and the safer default is to surface the diagnosis
// and escalate. Auto-patching regressions risks making the problem worse.
async function fixRegressions(repoPath, regressionReport) {
  const findings = [];
  for (const missing of regressionReport.critical) {
    findings.push(await diagnoseMissingCall(repoPath, missing));
  }
  return findings;
}

async function diagnoseMissingCall(repoPath, missing) {
  const read = async (rel) => {
    try { return await fsp.readFile(path.join(repoPath, rel), 'utf8'); }
    catch { return null; }
  };
  const host = new URL(missing.url).hostname;
  const scripts = await read('scripts/scripts.js') ?? '';
  const delayed = await read('scripts/delayed.js') ?? '';

  switch (missing.category) {
    case 'analytics':
      // Analytics payload requires both a configured datastream AND a populated
      // data layer before sendEvent fires. Either missing → no beacon.
      return {
        url: missing.url,
        category: 'analytics',
        hasDatastreamConfig: /datastreamId|datastream_id/.test(scripts),
        hasSendEvent: /sendEvent|pageView/.test(scripts),
        recommendation: 'Verify datastream ID is set and sendEvent is called in loadLazy after the data layer is populated.',
      };
    case 'personalization':
      return {
        url: missing.url,
        category: 'personalization',
        alloyInEager: /loadEager[\s\S]*?alloy/.test(scripts),
        recommendation: 'Ensure alloy is configured and awaited inside loadEager before first section renders.',
      };
    case 'consent':
      return {
        url: missing.url,
        category: 'consent',
        consentScriptReferenced: /OneTrust|Optanon|cookielaw/i.test(scripts + delayed),
        recommendation: 'Confirm the consent script is loaded early (before loadDelayed) and its callback fires.',
      };
    default:
      // Generic third-party tags should still come from the container loaded
      // in delayed.js — check that the original container URL is intact.
      return {
        url: missing.url,
        category: missing.category,
        containerStillLoaded: delayed.includes(host) || /loadScript.*adobedtm|googletagmanager/.test(delayed),
        recommendation: 'Confirm the original container URL is loaded in delayed.js and the tag is still present in the container.',
      };
  }
}
```

> The diagnostic output is returned to the loop and attached to the iteration record so the human reviewer can act on it. We deliberately avoid auto-rewriting code on regression — see Success Criteria: any failing criterion triggers another iteration, then escalates.

---

## Phase 7: Human Review

### Step 7.1: Generate Review Package

```javascript
function generateReviewPackage(iterations) {
  const latestIteration = iterations[iterations.length - 1];
  
  return {
    summary: {
      totalIterations: iterations.length,
      finalStatus: latestIteration.decision.status,
      performanceDelta: latestIteration.performanceDelta,
      regressionStatus: latestIteration.regressionReport.status
    },
    
    filesChanged: [
      'scripts/scripts.js',
      'scripts/delayed.js', 
      'head.html',
      // ... other files
    ],
    
    diffLinks: {
      scriptsJs: `https://github.com/org/repo/compare/main...martech-migration#diff-scripts-js`,
      // ...
    },
    
    testUrls: {
      preview: `https://martech-migration--repo--org.aem.page/`,
      deepPsi: `https://tools.aem.live/tools/deep-psi/deep-psi.html?url=...`
    },
    
    manualChecks: [
      '[ ] Personalization renders without flicker',
      '[ ] Analytics data appears in reports',
      '[ ] Consent banner functions correctly',
      '[ ] No console errors related to martech'
    ],
    
    iterationHistory: iterations.map(i => ({
      iteration: i.iteration,
      status: i.decision.status,
      lcpDelta: i.performanceDelta.lcp.delta,
      missingCalls: i.regressionReport.missingCount
    }))
  };
}
```

### Step 7.2: Present to Human

```markdown
## Martech Migration Review

### Summary
- **Iterations:** ${totalIterations}
- **Final Status:** ${finalStatus}
- **Performance:** LCP ${lcpDelta > 0 ? 'regressed' : 'improved'} by ${Math.abs(lcpDelta)}ms

### Files Changed
${filesChanged.map(f => `- \`${f}\``).join('\n')}

### Test URLs
- Preview: ${previewUrl}
- Deep-PSI: ${deepPsiUrl}

### Manual Verification Checklist
${manualChecks.join('\n')}

### Approve or Request Changes?
```

---

## Detailed Flow

![Agentic optimization loop — detailed flow](agentic-optimization-loop.png)

---

## Loop Orchestration

```javascript
async function runOptimizationLoop(config) {
  const maxIterations = config.optimization?.max_iterations ?? 5;
  const iterations = [];

  // Phase 0 — baseline. Performance and network are captured on the original
  // site so every iteration compares against the same reference point.
  const baseline = {
    network: await captureNetworkBaseline(config.source.site_url),
    performance: await measurePerformance(config.source.site_url, 'baseline'),
  };

  // Phase 1–2 run once: analysis and strategy don't change across iterations.
  const containerAnalysis = await analyzeContainer(config);
  const strategy = selectStrategy(containerAnalysis);

  for (let i = 1; i <= maxIterations; i++) {
    console.log(`\n=== Iteration ${i} ===\n`);

    // Phase 3 — apply instrumentation. On iteration 1 this is the full
    // migration; later iterations layer on optimizations from the previous
    // iteration's result.
    const plan = generateMigrationPlan(strategy, containerAnalysis, i);
    await applyInstrumentation(config.target.repo_path, plan);

    // Phase 4 — deploy, then measure on the preview URL.
    await deployToPreview(config.target);
    const currentPerformance = await measurePerformance(config.target.preview_url, `iter-${i}`);
    const performanceDelta = calculatePerformanceDelta(baseline.performance, currentPerformance);

    // Phase 5 — network regression check.
    const currentNetwork = await captureNetworkBaseline(config.target.preview_url);
    const regressionReport = compareNetworkCalls(baseline.network, currentNetwork);

    // Phase 6 — decide what to do next.
    const decision = evaluateIteration(performanceDelta, regressionReport, i);
    const record = { iteration: i, plan, performanceDelta, regressionReport, decision };

    if (decision.status === 'SUCCESS') {
      iterations.push(record);
      break;
    }
    if (decision.status === 'REGRESSION') {
      // Surface diagnostics for the human reviewer; don't auto-patch.
      record.diagnostics = await fixRegressions(config.target.repo_path, regressionReport);
    } else if (decision.nextAction === 'ATTEMPT_OPTIMIZATION') {
      // Strategies need both the container analysis and the current network
      // capture to make meaningful choices (e.g., which domains to preconnect).
      record.optimizations = await applyOptimizationStrategy(config.target.repo_path, i, {
        containerAnalysis,
        networkCalls: currentNetwork.all,
      });
    }
    iterations.push(record);
  }

  return generateReviewPackage(iterations);
}
```

---

## Orchestration Helper Functions

The loop orchestration above calls five functions that are defined here.

```javascript
// Unify GTM and Launch analysis behind a single interface
async function analyzeContainer(config) {
  const { type } = config.container;
  if (type === 'gtm') {
    const tagmanager = await authenticateGTM(config.container.gtm.api_credentials.service_account_key);
    return analyzeGTMContainer(tagmanager, config.container.gtm.account_id, config.container.gtm.container_id);
  }
  if (type === 'launch') {
    const { access_token } = await authenticateLaunch(
      config.container.launch.api_credentials.client_id,
      config.container.launch.api_credentials.client_secret,
      config.container.launch.api_credentials.org_id
    );
    return analyzeLaunchContainer(access_token, config.container.launch.property_id);
  }
  if (type === 'both') {
    const [gtm, launch] = await Promise.all([
      analyzeContainer({ ...config, container: { ...config.container, type: 'gtm' } }),
      analyzeContainer({ ...config, container: { ...config.container, type: 'launch' } })
    ]);
    return { gtm, launch, type: 'both' };
  }
  // Fallback: source code analysis when no API access
  return analyzeFromSource(config.source.scripts_js, config.container.url);
}

// Translate container analysis into a strategy choice
function selectStrategy(containerAnalysis) {
  const hasPersonalization = containerAnalysis.personalization?.length > 0
    || containerAnalysis.hasPersonalization;
  const hasAnalytics = containerAnalysis.analytics_pageview?.length > 0
    || containerAnalysis.hasAnalytics;
  const isGTM = containerAnalysis.type === 'gtm' || containerAnalysis.containerType === 'gtm';
  const isBoth = containerAnalysis.type === 'both' || containerAnalysis.containerType === 'both';

  if (isBoth) return { plugin: 'dual', approach: 'dual-martech' };
  if (isGTM && !hasPersonalization) return { plugin: 'aem-gtm-martech', approach: 'gtm-only' };
  if (hasPersonalization && hasAnalytics) return { plugin: 'aem-martech', approach: 'full-adobe-stack' };
  return { plugin: null, approach: 'launch-delayed-only' };
}

// Build the per-iteration instrumentation plan
function generateMigrationPlan(strategy, containerAnalysis, iteration) {
  return {
    iteration,
    strategy,
    // What gets extracted into EDS code (extraction boundary)
    eager: strategy.approach === 'full-adobe-stack' ? ['alloy.js init', 'Target propositions'] : [],
    lazy: (strategy.approach === 'full-adobe-stack' || strategy.approach === 'gtm-only')
      ? ['analytics page view beacon'] : [],
    // Everything else stays in the container loaded in delayed
    delayed: ['container URL', 'consent', 'social pixels', 'remaining tags'],
    requiresPlugin: !!strategy.plugin,
    pluginType: strategy.plugin,
    // Optimization hints for iteration > 1
    optimizations: iteration > 1 ? selectOptimizationForIteration(iteration) : []
  };
}

function selectOptimizationForIteration(iteration) {
  // iteration is 1-indexed; the first optimization runs on iteration 2.
  return OPTIMIZATION_STRATEGIES[(iteration - 2) % OPTIMIZATION_STRATEGIES.length];
}

// Runs the iteration's optimization strategy if its condition passes, threading
// through the container analysis and current network capture so strategies can
// make data-driven choices (e.g., which domains to preconnect).
async function applyOptimizationStrategy(repoPath, iteration, context) {
  const strategy = selectOptimizationForIteration(iteration);
  if (strategy.condition && !strategy.condition(context)) {
    return { skipped: strategy.name, reason: 'condition not met' };
  }
  const result = await strategy.apply(repoPath, context);
  return { name: strategy.name, ...result };
}

// Pushes to the configured preview branch and waits for AEM Code Sync. The
// branch is read from config so multi-branch workflows (e.g., parallel
// experiments) don't collide on a hardcoded name.
async function deployToPreview(target) {
  const { execSync } = require('child_process');
  const branch = target.branch ?? 'martech-migration';
  execSync(`git push origin ${branch}`, { cwd: target.repo_path, stdio: 'inherit' });
  // AEM Code Sync webhook latency is usually <30s; give it a fixed pause
  // before measurement to avoid racing the preview URL.
  await new Promise((resolve) => setTimeout(resolve, 30000));
}
```

---

## Boilerplate Compatibility

All current EDS projects use `aem.js`. The `loadEager` hook is an exported default function:

```javascript
// scripts/scripts.js — aem.js boilerplate (all current repos)
export default async function loadEager(doc) {
  // ... decoration code ...
  // martech eager init goes here
}
```

```javascript
function detectBoilerplate(scriptsJsContent) {
  if (/from ['"]\.\/aem\.js['"]/i.test(scriptsJsContent)) return 'aem.js';
  // lib-franklin.js is fully retired — warn if encountered
  console.warn('Unexpected legacy boilerplate detected — review manually');
  return 'unknown';
}
```

---

## Configuration Schema

```yaml
# martech-migration-config.yaml

source:
  site_url: "https://original-site.com/"
  scripts_js_url: "https://original-site.com/scripts/scripts.js"

container:
  type: "launch"  # or "gtm" or "both"
  launch:
    container_url: "https://assets.adobedtm.com/.../launch-xxx.min.js"
    api_credentials:
      client_id: "${LAUNCH_CLIENT_ID}"
      client_secret: "${LAUNCH_CLIENT_SECRET}"
      org_id: "${IMS_ORG_ID}"
  gtm:
    container_id: "GTM-XXXXXXX"
    api_credentials:
      service_account_key: "${GTM_SERVICE_ACCOUNT_KEY_PATH}"

target:
  repo_path: "/path/to/eds-project"
  preview_url: "https://main--repo--org.aem.page/"
  
adobe_stack:
  datastream_id: "${DATASTREAM_ID}"
  analytics_rsid: "${ANALYTICS_RSID}"
  target_property_token: "${TARGET_PROPERTY_TOKEN}"

optimization:
  max_iterations: 5
  performance_targets:
    lcp_max_ms: 2500
    cls_max: 0.1
    tbt_max_ms: 200
  
human_review:
  notify_on_completion: true
  notification_channel: "slack"  # or "email"
```

---

## Metrics Dashboard

Track across iterations:

| Metric | Baseline | Iter 1 | Iter 2 | Iter 3 | Target |
|--------|----------|--------|--------|--------|--------|
| LCP (ms) | 3200 | 2800 | 2500 | 2400 | ≤2500 |
| CLS | 0.15 | 0.12 | 0.08 | 0.05 | ≤0.1 |
| TBT (ms) | 450 | 300 | 200 | 180 | ≤200 |
| Missing Calls | 0 | 2 | 0 | 0 | 0 |
| Status | — | REGRESSION | PARTIAL | SUCCESS | — |

---

## Error Handling

```javascript
const ERROR_HANDLERS = {
  'API_AUTH_FAILED': async (error, config) => {
    // Prompt for new credentials
    return { action: 'REQUEST_CREDENTIALS', message: 'API authentication failed' };
  },
  
  'CONTAINER_NOT_FOUND': async (error, config) => {
    // Fallback to source code analysis
    return { action: 'FALLBACK_TO_SOURCE_ANALYSIS' };
  },
  
  'DEEP_PSI_TIMEOUT': async (error, config) => {
    // Retry with longer timeout
    return { action: 'RETRY', delay: 60000 };
  },
  
  'REGRESSION_UNFIXABLE': async (error, config) => {
    // Escalate to human
    return { action: 'ESCALATE_TO_HUMAN', reason: error.message };
  }
};
```

---

## Success Criteria

The loop terminates successfully when **all four** conditions are met:

| Criterion | Measure | Pass Condition |
|-----------|---------|----------------|
| **Performance** | Deep-PSI scores (LCP, CLS, TBT) | Equal to or better than baseline |
| **No flicker** | Personalization render timing | Content visible before alloy propositions apply (no FOUC) |
| **Analytics fires** | Network calls to `edge.adobedc.net` or GA | Page view beacon present with correct XDM / GA4 payload |
| **No regressions** | All third-party network calls | Every call present in baseline is still present post-migration (order may differ) |

Any failing criterion triggers another iteration (up to `MAX_ITERATIONS`), then escalates to human review.

The result is then passed to Phase 7 (Human Review) for final approval and merge to production.

---

## Input/Output Specification

### Input Schema

```yaml
required:
  - source_scripts_js: URL or file content of the customer's current scripts.js
  - container_type: "launch" | "gtm" | "both"
  - container_url: The Launch or GTM container URL(s)

optional:
  - site_url: Live URL of the current site (for network call baseline)
  - ims_org_id: Customer's IMS Org ID (for Adobe stack)
  - datastream_id: Customer's AEP Datastream ID
  - analytics_rsid: Adobe Analytics Report Suite ID
  - ga_measurement_id: Google Analytics Measurement ID
  - target_property_token: Target property token if applicable
```

### Output Schema

```yaml
output:
  - migrated_scripts_js: Updated scripts.js with EDS martech integration
  - migration_report:
      detected_stack: "launch" | "gtm" | "both"
      eager_phase: list of what was extracted for eager loading
      lazy_phase: list of what was extracted for lazy loading
      delayed_phase: description of what remains in the container
      data_layer_mappings: mapping of original data points to new instrumentation
      manual_review_items: list of anything ambiguous or requiring human attention
      confidence_level: "high" | "medium" | "low"
```

---

## Data Layer Mapping

XDM fields, eVars, props, and GA dimensions previously populated inside the container must be explicitly populated in EDS code before the analytics beacon fires. Flag any field that cannot be confidently mapped for human review.

**Implementation:** See [`references/data-layer-mapping.md`](../references/data-layer-mapping.md) for `extractDataLayerSchema`, `generateDataLayerCode`, `validateDataLayerMapping`, and guidance on ambiguous mappings.

---

## Consent Interaction

When personalization and analytics are extracted from the container into EDS code, consent checks that were previously handled inside the container must be re-implemented in `scripts.js`. Failure to do this will fire martech calls before the user has given consent.

**Implementation:** See [`references/consent-gated-architecture.md`](../references/consent-gated-architecture.md) for `hasAnalyticsConsent`, `hasPersonalizationConsent`, OneTrust event listener patterns, and the full consent-gated `loadEager` structure from real production projects.

---

## Delayed Phase: requestIdleCallback vs setTimeout

Prefer `requestIdleCallback` over a fixed 3-second timeout when tags are not time-sensitive.

### Implementation

```javascript
// scripts/delayed.js
function loadDelayedContent() {
  // Load remaining container and non-critical tags
  loadScript(CONTAINER_URL, { async: true });
  
  // Other delayed functionality...
}

// Prefer requestIdleCallback for better performance
if ('requestIdleCallback' in window) {
  requestIdleCallback(loadDelayedContent, { timeout: 5000 });
} else {
  // Fallback for Safari and older browsers
  setTimeout(loadDelayedContent, 3000);
}
```

### When to Use Each

| Scenario | Approach | Why |
|----------|----------|-----|
| Social pixels, RUM | `requestIdleCallback` | Not time-sensitive, can wait for idle |
| Cookie consent UI | `setTimeout(3000)` | Needs predictable timing for compliance |
| Analytics (if not in lazy) | `setTimeout(3000)` | Needs to fire within session window |

---

## WebSDK Container Splitting (v2.34.0+)

WebSDK v2.34.0+ of the Launch extension supports native container splitting. Reference this when applicable.

### Detection

```javascript
// Fetches the Launch container bundle and reads the alloy version embedded
// inside it. Returns null when the version cannot be determined so callers
// fall back to the manual aem-martech path rather than misapplying native
// splitting on an older runtime.
async function detectWebSDKVersion(containerUrl) {
  const source = await fetch(containerUrl).then((r) => r.text());
  // alloy bundles include a version banner like: "alloy":"2.34.0" or
  // libVersion:"2.34.0". Match either form.
  const match = source.match(/(?:alloy|libVersion)["':\s]+(\d+\.\d+\.\d+)/i);
  if (!match) return null;
  const [major, minor] = match[1].split('.').map(Number);
  return {
    version: match[1],
    supportsNativeSplitting: major > 2 || (major === 2 && minor >= 34),
  };
}
```

### Native Splitting Configuration

When WebSDK 2.34.0+ is detected, the Launch container can be configured to:
- Handle personalization in the container's "page top" rule
- Handle analytics in the container's "page bottom" rule
- The container itself manages the eager/lazy split internally

This reduces the need for manual alloy.js wiring but still requires:
- Container loads early (not in delayed phase)
- Proper rule ordering in the container
- Data layer populated before container fires

### When to Use

| Scenario | Approach |
|----------|----------|
| New implementation, WebSDK 2.34.0+ | Consider native splitting |
| Existing container with many custom rules | Manual aem-martech plugin (more control) |
| GTM (Google stack) | aem-gtm-martech plugin (native splitting N/A) |

---

## Testing

**Full test suites:** See [`references/testing.md`](../references/testing.md) for unit tests (`detectContainerType`, `selectStrategy`, `generateMigrationPlan`, `detectBoilerplate`), integration tests against the WKND martech hybrid project using the Sites Internal Org, performance tests (LCP/CLS/TBT regression checks), regression tests (network call comparison), and the manual verification checklist.

---

## Open Questions & Risks

| Risk | Mitigation |
|------|------------|
| **Data layer mapping complexity** — Highly customized data layers may not map correctly | Flag unmapped fields for human review; provide mapping suggestions based on field names |
| **Container access permissions** — API access may not be available | Fallback to source code analysis; extract container URL and analyze loaded scripts |
| **Ambiguous tag identification** — Custom-named tags don't follow conventions | Use heuristics + LLM reasoning; flag low-confidence classifications |
| **Hybrid GTM + Launch scenarios** — Adds complexity | Support dual martech pattern; clearly document which container handles what |
| **Cookie consent interaction** — Extracting tags breaks consent gating | Re-implement consent checks in EDS code; test with consent denied |

