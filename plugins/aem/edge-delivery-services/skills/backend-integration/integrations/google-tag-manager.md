# Google Tag Manager

**Category:** Tag Management
**Edge Delivery Services approach:** `scripts/delayed.js`
**Load timing:** Post-LCP (3s delay)

## When to Use

Use this when the source site has a GTM container (`GTM-XXXXXXX`). GTM manages other tags (GA4, remarketing pixels, etc.) via the GTM web UI.

## What to Extract During Audit

| Value | How to find it |
|-------|---------------|
| Container ID | Page source → `GTM-XXXXXXX` in the inline script or noscript iframe |

## Config Variables

| Variable | Where to get it |
|----------|----------------|
| `GTM_CONTAINER_ID` | Google Tag Manager → Admin → Container Settings → Container ID. Format: `GTM-XXXXXXX` |

## Code — `scripts/delayed.js`

```javascript
const GTM_CONTAINER_ID = ''; // ← GTM-XXXXXXX (Tag Manager → Admin → Container Settings)

// With OneTrust: replace with isConsentGroupAllowed('C0002') from onetrust.md
function isAnalyticsAllowed() {
  return !document.cookie.includes('analytics_storage=denied');
}

function loadGTM() {
  if (!GTM_CONTAINER_ID) {
    // eslint-disable-next-line no-console
    console.warn('GTM: Set GTM_CONTAINER_ID in delayed.js');
    return;
  }

  const { hostname } = window.location;
  if (
    hostname.includes('localhost')
    || hostname.includes('.aem.page')
    || hostname.includes('.aem.live')
  ) {
    // eslint-disable-next-line no-console
    console.log('GTM: skipped (local/preview environment)');
    return;
  }

  if (!isAnalyticsAllowed()) {
    // eslint-disable-next-line no-console
    console.log('GTM: skipped (consent denied)');
    return;
  }

  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });

  const gtmScript = document.createElement('script');
  gtmScript.async = true;
  gtmScript.src = `https://www.googletagmanager.com/gtm.js?id=${GTM_CONTAINER_ID}`;
  const firstScript = document.getElementsByTagName('script')[0];
  firstScript.parentNode.insertBefore(gtmScript, firstScript);

  const gtmIframe = document.createElement('iframe');
  gtmIframe.src = `https://www.googletagmanager.com/ns.html?id=${GTM_CONTAINER_ID}`;
  gtmIframe.style.cssText = 'display:none;visibility:hidden';
  gtmIframe.width = '0';
  gtmIframe.height = '0';
  const gtmNoscript = document.createElement('noscript');
  gtmNoscript.append(gtmIframe);
  document.body.prepend(gtmNoscript);
}

loadGTM();
```

## Code — `head.html`

```html
<link rel="preconnect" href="https://www.googletagmanager.com" crossorigin>
```

## Verification

- **Network tab:** Request to `googletagmanager.com/gtm.js?id=GTM-...` after ~3s
- **Console:** `window.dataLayer` should contain `gtm.start` event
- **DOM:** `noscript > iframe[src*="googletagmanager"]` should exist in body
- **Note:** Skipped on localhost and .aem.page/.aem.live — test on a preview/production URL

## Real-World Reference

Production patterns from real Edge Delivery Services projects. GTM is the most common third-party integration across aemsites repos (9 out of 42 surveyed).

### Pattern 1: Config-Driven + Consent-Gated

The gold-standard pattern: GTM container ID comes from a `constants.xlsx` spreadsheet (fetched as JSON), and loading is gated behind OneTrust consent helpers.

```javascript
import { loadScript } from './aem.js';
import { isPerformanceAllowed, COOKIE_CONFIGS } from './common.js';

const { GTM_ID = false } = COOKIE_CONFIGS;

function checkCookiesAndLoadAllScripts() {
  if (isPerformanceAllowed()) {
    GTM_ID && loadGoogleTagManager();
  }
  // ... other integrations
}
checkCookiesAndLoadAllScripts();

