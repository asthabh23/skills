# OneTrust Consent Management

**Category:** Consent Management
**Edge Delivery Services approach:** `scripts/delayed.js` (early — before other integrations)
**Load timing:** Top of `delayed.js`, before any analytics or targeting scripts fire

## When to Use

OneTrust is the dominant consent management platform across Edge Delivery Services projects, powering cookie consent banners and preference centers. It must load before any analytics or targeting scripts fire so that consent decisions gate downstream tracking. If the source site uses OneTrust (look for `cdn.cookielaw.org` requests or `OptanonConsent` cookies), place it at the **top of `scripts/delayed.js`**, before any other integrations. All other integrations (GTM, HubSpot, etc.) go after it in the same file, gated behind OneTrust consent helpers.

## What to Extract During Audit

| Value | How to find it |
|-------|---------------|
| Domain Script ID | View source → look for `data-domain-script` attribute on the `otSDKStub.js` script tag (UUID format, e.g. `01234567-89ab-cdef-0123-456789abcdef`) |
| Region variant | Check if script src uses `cdn.cookielaw.org` (global) or `cdn-ukwest.onetrust.com` (EU region) |
| Auto-blocking script | Check for `otCCPAccepted.js` or `otBannerSdk.js` loaded alongside the stub |
| Consent categories in use | Search source for `C0001`, `C0002`, `C0003`, `C0004` references to see which groups are active |
| OptanonWrapper callback | Search for `function OptanonWrapper` — this fires on consent changes and often triggers other scripts |

## Config Variables

| Variable | Where to get it |
|----------|----------------|
| `ONETRUST_DOMAIN_SCRIPT_ID` | OneTrust Admin Console → Scripts → select your domain → Script ID (UUID format). Also visible in the source site's `data-domain-script` attribute. |

## Consent Categories

| Category | Code | Typical use |
|----------|------|-------------|
| Strictly Necessary | `C0001` | Always active, cannot be disabled |
| Performance | `C0002` | Analytics (Google Analytics, Adobe Analytics) |
| Functional | `C0003` | Chat widgets, embedded videos, personalization |
| Targeting | `C0004` | Ad tracking, remarketing, Pardot, social pixels |

## Code — `scripts/delayed.js` (top — before other integrations)

```javascript
import { loadScript } from './aem.js';

const ONETRUST_DOMAIN_SCRIPT_ID = ''; // ← Set your OneTrust domain script ID (UUID)

/**
 * Loads OneTrust at the top of delayed.js, before any other integrations.
 * OptanonWrapper MUST be assigned before loadScript is called — OneTrust
 * invokes it immediately after the SDK loads, so any later assignment misses the call.
 */
async function loadOneTrust() {
  if (!ONETRUST_DOMAIN_SCRIPT_ID) {
    // eslint-disable-next-line no-console
    console.warn('OneTrust: ONETRUST_DOMAIN_SCRIPT_ID not configured — consent banner skipped');
    return;
  }

  const { hostname } = window.location;
  if (
    hostname.includes('localhost')
    || hostname.includes('.aem.page')
    || hostname.includes('.aem.live')
  ) {
    return;
  }

  // Must be assigned BEFORE loadScript — OneTrust calls OptanonWrapper immediately on load.
  window.OptanonWrapper = () => {
    document.dispatchEvent(new CustomEvent('consent-updated'));
  };

  await loadScript('https://cdn.cookielaw.org/scripttemplates/otSDKStub.js', {
    type: 'text/javascript',
    charset: 'UTF-8',
    'data-domain-script': ONETRUST_DOMAIN_SCRIPT_ID,
  });
}

await loadOneTrust();

// Other integrations go below — gate each on isConsentGroupAllowed() (see section below).
// if (isConsentGroupAllowed('C0002')) loadGTM();
// if (isConsentGroupAllowed('C0004')) loadAds();
```

## Code — `head.html`

```html
<link rel="preconnect" href="https://cdn.cookielaw.org">
```

## Consent-Gated Loading

Other integrations should check OneTrust consent groups before loading. This pattern reads the `OptanonConsent` cookie to determine which groups the user has accepted:

```javascript
/**
 * Checks whether a specific OneTrust consent group is allowed.
 * @param {string} group - The consent group code (e.g. 'C0002', 'C0004')
 * @returns {boolean} True if the user has consented to this group
 */
function isConsentGroupAllowed(group) {
  const cookie = document.cookie.split(';').find((c) => c.trim().startsWith('OptanonConsent='));
  if (!cookie) return false;
  const groups = decodeURIComponent(cookie.split('=')[1]).match(/groups=([^&]*)/);
  return groups ? groups[1].includes(`${group}:1`) : false;
}

// Usage examples:
// C0002 = Performance (analytics) — gate Google Analytics, Adobe Analytics
if (isConsentGroupAllowed('C0002')) {
  loadGoogleAnalytics();
}

// C0004 = Targeting (ads/marketing) — gate Pardot, ad pixels, remarketing
if (isConsentGroupAllowed('C0004')) {
  loadPardot();
}
```

