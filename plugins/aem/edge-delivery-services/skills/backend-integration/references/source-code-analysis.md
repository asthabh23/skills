# Source Code Analysis (Path A) — Full Implementation

Full implementation for the three-stage pipeline in **Phase 1, Path A** of [`workflows/agentic-optimization-loop.md`](../workflows/agentic-optimization-loop.md). The workflow file carries the short skeleton; this file carries the vendor signatures, slicing logic, formatting wrapper, and LLM classifier prompt.

Stage order (recap):

1. Deterministic regex scan against `VENDOR_SIGNATURES`
2. Format only the *near-miss slices* (not the full bundle)
3. LLM classifier over formatted slices, capped at `MAX_LLM_SLICES`

---

## Source Site EDS Preflight (Phase 0)

Runs before any other analysis. If the source site is already on EDS, the loop has nothing to migrate — abort with guidance rather than producing a less-sophisticated copy of what's already deployed.

```javascript
// EDS sites import their boilerplate from one of two filenames (aem.js is
// the current standard; lib-franklin.js predates the rename and is still in
// use on older projects). Path conventions vary — most use /scripts/ but
// some sites (e.g., marutisuzuki.com) use /commons/scripts/. The HTML scan
// catches non-standard paths since every EDS page imports one of those two
// filenames somewhere in a <script> tag.
async function detectExistingEdsSite(siteUrl) {
  const candidatePaths = [
    '/scripts/aem.js',
    '/scripts/lib-franklin.js',
    '/commons/scripts/aem.js',
    '/commons/scripts/lib-franklin.js',
  ];
  for (const path of candidatePaths) {
    const res = await fetch(new URL(path, siteUrl).href, { method: 'HEAD' });
    if (res.ok) return { isEds: true, evidence: `boilerplate at ${path}` };
  }

  // Fallback: scan the rendered HTML for an aem.js / lib-franklin.js import
  // at any path. Skips the candidate-path probes' assumption about location.
  const html = await fetch(siteUrl).then((r) => r.text());
  const m = html.match(/<script[^>]+src="([^"]+(?:aem|lib-franklin)\.js)"/i);
  if (m) return { isEds: true, evidence: `imports ${m[1]}` };

  return { isEds: false };
}
```

The Phase 0 caller throws `SOURCE_ALREADY_EDS` when `isEds: true`. Migration of an already-migrated site silently produces wrong-but-plausible output; abort is safer than continuing.

---

## Vendor Signatures

Deliberately conservative — false positives here mislead Phase 2 strategy selection. Each entry carries the regex, the martech category, and the phase where the vendor typically belongs post-migration.

