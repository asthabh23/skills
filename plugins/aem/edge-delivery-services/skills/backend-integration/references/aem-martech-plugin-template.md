# aem-martech Plugin Template

Complete template for integrating the aem-martech plugin into an Edge Delivery Services project.

Reference: https://github.com/adobe-rnd/aem-martech

## Overview

The aem-martech plugin orchestrates the full Adobe Experience Cloud stack:
- **Eager:** WebSDK (alloy) fetches Target/AJO propositions before first paint
- **Lazy:** Analytics page view beacon after LCP
- **Delayed:** Launch container loads remaining tags

This eliminates content flicker and optimizes Core Web Vitals.

---

## Installation

### 1. Add Plugin Files

Clone or copy from https://github.com/adobe-rnd/aem-martech:

```
scripts/
├── aem.js           # (existing)
├── scripts.js       # (modify)
├── delayed.js       # (modify)
├── alloy.js         # (add from plugin)
└── martech/
    ├── index.js     # Plugin entry point
    ├── alloy.js     # WebSDK wrapper
    └── acdl.js      # Adobe Client Data Layer
```

### 2. Configure scripts.js

```javascript
// scripts/scripts.js

import { sampleRUM, loadHeader, loadFooter, decorateButtons, decorateIcons,
  decorateBlock, decorateSections, decorateBlocks, decorateTemplateAndTheme,
  waitForFirstImage, loadSection, loadSections, loadCSS, getMetadata } from './aem.js';

// ============================================================
// aem-martech Plugin Configuration
// ============================================================
// SETUP: Configure the values below before deploying to production.
//
// datastreamId: AEP → Data Collection → Datastreams → your stream → copy ID
// orgId: Adobe Admin Console → Settings → Organization ID (format: XXXXX@AdobeOrg)
// launchUrls: AEP → Data Collection → Tags → Environments → Install URLs
// ============================================================

const MARTECH_CONFIG = {
  // Core identifiers — REQUIRED
  datastreamId: '', // ← AEP Datastream ID
  orgId: '',        // ← IMS Org ID (XXXXX@AdobeOrg)

  // Launch container URLs by environment
  launchUrls: {
    dev: '',        // ← Development container URL
    stage: '',      // ← Staging container URL  
    prod: '',       // ← Production container URL
  },

  // Data layer instance name — must match Launch ACDL extension setting
  dataLayerInstanceName: 'adobeDataLayer',

  // Consent default — DO NOT change to 'in' without legal review
  // 'pending' = wait for consent signal before tracking
  // 'in' = assume consent (only for regions without consent requirements)
  defaultConsent: 'pending',

  // Page metadata key that enables personalization
  // Set 'Target: on' in page metadata to enable propositions
  targetMetadataKey: 'target',

  // Environment detection
  getEnvironment: () => {
    const { hostname } = window.location;
    if (hostname.includes('localhost') || hostname.includes('.aem.page')) return 'dev';
    if (hostname.includes('.aem.live')) return 'stage';
    return 'prod';
  },
};

// Skip martech entirely on preview/dev if not configured
const SKIP_MARTECH = !MARTECH_CONFIG.datastreamId || !MARTECH_CONFIG.orgId;

// ============================================================
// Plugin Import and Initialization
// ============================================================

let martechPlugin = null;

async function initMartech() {
  if (SKIP_MARTECH) {
    console.warn('aem-martech: datastreamId and orgId must be configured');
    return null;
  }

  const { hostname } = window.location;
  if (hostname.includes('localhost') || hostname.includes('.aem.page') || hostname.includes('.aem.live')) {
    console.log('aem-martech: skipped on preview/dev environment');
    return null;
  }

  const { default: martech } = await import('./martech/index.js');
  return martech;
}

// ============================================================
// Standard EDS Functions (with martech hooks)
// ============================================================

function buildAutoBlocks(main) {
  // Add auto-block logic here
}

function decorateMain(main) {
  decorateButtons(main);
  decorateIcons(main);
  buildAutoBlocks(main);
  decorateSections(main);
  decorateBlocks(main);
}

async function loadEager(doc) {
  document.documentElement.lang = 'en';
  decorateTemplateAndTheme();

  const main = doc.querySelector('main');
  if (main) {
    decorateMain(main);
    document.body.classList.add('appear');

    // ============================================================
    // MARTECH EAGER PHASE
    // Initialize alloy and fetch Target propositions BEFORE first section loads.
    // This is what eliminates personalization flicker.
    // ============================================================
    if (!SKIP_MARTECH) {
      martechPlugin = await initMartech();
      if (martechPlugin) {
        await martechPlugin.configure({
          datastreamId: MARTECH_CONFIG.datastreamId,
          orgId: MARTECH_CONFIG.orgId,
          defaultConsent: MARTECH_CONFIG.defaultConsent,
          dataLayerInstanceName: MARTECH_CONFIG.dataLayerInstanceName,
        });

        // Only fetch propositions if page has Target metadata enabled
        if (getMetadata(MARTECH_CONFIG.targetMetadataKey)) {
          await martechPlugin.fetchPropositions();
        }
      }
    }

    await loadSection(main.querySelector('.section'), waitForFirstImage);
  }

  sampleRUM.enhance();

  try {
    performance.mark('eager-end');
    performance.measure('eager', 'navigationStart', 'eager-end');
  } catch (e) {
    // ignore
  }
}

async function loadLazy(doc) {
  const main = doc.querySelector('main');
  await loadSections(main);

  const { hash } = window.location;
  const element = hash ? doc.getElementById(hash.substring(1)) : false;
  if (hash && element) element.scrollIntoView();

  loadHeader(doc.querySelector('header'));
  loadFooter(doc.querySelector('footer'));

  loadCSS(`${window.hlx.codeBasePath}/styles/lazy-styles.css`);

  // ============================================================
  // MARTECH LAZY PHASE
  // Fire analytics page view beacon after LCP.
  // ============================================================
  if (martechPlugin) {
    martechPlugin.trackPageView({
      pageName: document.title,
      pageUrl: window.location.href,
      // Add custom data layer fields here
    });
  }

  sampleRUM('lazy');
  sampleRUM.observe(main.querySelectorAll('div[data-block-name]'));
}

function loadDelayed() {
  window.setTimeout(() => {
    import('./delayed.js');
  }, 3000);
}

async function loadPage() {
  await loadEager(document);
  await loadLazy(document);
  loadDelayed();
}

loadPage();
```

