# HubSpot

**Category:** Marketing Automation
**Edge Delivery Services approach:** `scripts/delayed.js`
**Load timing:** Post-LCP (3s delay)

## When to Use

HubSpot provides marketing automation, CRM tracking, live chat, and form handling. Use this integration when migrating sites that use HubSpot for visitor tracking, lead capture, chatbots, or analytics. The tracking code loads post-LCP to avoid impacting Core Web Vitals, while forms and chat widgets can be implemented as blocks for lazy loading.

## What to Extract During Audit

| Value | How to find it |
|-------|---------------|
| Portal ID (Hub ID) | View source, search for `js.hs-scripts.com/` - the number after is the Portal ID |
| Tracking Code | Look for `hs-script-loader` or `js.hs-scripts.com` script tags |
| Forms | Search for `hbspt.forms.create` calls to find form IDs and portal IDs |
| Chat Widget | Look for `HubSpotConversations` or chat bubble in the UI |

## Config Variables

| Variable | Where to get it |
|----------|----------------|
| `HUBSPOT_PORTAL_ID` | HubSpot > Settings > Account Setup > Account Defaults > Hub ID (numeric) |
| `HUBSPOT_FORM_ID` | HubSpot > Marketing > Forms > Select form > Form ID in URL or embed code |

## Code - Tracking Code

### `scripts/delayed.js`

```javascript
import { loadScript } from './aem.js';

// Exported so blocks/hubspot-form/hubspot-form.js can import it — avoids duplicating the value.
export const HUBSPOT_PORTAL_ID = ''; // ← HubSpot > Settings > Account Defaults > Hub ID

// With OneTrust: replace with isConsentGroupAllowed('C0002') from onetrust.md
function isAnalyticsAllowed() {
  return !document.cookie.includes('analytics_storage=denied');
}

function loadHubSpot() {
  if (!HUBSPOT_PORTAL_ID) {
    // eslint-disable-next-line no-console
    console.warn('HubSpot: HUBSPOT_PORTAL_ID is not configured — skipping.');
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

  if (!isAnalyticsAllowed()) {
    return;
  }

  loadScript(`https://js.hs-scripts.com/${HUBSPOT_PORTAL_ID}.js`, {
    id: 'hs-script-loader',
    async: true,
    defer: true,
  });
}

loadHubSpot();
```

## Code - HubSpot Form Block

### `blocks/hubspot-form/hubspot-form.js`

```javascript
import { loadScript } from '../../scripts/aem.js';
// Importing HUBSPOT_PORTAL_ID from delayed.js avoids duplicating the value.
// delayed.js is an ES module (dynamically imported by aem.js), so named exports work.
// Alternative: read from page metadata — document.querySelector('meta[name="hubspot-portal-id"]')?.content
import { HUBSPOT_PORTAL_ID } from '../../scripts/delayed.js';

let formsLoadPromise = null;

function loadHubSpotForms() {
  if (!formsLoadPromise) {
    formsLoadPromise = loadScript('https://js.hsforms.net/forms/v2.1.js');
  }
  return formsLoadPromise;
}

export default async function decorate(block) {
  if (!HUBSPOT_PORTAL_ID) {
    // eslint-disable-next-line no-console
    console.warn('HubSpot Form: HUBSPOT_PORTAL_ID is not configured — skipping.');
    block.innerHTML = '<p>Form unavailable — HubSpot not configured</p>';
    return;
  }

  const formId = block.textContent.trim();
  if (!formId) {
    block.innerHTML = '<p>Form unavailable — no form ID specified</p>';
    return;
  }

  const formContainer = document.createElement('div');
  formContainer.className = 'hubspot-form-container';
  formContainer.id = `hubspot-form-${formId}`;
  block.innerHTML = '';
  block.appendChild(formContainer);

  await loadHubSpotForms();

  if (window.hbspt?.forms) {
    window.hbspt.forms.create({
      portalId: HUBSPOT_PORTAL_ID,
      formId,
      target: `#${formContainer.id}`,
    });
  }
}
```

### `blocks/hubspot-form/hubspot-form.css`

```css
.hubspot-form {
  margin: 2rem 0;
}