Convenience helpers:

```javascript
function isPerformanceAllowed() {
  return isConsentGroupAllowed('C0002');
}

function isFunctionalAllowed() {
  return isConsentGroupAllowed('C0003');
}

function isTargetingAllowed() {
  return isConsentGroupAllowed('C0004');
}
```

## Why Top of `delayed.js` and Not `loadLazy()`

OneTrust goes at the **top of `delayed.js`**, not in `loadLazy()`. All other integrations (GTM, HubSpot, analytics pixels) also live in `delayed.js` — placing OneTrust first in the same file ensures consent is established before any of them run. If OneTrust were in `loadLazy()` and analytics in `delayed.js`, the timing would be correct (lazy runs before delayed), but splitting them across files creates confusion and makes consent orchestration harder to follow. Keeping everything in `delayed.js` — OneTrust first, others after — is the pattern used in production EDS repos and is the approach shown in all real-world references in this file.

## Verification

- **Network tab:** Request to `cdn.cookielaw.org/scripttemplates/otSDKStub.js` with your domain script ID as `data-domain-script` attribute
- **Console:** `window.OneTrust` object exists after script loads; `window.OptanonWrapper` is defined
- **Cookies:** `OptanonConsent` cookie set after user interacts with the banner; `OptanonAlertBoxClosed` cookie set after dismissal
- **Consent state:** Run `OnetrustActiveGroups` in the console — returns a string like `,C0001,C0002,` showing accepted groups
- **Banner visibility:** Consent banner appears on first visit before any analytics network requests fire

## Real-World Reference

These patterns come from production Edge Delivery Services repos on GitHub.

### Pattern: Config-Driven Consent Architecture

This three-layer architecture uses configuration values in a `constants.xlsx` spreadsheet (fetched as JSON at runtime), consent-checking helpers in `common.js`, and OneTrust loading with consent-gated script orchestration in `delayed.js`.

#### Layer 1  Consent Helpers (`common.js`)

Helpers read the `OptanonConsent` cookie directly and check whether a specific OneTrust group (e.g. `C0002`) has been granted. The group IDs themselves come from the spreadsheet config, not hardcoded values.

```javascript
/**
 * Check if one trust group is checked.
 * @param {String} groupName the one trust group like: C0002
 */
function checkOneTrustGroup(groupName, cookieCheck = false) {
  const oneTrustCookie = decodeURIComponent(
    document.cookie.split(';').find((cookie) => cookie.trim().startsWith('OptanonConsent='))
  );
  return cookieCheck || oneTrustCookie.includes(`${groupName}:1`);
}

const {
  PERFORMANCE_COOKIE = false,
  FUNCTIONAL_COOKIE = false,
  TARGETING_COOKIE = false,
  SOCIAL_COOKIE = false,
} = COOKIE_CONFIGS;

function isPerformanceAllowed() {
  return checkOneTrustGroup(PERFORMANCE_COOKIE);
}

function isFunctionalAllowed() {
  return checkOneTrustGroup(FUNCTIONAL_COOKIE);
}

function isTargetingAllowed() {
  return checkOneTrustGroup(TARGETING_COOKIE);
}

function isSocialAllowed() {
  return checkOneTrustGroup(SOCIAL_COOKIE);
}
```