### 3. Configure delayed.js

```javascript
// scripts/delayed.js

import { loadScript, sampleRUM } from './aem.js';

sampleRUM('cwv');

// ============================================================
// Launch Container (Delayed Phase)
// ============================================================
// The Launch container loads here with all tags EXCEPT:
// - WebSDK (handled by martech plugin in eager phase)
// - Target (handled by martech plugin in eager phase)
// - Analytics page view (handled by martech plugin in lazy phase)
//
// Everything else stays in the container: social pixels, RUM,
// cookie consent triggers, custom event rules, etc.
// ============================================================

const LAUNCH_URLS = {
  dev: '',    // ← Development container
  stage: '',  // ← Staging container
  prod: '',   // ← Production container
};

function getEnvironment() {
  const { hostname } = window.location;
  if (hostname.includes('localhost') || hostname.includes('.aem.page')) return 'dev';
  if (hostname.includes('.aem.live')) return 'stage';
  return 'prod';
}

function loadLaunchContainer() {
  const env = getEnvironment();
  const launchUrl = LAUNCH_URLS[env];

  if (!launchUrl) {
    console.warn('Adobe Launch: No container URL configured for environment:', env);
    return;
  }

  const { hostname } = window.location;
  if (hostname.includes('localhost')) {
    console.log('Adobe Launch: skipped on localhost');
    return;
  }

  // Check consent before loading (if using OneTrust)
  // Uncomment if consent gating is required:
  // if (document.cookie.includes('OptanonConsent') && !document.cookie.includes('C0002:1')) {
  //   console.log('Adobe Launch: skipped (performance consent not granted)');
  //   return;
  // }

  loadScript(launchUrl, { async: true });
}

loadLaunchContainer();
```

