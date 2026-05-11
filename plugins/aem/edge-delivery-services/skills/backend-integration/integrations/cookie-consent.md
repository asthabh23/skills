# Cookie Consent

**Category:** Consent Management
**Edge Delivery Services approach:** `scripts/scripts.js` (early load — must run before analytics)
**Load timing:** During `loadLazy()`, before `loadDelayed()`

## When to Use

Use this when the source site has a cookie consent banner using Cookiebot, TrustArc, or a custom-built banner.

> **OneTrust users:** If the audit finds `cdn.cookielaw.org`, `OptanonConsent` cookies, or `window.OneTrust`, use `integrations/onetrust.md` instead — it has full OneTrust-specific guidance including consent group helpers.

The consent mechanism must load BEFORE analytics scripts in `delayed.js`, because those scripts check consent cookies before firing.

## Which Approach to Use

| If the audit finds… | Use |
|--------------------|-----|
| `cdn.cookielaw.org` / `OptanonConsent` / `window.OneTrust` | **Use `integrations/onetrust.md`** (separate file) |
| `consent.cookiebot.com` scripts or `CookieConsent` cookie | **Approach A** (Cookiebot) below |
| A custom banner with no recognized provider domain | **Approach B** (Custom block) below |
| TrustArc or any other named provider | **Approach A** — adapt the script load URL and cookie name to match their SDK |

If you are unsure, check the audit's `externalDomains` list for any `cookielaw.org`, `cookiebot.com`, or `trustarc.com` entries.

## What to Extract During Audit

| Value | How to find it |
|-------|---------------|
| Provider | Look for OneTrust (`onetrust`), Cookiebot (`cookiebot`), or custom DOM elements |
| Cookie names | What cookies store consent state (e.g., `analytics_storage`, `ad_storage`, `OptanonConsent`) |
| Categories | What consent categories exist (essential, performance, targeting, etc.) |
| Gating logic | How analytics scripts check consent (e.g., `getCookieValue('ad_storage') != 'denied'`) |
| Banner text | The consent message shown to users |
| Provider ID | For OneTrust: domain script ID. For Cookiebot: CBID |

## Approach A: Third-Party Provider (Cookiebot, TrustArc)

### Config Variables

| Variable | Where to get it |
|----------|----------------|
| `COOKIEBOT_CBID` | Cookiebot → Settings → Domain Group ID |

### Code — `scripts/delayed.js` (top — before other integrations)

Place at the top of `delayed.js`, before any analytics or tracking scripts:

```javascript
async function loadConsentManager() {
  const COOKIEBOT_ID = ''; // ← Set your Cookiebot Domain Group ID
  if (!COOKIEBOT_ID) {
    // eslint-disable-next-line no-console
    console.warn('Consent: Set COOKIEBOT_ID in delayed.js');
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

  await new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = 'https://consent.cookiebot.com/uc.js';
    script.dataset.cbid = COOKIEBOT_ID;
    script.onload = resolve;
    script.onerror = resolve;
    document.head.appendChild(script);
  });
}

// Run consent manager first — all other integrations go after this line.
await loadConsentManager();
```

## Approach B: Custom Consent Banner (Block)

For sites with a custom-built consent banner (no third-party provider), create a block:

### Files to Create

- `blocks/cookie-consent/cookie-consent.js`
- `blocks/cookie-consent/cookie-consent.css`

### Code — `blocks/cookie-consent/cookie-consent.js`

The block should:
1. Check if consent cookies already exist → if yes, don't show the banner
2. Render a banner with "Accept" and "Manage" buttons
3. On "Accept" → set all consent cookies to `granted`, hide banner
4. On "Manage" → show a dialog with toggleable categories
5. On "Confirm" in dialog → save per-category preferences, hide banner

Consent cookies to set (must match what `delayed.js` checks):
- `analytics_storage` = `granted` | `denied`
- `ad_storage` = `granted` | `denied`

### Code — `scripts/scripts.js`

Auto-inject the consent block on every page:

```javascript
async function loadCookieConsent() {
  // Skip if consent already given
  if (document.cookie.includes('analytics_storage=') || document.cookie.includes('ad_storage=')) return;

  // Skip if block already authored on this page
  if (document.querySelector('.cookie-consent')) return;

  // Auto-inject
  const wrapper = document.createElement('div');
  wrapper.className = 'cookie-consent';
  document.body.appendChild(wrapper);

  try {
    const cssPromise = new Promise((resolve) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `${window.hlx.codeBasePath}/blocks/cookie-consent/cookie-consent.css`;
      link.onload = resolve;
      link.onerror = resolve;
      document.head.appendChild(link);
    });
    const mod = await import('../blocks/cookie-consent/cookie-consent.js');
    await cssPromise;
    if (mod.default) mod.default(wrapper);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('Cookie consent block failed to load:', e);
  }
}
```

Call this in `loadLazy()` before `loadDelayed()`:

```javascript
async function loadLazy(doc) {
  // ... existing code ...
  await loadCookieConsent(); // ← Add this
  // loadDelayed() is called after this
}
```

### Authoring (optional — to customize text)

If authors want to customize the banner text on specific pages:

| Cookie Consent | |
|---|---|
| Banner Text | We use cookies to improve your experience. |
| Privacy Link | /privacy#cookies |
| Know More Label | Learn more |
| Accept Label | Accept |

If no table is authored, the banner auto-injects with default text.

## Verification

