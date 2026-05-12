# Martech Migration — Testing Reference

Test suites for validating a martech migration to Edge Delivery Services. Run after each optimization loop iteration and as a final gate before human review.

## Unit Tests

```javascript
// test/migration.test.js

describe('Martech Migration', () => {
  test('detects Launch container from scripts.js', () => {
    const scriptsJs = `loadScript('https://assets.adobedtm.com/xxx/launch-xxx.min.js')`;
    expect(detectContainerType(scriptsJs)).toBe('launch');
  });

  test('detects GTM container from scripts.js', () => {
    const scriptsJs = `loadScript('https://www.googletagmanager.com/gtm.js?id=GTM-XXXXXX')`;
    expect(detectContainerType(scriptsJs)).toBe('gtm');
  });

  test('detects both containers', () => {
    const scriptsJs = `
      loadScript('https://assets.adobedtm.com/xxx/launch-xxx.min.js');
      loadScript('https://www.googletagmanager.com/gtm.js?id=GTM-XXXXXX');
    `;
    expect(detectContainerType(scriptsJs)).toBe('both');
  });

  test('selectStrategy returns aem-martech for Adobe stack with personalization', () => {
    const analysis = { personalization: [{ name: 'Target' }], analytics_pageview: [{}], type: 'launch' };
    expect(selectStrategy(analysis)).toMatchObject({ plugin: 'aem-martech', approach: 'full-adobe-stack' });
  });

  test('selectStrategy returns aem-gtm-martech for GTM without personalization', () => {
    const analysis = { personalization: [], analytics_pageview: [{}], type: 'gtm' };
    expect(selectStrategy(analysis)).toMatchObject({ plugin: 'aem-gtm-martech', approach: 'gtm-only' });
  });

  test('generateMigrationPlan enforces extraction boundary', () => {
    const strategy = { plugin: 'aem-martech', approach: 'full-adobe-stack' };
    const plan = generateMigrationPlan(strategy, {}, 1);
    expect(plan.eager).toContain('alloy.js init');
    expect(plan.lazy).toContain('analytics page view beacon');
    expect(plan.delayed).toContain('container URL');
  });

  test('detectBoilerplate identifies aem.js', () => {
    const scriptsJs = `import { loadCSS } from './aem.js';`;
    expect(detectBoilerplate(scriptsJs)).toBe('aem.js');
  });

  test('detectBoilerplate warns on unknown boilerplate', () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const scriptsJs = `import { loadCSS } from './some-other-lib.js';`;
    expect(detectBoilerplate(scriptsJs)).toBe('unknown');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('legacy boilerplate'));
    consoleSpy.mockRestore();
  });
});
```

## Integration Tests (WKND Martech Hybrid — Sites Internal Org)