### 4. Add head.html Preconnects

```html
<!-- head.html -->

<!-- Preconnect to AEP Edge — critical for eager phase personalization -->
<link rel="preconnect" href="https://edge.adobedc.net" crossorigin>

<!-- Preconnect to Launch CDN — optional, minor benefit for delayed phase -->
<link rel="preconnect" href="https://assets.adobedtm.com" crossorigin>
```

---

## Launch Container Configuration

The Launch container should be configured to NOT include:

| Extension | Reason |
|-----------|--------|
| Adobe Experience Platform Web SDK | Plugin loads alloy directly |
| Adobe Target | Handled via alloy sendEvent |
| Adobe Analytics (via Web SDK) | Handled via alloy sendEvent |

The container SHOULD include:

| Extension | Reason |
|-----------|--------|
| Adobe Client Data Layer | Required for data layer sync |
| Any social pixels | Meta, LinkedIn, Twitter, etc. |
| Any RUM tools | Hotjar, FullStory, etc. |
| Custom event rules | Non-page-view analytics |

---

## Consent Integration

If using OneTrust or another CMP:

```javascript
// In scripts.js, wrap the martech initialization:

async function loadEager(doc) {
  // ... decorateMain, etc.

  // Wait for consent before initializing martech
  if (window.OnetrustActiveGroups?.includes('C0002')) {
    // Performance consent granted — proceed
    martechPlugin = await initMartech();
    // ...
  } else if (typeof window.OneTrust !== 'undefined') {
    // Consent not yet determined — wait for callback
    window.OneTrust.OnConsentChanged(() => {
      if (window.OnetrustActiveGroups?.includes('C0002')) {
        initMartech().then((plugin) => {
          martechPlugin = plugin;
          // Fetch propositions and track page view
        });
      }
    });
  }
}
```

See `references/consent-gated-architecture.md` for the full pattern.

---

## Verification Checklist

After implementation, verify:

| Check | How | Expected |
|-------|-----|----------|
| Alloy configured | Console: `window.alloy` | Function exists |
| ACDL active | Console: `window.adobeDataLayer` | Array with events |
| Propositions fetched | Network: `edge.adobedc.net/ee/v1/interact` | Request during page load |
| Page view tracked | Network: `edge.adobedc.net/ee/v1/collect` | Request after LCP |
| Launch container | Network: `assets.adobedtm.com` | Request at ~3s |
| No flicker | Visual | Content stable on first paint |
| Dev/preview skip | Console | "skipped" messages on .aem.page |

---

## Troubleshooting

### Personalization flicker

**Cause:** Propositions fetched too late (after first paint).

**Fix:** Ensure `await martechPlugin.fetchPropositions()` completes before `loadSection()`.

### Analytics not appearing in reports

**Cause:** Datastream not connected to Analytics, or wrong RSID.

**Fix:** Check AEP Datastream → Services → Adobe Analytics is enabled with correct RSID.

### Target activities not rendering

**Cause:** Page missing Target metadata, or wrong property token.

**Fix:** 
1. Add `Target: on` to page metadata
2. Verify property token in Target UI matches datastream config

### Console error: "alloy is not defined"

**Cause:** alloy.js not loaded or path incorrect.

**Fix:** Verify `scripts/alloy.js` exists and import path is correct.

### Launch container not loading

**Cause:** Empty URL or wrong environment detection.

**Fix:** Check `LAUNCH_URLS` has correct URLs for all environments.
