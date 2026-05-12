# Regression Diagnostics — Full Implementation

Implementation for **Phase 6, Step 6.3** of [`workflows/agentic-optimization-loop.md`](../workflows/agentic-optimization-loop.md). Invoked when a regression is detected (a baseline network call is missing from the migrated page). **Does not auto-patch** — returns findings per missing call so the human reviewer can act.

## Why diagnostic-only, not auto-fix

A missing network call almost always means the extracted instrumentation is broken — the container was meant to fire that call and the migration lost it. The safe response is to surface a precise diagnosis (what's there, what's missing, where to look) and escalate. Auto-rewriting code on regression risks compounding the problem: the next iteration might mutate a working file based on a partially-correct guess.

The loop treats regressions as an escalation boundary — see Success Criteria in the workflow doc.

## `fixRegressions`

```javascript
const fsp = require('fs/promises');
const path = require('path');

// Returns a list of human-readable findings per missing call. We don't
// auto-mutate on regression — regressions almost always signal an error in the
// extracted instrumentation, and the safer default is to surface the diagnosis
// and escalate. Auto-patching regressions risks making the problem worse.
async function fixRegressions(repoPath, regressionReport) {
  const findings = [];
  for (const missing of regressionReport.critical) {
    findings.push(await diagnoseMissingCall(repoPath, missing));
  }
  return findings;
}
```

## `diagnoseMissingCall`

Four category-specific diagnoses. Each reads the relevant source files and returns boolean checks + a recommendation string.

```javascript
async function diagnoseMissingCall(repoPath, missing) {
  const read = async (rel) => {
    try { return await fsp.readFile(path.join(repoPath, rel), 'utf8'); }
    catch { return null; }
  };
  const host = new URL(missing.url).hostname;
  const scripts = await read('scripts/scripts.js') ?? '';
  const delayed = await read('scripts/delayed.js') ?? '';

  switch (missing.category) {
    case 'analytics':
      // Analytics payload requires both a configured datastream AND a populated
      // data layer before sendEvent fires. Either missing → no beacon.
      return {
        url: missing.url,
        category: 'analytics',
        hasDatastreamConfig: /datastreamId|datastream_id/.test(scripts),
        hasSendEvent: /sendEvent|pageView/.test(scripts),
        recommendation: 'Verify datastream ID is set and sendEvent is called in loadLazy after the data layer is populated.',
      };
    case 'personalization':
      return {
        url: missing.url,
        category: 'personalization',
        alloyInEager: /loadEager[\s\S]*?alloy/.test(scripts),
        recommendation: 'Ensure alloy is configured and awaited inside loadEager before first section renders.',
      };
    case 'consent':
      return {
        url: missing.url,
        category: 'consent',
        consentScriptReferenced: /OneTrust|Optanon|cookielaw/i.test(scripts + delayed),
        recommendation: 'Confirm the consent script is loaded early (before loadDelayed) and its callback fires.',
      };
    default:
      // Generic third-party tags should still come from the container loaded
      // in delayed.js — check that the original container URL is intact.
      return {
        url: missing.url,
        category: missing.category,
        containerStillLoaded: delayed.includes(host) || /loadScript.*adobedtm|googletagmanager/.test(delayed),
        recommendation: 'Confirm the original container URL is loaded in delayed.js and the tag is still present in the container.',
      };
  }
}
```

## Finding shape

```yaml
# One entry per missing call. Attached to the iteration record as
# `record.diagnostics` in the loop orchestrator.
{
  url: 'https://edge.adobedc.net/ee/v1/collect',
  category: 'analytics',
  hasDatastreamConfig: true,
  hasSendEvent: false,            # ← the actionable bit
  recommendation: 'Verify datastream ID is set and sendEvent is called in loadLazy after the data layer is populated.',
}
```

## Extending to a new category

To add a category (e.g., `social`, `rum`):

1. Add the relevant pattern to `IDENTIFYING_PARAMS` / `categorizeCall` in [`references/extraction-scripts.md`](./extraction-scripts.md) so the comparison tags calls with the new category.
2. Add a `case` to `diagnoseMissingCall` that reads the files where that category's code lives and returns the most actionable boolean checks.
3. Keep recommendations **specific** — "verify X is configured and Y is called" is useful; "check the code" is not.
