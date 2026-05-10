# Integration Extraction Scripts

Copy-paste these scripts into `playwright-cli eval --tab=ID '...'` to extract integration data.

## Full Integration Audit

```javascript
(() => {
  const results = {};

  // 1. All external script sources
  results.scripts = [...document.querySelectorAll('script[src]')].map(s => s.src);

  // 2. External stylesheets and preconnects
  results.stylesheets = [...document.querySelectorAll('link[rel=stylesheet]')].map(l => l.href);
  results.preconnects = [...document.querySelectorAll('link[rel=preconnect]')].map(l => l.href);
  results.dnsPrefetch = [...document.querySelectorAll('link[rel=dns-prefetch]')].map(l => l.href);

  // 3. Meta tags
  results.metaTags = [...document.querySelectorAll('meta')].map(m => ({
    name: m.getAttribute('name') || m.getAttribute('property') || m.getAttribute('http-equiv'),
    content: m.getAttribute('content')
  })).filter(m => m.name);

  // 4. Inline scripts (first 300 chars each)
  results.inlineScripts = [...document.querySelectorAll('script:not([src])')].map(s =>
    s.textContent.trim().substring(0, 300)
  ).filter(s => s.length > 0);

  // 5. Iframes
  results.iframes = [...document.querySelectorAll('iframe')].map(i => ({
    src: i.src, id: i.id, title: i.title
  }));

  // 6. Global JS objects (common third-party indicators)
  const globals = [
    'ga', 'gtag', 'dataLayer', '_gaq', 'fbq', '_satellite', 'adobe', 'alloy',
    'Tealium', 'utag', 'optimizely', 'Optimizely', '_kmq', 'mixpanel', 'heap',
    'amplitude', 'Intercom', 'drift', 'HubSpot', 'Hotjar', 'hj', '_hjSettings',
    'clarity', 'Sentry', 'newrelic', 'NREUM', 'DD_RUM', 'LogRocket', 'FullStory',
    'OneSignal', 'CleverTap', 'MoEngage', 'webengage', 'Branch', 'firebase',
    'Freshchat', 'Freshdesk', 'jQuery', 'React', 'Vue', 'angular', 'ng',
    '__NEXT_DATA__', '__NUXT__', 'Ember', 'Backbone', 'Svelte',
    'webpackJsonp', '__webpack_require__', 'Webflow', 'grecaptcha', 'turnstile',
    'adsbygoogle', 'googletag', 'pbjs', 'Criteo', 'VWO', '_vwo_code',
    'Salesforce', 'LiveAgent', 'zE', 'Zendesk', 'tawk', 'Tawk_API',
    'Razorpay', 'Stripe', 'PayPal', 'paytm', 'cashfree'
  ];

  results.detectedGlobals = globals.filter(g => {
    try { return typeof window[g] !== 'undefined'; } catch(e) { return false; }
  });

  // 7. Cookies (names only)
  results.cookies = document.cookie.split(';').map(c => c.trim().split('=')[0]).filter(Boolean);

  // 8. Service Worker
  results.serviceWorker = 'serviceWorker' in navigator;

  // 9. Generator meta
  const gen = document.querySelector('meta[name=generator]');
  results.generator = gen ? gen.content : null;

  // 10. All unique external domains
  const allUrls = [
    ...document.querySelectorAll('script[src]'),
    ...document.querySelectorAll('link[href]'),
    ...document.querySelectorAll('img[src]'),
    ...document.querySelectorAll('iframe[src]')
  ].map(el => el.src || el.href).filter(Boolean);

  const domains = [...new Set(allUrls.map(u => {
    try { return new URL(u).hostname; } catch(e) { return null; }
  }).filter(Boolean))];

  const siteDomain = window.location.hostname;
  results.externalDomains = domains.filter(d => !d.includes(siteDomain.split('.').slice(-2).join('.')));
  results.internalDomains = domains.filter(d => d.includes(siteDomain.split('.').slice(-2).join('.')));

  return JSON.stringify(results, null, 2);
})()
```

