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

### Step 0.2: Note the Baseline URL

Deep-PSI is a **two-URL comparison tool**: it runs 20 PSI iterations per URL in the same session (shared cache-busting logic, same pass count) and applies a two-sample t-test per metric. The loop uses it end-to-end — baseline and iteration are measured together in Phase 4, not separately.

This means Phase 0 doesn't need to capture performance numbers on their own. Record the original URL so Phase 4 can pass it to Deep-PSI alongside the preview URL each iteration.

```javascript
// Baseline record is just the URL; Deep-PSI measures original and preview
// together every iteration, keeping both sides in the same measurement
// environment.
const baseline = { originalUrl: config.source.site_url };
```

> **Why not measure baseline once and reuse?** Comparing a baseline captured on day 1 against preview captured on day 3 mixes measurement environments (different Lighthouse versions on the server, different cache states, different network conditions). Re-measuring the original URL each iteration — in the same Deep-PSI session as the preview URL — eliminates that drift.

---

## Phase 1: Container Analysis

Container analysis has two paths depending on available access. Use the API path when credentials are available; otherwise fall back to source code analysis.

### Path A: Source Code Analysis (Always Available)

Path A is a **three-stage pipeline**. Earlier stages are cheap and deterministic; later stages are paid but catch what earlier ones miss. This is the same pattern used across the workflow — do the free, high-confidence work first, then escalate.

| Stage | What | Cost | Confidence |
|-------|------|------|------------|
| 1. Regex scan | Match known vendor signatures (Adobe, GTM, Optimizely, VWO, Dynamic Yield, Segment, Mixpanel, Amplitude, Heap, Hotjar, Contentsquare, OneTrust, Cookiebot, …) in the raw bundle | Free | High when matched |
| 2. Slice + format | Extract ±4 KB character windows around *near-miss anchors* (`track`, `experiment`, `consent`, etc.) and format each slice with `prettier` | ~1 s × ≤10 slices | — |
| 3. LLM triage | Classifier returns `{vendor, category, phase, confidence, reasoning}` per slice | Paid; capped at `MAX_LLM_SLICES=10` | Self-reported |

The staged order matters: regex handles the 80% case deterministically, slicing avoids sending a 500 KB bundle to the LLM, and `MAX_LLM_SLICES` is a hard cost ceiling.

```javascript
// Skeleton — full implementation in references/source-code-analysis.md.
async function analyzeFromSource(scriptsJsContent, containerUrl) {
  const containerType = detectContainerType(scriptsJsContent);
  const source = await fetch(containerUrl).then((r) => r.text());
  const matches = scanSignatures(source);              // Stage 1
  const residual = await triageResidual(source, matches); // Stages 2 + 3
  const all = [...matches, ...residual];
  return {
    containerType,
    vendors: all,
    hasPersonalization: all.some((m) => m.category === 'personalization'),
    hasAnalytics: all.some((m) => m.category.startsWith('analytics')),
    confidence: all.every((m) => m.confidence === 'high') ? 'high' : 'mixed',
  };
}
```

**Implementation:** See [`references/source-code-analysis.md`](../references/source-code-analysis.md) for the full `VENDOR_SIGNATURES` table, `triageResidual` (slice + format + classify), `formatSlice` (prettier-on-demand with soft fail), `dedupeFindings`, and the LLM classifier prompt contract.

> **Flag for human review** any finding where `confidence !== 'high'` — regardless of whether it came from regex or the LLM. The LLM stage expands *coverage*, not *certainty*.

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

### Step 4.2: Run Deep-PSI Comparison

Feed both URLs — original and preview — into Deep-PSI's comparison form (`#url1`, `#url2`, Submit). It runs 20 PSI iterations per URL in the same session, then emits:

1. A results table per URL with a stable (avg ± stddev) summary row across all runs.
2. A **Statistical Significance Test** section (two-sample t-test, α = 0.05) that labels each metric's difference as "Significant" or "Not significant" with a p-value.

Deep-PSI supplies the significance call; the loop combines that with a direction check (preview vs. original stable average, respecting that lower-is-better for time/CLS and higher-is-better for Score) to produce the per-metric verdict: `improved` / `regressed` / `flat`. No local noise floor — the t-test already filters noise.