Use the [WKND martech hybrid](https://github.com/hlxsites/wknd/blob/adobe-martech-hybrid/scripts/scripts.js#L28-L61) project as the test baseline. Apply the skill output to a fresh EDS boilerplate project connected to the Sites Internal Org (Target, AEP, Analytics).

```javascript
// test/integration.test.js

const PREVIEW_URL = process.env.PREVIEW_URL;
const ORIGINAL_URL = process.env.ORIGINAL_URL;

describe('Integration Tests', () => {
  test('personalization renders without flicker', async () => {
    const page = await browser.newPage();

    let flickerDetected = false;
    await page.evaluateOnNewDocument(() => {
      new MutationObserver(() => {
        const personalized = document.querySelector('[data-personalized]');
        if (personalized && personalized.style.visibility === 'hidden') {
          window.__flickerDetected = true;
        }
      }).observe(document, { childList: true, subtree: true });
    });

    await page.goto(PREVIEW_URL);
    await page.waitForLoadState('networkidle');

    flickerDetected = await page.evaluate(() => !!window.__flickerDetected);
    expect(flickerDetected).toBe(false);
  });

  test('analytics beacon fires with correct XDM payload', async () => {
    const analyticsRequests = [];

    page.on('request', req => {
      if (req.url().includes('edge.adobedc.net') && req.url().includes('interact')) {
        analyticsRequests.push(req);
      }
    });

    await page.goto(PREVIEW_URL);
    await page.waitForTimeout(5000); // Wait for lazy phase

    expect(analyticsRequests.length).toBeGreaterThan(0);
    const payload = JSON.parse(analyticsRequests[0].postData());
    expect(payload.events[0].xdm.web.webPageDetails.name).toBeTruthy();
  });

  test('container still loads in delayed phase', async () => {
    const containerRequests = [];

    page.on('request', req => {
      if (req.url().includes('assets.adobedtm.com') || req.url().includes('googletagmanager.com')) {
        containerRequests.push({ url: req.url(), timing: Date.now() });
      }
    });

    const start = Date.now();
    await page.goto(PREVIEW_URL);
    await page.waitForTimeout(6000); // Wait past delayed phase

    expect(containerRequests.length).toBeGreaterThan(0);
    // Container should load after ~3s (delayed phase)
    const containerLoadTime = containerRequests[0].timing - start;
    expect(containerLoadTime).toBeGreaterThan(2500);
  });
});
```

## Performance Tests

Performance is measured by driving Deep-PSI's two-URL comparison once per test run — the same path the loop uses. Individual metrics are expected to be either `improved` or `flat` versus the original; any `regressed` verdict fails the test.

```javascript
// test/performance.test.js

describe('Performance Tests', () => {
  // One Deep-PSI run covers all core metrics, so cache the result.
  let comparison;
  beforeAll(async () => {
    comparison = await compareWithDeepPsi(ORIGINAL_URL, PREVIEW_URL, 'test');
  }, 10 * 60 * 1000); // Deep-PSI runs 20 PSI iterations per URL

  test('LCP does not regress (Deep-PSI t-test)', () => {
    expect(comparison.metrics.lcp.verdict).not.toBe('regressed');
  });

  test('CLS does not regress (Deep-PSI t-test)', () => {
    expect(comparison.metrics.cls.verdict).not.toBe('regressed');
  });

  test('TBT does not regress (Deep-PSI t-test)', () => {
    expect(comparison.metrics.tbt.verdict).not.toBe('regressed');
  });

  test('Lighthouse performance score on preview >= 90', () => {
    expect(comparison.metrics.score.preview).toBeGreaterThanOrEqual(90);
  });
});
```

### Deep-PSI Parser Unit Tests

`parseDeepPsiOutput` is a pure function over scraped DOM data. It's the most fragile surface in the integration — if Deep-PSI ships UI changes, this parser fails first. Unit-test it with captured fixtures rather than live runs (live runs take minutes and depend on network).

Fixture below is a real capture from `tools.aem.live/tools/deep-psi/deep-psi.html` comparing `aem.live` against a boilerplate preview URL. Refresh the fixture when the parser is updated.

```javascript
// test/deep-psi-parser.test.js

const FIXTURE_RAW = {
  url1Row: [
    '1.126 (1.165 ± 0.222)', // FCP
    '1.137 (1.821 ± 1.115)', // SI
    '1.351 (1.781 ± 0.719)', // LCP
    '1.351 (1.925 ± 1.099)', // TTI
    '0.000 (0.120 ± 0.533)', // TBT
    '0.002 (0.002 ± 0.000)', // CLS
    '100',                    // Score
  ],
  url2Row: [
    '1.050 (1.080 ± 0.180)',
    '1.700 (1.750 ± 0.900)',
    '1.200 (1.250 ± 0.600)',
    '1.800 (1.850 ± 1.000)',
    '0.100 (0.115 ± 0.500)',
    '0.002 (0.002 ± 0.000)',
    '100',
  ],
  significance: [
    { metric: 'FCP', pText: 'p = 0.00342',   significant: true  },
    { metric: 'SI',  pText: 'p = 0.0976',    significant: false },
    { metric: 'LCP', pText: 'p = 0.0000521', significant: true  },
    { metric: 'TTI', pText: 'p = 0.000865',  significant: true  },
    { metric: 'TBT', pText: 'p = 0.186',     significant: false },
    { metric: 'CLS', pText: 'p = 0.149',     significant: false },
  ],
};

describe('parseDeepPsiOutput', () => {
  const META = { originalUrl: 'https://a/', previewUrl: 'https://b/', label: 'test' };

  test('parses stable averages from table cells', () => {
    const out = parseDeepPsiOutput(FIXTURE_RAW, META);
    expect(out.metrics.lcp.original).toBeCloseTo(1.351);
    expect(out.metrics.lcp.preview).toBeCloseTo(1.200);
    expect(out.metrics.cls.original).toBeCloseTo(0.002);
  });

  test('significant + preview lower = improved (lower-is-better metric)', () => {
    const out = parseDeepPsiOutput(FIXTURE_RAW, META);
    expect(out.metrics.lcp.verdict).toBe('improved');
    expect(out.metrics.lcp.significant).toBe(true);
    expect(out.metrics.lcp.pValue).toBeCloseTo(0.0000521);
  });

  test('not significant = flat regardless of numeric delta', () => {
    const out = parseDeepPsiOutput(FIXTURE_RAW, META);
    // TBT went from 0 to 0.1 but p = 0.186 > 0.05 → flat
    expect(out.metrics.tbt.verdict).toBe('flat');
  });

  test('Score has no significance row → flat', () => {
    const out = parseDeepPsiOutput(FIXTURE_RAW, META);
    expect(out.metrics.score.verdict).toBe('flat');
    expect(out.metrics.score.significant).toBe(false);
  });

  test('overallImproved requires at least one core improvement and zero regressions', () => {
    const out = parseDeepPsiOutput(FIXTURE_RAW, META);
    // LCP improved, CLS/TBT flat → overallImproved true, hasRegressions false
    expect(out.overallImproved).toBe(true);
    expect(out.hasRegressions).toBe(false);
  });

  test('a significant core regression flips hasRegressions', () => {
    const regressed = {
      ...FIXTURE_RAW,
      url2Row: [...FIXTURE_RAW.url2Row],
      significance: FIXTURE_RAW.significance.map((s) => (
        s.metric === 'LCP' ? { ...s, significant: true } : s
      )),
    };
    regressed.url2Row[2] = '1.800 (1.850 ± 0.600)'; // preview LCP > original
    const out = parseDeepPsiOutput(regressed, META);
    expect(out.metrics.lcp.verdict).toBe('regressed');
    expect(out.hasRegressions).toBe(true);
    expect(out.overallImproved).toBe(false);
  });

  test('missing results table throws DEEP_PSI_EXTRACTION_FAILED', () => {
    expect(() => parseDeepPsiOutput({ url1Row: null, url2Row: null, significance: [] }, META))
      .toThrow(/DEEP_PSI_EXTRACTION_FAILED/);
  });

  test('unexpected column count throws DEEP_PSI_EXTRACTION_FAILED', () => {
    const short = { ...FIXTURE_RAW, url1Row: FIXTURE_RAW.url1Row.slice(0, 3) };
    expect(() => parseDeepPsiOutput(short, META)).toThrow(/unexpected column count/);
  });
});
```

## Regression Tests

```javascript
// test/regression.test.js

describe('Regression Tests', () => {
  test('all baseline third-party network calls are present after migration', async () => {
    const baselineCalls = await captureNetworkBaseline(ORIGINAL_URL);
    const migratedCalls = await captureNetworkBaseline(PREVIEW_URL);
    const comparison = compareNetworkCalls(baselineCalls, migratedCalls);
    expect(comparison.missingCalls).toHaveLength(0);
  });

  test('flags missing calls for human review', () => {
    const comparison = {
      missingCalls: [{ url: 'https://example.com/pixel' }],
      newCalls: [],
      totalBaseline: 1,
      totalCurrent: 0,
      hasRegressions: true,
    };
    const report = generateRegressionReport(comparison);
    expect(report.status).toBe('FAILED');
    expect(report.critical).toHaveLength(1);
    expect(report.recommendation).toContain('Investigate');
  });

  test('new calls are reported as informational only', () => {
    const comparison = {
      missingCalls: [],
      newCalls: [{ url: 'https://new.cdn.com/script.js' }],
      totalBaseline: 0,
      totalCurrent: 1,
      hasRegressions: false,
    };
    const report = generateRegressionReport(comparison);
    expect(report.status).toBe('PASSED');
    expect(report.informational).toHaveLength(1);
  });
});
```

## Manual Verification Checklist

After all automated tests pass, verify manually on the preview URL:

- [ ] Personalization renders without visible flicker on first load
- [ ] Adobe Target / AJO propositions apply correctly
- [ ] Analytics page view beacon fires in the correct phase (lazy — after LCP)
- [ ] Cookie consent banner appears and consent gating works (accept / reject and verify calls)
- [ ] Social pixels and other third-party tags still load (check Network tab at ~3s)
- [ ] No console errors related to martech (alloy, at.js, GTM, Analytics)
- [ ] Deep-PSI score on preview is equal to or better than original site baseline