.hubspot-form .hubspot-form-container {
  max-width: 600px;
}

/* Override HubSpot default styles to match site design */
.hubspot-form .hs-form-field {
  margin-bottom: 1.5rem;
}

.hubspot-form .hs-form-field label {
  display: block;
  margin-bottom: 0.5rem;
  font-weight: 600;
  color: var(--text-color, #333);
}

.hubspot-form .hs-input {
  width: 100%;
  padding: 0.75rem;
  border: 1px solid var(--border-color, #ccc);
  border-radius: 4px;
  font-size: 1rem;
}

.hubspot-form .hs-input:focus {
  outline: none;
  border-color: var(--link-color, #0066cc);
  box-shadow: 0 0 0 2px rgb(0 102 204 / 20%);
}

.hubspot-form .hs-button {
  background-color: var(--link-color, #0066cc);
  color: white;
  padding: 0.75rem 1.5rem;
  border: none;
  border-radius: 4px;
  font-size: 1rem;
  cursor: pointer;
  transition: background-color 0.2s;
}

.hubspot-form .hs-button:hover {
  background-color: var(--link-hover-color, #0052a3);
}

.hubspot-form .hs-error-msgs {
  color: #dc3545;
  font-size: 0.875rem;
  margin-top: 0.25rem;
}

.hubspot-form p {
  padding: 1rem;
  text-align: center;
  background-color: var(--light-color, #f5f5f5);
}
```

## Code - `head.html`

```html
<link rel="preconnect" href="https://js.hs-scripts.com">
<link rel="preconnect" href="https://js.hsforms.net">
<link rel="preconnect" href="https://forms.hsforms.com">
```

## Consent-Gated Loading

If using OneTrust or another consent manager, gate HubSpot behind performance cookies:

```javascript
import { isPerformanceAllowed } from './common.js';

function loadHubSpotWithConsent() {
  if (!isPerformanceAllowed()) {
    // eslint-disable-next-line no-console
    console.log('HubSpot: skipped (consent not granted)');
    return;
  }

  loadHubSpot();
}

// Re-check on consent change
window.addEventListener('consent-updated', loadHubSpotWithConsent);
loadHubSpotWithConsent();
```

## Authoring Instructions

### Tracking Code
No authoring required - tracking loads automatically on all pages.

### HubSpot Form Block
Authors create a form block in their document:

| HubSpot Form |
|--------------|
| xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx |

The value is the Form ID (GUID) from HubSpot.

## Verification

- **Network tab:** Request to `js.hs-scripts.com/{PORTAL_ID}.js` after ~3s
- **Console:** `window.HubSpotConversations` or `window._hsq` should be defined
- **Cookies:** `hubspotutk` cookie should be set (visitor tracking)
- **Forms:** `window.hbspt.forms` should be defined when form block loads
- **Chat:** If enabled, chat widget appears in bottom-right corner

## Real-World Reference

### Pattern: Dedicated Helper Module

Some Edge Delivery Services projects isolate HubSpot in a dedicated helper module:

```javascript
// scripts/hubspot-helper.js
import { loadScript } from './aem.js';

const HUBSPOT_PORTAL_ID = '';

export default function loadHubSpot() {
  if (!HUBSPOT_PORTAL_ID) return;

  const { hostname } = window.location;
  if (hostname.includes('localhost') || hostname.includes('.aem.')) return;

  loadScript(`https://js.hs-scripts.com/${HUBSPOT_PORTAL_ID}.js`, {
    id: 'hs-script-loader',
    async: true,
    defer: true,
  });
}
```

```javascript
// scripts/delayed.js
import loadHubSpot from './hubspot-helper.js';

loadHubSpot();
```

This keeps `delayed.js` clean and makes the HubSpot configuration easy to find and update.