## Platform-Specific Checks

```javascript
(() => {
  const platforms = {};

  // Adobe Experience Manager
  platforms.aem = {
    clientlibs: document.querySelector('link[href*="clientlibs"]') !== null,
    etcDesigns: document.querySelector('[href*="/etc/"]') !== null,
    contentDam: document.querySelector('[src*="/content/dam/"]') !== null,
    adobeDTM: document.querySelector('script[src*="adobedtm"]') !== null,
    satellite: typeof window._satellite !== 'undefined',
    alloy: typeof window.alloy !== 'undefined'
  };

  // Adobe Experience Platform
  platforms.aep = {
    alloyPresent: typeof window.alloy === 'function',
    adobeOrgId: document.cookie.match(/kndctr_([^_]+)_AdobeOrg/)?.[1] || null,
    launchScripts: [...document.querySelectorAll('script[src*="adobedtm"]')].map(s => s.src)
  };

  // VWO
  platforms.vwo = {
    present: typeof window.VWO !== 'undefined',
    version: (() => { try { return window.VWO?.v || null; } catch(e) { return null; } })()
  };

  // Akamai
  platforms.akamai = {
    bmCookies: document.cookie.includes('bm_sz') || document.cookie.includes('_abck'),
    akamaiScript: [...document.querySelectorAll('script[src*="akamai"]')].length > 0
  };

  // Schema.org structured data
  const ldJson = [...document.querySelectorAll('script[type="application/ld+json"]')];
  platforms.structuredData = ldJson.map(s => {
    try { const d = JSON.parse(s.textContent); return { type: d['@type'], name: d.name }; }
    catch(e) { return null; }
  }).filter(Boolean);

  // Google
  platforms.google = {
    siteVerification: document.querySelector('meta[name="google-site-verification"]')?.content || null,
    analytics: typeof window.ga !== 'undefined' || typeof window.gtag !== 'undefined',
    tagManager: typeof window.dataLayer !== 'undefined'
  };

  // Speculation Rules (modern prerender)
  platforms.speculationRules = document.querySelector('script[type="speculationrules"]') !== null;

  return JSON.stringify(platforms, null, 2);
})()
```

## Network Interceptor

Install this to capture API calls made by integrations:

```javascript
(() => {
  window.__integrationCalls = [];

  // Intercept fetch
  const origFetch = window.fetch;
  window.fetch = function(...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    const opts = args[1] || {};
    window.__integrationCalls.push({
      url: url.substring(0, 300),
      method: opts.method || 'GET',
      body: opts.body ? (typeof opts.body === 'string' ? opts.body.substring(0, 500) : 'non-string') : null,
      type: 'fetch'
    });
    return origFetch.apply(this, args);
  };

  // Intercept XMLHttpRequest
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__method = method;
    this.__url = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    window.__integrationCalls.push({
      url: (this.__url || '').substring(0, 300),
      method: this.__method || 'GET',
      body: body ? String(body).substring(0, 500) : null,
      type: 'xhr'
    });
    return origSend.apply(this, arguments);
  };

  return 'Interceptors installed. Trigger the integration, then run: JSON.stringify(window.__integrationCalls, null, 2)';
})()
```

After triggering the integration (click, type, etc.), collect captured calls:

```javascript
JSON.stringify(window.__integrationCalls, null, 2)
```

## Resource Timing Analysis

Get performance data for all loaded resources:

```javascript
(() => {
  const entries = performance.getEntriesByType('resource');
  const byDomain = {};

  entries.forEach(e => {
    try {
      const domain = new URL(e.name).hostname;
      if (!byDomain[domain]) byDomain[domain] = { count: 0, totalBytes: 0, totalDuration: 0 };
      byDomain[domain].count++;
      byDomain[domain].totalDuration += e.duration;
      if (e.transferSize) byDomain[domain].totalBytes += e.transferSize;
    } catch(err) {}
  });

  // Sort by count
  const sorted = Object.entries(byDomain)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([domain, stats]) => ({
      domain,
      requests: stats.count,
      totalMs: Math.round(stats.totalDuration),
      totalKB: Math.round(stats.totalBytes / 1024)
    }));

  return JSON.stringify(sorted, null, 2);
})()
```