```javascript
// Installs Playwright + Chromium on demand. No-ops when already present, so
// calling this at loop startup is safe.
async function ensurePlaywright() {
  const { execSync } = require('child_process');
  try { require.resolve('playwright'); }
  catch { execSync('npm install --no-save playwright', { stdio: 'inherit' }); }
  execSync('npx playwright install chromium', { stdio: 'inherit' });
  return require('playwright');
}

// Deep-PSI runs 20 PSI iterations per URL by default and emits (a) a per-URL
// results table and (b) a two-sample t-test section with a p-value verdict
// per metric. Significance comes from the tool; direction (improved vs
// regressed) is computed here from the two stable averages.
//
// Columns in the results table, in order. Time metrics are in seconds; CLS
// is unitless; Score is the Lighthouse performance score (0-100).
const DEEP_PSI_METRICS = ['FCP', 'SI', 'LCP', 'TTI', 'TBT', 'CLS', 'Score'];
const DEEP_PSI_CORE = ['LCP', 'CLS', 'TBT']; // drive the pass/fail decision
const DEEP_PSI_URL = 'https://tools.aem.live/tools/deep-psi/deep-psi.html';
const DEEP_PSI_TIMEOUT_MS = 600_000; // 20 PSI runs per URL + t-test ~ several minutes

// For most metrics, lower is better; Score is the exception. Direction is
// determined by comparing preview vs original only after the t-test says the
// difference is significant — otherwise it's noise.
const LOWER_IS_BETTER = new Set(['FCP', 'SI', 'LCP', 'TTI', 'TBT', 'CLS']);

// Drives Deep-PSI's two-URL comparison via Playwright. Both URLs run in the
// same session, same pass count, same cache-busting logic — so the verdict
// reflects real migration impact, not drift between measurement environments.
// Throws on parse/timeout; the caller escalates rather than feeding bogus
// data into the loop decision.
async function compareWithDeepPsi(originalUrl, previewUrl, label = 'iteration') {
  const { chromium } = await ensurePlaywright();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(DEEP_PSI_URL);

    // The form uses concrete IDs: url1 (required), url2 (optional), plus a
    // <button type="submit">Submit</button>.
    await page.locator('#url1').fill(originalUrl);
    await page.locator('#url2').fill(previewUrl);
    await page.getByRole('button', { name: 'Submit' }).click();

    // Completion signal: the significance-test list renders only after both
    // URLs have finished all their PSI runs and the t-test has been computed.
    await page.waitForSelector('#significancetestresults li', { timeout: DEEP_PSI_TIMEOUT_MS });

    // Pull the DOM directly; innerText-scraping is fragile and loses the
    // per-metric structure that #significancetestresults provides for free.
    const raw = await page.evaluate(() => {
      const tables = document.querySelectorAll('main table');
      // Last row of each URL's table holds the stable average as "X (avg ± stddev)".
      const readStableRow = (table) => {
        if (!table) return null;
        const rows = table.querySelectorAll('tbody tr');
        const cells = rows[rows.length - 1]?.querySelectorAll('td');
        return cells ? Array.from(cells).map((c) => c.textContent.trim()) : null;
      };
      const sig = Array.from(document.querySelectorAll('#significancetestresults li')).map((li) => ({
        metric: li.querySelector('code')?.textContent.trim(),
        pText: li.querySelector('.psi-sig-p')?.textContent.trim(),
        significant: li.querySelector('.psi-sig-verdict')?.classList.contains('psi-sig-verdict-yes'),
      }));
      return {
        url1Row: readStableRow(tables[0]),
        url2Row: readStableRow(tables[1]),
        significance: sig,
      };
    });

    return parseDeepPsiOutput(raw, { originalUrl, previewUrl, label });
  } finally {
    await browser.close();
  }
}

// Pure function over Deep-PSI's scraped DOM data. Separated so it can be unit
// tested with fixture objects when the tool's markup shifts. Throws on
// structural surprises — the loop escalates rather than guess.
function parseDeepPsiOutput(raw, { originalUrl, previewUrl, label }) {
  const { url1Row, url2Row, significance } = raw;
  if (!url1Row || !url2Row) {
    throw new Error('DEEP_PSI_EXTRACTION_FAILED: missing results table');
  }
  if (url1Row.length < DEEP_PSI_METRICS.length || url2Row.length < DEEP_PSI_METRICS.length) {
    throw new Error(`DEEP_PSI_EXTRACTION_FAILED: unexpected column count (got ${url1Row.length}/${url2Row.length})`);
  }

  // Each table cell looks like "1.126 (1.165 ± 0.222)"; the leading number is
  // the stable value Deep-PSI recommends using for comparison. Fall back to
  // the parenthesized average if the stable value is missing.
  const parseStable = (cell) => {
    const leading = parseFloat(cell);
    if (!Number.isNaN(leading)) return leading;
    const m = cell.match(/\(\s*([\d.]+)/);
    return m ? parseFloat(m[1]) : NaN;
  };

  const sigByMetric = new Map(significance.map((s) => [s.metric, s]));

  const metrics = {};
  for (let i = 0; i < DEEP_PSI_METRICS.length; i++) {
    const m = DEEP_PSI_METRICS[i];
    const original = parseStable(url1Row[i]);
    const preview = parseStable(url2Row[i]);
    const sig = sigByMetric.get(m);

    let verdict;
    if (!sig) {
      // Score has no significance row in Deep-PSI's output; treat it as flat
      // unless the reviewer wants it factored in later.
      verdict = 'flat';
    } else if (!sig.significant) {
      verdict = 'flat';
    } else {
      const lowerBetter = LOWER_IS_BETTER.has(m);
      const previewBetter = lowerBetter ? preview < original : preview > original;
      verdict = previewBetter ? 'improved' : 'regressed';
    }

    metrics[m.toLowerCase()] = {
      original,
      preview,
      pValue: sig ? parseFloat((sig.pText ?? '').replace(/[^\d.e+-]/gi, '')) : null,
      significant: sig?.significant ?? false,
      verdict,
    };
  }

  const coreKeys = DEEP_PSI_CORE.map((m) => m.toLowerCase());
  const overallImproved = coreKeys.some((k) => metrics[k].verdict === 'improved')
    && !coreKeys.some((k) => metrics[k].verdict === 'regressed');
  const hasRegressions = coreKeys.some((k) => metrics[k].verdict === 'regressed');

  return {
    label,
    originalUrl,
    previewUrl,
    timestamp: Date.now(),
    source: 'deep-psi-comparison',
    metrics,
    overallImproved,
    hasRegressions,
  };
}
```

