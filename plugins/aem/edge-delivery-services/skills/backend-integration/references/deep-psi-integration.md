# Deep-PSI Integration — Full Implementation

Implementation for **Phase 4, Step 4.2** of [`workflows/agentic-optimization-loop.md`](../workflows/agentic-optimization-loop.md). The workflow carries the prose and a short skeleton; this file carries the full `compareWithDeepPsi` + `parseDeepPsiOutput` implementation, validated against the live tool at `https://tools.aem.live/tools/deep-psi/deep-psi.html`.

## What Deep-PSI emits

Validated via Playwright against the live UI:

| DOM element | Purpose |
|---|---|
| `#url1`, `#url2` (inputs, type=url) | First URL (required), Second URL (optional) |
| `<button type="submit">Submit</button>` | Kicks off the comparison |
| `main table` (one per URL) | Per-run rows + a final stable-avg row: `"1.126 (1.165 ± 0.222)"` |
| `#significancetestresults li` | One `<li>` per metric with `<code>METRIC</code>`, `.psi-sig-p`, `.psi-sig-verdict-yes`/`-no` |

Columns in the results table, in order: **FCP | SI | LCP | TTI | TBT | CLS | Score**. Time metrics are in **seconds**; CLS is unitless; Score is a 0–100 integer.

The tool labels each metric "Significant" or "Not significant" with a p-value; it does **not** say which URL is better — the loop derives direction from the stable averages (respecting that lower-is-better for time/CLS, higher-is-better for Score).

## Playwright driver + on-demand install

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
```

## Constants

```javascript
// Metric columns, in the order they appear in the table.
const DEEP_PSI_METRICS = ['FCP', 'SI', 'LCP', 'TTI', 'TBT', 'CLS', 'Score'];
// Metrics that drive the overall pass/fail decision in Phase 6.
const DEEP_PSI_CORE = ['LCP', 'CLS', 'TBT'];
const DEEP_PSI_URL = 'https://tools.aem.live/tools/deep-psi/deep-psi.html';
// 20 PSI runs per URL + t-test takes several minutes; 10 min covers slow pages.
const DEEP_PSI_TIMEOUT_MS = 600_000;

// Direction is determined by comparing preview vs original only after the
// t-test says the difference is significant — otherwise it's treated as flat.
const LOWER_IS_BETTER = new Set(['FCP', 'SI', 'LCP', 'TTI', 'TBT', 'CLS']);
```

## `compareWithDeepPsi`

```javascript
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
```

## `parseDeepPsiOutput`

Pure function over the scraped DOM data — isolated so it can be unit tested with fixture objects when the tool's markup shifts. Throws on structural surprises; the loop escalates rather than guessing.

```javascript
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

## Output shape

```yaml
# Returned from compareWithDeepPsi
{
  label: 'iter-3',
  originalUrl: 'https://original-site.com/',
  previewUrl: 'https://martech-migration--repo--org.aem.page/',
  timestamp: 1715524800000,
  source: 'deep-psi-comparison',
  metrics: {
    fcp:   { original: 1.126, preview: 1.050, pValue: 0.00342,   significant: true,  verdict: 'improved' },
    si:    { original: 1.821, preview: 1.700, pValue: 0.0976,    significant: false, verdict: 'flat' },
    lcp:   { original: 1.351, preview: 1.200, pValue: 0.0000521, significant: true,  verdict: 'improved' },
    tti:   { original: 1.925, preview: 1.800, pValue: 0.000865,  significant: true,  verdict: 'improved' },
    tbt:   { original: 0.120, preview: 0.100, pValue: 0.186,     significant: false, verdict: 'flat' },
    cls:   { original: 0.002, preview: 0.002, pValue: 0.149,     significant: false, verdict: 'flat' },
    score: { original: 100,   preview: 100,   pValue: null,      significant: false, verdict: 'flat' },
  },
  overallImproved: true,
  hasRegressions: false,
}
```

## Failure modes

| Symptom | Error | Handler behavior |
|---|---|---|
| Submit button never enables, verdict list never renders | `DEEP_PSI_TIMEOUT` (Playwright `waitForSelector`) | Retry with back-off up to `DEEP_PSI_MAX_RETRIES`, then escalate |
| Tables exist but have a different column count | `DEEP_PSI_EXTRACTION_FAILED: unexpected column count` | Escalate immediately — tool output format changed |
| `#significancetestresults` missing | `DEEP_PSI_EXTRACTION_FAILED: missing results table` | Escalate immediately — UI contract changed |
| Cell text doesn't start with a number | Falls through to parenthesized-avg fallback; if that also fails, returns `NaN` | Surfaces in the iteration record; downstream verdict is `flat` |

## Why no fallback measurement system

A fallback that measures differently (single PSI API call, averaged API calls, single Lighthouse run) silently changes the measurement system mid-loop and produces incomparable numbers. Deep-PSI's value is that it runs both URLs through identical passes in one session. If it fails, the loop escalates rather than switching to a worse measurement — the `DEEP_PSI_TIMEOUT` / `DEEP_PSI_EXTRACTION_FAILED` / `DEEP_PSI_UI_CHANGED` handlers in the workflow's Error Handling section retry, then hand off to a human.
