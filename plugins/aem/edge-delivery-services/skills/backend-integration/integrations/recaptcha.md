# Google reCAPTCHA

**Category:** Bot Protection / Security
**Edge Delivery Services approach:** Dedicated module `scripts/recaptcha.js` (imported by form blocks)
**Load timing:** On form load (lazy — only when a form block with reCAPTCHA is decorated)

## When to Use

Google reCAPTCHA protects forms from spam and abuse by verifying that submissions come from humans. Use this integration when migrating sites with contact forms, registration forms, or any user input that needs bot protection. reCAPTCHA v3 runs invisibly in the background scoring user interactions, while reCAPTCHA v2 displays the familiar checkbox or image challenge.

## What to Extract During Audit

| Value | How to find it |
|-------|---------------|
| Site Key | View source, search for `data-sitekey` or `render=` parameter in reCAPTCHA script URL |
| reCAPTCHA Version | v2 uses checkbox/challenge widget; v3 uses invisible scoring with `grecaptcha.execute()` |
| Implementation Type | Check if it's embedded in a form (`data-sitekey` on div) or loaded programmatically |
| Actions (v3 only) | Search for `grecaptcha.execute()` calls to find action names like `'submit'`, `'login'` |

## Config Variables

| Variable | Where to get it |
|----------|----------------|
| `RECAPTCHA_SITE_KEY` | Google reCAPTCHA Admin Console (https://www.google.com/recaptcha/admin) > Select your site > Settings > Site Key |

## Code - reCAPTCHA v3 (Invisible)

### `scripts/recaptcha.js` (dedicated module — imported by form blocks)

Keep reCAPTCHA logic in its own module rather than `scripts.js`. Exporting from `scripts.js` creates side-effect coupling — a dedicated module is the standard EDS pattern for shared utilities.

```javascript
// Score thresholds (v3): 1.0 = human, 0.0 = bot. Reject server-side if score < 0.5.
// Verify token: POST https://www.google.com/recaptcha/api/siteverify with your secret key.
import { loadScript } from './aem.js';

const RECAPTCHA_SITE_KEY = ''; // ← Set your reCAPTCHA v3 site key

let recaptchaLoadPromise = null;

export async function loadRecaptcha() {
  if (!RECAPTCHA_SITE_KEY) {
    // eslint-disable-next-line no-console
    console.warn('reCAPTCHA: RECAPTCHA_SITE_KEY is not configured — skipping.');
    return false;
  }

  const { hostname } = window.location;
  if (
    hostname.includes('localhost')
    || hostname.includes('.aem.page')
    || hostname.includes('.aem.live')
  ) {
    return false;
  }

  if (!recaptchaLoadPromise) {
    recaptchaLoadPromise = loadScript(
      `https://www.google.com/recaptcha/api.js?render=${RECAPTCHA_SITE_KEY}`,
    ).then(() => true).catch(() => false);
  }
  return recaptchaLoadPromise;
}

/** @param {string} action - e.g. 'contact_submit', 'login' — sent to reCAPTCHA for scoring */
export async function executeRecaptcha(action = 'submit') {
  if (!window.grecaptcha) {
    // eslint-disable-next-line no-console
    console.warn('reCAPTCHA: grecaptcha not loaded — token unavailable');
    return null;
  }

  return new Promise((resolve) => {
    window.grecaptcha.ready(() => {
      window.grecaptcha.execute(RECAPTCHA_SITE_KEY, { action })
        .then(resolve)
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.error('reCAPTCHA execution failed:', err);
          resolve(null);
        });
    });
  });
}
```

### Usage in Form Block

```javascript
import { loadRecaptcha, executeRecaptcha } from '../../scripts/recaptcha.js';

export default async function decorate(block) {
  await loadRecaptcha();

  const form = block.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const token = await executeRecaptcha('form_submit');
    if (!token) return; // gracefully skip — form still submits without token on localhost/preview

    const formData = new FormData(form);
    formData.append('g-recaptcha-response', token);
    // Send formData to your backend — validate token server-side before processing
  });
}
```

## Code - reCAPTCHA v2 (Checkbox)

### Form Block

```javascript
import { loadScript } from '../../scripts/aem.js';

const RECAPTCHA_SITE_KEY = ''; // ← reCAPTCHA v2 site key (google.com/recaptcha/admin)

export default async function decorate(block) {
  if (!RECAPTCHA_SITE_KEY) {
    // eslint-disable-next-line no-console
    console.warn('reCAPTCHA: RECAPTCHA_SITE_KEY is not configured — skipping.');
    return;
  }

  const recaptchaContainer = document.createElement('div');
  recaptchaContainer.className = 'g-recaptcha';
  recaptchaContainer.dataset.sitekey = RECAPTCHA_SITE_KEY;

  const submitBtn = block.querySelector('button[type="submit"]');
  if (submitBtn) {
    submitBtn.parentNode.insertBefore(recaptchaContainer, submitBtn);
  }

  await loadScript('https://www.google.com/recaptcha/api.js');
}
```

## Code - `head.html`

```html
<link rel="preconnect" href="https://www.google.com">
<link rel="preconnect" href="https://www.gstatic.com" crossorigin>
```

## Server-Side Verification

reCAPTCHA tokens must be verified server-side. Send the token to Google's verification endpoint:

```
POST https://www.google.com/recaptcha/api/siteverify
Parameters:
  - secret: Your secret key (server-side only, never expose in frontend)
  - response: The token from grecaptcha.execute() or g-recaptcha-response
  - remoteip: (optional) User's IP address
```

Response includes a `score` (0.0-1.0 for v3) or `success` boolean (v2).

## Verification

- **Network tab:** Request to `www.google.com/recaptcha/api.js` with your site key
- **Console:** `window.grecaptcha` should be defined after script loads
- **DOM (v2):** `div.g-recaptcha` with `data-sitekey` attribute; iframe appears after load
- **Form submission:** `g-recaptcha-response` field should be included in form data