```javascript
const VENDOR_SIGNATURES = [
  // Personalization / A-B testing
  { vendor: 'adobe-target',       category: 'personalization', phase: 'eager',   re: /\b(at\.js|mbox|tt\.omtrdc\.net|adobe\.target)\b/i },
  { vendor: 'adobe-websdk-alloy', category: 'personalization', phase: 'eager',   re: /\balloy\b|\bdecisioning\b|edge\.adobedc\.net/i },
  { vendor: 'adobe-ajo',          category: 'personalization', phase: 'eager',   re: /journey-?optimizer|\bajo\b/i },
  { vendor: 'optimizely',         category: 'personalization', phase: 'eager',   re: /cdn\.optimizely\.com|window\.optimizely|optimizelyDataLayer/i },
  { vendor: 'vwo',                category: 'personalization', phase: 'eager',   re: /_vwo_code|dev\.visualwebsiteoptimizer|\.vwo\.com/i },
  { vendor: 'dynamic-yield',      category: 'personalization', phase: 'eager',   re: /cdn\.dynamicyield\.com|DY\.recommendationContext|window\.DY\b/i },
  { vendor: 'kameleoon',          category: 'personalization', phase: 'eager',   re: /kameleoon\.com|Kameleoon\.API/i },
  { vendor: 'monetate',           category: 'personalization', phase: 'eager',   re: /monetate\.net|monetate_lt/i },

  // Analytics — pageview (extract to lazy)
  { vendor: 'adobe-analytics', category: 'analytics_pageview', phase: 'lazy', re: /\bs\.t\s*\(\)|AppMeasurement|\bomniture\b/i },
  { vendor: 'ga4',             category: 'analytics_pageview', phase: 'lazy', re: /gtag\(\s*['"]event['"]\s*,\s*['"]page_view['"]|google-analytics\.com\/g\/collect|G-[A-Z0-9]{6,}/ },
  { vendor: 'ga-universal',    category: 'analytics_pageview', phase: 'lazy', re: /\bga\(\s*['"]send['"]\s*,\s*['"]pageview['"]/i },

  // Analytics — events (stay in delayed container)
  { vendor: 'mixpanel',      category: 'analytics_events', phase: 'delayed', re: /cdn\.mxpnl\.com|mixpanel\.(init|track)/i },
  { vendor: 'amplitude',     category: 'analytics_events', phase: 'delayed', re: /cdn\.amplitude\.com|amplitude\.getInstance/i },
  { vendor: 'segment',       category: 'analytics_events', phase: 'delayed', re: /cdn\.segment\.com|analytics\.load\(|window\.analytics\.track/i },
  { vendor: 'heap',          category: 'analytics_events', phase: 'delayed', re: /cdn\.heapanalytics\.com|heap\.track/i },
  { vendor: 'hotjar',        category: 'analytics_events', phase: 'delayed', re: /static\.hotjar\.com|\bhjid\b\s*[:=]/i },
  { vendor: 'contentsquare', category: 'analytics_events', phase: 'delayed', re: /cdn\.contentsquare\.net|\b_uxa\s*=/i },

  // Consent — early, not extracted
  { vendor: 'onetrust',  category: 'consent', phase: 'head', re: /OneTrust|Optanon|cookielaw\.org/i },
  { vendor: 'cookiebot', category: 'consent', phase: 'head', re: /consent\.cookiebot\.com|Cookiebot/ },
  { vendor: 'trustarc',  category: 'consent', phase: 'head', re: /trustarc\.com|truste\.com/i },
];
```

---

## Orchestrator

```javascript
// Hard ceilings bound cost and latency regardless of bundle size.
const SLICE_RADIUS = 4000;   // characters on each side of an anchor hit
const MAX_LLM_SLICES = 10;   // cap on formatted slices sent to the LLM

async function analyzeFromSource(scriptsJsContent, containerUrl) {
  const containerType = detectContainerType(scriptsJsContent);
  const source = await fetch(containerUrl).then((r) => r.text());

  // Stage 1: SDK-string regex (cheap, catches vendors with embedded SDK code)
  const sdkMatches = scanSignatures(source);

  // Stage 1.5: Launch-extension scan (cheap, catches vendors loaded *by* a
  // Launch container that don't embed their SDK in the bundle). Without this,
  // a Launch container that loads alloy/GA4/Floodlight at runtime would
  // appear vendor-free to Stage 1, since those SDKs aren't in the bundle.
  const extMatches = containerType === 'launch' || containerType === 'both'
    ? scanLaunchExtensions(source)
    : [];

  // Merge and dedupe — a vendor matched by both passes (rare) is high-confidence
  // and we keep one entry.
  const matches = mergeVendorFindings(sdkMatches, extMatches);

  const residual = await triageResidual(source, matches);
  const all = [...matches, ...residual];

  return {
    containerType,
    vendors: all,
    hasPersonalization: all.some((m) => m.category === 'personalization'),
    hasAnalytics: all.some((m) => m.category.startsWith('analytics')),
    // 'mixed' signals the caller to surface low/medium-confidence items for review.
    confidence: all.every((m) => m.confidence === 'high') ? 'high' : 'mixed',
  };
}

function detectContainerType(scriptsJs) {
  const launch = /assets\.adobedtm\.com/i.test(scriptsJs);
  const gtm = /googletagmanager\.com/i.test(scriptsJs);
  if (launch && gtm) return 'both';
  if (launch) return 'launch';
  if (gtm) return 'gtm';
  return 'unknown';
}
```

