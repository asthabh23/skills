# Google Translate Widget

**Category:** Localization
**Edge Delivery Services approach:** `scripts/delayed.js` (basic) or custom block (advanced)
**Load timing:** Post-LCP (3s delay)

## When to Use

Use this when the source site embeds the Google Translate widget (`translate.google.com/translate_a/element.js`) to let users switch languages. The widget injects a dropdown into a designated container element.

This is the free, client-side Google Translate — not Google Cloud Translation API (which is a server-side service). The widget is suitable for informational sites that need accessible multilingual support without managing translated content. For content-heavy sites with SEO requirements, dedicated translated pages (Edge Delivery Services's built-in multi-language folder structure) are preferable.

## What to Extract During Audit

| Value | How to find it |
|-------|---------------|
| Container element ID | Page source → the `div` or element passed to `new google.translate.TranslateElement(...)` — typically `'google_translate_element'` |
| Page language | The `pageLanguage` option in the `TranslateElement` config — e.g., `'en'` |
| Layout style | Optional — `google.translate.TranslateElement.InlineLayout.SIMPLE` or `HORIZONTAL` if specified |
| Include/exclude languages | Optional — `includedLanguages: 'en,es,fr'` if the site restricts available languages |

## Config Variables

| Variable | Where to get it |
|----------|----------------|
| `TRANSLATE_CONTAINER_ID` | The DOM element ID where the widget renders — usually `'google_translate_element'`. Match whatever the source site uses. |
| `PAGE_LANGUAGE` | Source language of the page content — typically `'en'` |
| `INCLUDED_LANGUAGES` | Optional. Comma-separated language codes to restrict the dropdown. Leave empty for all languages. |

## Code — `scripts/delayed.js`

```javascript
// ============================================================
// Google Translate Widget
// ============================================================
// SETUP: Ensure a container element exists in the page where the
// widget should render. By default, this looks for an element with
// id="google_translate_element". For Edge Delivery Services, the recommended approach
// is a dedicated block (see "Block Approach" below) rather than
// injecting a container into the header/footer via JS.
//
// NOTE: Google Translate is a free, client-side translation widget.
// It rewrites page content via JavaScript — there is no server-side
// translation. SEO value is limited.
// ============================================================

const TRANSLATE_CONTAINER_ID = 'google_translate_element'; // ← element ID for the widget
const PAGE_LANGUAGE = 'en'; // ← source language of your content
const INCLUDED_LANGUAGES = ''; // ← optional: 'en,es,fr,de' to restrict. Empty = all languages.

function loadGoogleTranslate() {
  const container = document.getElementById(TRANSLATE_CONTAINER_ID);
  if (!container) {
    // eslint-disable-next-line no-console
    console.log('Google Translate: container element not found, skipping');
    return;
  }

  // Define the callback before loading the script
  window.googleTranslateElementInit = function googleTranslateElementInit() {
    const options = {
      pageLanguage: PAGE_LANGUAGE,
    };
    if (INCLUDED_LANGUAGES) {
      options.includedLanguages = INCLUDED_LANGUAGES;
    }
    // eslint-disable-next-line no-new
    new google.translate.TranslateElement(options, TRANSLATE_CONTAINER_ID);
  };

  // Load the Google Translate script — it calls googleTranslateElementInit on load
  const script = document.createElement('script');
  script.src = 'https://translate.google.com/translate_a/element.js?cb=googleTranslateElementInit';
  script.async = true;
  document.body.appendChild(script);
}
```

## Block Approach (Recommended for Edge Delivery Services)

Rather than injecting the container element via JavaScript, create a simple Edge Delivery Services block that authors can place in their pages (typically in the header or footer).

### Block code — `blocks/google-translate/google-translate.js`

```javascript
export default function decorate(block) {
  const container = document.createElement('div');
  container.id = 'google_translate_element';
  block.textContent = '';
  block.appendChild(container);

  // The actual script loading happens in delayed.js via loadGoogleTranslate()
  // This block just creates the container element.
}
```

### Block code — `blocks/google-translate/google-translate.css`

```css
.google-translate-wrapper {
  display: flex;
  align-items: center;
}

/* Google Translate injects its own styles — these overrides tame the defaults */
.google-translate .goog-te-gadget {
  font-family: var(--body-font-family) !important;
  font-size: var(--body-font-size-s) !important;
}

.google-translate .goog-te-gadget-simple {
  border: 1px solid var(--color-border, #ccc) !important;
  border-radius: 4px;
  padding: 4px 8px;
}

/*
 * Google Translate pushes <body> down by ~40px when the translation bar appears.
 * This rule prevents that shift. It must be placed at the document root (body) —
 * it cannot be scoped to the block — because Google Translate modifies body.style.top.
 * Note: hiding .goog-te-banner-frame is generally safe, but verify with your legal team
 * that removing the "Translated by Google" attribution doesn't violate your usage terms.
 */
body {
  top: 0 !important;
}
```

### Authoring instructions

Tell authors to add this table to their Google Doc where they want the translate widget:

| Google Translate |
|------------------|
|                  |

The block renders the container; `delayed.js` loads the script.

## Code — `head.html`

```html
<link rel="preconnect" href="https://translate.google.com" crossorigin>
<link rel="preconnect" href="https://translate.googleapis.com" crossorigin>
```

## Verification

- **DOM:** `document.getElementById('google_translate_element')` should contain the Google Translate dropdown after ~3s
- **Network:** Request to `translate.google.com/translate_a/element.js` should fire after delayed.js loads
- **Functionality:** Selecting a language from the dropdown should translate visible page text
- **Visual:** The translate bar should not push the page content down (CSS override handles this)
- **Console:** `window.google.translate.TranslateElement` should be defined

## Caveats

1. **Google Translate rewrites the DOM.** It wraps text nodes in `<font>` tags and adds inline styles. This can break CSS that targets specific DOM structures. Test thoroughly with the site's actual content.
2. **No SEO benefit.** Search engines don't index client-side translations. For multilingual SEO, use Edge Delivery Services's folder-based language structure (`/en/`, `/es/`, etc.) with authored translations.
3. **Cookie banner interaction.** Google Translate sets cookies (`googtrans`, `NID`). If the site has a consent manager, declare these as functional cookies in the consent configuration.
4. **Deprecated API.** The Google Translate Widget (v2) was officially deprecated in 2019 but still functions. Google has not announced a shutdown date, but there's no guarantee of continued support. For new implementations, consider alternatives like custom translation workflows.
5. **Attribution requirement.** Google's Terms of Service for the free widget require displaying "Translated by Google" branding. Hiding `.goog-te-banner-frame` or `.skiptranslate` with CSS may violate these terms. Review with your legal team before suppressing branding in production.

## Real-World Reference

### Pattern: Delayed Load with Accessibility Widget

This pattern loads Google Translate in `delayed.js` alongside an accessibility widget (UserWay) and Google Tag Manager. The translate function is simple — two script injections, no block structure.

```javascript
// scripts/delayed.js
function googleTranslate() {
  const s1 = document.createElement('script');
  s1.setAttribute('src', 'https://translate.google.com/translate_a/element.js?cb=googleTranslateElementInit');
  (document.body || document.head).appendChild(s1);

  const s2 = document.createElement('script');
  s2.text = `
    function googleTranslateElementInit() {
      new google.translate.TranslateElement({pageLanguage: 'en'}, 'google_translate_element');
    }
  `;
  (document.body || document.head).appendChild(s2);
}

googleTranslate();
```

Source: aemsites/clarkcountynv — `scripts/delayed.js`

Key design points:
- **Two-script approach.** The callback function (`googleTranslateElementInit`) is defined via a separate inline script rather than as a `window` property. Both approaches work, but the `window.googleTranslateElementInit` pattern (as in our template) is cleaner for module-based code.
- **No container guard.** The function assumes `google_translate_element` exists in the DOM. In Edge Delivery Services, the container likely comes from a block or is injected into the header/footer during `loadLazy()`.
- **Accessibility context.** Google Translate is commonly added to institutional and government sites as part of language-access requirements.
- **Coexists with other delayed integrations.** The same file loads an accessibility widget, path-based GTM routing, and a podcast streaming script — all fire at delayed.js time with no ordering dependencies between them.