Source: [aemsites/vg-macktrucks-com](https://github.com/aemsites/vg-macktrucks-com)  scripts/common.js

#### Layer 2  OneTrust Loading and Consent-Change Handling (`delayed.js`)

The OneTrust SDK is loaded with a `DATA_DOMAIN_SCRIPT` value pulled from the spreadsheet config. The `OptanonWrapper` callback registers a consent-change listener that re-evaluates which third-party scripts to load when the user updates their preferences.

```javascript
import { loadScript } from './aem.js';
import {
  isPerformanceAllowed, isSocialAllowed, isTargetingAllowed,
  extractObjectFromArray, COOKIE_CONFIGS, isDevHost,
} from './common.js';

const {
  DATA_DOMAIN_SCRIPT = false,
  GTM_ID = false,
  HOTJAR_ID = false,
  FACEBOOK_ID = false,
  LINKEDIN_PARTNER_ID = false,
} = COOKIE_CONFIGS;

function checkCookiesAndLoadAllScripts() {
  if (isPerformanceAllowed()) {
    if (GTM_ID) loadGoogleTagManager();
    if (HOTJAR_ID) loadHotjar();
  }
  if (isSocialAllowed()) {
    if (FACEBOOK_ID) loadFacebookPixel();
    if (LINKEDIN_PARTNER_ID) loadLinkedInInsightTag();
  }
  if (isTargetingAllowed()) {
    // Pardot / Account Engagement tracking
  }
}
```

Source: [aemsites/vg-macktrucks-com](https://github.com/aemsites/vg-macktrucks-com)  scripts/delayed.js

```javascript
function delayedInit() {
  checkCookiesAndLoadAllScripts();

  if (!window.location.pathname.includes('srcdoc') && !isDevHost()) {
    loadScript('https://cdn.cookielaw.org/scripttemplates/otSDKStub.js', {
      type: 'text/javascript',
      charset: 'UTF-8',
      'data-domain-script': DATA_DOMAIN_SCRIPT,
    });

    window.OptanonWrapper = () => {
      const currentOnetrustActiveGroups = window.OnetrustActiveGroups;

      function isSameGroups(groups1, groups2) {
        const s1 = JSON.stringify(groups1.split(','));
        const s2 = JSON.stringify(groups2.split(','));
        return s1 === s2;
      }

      window.OneTrust.OnConsentChanged(() => {
        if (!isSameGroups(currentOnetrustActiveGroups, window.OnetrustActiveGroups)) {
          checkCookiesAndLoadAllScripts();
        }
      });
    };
  }
}
```

Source: [aemsites/vg-macktrucks-com](https://github.com/aemsites/vg-macktrucks-com)  scripts/delayed.js

The `isDevHost()` guard skips OneTrust on localhost, `aem.page`, and `aem.live` because the consent cookie is not persistent on those domains  the banner would appear on every page load. 

### Key Insight: Config-Driven Reusability

The OneTrust domain script ID and all consent group IDs (`PERFORMANCE_COOKIE`, `TARGETING_COOKIE`, etc.) are stored in a `constants.xlsx` spreadsheet, not hardcoded in JavaScript. This makes the same codebase reusable across brands (multiple brands can share identical code with different spreadsheet values) and across locales without code changes. The spreadsheet is fetched as JSON at runtime via the standard Edge Delivery Services `fetch` + `toJSON` pattern.

---

### Pattern: Multi-Domain Config Map in a Dedicated Module

This multi-brand pattern isolates the per-domain OneTrust config in a dedicated `scripts/otconfing.js` module that maps URL regex patterns to domain script IDs. Each brand/environment gets its own OneTrust property.

**`scripts/otconfing.js`:**

```javascript
import { loadScript } from './aem.js';

export default function getOneTrustConfig(pageUrl) {
  const otConfigMap = [
    {
      pattern: /^https?:\/\/(www\.)?shredit\.com(\/|$)/,
      domainScript: 'REDACTED',  // brand-a production domain script ID
      script: 'https://cdn.cookielaw.org/consent/REDACTED/OtAutoBlock.js',
    },
    {
      pattern: /^https?:\/\/dev-us\.shredit\.com(\/|$)/,
      domainScript: 'REDACTED',  // brand-a dev domain script ID
      script: 'https://cdn.cookielaw.org/consent/REDACTED/OtAutoBlock.js',
    },
    // Add more brand/environment patterns here
  ];

  const matched = otConfigMap.find((config) => config.pattern.test(pageUrl));
  return matched || otConfigMap[0]; // fall back to first config
}

async function addCookieBanner() {
  const otConfig = getOneTrustConfig(window.location.href);
  await loadScript('https://cdn.cookielaw.org/scripttemplates/otSDKStub.js', {
    type: 'text/javascript',
    charset: 'UTF-8',
    'data-domain-script': otConfig.domainScript,
  });
}

await addCookieBanner();
```

**How it's loaded — `scripts/delayed.js`:**

```javascript
import { initMartech } from './martech.js';

// Load full martech stack — conditionally on QA environments with ?load-martech=delayed
const urlParams = new URLSearchParams(window.location.search);
if (
  (window.location.hostname.endsWith('.aem.page') || window.location.hostname.endsWith('.aem.live'))
  && urlParams.get('load-martech')?.toLowerCase() === 'delayed'
) {
  initMartech(getEnvironment());
}
```

Source: [aemsites/stericycle-shared](https://github.com/aemsites/stericycle-shared) — `scripts/otconfing.js`, `scripts/delayed.js`

**Key design points:**

1. **Config map pattern for multi-brand/multi-domain.** When a single codebase serves multiple domains, a regex-based config map is cleaner than a chain of `if/else` checks. `Array.find()` returns the first match, so more-specific patterns (e.g., dev subdomain) should appear before broad ones.
2. **Per-environment domain script IDs.** OneTrust allows creating separate "test" domain scripts for dev/staging environments. Using `dev-us.shredit.com` → its own script ID keeps development consent activity out of production analytics reports in the OneTrust dashboard.
3. **Dedicated `otconfing.js` module.** Isolating the config map in its own file keeps `delayed.js` clean and makes the per-brand mapping easy to find and update without touching orchestration logic. Other modules (`delayed.js`, `scripts.js`) can `import getOneTrustConfig` if they need it.
4. **`await addCookieBanner()` at module top-level.** The function executes immediately on `import './otconfing.js'` — no explicit call needed at the import site. This is valid in ES modules (top-level `await`) but requires the consuming script to also be a module.
5. **`?load-martech=delayed` QA override.** The full martech stack (Adobe Launch, GTM) only loads on `.aem.page`/`.aem.live` with this query param — a testing escape hatch that bypasses the normal delayed load without touching production code.

---

### Pattern: `banner-loaded` Event + `data-document-language` + Production Guard

This pattern introduces three techniques not seen in the other references: a custom `banner-loaded` event that decouples OneTrust from downstream scripts, the `data-document-language` attribute for locale-aware banners, and a clean config-object function signature.

**`scripts/delayed.js`:**

```javascript
import { loadScript } from './aem.js';

async function loadOneTrust(config) {
  const { onetrustId } = config;
  if (!onetrustId) return;

  // Set OptanonWrapper BEFORE loading the script (required by OneTrust)
  window.OptanonWrapper = () => {
    if (window.OnetrustActiveGroups) {
      const activeGroups = window.OnetrustActiveGroups.split(',');
      // eslint-disable-next-line no-console
      console.log(`OneTrust Loaded. Active groups: ${activeGroups}`);
    }

    // Dispatch a custom event so other scripts can react to consent readiness
    // without coupling directly to OptanonWrapper
    const bannerLoadedEvent = new Event('banner-loaded');
    window.dispatchEvent(bannerLoadedEvent);
  };

  await loadScript('https://cdn.cookielaw.org/scripttemplates/otSDKStub.js', {
    type: 'text/javascript',
    charset: 'UTF-8',
    'data-domain-script': onetrustId,
    'data-document-language': 'true',  // use <html lang> for locale-specific banner text
  });
}

function isProduction() {
  return window.location.host === 'YOUR_PRODUCTION_DOMAIN.com'; // ← set your production hostname
}

function hasOTParameter() {
  return new URLSearchParams(window.location.search).get('ot') === 'true';
}

// Load OneTrust on production only, or when ?ot=true is present (QA override)
if (isProduction() || hasOTParameter()) {
  await loadOneTrust({ onetrustId: '' }); // ← set your OneTrust domain script ID
}
```

**Consuming the `banner-loaded` event in other scripts:**

```javascript
// Instead of hooking into OptanonWrapper directly, listen for the custom event
window.addEventListener('banner-loaded', () => {
  // OneTrust is ready — check active groups and load analytics
  if (isConsentGroupAllowed('C0002')) loadAnalytics();
  if (isConsentGroupAllowed('C0004')) loadTargetingScripts();
});
```

**Key design points:**

1. **`banner-loaded` custom event.** Rather than adding logic directly inside `OptanonWrapper`, `OptanonWrapper` dispatches a custom `banner-loaded` event. Other modules listen for this event independently. This decouples consent readiness from the scripts that depend on it — each script registers its own listener rather than all being co-located in a single growing `OptanonWrapper` function.
2. **`data-document-language: 'true'`.** This attribute instructs OneTrust to read the `<html lang>` attribute and display the consent banner in the matching language automatically. Essential for multilingual sites where the banner text needs to match the page language without JavaScript logic.
3. **Config object signature `loadOneTrust({ onetrustId })`.** Passing a config object rather than a positional string argument makes the function easy to extend — adding `region`, `autoBlock`, or `testMode` later requires no signature change at the call site.
4. **`isProduction() || hasOTParameter()` guard.** A hostname check prevents OneTrust from loading on preview and local environments where the consent cookie doesn't persist across page loads and the banner would reappear on every load. The `?ot=true` param gives QA a way to test the banner on any environment.
5. **Hardcoded `onetrustId` vs spreadsheet.** This project hardcodes the domain script ID directly in `delayed.js`, unlike the config-driven approach (Pattern 1's spreadsheet) or the multi-domain config map approach (Pattern 2). Right choice for single-brand, single-domain projects where the ID never changes.
