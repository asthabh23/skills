# Consent-Gated Integration Architecture

Reference implementation from [aemsites/vg-macktrucks-com](https://github.com/aemsites/vg-macktrucks-com) and [aemsites/volvotrucks-na](https://github.com/aemsites/volvotrucks-na) — the most comprehensive consent-gated loading pattern found across aemsites repos.

## Overview

All third-party integrations are gated behind OneTrust consent categories. Config values (IDs, hostnames, consent group codes) are stored in a `constants.xlsx` SharePoint spreadsheet — not hardcoded in JavaScript. The same codebase serves multiple brands and locales by swapping the spreadsheet.

## File Structure

```
scripts/
├── aem.js          # Standard AEM SDK (loadScript, sampleRUM, etc.)
├── common.js       # Consent helpers + COOKIE_CONFIGS from constants.xlsx
├── delayed.js      # Integration loader — reads config, gates on consent
└── scripts.js      # Core site logic (decorateMain, loadLazy, etc.)
```

## Architecture Flow

```
constants.xlsx (SharePoint)
  ↓ fetched as JSON at runtime
COOKIE_CONFIGS object (common.js)
  ↓ destructured into named variables
delayed.js: { GTM_ID, HOTJAR_ID, FACEBOOK_ID, ... } = COOKIE_CONFIGS
  ↓ checked against consent
isPerformanceAllowed() / isSocialAllowed() / isTargetingAllowed()
  ↓ if allowed
loadGoogleTagManager() / loadHotjar() / loadFacebookPixel() / ...
```

## Key Code: common.js — Consent Helpers

```javascript
/**
 * Cookie config values loaded from constants.xlsx spreadsheet.
 * Each row has a `key` and `value` column — keys include:
 *   GTM_ID, HOTJAR_ID, FACEBOOK_ID, LINKEDIN_PARTNER_ID,
 *   ACC_ENG_TRACKING, DATA_DOMAIN_SCRIPT,
 *   PERFORMANCE_COOKIE, FUNCTIONAL_COOKIE, TARGETING_COOKIE, SOCIAL_COOKIE
 */
export const COOKIE_CONFIGS = /* loaded from spreadsheet */;

const {
  PERFORMANCE_COOKIE = false,
  FUNCTIONAL_COOKIE = false,
  TARGETING_COOKIE = false,
  SOCIAL_COOKIE = false,
} = COOKIE_CONFIGS;

/**
 * Check if a OneTrust consent group is active.
 * Reads the OptanonConsent cookie and checks if the group code (e.g. C0002)
 * has value :1 (opted in).
 *
 * @param {string} groupName - OneTrust group code (e.g. 'C0002')
 * @param {boolean} cookieCheck - Override to bypass the cookie check
 */
function checkOneTrustGroup(groupName, cookieCheck = false) {
  const oneTrustCookie = decodeURIComponent(
    document.cookie
      .split(';')
      .find((cookie) => cookie.trim().startsWith('OptanonConsent='))
  );
  return cookieCheck || oneTrustCookie.includes(`${groupName}:1`);
}

export function isPerformanceAllowed() {
  return checkOneTrustGroup(PERFORMANCE_COOKIE);
}

export function isFunctionalAllowed() {
  return checkOneTrustGroup(FUNCTIONAL_COOKIE);
}

export function isTargetingAllowed() {
  return checkOneTrustGroup(TARGETING_COOKIE);
}

export function isSocialAllowed() {
  return checkOneTrustGroup(SOCIAL_COOKIE);
}

/**
 * Check if the current host is a development/preview environment.
 * Used to skip OneTrust loading on non-production domains where
 * cookies are not persistent.
 */
export function isDevHost() {
  const { hostname } = window.location;
  return hostname.includes('localhost')
    || hostname.includes('.aem.page')
    || hostname.includes('.aem.live');
}
```

Source: [aemsites/vg-macktrucks-com](https://github.com/aemsites/vg-macktrucks-com) — `scripts/common.js`

## Key Code: delayed.js — Orchestration

```javascript
import { loadScript, sampleRUM } from './aem.js';
import {
  isPerformanceAllowed, isSocialAllowed, isTargetingAllowed,
  extractObjectFromArray, COOKIE_CONFIGS, isDevHost,
} from './common.js';

// Destructure ALL integration IDs from the spreadsheet config.
// Each defaults to `false` — if a value is missing from the spreadsheet,
// that integration is silently skipped.
const {
  ACC_ENG_TRACKING = false,
  DATA_DOMAIN_SCRIPT = false,
  FACEBOOK_ID = false,
  GTM_ID = false,
  HOTJAR_ID = false,
  LINKEDIN_PARTNER_ID = false,
} = COOKIE_CONFIGS;

sampleRUM('cwv');

/**
 * Central orchestrator: checks consent state and loads all integrations.
 * Called once at init AND again via OneTrust.OnConsentChanged() when the
 * user updates their cookie preferences — no page reload needed.
 */
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
    if (ACC_ENG_TRACKING) loadAccountEngagementTracking();
  }
}
checkCookiesAndLoadAllScripts();

// OneTrust Consent Banner — skipped on dev/preview hosts where
// cookies are not persistent (would re-prompt on every page load).
if (DATA_DOMAIN_SCRIPT && !window.location.pathname.includes('srcdoc') && !isDevHost()) {
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

// --- Individual integration loaders below ---

async function loadGoogleTagManager() { /* ... see google-tag-manager.md */ }
async function loadHotjar() { /* ... see hotjar.md */ }
async function loadFacebookPixel() { /* ... see meta-pixel.md */ }
async function loadLinkedInInsightTag() { /* ... see linkedin-insight.md */ }
async function loadAccountEngagementTracking() { /* ... see pardot.md */ }
```

Source: [aemsites/vg-macktrucks-com](https://github.com/aemsites/vg-macktrucks-com) — `scripts/delayed.js`

## OneTrust Consent Groups

| Group Code | Category | Typical Integrations |
|-----------|----------|---------------------|
| C0001 | Strictly Necessary | (always active — no check needed) |
| C0002 | Performance | GTM, Google Analytics, Hotjar, FullStory, Clarity |
| C0003 | Functional | Intercom, chatbots, personalization |
| C0004 | Targeting | Pardot, Account Engagement tracking |
| C0005 | Social Media | Meta Pixel, LinkedIn Insight, Twitter/X |

Note: Group codes vary by OneTrust configuration. The config-driven approach stores the actual group codes in `constants.xlsx` rather than hardcoding C0002/C0004/etc.

## constants.xlsx Spreadsheet Structure

The spreadsheet has a `cookieValues` sheet with two columns:

| key | value |
|-----|-------|
| GTM_ID | GTM-XXXXXXX |
| HOTJAR_ID | 1234567 |
| FACEBOOK_ID | 1234567890123456 |
| LINKEDIN_PARTNER_ID | 1234567 |
| DATA_DOMAIN_SCRIPT | xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx |
| PERFORMANCE_COOKIE | C0002 |
| FUNCTIONAL_COOKIE | C0003 |
| TARGETING_COOKIE | C0004 |
| SOCIAL_COOKIE | C0005 |
| ACC_ENG_TRACKING | {"piAId":"123456","piCId":"12345","piHostname":"pi.pardot.com"} |

This approach means:
- **No code changes** to add/remove/change integration IDs — update the spreadsheet and the site picks up the new values
- **Multi-locale support** — each locale can have its own `constants.xlsx` with different IDs
- **Transparency** — business users can see which integrations are active without reading JavaScript

## Applying This Pattern

When a project needs 3+ third-party integrations with consent management:

1. Create `constants.xlsx` in SharePoint/Google Drive with the `cookieValues` sheet
2. Add consent helper functions to `scripts/common.js`
3. Structure `scripts/delayed.js` with the `checkCookiesAndLoadAllScripts()` orchestrator
4. Configure OneTrust with the matching domain script ID
5. Each integration becomes a simple loader function — the orchestrator handles consent

Cross-reference the individual integration files (`google-tag-manager.md`, `hotjar.md`, `meta-pixel.md`, `linkedin-insight.md`, `pardot.md`, `onetrust.md`) for the specific loader function code.

## Multi-Vendor Consent Fanout

Use this when the loop has already extracted vendors into `loadEager` / `loadLazy`. Those vendors are loaded by the time consent changes, so they need a runtime *update*, not a load-on-consent gate.

Phase 3 emits one block per entry in `containerAnalysis.vendors[]` — driven by detection (or by a supplied report), so the handler covers exactly the vendors actually on the page. Vendor-update snippets:

```javascript
function applyConsent({ collect, marketing, personalize, share }) {
  // adobe-websdk-alloy / adobe-target / adobe-ajo
  if (window.alloy) {
    window.alloy('setConsent', {
      consent: [{
        standard: 'Adobe', version: '2.0',
        value: {
          collect:     { val: collect ? 'y' : 'n' },
          marketing:   { preferences: { val: marketing ? 'y' : 'n' } },
          personalize: { content: { val: personalize ? 'y' : 'n' } },
          share:       { val: share ? 'y' : 'n' },
        },
      }],
    });
  }

  // ga4 / ga-universal / google-ads (gtag-driven vendors)
  if (window.gtag) {
    window.gtag('consent', 'update', {
      analytics_storage:  collect   ? 'granted' : 'denied',
      ad_storage:         marketing ? 'granted' : 'denied',
      ad_user_data:       marketing ? 'granted' : 'denied',
      ad_personalization: marketing ? 'granted' : 'denied',
    });
  }

  // segment — opt-out toggles its sink; mixpanel and amplitude expose similar
  // calls if the vendor is on the page.
  if (window.analytics?.reset && !collect) window.analytics.reset();
  if (window.mixpanel) (collect ? window.mixpanel.opt_in_tracking : window.mixpanel.opt_out_tracking)();
  if (window.amplitude) window.amplitude.setOptOut(!collect);
}

// Initial decision plus banner-driven updates. Event names match the
// generated consent helpers; Adobe Target / personalization use 'consent',
// most CMPs emit 'consent-updated'.
applyConsent(readStoredConsent());
window.addEventListener('consent',         (ev) => applyConsent(ev.detail.categories));
window.addEventListener('consent-updated', (ev) => applyConsent(ev.detail.categories));
```

### What Phase 3 Generates

For each `vendor` in `containerAnalysis.vendors[]`, Phase 3 emits the matching block above. Vendors not in this snippet — Microsoft Clarity, Meta Pixel, LinkedIn Insight, Hotjar, Heap, Contentsquare — are flagged in `manual_review_items` so the reviewer adds the vendor-specific call. The fanout shape is generic; the per-vendor APIs are not.

> Use this **alongside** the load-on-consent pattern above, not instead of it. Vendors extracted to eager/lazy use fanout (already loaded → update at runtime); vendors that stay in delayed use load-on-consent (gate before loading).