## Cookie Analysis

Categorize cookies by likely purpose:

```javascript
(() => {
  const cookies = document.cookie.split(';').map(c => {
    const [name, value] = c.trim().split('=');
    return { name, valueLength: (value || '').length };
  });

  const categorized = {
    analytics: [],
    adobeExperience: [],
    vwo: [],
    akamai: [],
    session: [],
    other: []
  };

  cookies.forEach(c => {
    const n = c.name.toLowerCase();
    if (n.includes('_ga') || n.includes('_gid') || n.includes('_gat')) {
      categorized.analytics.push(c.name);
    } else if (n.includes('kndctr') || n.includes('s_') || n.includes('mbox')) {
      categorized.adobeExperience.push(c.name);
    } else if (n.includes('_vwo') || n.includes('_vis_opt')) {
      categorized.vwo.push(c.name);
    } else if (n.includes('bm_') || n.includes('_abck') || n.includes('ak_')) {
      categorized.akamai.push(c.name);
    } else if (n.includes('session') || n.includes('sid') || n.includes('csrf')) {
      categorized.session.push(c.name);
    } else {
      categorized.other.push(c.name);
    }
  });

  return JSON.stringify(categorized, null, 2);
})()
```

## Network Baseline Capture (used by Workflow 2)

Workflow 2 and `testing.md` call `captureNetworkBaseline`, `isAnalyticsCall`, `isPersonalizationCall`, and `categorizeCall`. Define them here once so both consumers stay in sync.

```javascript
// Hostname + path patterns for each martech category. Keeping the patterns
// in one place makes it obvious when a new integration needs classification.
const CATEGORY_PATTERNS = {
  analytics: [/\/b\/ss\//, /google-analytics\.com/, /analytics\.google\.com/, /edge\.adobedc\.net\/ee\/v1\/collect/],
  personalization: [/tt\.omtrdc\.net/, /edge\.adobedc\.net\/ee\/v1\/interact/, /mbox/, /\/ajo\//],
  consent: [/cookielaw\.org/, /cookiebot\.com/, /trustarc\.com/, /onetrust/],
  social: [/facebook\.com\/tr/, /linkedin\.com\/px/, /twitter\.com\/i\/adsct/, /pinterest\.com\/ct/],
};

const matchesAny = (url, patterns) => patterns.some((p) => p.test(url));
const isAnalyticsCall = (url) => matchesAny(url, CATEGORY_PATTERNS.analytics);
const isPersonalizationCall = (url) => matchesAny(url, CATEGORY_PATTERNS.personalization);

function categorizeCall(url) {
  for (const [category, patterns] of Object.entries(CATEGORY_PATTERNS)) {
    if (matchesAny(url, patterns)) return category;
  }
  return 'other';
}

// Drives Playwright to load the URL, captures every network request issued
// during page load, and groups them by category. Returns both the flat list
// and per-category buckets so callers can compare totals or inspect specifics.
async function captureNetworkBaseline(url) {
  const { chromium } = await ensurePlaywright();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const all = [];
    page.on('request', (req) => {
      all.push({ url: req.url(), method: req.method(), timestamp: Date.now() });
    });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    const buckets = { analytics: [], personalization: [], consent: [], social: [], other: [] };
    for (const call of all) buckets[categorizeCall(call.url)].push(call);
    return { url, timestamp: Date.now(), all, ...buckets };
  } finally {
    await browser.close();
  }
}
```

> `ensurePlaywright` is defined in `workflows/agentic-optimization-loop.md` and handles package + browser install on first use.