async function loadGoogleTagManager() {
  (function loadGoogleTagManagerInit(w, d, s, l, i) {
    w[l] = w[l] || [];
    w[l].push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
    const f = d.getElementsByTagName(s)[0];
    const j = d.createElement(s);
    const dl = l != 'dataLayer' ? `&l=${l}` : '';
    j.async = true;
    j.src = `https://www.googletagmanager.com/gtm.js?id=${i}${dl}`;
    f.parentNode.insertBefore(j, f);
  })(window, document, 'script', 'dataLayer', GTM_ID);
}
```

Source: aemsites/vg-macktrucks-com — `scripts/delayed.js`, aemsites/volvotrucks-na — `scripts/delayed.js`

Key design points:
- `GTM_ID` is stored in the `cookieValues` sheet of `constants.xlsx`, not in code — deploying to a new locale just means updating the spreadsheet
- `isPerformanceAllowed()` reads the `OptanonConsent` cookie to check if OneTrust group C0002 is active
- The `checkCookiesAndLoadAllScripts()` function is re-invoked via `OneTrust.OnConsentChanged()`, so GTM loads dynamically when the user grants consent without a page reload
- The `= false` default means GTM is skipped entirely if the config value is missing

### Pattern 2: Web Worker Pre-Fetch (Learning A-Z)

An unusual pattern that fetches the GTM script via a Web Worker to avoid main-thread blocking:

```javascript
// scripts/delayed.js
function enableGoogleTagManager() {
  const gtmWorker = new Worker(`${window.hlx.codeBasePath}/scripts/googletagmanager-worker.js`);
  gtmWorker.postMessage('loadGTM');

  gtmWorker.onmessage = function (event) {
    if (event.data.error) {
      // eslint-disable-next-line no-console
      console.error('Error in GTM Web Worker:', event.data.error);
      return;
    }
    const gtmScript = document.createElement('script');
    gtmScript.type = 'text/javascript';
    gtmScript.innerHTML = event.data;
    const l = 'dataLayer';
    window[l] = window[l] || [];
    window[l].push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
    const f = document.getElementsByTagName('script')[0];
    f.parentNode.insertBefore(gtmScript, f);

    // noscript fallback
    const noscriptElement = document.createElement('noscript');
    const iframeElement = document.createElement('iframe');
    iframeElement.src = 'https://www.googletagmanager.com/ns.html?id=GTM-XXXXXXX'; // redacted
    iframeElement.height = '0';
    iframeElement.width = '0';
    iframeElement.style.display = 'none';
    iframeElement.style.visibility = 'hidden';
    noscriptElement.appendChild(iframeElement);
    document.body.insertAdjacentElement('afterbegin', noscriptElement);
  };
}
enableGoogleTagManager();

// scripts/googletagmanager-worker.js
onmessage = function (event) {
  if (event.data === 'loadGTM') {
    fetch('https://www.googletagmanager.com/gtm.js?id=GTM-XXXXXXX') // redacted
      .then((response) => response.text())
      .then((data) => postMessage(data))
      .catch((error) => postMessage({ error: error.message }));
  }
};
```

Source: [aemsites/learninga-z](https://github.com/aemsites/learninga-z) — `scripts/delayed.js` + `scripts/googletagmanager-worker.js`

This approach pre-fetches the GTM script off the main thread, then injects the fetched text as an inline script. Trade-off: slightly more complex, but the fetch itself doesn't block the main thread. Note that the container ID is hardcoded in the worker file — a config-driven approach would be better.

### Pattern 3: Module Delegation (Hubble Homes)

Some repos keep delayed.js minimal and delegate GTM initialization to a separate module:

```javascript
// scripts/delayed.js
import loadHubSpot from './hubspot-helper.js';
import { initMap } from '../templates/map-view/delayed-map.js';

async function loadDelayed() {
  sampleRUM('cwv');
  loadHubSpot();
  loadScript('/scripts/gtm-init.js', { defer: true });
  // ...
}
loadDelayed();
```

Source: [aemsites/hubblehomes-com](https://github.com/aemsites/hubblehomes-com) — `scripts/delayed.js`

This keeps delayed.js clean but pushes the GTM logic into `gtm-init.js`. Good for repos with many integrations — prevents delayed.js from becoming a monolith.

---

### Summary: Which Pattern to Use

| Pattern | Pros | Cons | Best for |
|---------|------|------|----------|
| Config-driven (Pattern 1) | No hardcoded IDs, consent-gated, multi-locale | Requires constants.xlsx setup | Multi-brand/multi-locale sites with OneTrust |
| Web Worker (Pattern 2) | Off-main-thread fetch | Complex, hardcoded IDs | Performance-critical sites |
| Module delegation (Pattern 3) | Clean delayed.js | Extra file to maintain | Sites with many integrations |
| Direct inline (our template) | Simple, self-contained | Manual ID management | Single-brand sites |

> **See also:** For dual martech sites (Adobe Launch + GTM), use Workflow 1 (`workflows/martech-migration.md`) — it covers the `?loadMartech` QA override pattern for hybrid stacks.
