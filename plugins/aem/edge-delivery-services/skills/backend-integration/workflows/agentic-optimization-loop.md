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
async function captureDeepPsi(url, label = 'baseline') {
  const deepPsiUrl = `https://tools.aem.live/tools/deep-psi/deep-psi.html`;

  // 1. Open deep-PSI in Playwright browser
  await playwright.navigate(deepPsiUrl);

  // 2. Fill in the URL field and submit
  await playwright.fill('input[name="url"], input[type="url"]:first-of-type', url);
  await playwright.click('button[type="submit"], button:has-text("Submit")');

  // 3. Wait for results — deep-PSI runs multiple PSI iterations, allow up to 3 minutes
  await playwright.waitForSelector('.results, [data-metric="lcp"]', { timeout: 180000 });

  // 4. Extract metric averages from the results table
  const metrics = await playwright.evaluate(() => {
    const getText = (selector) =>
      parseFloat(document.querySelector(selector)?.textContent?.replace(/[^0-9.]/g, '') || '0');
    return {
      lcp: getText('[data-metric="lcp"] .average, .lcp-avg'),
      cls: getText('[data-metric="cls"] .average, .cls-avg'),
      tbt: getText('[data-metric="tbt"] .average, .tbt-avg'),
      fcp: getText('[data-metric="fcp"] .average, .fcp-avg'),
      performanceScore: getText('[data-metric="performance"] .average, .perf-avg'),
    };
  });

  return { label, url, timestamp: Date.now(), ...metrics };
}
```

> **Note:** If Playwright is not available, fall back to a single Google PSI API call:
> `GET https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=<URL>&strategy=mobile`
> This gives one data point without statistical averaging.

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
  // Primary: Playwright-driven deep-PSI (multi-run, statistically reliable)
  try {
    return await captureDeepPsi(previewUrl, label);
  } catch (e) {
    // Fallback: single Google PSI API call if Playwright unavailable
    console.warn('Deep-PSI via Playwright failed, falling back to single PSI call:', e.message);
    return await captureGooglePsi(previewUrl, label);
  }
}

async function captureGooglePsi(url, label) {
  const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile`;
  const response = await fetch(apiUrl);
  const results = await response.json();
  const audits = results.lighthouseResult.audits;
  return {
    label, url, timestamp: Date.now(),
    lcp: audits['largest-contentful-paint'].numericValue,
    cls: audits['cumulative-layout-shift'].numericValue,
    tbt: audits['total-blocking-time'].numericValue,
    fcp: audits['first-contentful-paint'].numericValue,
    performanceScore: results.lighthouseResult.categories.performance.score * 100,
  };
}
```

### Step 4.3: Calculate Performance Delta

```javascript
function calculatePerformanceDelta(baseline, current) {
  return {
    lcp: { 
      baseline: baseline.lcp, 
      current: current.lcp, 
      delta: current.lcp - baseline.lcp,
      improved: current.lcp < baseline.lcp
    },
    cls: { 
      baseline: baseline.cls, 
      current: current.cls, 
      delta: current.cls - baseline.cls,
      improved: current.cls < baseline.cls
    },
    tbt: { 
      baseline: baseline.tbt, 
      current: current.tbt, 
      delta: current.tbt - baseline.tbt,
      improved: current.tbt < baseline.tbt
    },
    overallImproved: (
      current.lcp <= baseline.lcp &&
      current.cls <= baseline.cls &&
      current.tbt <= baseline.tbt
    )
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

function callsMatch(call1, call2) {
  // Match by domain and path, ignore query params and timestamps
  const url1 = new URL(call1.url);
  const url2 = new URL(call2.url);
  return url1.hostname === url2.hostname && url1.pathname === url2.pathname;
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
const OPTIMIZATION_STRATEGIES = [
  {
    name: 'defer_non_critical_tags',
    description: 'Move more tags from container to delayed phase',
    apply: async (repoPath) => {
      // Identify tags that can be deferred further
    }
  },
  {
    name: 'lazy_load_alloy',
    description: 'Load alloy.js asynchronously if no personalization',
    condition: (analysis) => analysis.personalization.length === 0,
    apply: async (repoPath) => {
      // Change from sync to async alloy loading
    }
  },
  {
    name: 'reduce_data_layer_payload',
    description: 'Trim unnecessary data layer fields',
    apply: async (repoPath) => {
      // Analyze and remove unused data layer fields
    }
  },
  {
    name: 'add_preconnects',
    description: 'Add preconnect hints for third-party domains',
    apply: async (repoPath, networkCalls) => {
      const domains = [...new Set(networkCalls.map(c => new URL(c.url).hostname))];
      // Add preconnect for critical domains
    }
  }
];
```

### Step 6.3: Regression Fixes

When regressions are detected:

```javascript
async function fixRegressions(repoPath, regressionReport) {
  for (const missing of regressionReport.critical) {
    const category = missing.category;
    
    if (category === 'analytics') {
      // Analytics call missing - check data layer population
      await verifyDataLayerPopulation(repoPath);
    } else if (category === 'personalization') {
      // Personalization call missing - check alloy configuration
      await verifyAlloyConfiguration(repoPath);
    } else if (category === 'consent') {
      // Consent call missing - check OneTrust loading
      await verifyConsentLoading(repoPath);
    } else {
      // Other third-party call missing - ensure container still loads it
      await verifyContainerInclusion(repoPath, missing.url);
    }
  }
}
```

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

## Loop Orchestration

```javascript
async function runOptimizationLoop(config) {
  const MAX_ITERATIONS = 5;
  const iterations = [];
  
  // Phase 0: Capture baseline
  const baseline = {
    network: await captureNetworkBaseline(config.siteUrl),
    performance: await measurePerformance(config.siteUrl)
  };

  // Phase 1: Analyze container
  const containerAnalysis = await analyzeContainer(config);

  // Phase 2: Select strategy (recorded in migration plan)
  const migrationStrategy = selectStrategy(containerAnalysis);

  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    console.log(`\n=== Iteration ${i} ===\n`);

    // Phase 3: Apply instrumentation
    const migrationPlan = generateMigrationPlan(migrationStrategy, containerAnalysis, i);
    await applyInstrumentation(config.repoPath, migrationPlan);

    // Phase 4: Deploy and measure
    await deployToPreview(config.repoPath);
    const currentPerformance = await measurePerformance(config.previewUrl);
    const performanceDelta = calculatePerformanceDelta(baseline.performance, currentPerformance);

    // Phase 5: Verify regressions
    const currentNetwork = await captureNetworkBaseline(config.previewUrl);
    const regressionReport = compareNetworkCalls(baseline.network, currentNetwork);

    // Phase 6: Evaluate & decide
    const decision = evaluateIteration(performanceDelta, regressionReport, i);
    
    iterations.push({
      iteration: i,
      migrationPlan,
      performanceDelta,
      regressionReport,
      decision
    });
    
    // Check if we should stop
    if (decision.status === 'SUCCESS') {
      console.log('✅ Migration successful - proceeding to human review');
      break;
    } else if (decision.status === 'REGRESSION') {
      console.log('⚠️ Regression detected - attempting fix');
      await fixRegressions(config.repoPath, regressionReport);
    } else if (decision.nextAction === 'ATTEMPT_OPTIMIZATION') {
      console.log('📈 Attempting optimization');
      await applyOptimizationStrategy(config.repoPath, i);
    }
  }
  
  // Phase 7: Human review
  const reviewPackage = generateReviewPackage(iterations);
  return reviewPackage;
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
  // Cycle through strategies on successive iterations
  return [OPTIMIZATION_STRATEGIES[(iteration - 2) % OPTIMIZATION_STRATEGIES.length]];
}

// Apply the chosen optimization strategy from the OPTIMIZATION_STRATEGIES array
async function applyOptimizationStrategy(repoPath, iteration) {
  const strategies = selectOptimizationForIteration(iteration);
  for (const strategy of strategies) {
    if (!strategy.condition || strategy.condition({})) {
      await strategy.apply(repoPath);
      console.log(`Applied optimization: ${strategy.name}`);
    }
  }
}

// Push to preview branch and wait for AEM Code Sync
async function deployToPreview(repoPath) {
  const { execSync } = require('child_process');
  execSync('git push origin martech-migration', { cwd: repoPath, stdio: 'inherit' });
  // Poll for AEM Code Sync (up to 60s)
  await new Promise(resolve => setTimeout(resolve, 30000));
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
function detectWebSDKVersion(containerUrl) {
  // Fetch and parse container to find alloy version
  // If >= 2.34.0, native splitting is available
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

---

## Diagrams

Visual representations of this workflow are available:

- **Detailed flow:** `agentic-optimization-loop.puml`
- **Overview:** `agentic-loop-overview.puml`

Render with PlantUML: `plantuml agentic-optimization-loop.puml`

