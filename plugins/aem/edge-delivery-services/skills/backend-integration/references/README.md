# References Index

Each file here holds the full implementation for one topic. Workflow documents carry the narrative and short code skeletons; they point to files in this folder for the complete code, selectors, and contracts.

## Used by the agentic optimization loop only

- [`deep-psi-integration.md`](./deep-psi-integration.md) — Playwright driver + parser for the Deep-PSI two-URL comparison (`compareWithDeepPsi`, `parseDeepPsiOutput`, validated selectors)
- [`optimization-strategies.md`](./optimization-strategies.md) — Rotating per-iteration strategies (`defer_non_critical_tags`, `add_preconnects`), strategy contract, idempotency rules
- [`regression-diagnostics.md`](./regression-diagnostics.md) — Diagnostic findings for missing network calls (`fixRegressions`, `diagnoseMissingCall`) — no auto-patching
- [`source-code-analysis.md`](./source-code-analysis.md) — Three-stage Path A pipeline: deterministic regex → slice + format → LLM classifier for container bundles

## Shared across workflows (agentic loop and `martech-migration`)

- [`extraction-scripts.md`](./extraction-scripts.md) — Playwright network interception, categorization (`captureNetworkBaseline`, `categorizeCall`, `IDENTIFYING_PARAMS`)
- [`container-analysis-scripts.md`](./container-analysis-scripts.md) — GTM / Launch Reactor API clients (`authenticateGTM`, `authenticateLaunch`, `analyze*Container`, `classify*`)
- [`consent-gated-architecture.md`](./consent-gated-architecture.md) — OneTrust / Cookiebot integration patterns, consent-gated `loadEager` structure
- [`data-layer-mapping.md`](./data-layer-mapping.md) — XDM mapping helpers (`extractDataLayerSchema`, `validateDataLayerMapping`)
- [`aem-martech-plugin-template.md`](./aem-martech-plugin-template.md) — Full `scripts.js` / `delayed.js` / `head.html` templates for `aem-martech` and `aem-gtm-martech`
- [`testing.md`](./testing.md) — Unit / integration / performance / regression test patterns and WKND hybrid integration setup