> **Units:** Deep-PSI reports time metrics (FCP, SI, LCP, TTI, TBT) in **seconds**, CLS as a unitless ratio, and Score as a 0–100 integer. `original` / `preview` in the output above carry those raw values — downstream code that renders deltas should annotate units when presenting to humans.

> **Why not fall back to a different tool on failure?** A fallback that measures differently (PSI API averaging, single Lighthouse run, etc.) silently changes the measurement system mid-loop and produces incomparable numbers. If Deep-PSI fails, the loop escalates via the `DEEP_PSI_TIMEOUT` / `DEEP_PSI_EXTRACTION_FAILED` handlers in [Error Handling](#error-handling) — retry first, then human review.

### Step 4.3: Use Deep-PSI's Verdict Directly

No local delta math. The Phase 6 decision reads `result.overallImproved` and `result.hasRegressions` from the Deep-PSI comparison — the statistical significance is already baked in.

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
// Reads the performance verdict directly from the Deep-PSI comparison result
// (no local delta math) and combines it with the network regression report.
// Deep-PSI already applies statistical significance across multiple Lighthouse
// passes, so we don't re-compute noise floors here.
//
// Two independent regression axes:
//   - perf regression:    a core Deep-PSI metric got significantly worse
//   - network regression: a baseline third-party call is missing post-migration
// Either failure short-circuits to REGRESSION.
function evaluateIteration(comparison, regressionReport, iteration) {
  const perfImproved = comparison.overallImproved;
  const perfRegressed = comparison.hasRegressions;
  const networkRegressed = regressionReport.hasRegressions;

  let status;
  let nextAction;
  if (networkRegressed || perfRegressed) {
    status = 'REGRESSION';
    nextAction = 'FIX_REGRESSIONS';
  } else if (perfImproved) {
    status = 'SUCCESS';
    nextAction = 'PROCEED_TO_HUMAN_REVIEW';
  } else {
    // Neither improved nor regressed — Deep-PSI called it flat. Try another
    // optimization strategy before giving up.
    status = 'PARTIAL';
    nextAction = 'ATTEMPT_OPTIMIZATION';
  }

  return {
    iteration,
    perfImproved,
    perfRegressed,
    networkRegressed,
    status,
    nextAction,
  };
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
  const last = iterations[iterations.length - 1];

  return {
    summary: {
      totalIterations: iterations.length,
      finalStatus: last.decision.status,
      // Full Deep-PSI comparison (per-metric verdicts + original/preview numbers)
      comparison: last.comparison,
      regressionStatus: last.regressionReport.status,
    },

    filesChanged: [
      'scripts/scripts.js',
      'scripts/delayed.js',
      'head.html',
      // ... other files
    ],

    diffLinks: {
      scriptsJs: 'https://github.com/org/repo/compare/main...martech-migration#diff-scripts-js',
      // ...
    },

    testUrls: {
      preview: 'https://martech-migration--repo--org.aem.page/',
      deepPsi: 'https://tools.aem.live/tools/deep-psi/deep-psi.html',
    },

    manualChecks: [
      '[ ] Personalization renders without flicker',
      '[ ] Analytics data appears in reports',
      '[ ] Consent banner functions correctly',
      '[ ] No console errors related to martech',
    ],

    // One row per iteration with the LCP verdict (the metric reviewers care
    // about most) plus regression counts. Full per-metric detail is in
    // `comparison` on each iteration record.
    iterationHistory: iterations.map((i) => ({
      iteration: i.iteration,
      status: i.decision.status,
      lcpVerdict: i.comparison?.metrics.lcp.verdict ?? 'unknown',
      lcpOriginal: i.comparison?.metrics.lcp.original ?? null,
      lcpPreview: i.comparison?.metrics.lcp.preview ?? null,
      missingCalls: i.regressionReport.missingCount,
    })),
  };
}
```

### Step 7.2: Present to Human

```markdown
## Martech Migration Review

### Summary
- **Iterations:** ${totalIterations}
- **Final Status:** ${finalStatus}
- **Performance (Deep-PSI verdict, t-test α = 0.05):**
  - LCP: ${comparison.metrics.lcp.verdict} (${comparison.metrics.lcp.original}s → ${comparison.metrics.lcp.preview}s, p = ${comparison.metrics.lcp.pValue})
  - CLS: ${comparison.metrics.cls.verdict} (${comparison.metrics.cls.original} → ${comparison.metrics.cls.preview}, p = ${comparison.metrics.cls.pValue})
  - TBT: ${comparison.metrics.tbt.verdict} (${comparison.metrics.tbt.original}s → ${comparison.metrics.tbt.preview}s, p = ${comparison.metrics.tbt.pValue})

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

  // Phase 0 — only the network baseline is captured up front (it's cheap and
  // doesn't suffer from measurement drift the way performance metrics do).
  // Performance is measured fresh each iteration via Deep-PSI two-URL
  // comparison, which re-samples the original URL alongside the preview URL
  // in the same session.
  const baseline = {
    originalUrl: config.source.site_url,
    network: await captureNetworkBaseline(config.source.site_url),
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

    // Phase 4 — deploy, then run Deep-PSI comparison: original vs preview,
    // measured together in one session so both sides share the same pass
    // count, cache state, and cache-busting logic.
    await deployToPreview(config.target);
    const comparison = await compareWithDeepPsi(
      baseline.originalUrl,
      config.target.preview_url,
      `iter-${i}`,
    );

    // Phase 5 — network regression check.
    const currentNetwork = await captureNetworkBaseline(config.target.preview_url);
    const regressionReport = compareNetworkCalls(baseline.network, currentNetwork);

    // Phase 6 — decide what to do next. Deep-PSI's verdict drives the
    // performance axis; the network report drives the regression axis.
    const decision = evaluateIteration(comparison, regressionReport, i);
    const record = { iteration: i, plan, comparison, regressionReport, decision };

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

Each iteration re-runs Deep-PSI comparison against the original URL, so columns show the per-iteration verdict (Deep-PSI's own significance call) alongside the measured original → preview values.

| Metric | Iter 1 | Iter 2 | Iter 3 | Target |
|--------|--------|--------|--------|--------|
| LCP (original → preview, seconds) | 3.20 → 3.10 (regressed) | 3.20 → 2.50 (improved) | 3.20 → 2.40 (improved) | improved or flat |
| CLS | 0.15 → 0.12 (flat) | 0.15 → 0.08 (improved) | 0.15 → 0.05 (improved) | improved or flat |
| TBT (seconds) | 0.45 → 0.48 (regressed) | 0.45 → 0.20 (improved) | 0.45 → 0.18 (improved) | improved or flat |
| Missing Network Calls | 2 | 0 | 0 | 0 |
| Status | REGRESSION | PARTIAL | SUCCESS | — |

---

## Error Handling

```javascript
// Retry budget for Deep-PSI: the only sanctioned recovery path for
// measurement failures. Falling back to a different tool would change the
// measurement system mid-loop and produce incomparable numbers, so we retry
// first and escalate if the retries don't recover.
const DEEP_PSI_MAX_RETRIES = 2;

const ERROR_HANDLERS = {
  API_AUTH_FAILED: async () => ({
    action: 'REQUEST_CREDENTIALS',
    message: 'API authentication failed',
  }),

  CONTAINER_NOT_FOUND: async () => ({
    action: 'FALLBACK_TO_SOURCE_ANALYSIS',
  }),

  // Deep-PSI is slow by design (multiple Lighthouse passes). A single timeout
  // is usually transient network jitter; retry with back-off, then escalate.
  DEEP_PSI_TIMEOUT: async (_error, { attempt = 0 } = {}) => (
    attempt < DEEP_PSI_MAX_RETRIES
      ? { action: 'RETRY', delay: 60_000 * (attempt + 1) }
      : { action: 'ESCALATE_TO_HUMAN', reason: 'Deep-PSI repeatedly timed out — cannot measure this iteration' }
  ),

  // Parse failures usually mean the Deep-PSI UI changed. Retrying the same
  // parse won't help, so escalate immediately rather than wasting time.
  DEEP_PSI_EXTRACTION_FAILED: async (error) => ({
    action: 'ESCALATE_TO_HUMAN',
    reason: `Deep-PSI output format unrecognized: ${error.message}. Check parseDeepPsiOutput fixtures.`,
  }),

  DEEP_PSI_UI_CHANGED: async (error) => ({
    action: 'ESCALATE_TO_HUMAN',
    reason: `Deep-PSI UI changed: ${error.message}. Update selectors in compareWithDeepPsi.`,
  }),

  REGRESSION_UNFIXABLE: async (error) => ({
    action: 'ESCALATE_TO_HUMAN',
    reason: error.message,
  }),
};
```

> **No fallback measurement system.** If Deep-PSI fails after retries, the loop escalates rather than silently switching to a different tool. Comparing numbers captured with different pass counts, different cache-busting logic, or different environments is worse than an explicit "measurement unavailable" — it produces decisions on measurement drift rather than real performance change.

---

## Success Criteria

The loop terminates successfully when **all four** conditions are met:

| Criterion | Measure | Pass Condition |
|-----------|---------|----------------|
| **Performance** | Deep-PSI two-URL comparison verdict (LCP, CLS, TBT) | At least one core metric `improved` and none `regressed` (Deep-PSI computes the significance; the loop does not apply its own noise floor) |
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
| **LLM cost/latency on large containers** — Path A Stage 3 sends formatted slices to an LLM; a 500 KB bundle with many anchors could trigger many calls | Bound by `MAX_LLM_SLICES=10` and ±4 KB slice windows around near-miss anchors (never the full bundle); regex-matched vendors are excluded from the prompt so the LLM only reasons about residual code |
| **Noisy iteration history on the feature branch** — Phase 3 runs `git commit` inside the loop, so each iteration adds a commit to the `martech-migration` branch (up to `max_iterations`, default 5). If Phase 7 opens a PR from that branch later, reviewers see the churn ("iter 1: apply martech", "iter 2: defer non-critical tags", "iter 3: add preconnects", …) instead of one clean commit | Before Phase 7 generates the review package, squash the iteration commits on the branch into a single commit (or have Phase 3 `git commit --amend --no-edit` after iteration 1). The preview URL still updates on each push since it's branch-scoped, not commit-scoped, so squash/amend doesn't break the Deep-PSI measurement flow |