---

## Stage 1 — Regex Scan

```javascript
function scanSignatures(source) {
  const out = [];
  for (const sig of VENDOR_SIGNATURES) {
    if (sig.re.test(source)) {
      out.push({
        vendor: sig.vendor,
        category: sig.category,
        phase: sig.phase,
        confidence: 'high',
        source: 'regex',
      });
    }
  }
  return out;
}
```

---

## Stage 1.5 — Launch Extension Scan

Adobe Launch containers don't embed vendor SDKs — they load them at runtime via *extensions*. The bundle lists extensions by `modulePath` strings like `"facebook-pixel/src/lib/actions/firePixel.js"`. Stage 1's SDK-string regex misses these because there's no `fbq(` or `alloy` in the minified config; only the extension name.

This stage scans `modulePath` roots against a curated extension-to-vendor map. Cheap (one regex pass over the source), high-confidence (extensions are explicit dependencies declared by the customer in Launch).

```javascript
// Map of Launch extension package names → vendor metadata. Each entry mirrors
// the shape Stage 1 produces so the merge step is symmetric. Keep this list
// curated to known Adobe-marketplace + common gcoe-* extensions; add new
// rows as they're encountered. Unknown extensions are surfaced as confidence:
// 'low' so they reach human review rather than being silently classified.
const LAUNCH_EXTENSIONS = {
  // Adobe Marketplace
  'core':                          null, // Launch core — not a vendor
  'adobe-analytics':               { vendor: 'adobe-analytics',     category: 'analytics_pageview', phase: 'lazy'    },
  'adobe-target':                  { vendor: 'adobe-target',        category: 'personalization',    phase: 'eager'   },
  'adobe-mcid':                    { vendor: 'adobe-ecid',          category: 'identity',           phase: 'head'    },
  'adobe-audience-manager':        { vendor: 'adobe-aam',           category: 'advertising',        phase: 'delayed' },
  'web-sdk':                       { vendor: 'adobe-websdk-alloy',  category: 'personalization',    phase: 'eager'   },

  // Common third-party Launch extensions
  'facebook-pixel':                { vendor: 'meta-pixel',          category: 'advertising',        phase: 'delayed' },
  'doubleclick-floodlight':        { vendor: 'google-floodlight',   category: 'advertising',        phase: 'delayed' },
  'acronym-gtag.js':               { vendor: 'ga4',                 category: 'analytics_pageview', phase: 'lazy'    },
  'google-analytics':              { vendor: 'ga-universal',        category: 'analytics_pageview', phase: 'lazy'    },
  'contentsquare':                 { vendor: 'contentsquare',       category: 'analytics_events',   phase: 'delayed' },
  'hotjar':                        { vendor: 'hotjar',              category: 'analytics_events',   phase: 'delayed' },
  'linkedin-insight-tag':          { vendor: 'linkedin-insight',    category: 'advertising',        phase: 'delayed' },
  'tiktok-pixel':                  { vendor: 'tiktok-pixel',        category: 'advertising',        phase: 'delayed' },

  // Adobe gcoe-* (Adobe Group Centre of Excellence) extensions — internal-flavored
  // names that cover the data-layer + custom integrations Adobe customers ship.
  'gcoe-adobe-client-data-layer':  { vendor: 'adobe-data-layer',    category: 'data-layer',         phase: 'head'    },
};

function scanLaunchExtensions(source) {
  // Launch bundles emit modulePath strings as part of their module registry.
  // Extract every distinct root segment — that's the extension package name.
  const paths = [...source.matchAll(/modulePath:"([^"]+)"/g)].map((m) => m[1]);
  const roots = [...new Set(paths.map((p) => p.split('/')[0]))];

  const out = [];
  for (const root of roots) {
    if (!(root in LAUNCH_EXTENSIONS)) {
      // Unknown extension — surface for human review instead of silently dropping.
      out.push({
        vendor: root,
        category: 'unknown',
        phase: 'unknown',
        confidence: 'low',
        source: 'launch-ext',
      });
      continue;
    }
    const entry = LAUNCH_EXTENSIONS[root];
    if (!entry) continue; // entries mapped to null (e.g., 'core') aren't vendors
    out.push({ ...entry, source: 'launch-ext', confidence: 'high' });
  }
  return out;
}

// Stage 1 (SDK regex) and Stage 1.5 (extension scan) can both find the same
// vendor (e.g., adobe-target appears as both an at.js SDK string and an
// adobe-target extension). De-dupe on vendor name, keeping the higher-confidence
// finding. Source is preserved as a comma-joined string so downstream review
// shows what evidence backs the finding.
function mergeVendorFindings(...lists) {
  const rank = { high: 3, medium: 2, low: 1 };
  const byVendor = new Map();
  for (const list of lists) {
    for (const f of list) {
      const existing = byVendor.get(f.vendor);
      if (!existing) {
        byVendor.set(f.vendor, { ...f });
      } else if (rank[f.confidence] > rank[existing.confidence]) {
        byVendor.set(f.vendor, { ...f, source: `${existing.source},${f.source}` });
      } else {
        existing.source = `${existing.source},${f.source}`;
      }
    }
  }
  return [...byVendor.values()];
}
```

