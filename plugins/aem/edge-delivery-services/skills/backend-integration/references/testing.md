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

```javascript
// test/performance.test.js

describe('Performance Tests', () => {
  test('LCP does not regress more than 10% after migration', async () => {
    const baseline = await measurePerformance(ORIGINAL_URL);
    const migrated = await measurePerformance(PREVIEW_URL);
    expect(migrated.lcp).toBeLessThanOrEqual(baseline.lcp * 1.1);
  });

  test('CLS does not regress after migration', async () => {
    const baseline = await measurePerformance(ORIGINAL_URL);
    const migrated = await measurePerformance(PREVIEW_URL);
    expect(migrated.cls).toBeLessThanOrEqual(baseline.cls * 1.1);
  });

  test('TBT does not regress after migration', async () => {
    const baseline = await measurePerformance(ORIGINAL_URL);
    const migrated = await measurePerformance(PREVIEW_URL);
    expect(migrated.tbt).toBeLessThanOrEqual(baseline.tbt * 1.1);
  });

  test('Deep-PSI performance score >= 90', async () => {
    const result = await measurePerformance(PREVIEW_URL);
    expect(result.performanceScore).toBeGreaterThanOrEqual(90);
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
    const comparison = { missingCalls: [{ url: 'https://example.com/pixel' }], hasRegressions: true };
    const report = generateRegressionReport(comparison);
    expect(report.status).toBe('FAILED');
    expect(report.critical).toHaveLength(1);
    expect(report.recommendation).toContain('Investigate');
  });

  test('new calls are reported as informational only', () => {
    const comparison = { missingCalls: [], newCalls: [{ url: 'https://new.cdn.com/script.js' }], hasRegressions: false };
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