- **DOM:** `.cookie-consent-banner` should appear fixed at bottom-left on first visit
- **Click "Accept":** `analytics_storage=granted` and `ad_storage=granted` cookies should be set
- **Reload:** Banner should NOT appear (consent remembered)
- **Clear cookies + reload:** Banner reappears
- **Console:** After denying consent, `delayed.js` integrations should log "skipped (consent denied)"

---

## Real-World Reference

### Pattern: Spreadsheet-Driven Informational Cookie Notice

This pattern uses a lightweight cookie notification — not a full opt-in/opt-out CMP. Analytics load unconditionally regardless of whether the user dismisses the banner. Appropriate for sites not subject to GDPR opt-in requirements where the banner is purely informational.

**What makes this pattern distinct:**
- All banner text (message, link label, close aria-label) comes from the `placeholders` spreadsheet — zero hardcoded strings in code
- Locale-aware: placeholders are fetched at `{PATH_PREFIX}/{langCode}` (e.g., `/ext/en`, `/ext/fr`)
- The banner DOM is created in `loadEager()` with `display:none`, then made visible in `loadLazy()` after blocks load — avoids layout shift
- Uses a single simple `consent_cookie=1` flag, not `analytics_storage=granted/denied`

**`scripts/utils.js` — the cookie banner logic:**

```javascript
import { div, p, section, a, button, span } from './dom-helpers.js';
import { PATH_PREFIX, getLanguage } from './utils.js';

const setConsentCookie = (name, value, daysToExpire, cookieSection) => {
  const currDate = new Date();
  currDate.setTime(currDate.getTime() + (daysToExpire * 24 * 60 * 60 * 1000));
  const expiration = `expires=${currDate.toUTCString()}`;
  const domain = `; domain=${new URL(window.location.href).hostname};`;
  document.cookie = `${name}=${value}; ${expiration}; path=/${domain}`;
  cookieSection.style.display = 'none';
};

export function cookiePopUp() {
  // Skip if user already consented
  const consentCookie = document.cookie.replace(
    /(?:(?:^|.*;\s*)consent_cookie\s*=\s*([^;]*).*$)|^.*$/,
    '$1',
  );
  if (consentCookie.indexOf('1') >= 0) return;

  const cookieSection = section({ class: 'cookie-tooltip', style: 'display:none;' });

  // All text from placeholders spreadsheet — no hardcoded strings
  const placeholders = window.placeholders[`${PATH_PREFIX}/${getLanguage()}`] || {};
  if (!placeholders.cookiePopUpText) return;  // skip if text not configured

  const cookieContainer = div(
    { class: 'container' },
    p(
      { tabindex: 0 },
      `${placeholders.cookiePopUpText} `,
      a(
        { href: placeholders.cookiePopUpLearnMoreLink || '#' },
        placeholders.cookiePopUpLearnMoreLinkLabel || 'Click Here',
      ),
    ),
    button(
      {
        type: 'button',
        class: 'close accept-consent',
        'aria-label': placeholders.cookiePopUpCloseAriaLabel || 'Close Cookie Notification',
        onclick: () => setConsentCookie('consent_cookie', '1', 365, cookieSection),
      },
      span({ 'aria-hidden': 'true' }, '×'),
    ),
  );

  cookieSection.append(cookieContainer);
  document.body.insertBefore(cookieSection, document.body.firstChild);
}

export function showCookieConsent() {
  const cookieSection = document.querySelector('.cookie-tooltip');
  if (cookieSection) cookieSection.style = 'display:block;';
}
```

**`scripts/scripts.js` — split between eager and lazy phases:**

```javascript
async function loadEager(doc) {
  // Create banner DOM early (hidden) to avoid layout shift
  await cookiePopUp();
  // ... rest of eager ...
}

async function loadLazy(doc) {
  await loadBlocks(main);
  // Show banner only after page content has loaded
  showCookieConsent();
  // ... rest of lazy ...
}
```

**Placeholders spreadsheet columns required:**

| Key | Example value |
|-----|--------------|
| `cookiePopUpText` | `This site uses cookies to optimize functionality and give you the best possible experience.` |
| `cookiePopUpLearnMoreLink` | `/en/home/cookie-notice` |
| `cookiePopUpLearnMoreLinkLabel` | `Learn more` |
| `cookiePopUpCloseAriaLabel` | `Close Cookie Notification` |

Source: aemsites/world-bank — `scripts/utils.js`, `scripts/scripts.js`

**Key design points:**

1. **Informational notice, not a consent gate.** Analytics load unconditionally in `delayed.js` regardless of the banner. This is the right choice for sites without GDPR opt-in requirements. If your project needs to gate analytics on consent, use the `analytics_storage=granted/denied` cookie pattern (Approach B above) instead.
2. **Spreadsheet text = no code deploys for copy changes.** Authors update banner text, privacy links, and labels directly in the Google Sheet or SharePoint tab. No PR needed.
3. **`display:none` in eager, `display:block` in lazy.** Creating the DOM early but showing it late prevents the banner from competing with LCP rendering. The banner appears only after the main content is interactive.
4. **`consent_cookie=1` is a Fitfor-purpose signal.** If your project eventually needs granular consent categories (`analytics_storage`, `ad_storage`), this single-flag approach would need replacing with a full CMP. Use it only for simple notification banners.
5. **DOM helper functions instead of `innerHTML`.** `div()`, `p()`, `button()`, `span()` from `dom-helpers.js` produce cleaner code than template literals and avoid XSS risks from placeholder values.