> **When this matters:** any Adobe Launch container without embedded SDK code — i.e., most of them. A Launch container that loads alloy + GA4 + Facebook Pixel + Contentsquare at runtime would have appeared vendor-free to Stage 1 alone (real example: the marutisuzuki.com migration audit). Stage 1.5 closes that gap with no LLM cost.

---

## Stage 2 + 3 — Slice, Format, Classify

Slicing happens on the **raw minified source by character offset** — cheap, no parse. Each slice is then formatted independently; a parse failure on one slice falls back to the raw slice (obfuscated code won't kill the pipeline). The LLM is called at most `MAX_LLM_SLICES` times per container.

```javascript
// Near-miss anchors: tokens that frequently sit near martech code but aren't
// specific enough to ship as hard signatures. Extend this list as new vendors
// are encountered rather than adding regex heuristics that risk false hits.
const ANCHOR_RE = /track|pageView|pageview|experiment|campaign|segment|variant|consent|cookie|identity|session|beacon|collect/gi;

async function triageResidual(source, regexMatches) {
  const anchors = [...source.matchAll(ANCHOR_RE)].map((m) => m.index);
  if (anchors.length === 0) return [];

  const ranges = mergeRanges(
    anchors.map((i) => [Math.max(0, i - SLICE_RADIUS), Math.min(source.length, i + SLICE_RADIUS)]),
  ).slice(0, MAX_LLM_SLICES);

  const formatted = await Promise.all(ranges.map(([s, e]) => formatSlice(source.slice(s, e))));

  // Skip slices that don't add new signal on top of the regex pass. The LLM
  // only sees code that could realistically contain an unidentified vendor.
  const regexVendors = new Set(regexMatches.map((m) => m.vendor));
  const findings = [];
  for (const slice of formatted) {
    const result = await classifyWithLLM(slice, regexVendors);
    findings.push(...result);
  }
  return dedupeFindings(findings);
}

function mergeRanges(ranges) {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out = [[...sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    if (sorted[i][0] <= last[1]) last[1] = Math.max(last[1], sorted[i][1]);
    else out.push([...sorted[i]]);
  }
  return out;
}

// Formats one slice. Installs prettier on demand (same pattern as Playwright
// in Phase 0) so it isn't a permanent dependency. Fails soft: if prettier
// can't parse the slice (obfuscated code, partial statements), return the raw
// slice — the LLM can still reason over it.
async function formatSlice(slice) {
  const { execSync } = require('child_process');
  try { require.resolve('prettier'); }
  catch { execSync('npm install --no-save prettier', { stdio: 'inherit' }); }
  const prettier = require('prettier');
  try {
    return await prettier.format(slice, { parser: 'babel', printWidth: 120 });
  } catch {
    return slice;
  }
}

// The LLM may report the same vendor across multiple overlapping slices. Keep
// the highest-confidence finding per (vendor, category) pair.
function dedupeFindings(findings) {
  const rank = { high: 3, medium: 2, low: 1 };
  const byKey = new Map();
  for (const f of findings) {
    const key = `${f.vendor}:${f.category}`;
    const existing = byKey.get(key);
    if (!existing || rank[f.confidence] > rank[existing.confidence]) byKey.set(key, f);
  }
  return [...byKey.values()];
}
```

---

## LLM Classifier Contract

`classifyWithLLM(slice, knownVendors)` is invoked per formatted slice. It can be implemented as:

- The host agent reasoning over the slice inline, or
- A direct Claude API call with the prompt below.

### Input

| Argument | Type | Purpose |
|----------|------|---------|
| `slice` | string | One formatted JS slice (≤ ~8 KB after formatting) |
| `knownVendors` | `Set<string>` | Vendors already identified by Stage 1 — exclude from output to avoid duplicate findings |

### Prompt Template

```
You are analyzing a slice of JavaScript extracted from a tag-manager container
bundle (e.g., Adobe Launch, Google Tag Manager). Identify any marketing-tech
(martech) vendor present in the slice and classify it.

Output rules:
- Return a JSON array. Empty array [] if no martech is present.
- One object per distinct vendor. Do NOT repeat a vendor across slices.
- Exclude any vendor in the "already identified" list.
- Confidence is self-assessed and honest: 'high' only for clear, vendor-specific
  API calls, DOM markers, or URLs; 'medium' for plausible but ambiguous patterns;
  'low' when guessing.

Already identified by deterministic scan (do not repeat):
<knownVendors as comma-separated list>

Slice:
<slice>

Output JSON schema:
[
  {
    "vendor": string,        // e.g., "optimizely", "custom-ab-test", "unknown-pixel"
    "category": string,      // personalization | analytics_pageview | analytics_events | consent | social | other
    "phase": string,         // eager | lazy | delayed | head
    "confidence": string,    // high | medium | low
    "reasoning": string      // 1-2 sentences, cite the specific token that led to this classification
  }
]
```

### Output

Array of findings matching the schema above. The orchestrator tags each with `source: 'llm'` and merges with regex findings.

---

## Error Modes

| Failure | Behavior |
|---------|----------|
| `fetch(containerUrl)` fails | Propagate — Path A cannot run without the bundle |
| `prettier` install fails | Slice passes through unformatted; LLM still receives raw slice |
| Prettier parse error on a slice | Caught; raw slice is classified instead |
| LLM returns malformed JSON | Orchestrator logs, skips that slice, continues with remaining slices |
| `MAX_LLM_SLICES` exceeded | Earlier slices win (anchors are scanned in source order); record warning in output |

---

## Classification Lookup (For Path 0 Pre-Detection Reports)

When the workflow's `container_analysis` is supplied with vendor names but missing `category` or `phase` for some entries, this helper enriches them by name without re-running detection.

```javascript
// Index VENDOR_SIGNATURES by vendor name once for O(1) classification lookup.
const VENDORS_BY_NAME = new Map(VENDOR_SIGNATURES.map((s) => [s.vendor, s]));

// Enriches a partial vendor entry from a supplied detection report. If the
// caller already provided category/phase those win; otherwise we look them
// up in the signatures table. Returns null when the vendor name isn't known
// and the entry is incomplete — surfacing the gap rather than guessing.
function classifyKnownVendor(entry) {
  const known = VENDORS_BY_NAME.get(entry.vendor);
  return {
    vendor: entry.vendor,
    category: entry.category ?? known?.category ?? null,
    phase: entry.phase ?? known?.phase ?? null,
    confidence: entry.confidence ?? (known ? 'high' : 'low'),
    source: entry.source ?? 'lookup',
  };
}
```

The Phase 1 orchestrator's Path 0 branch (`loadSuppliedAnalysis`) calls this for any entry missing `category` or `phase`. Entries that come back with `category: null` are flagged for human review and excluded from extraction-boundary decisions in Phase 2.
