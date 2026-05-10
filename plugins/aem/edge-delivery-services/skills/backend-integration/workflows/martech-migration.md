# Martech Migration Workflow

This workflow migrates Adobe Launch + Target + Analytics (the "full Adobe stack") to Edge Delivery Services using the eager/lazy/delayed loading pattern.

## When to Use

Invoke this workflow when:

- Source site has `assets.adobedtm.com` (Launch) AND Target/Analytics signals
- User asks to "migrate martech", "migrate analytics", or "set up Adobe stack"
- Audit detects `_satellite`, `alloy`, `s.t()`, `mbox`, or `tt.omtrdc.net`

## Why This Workflow Exists

Traditional martech loads everything in one container. EDS splits loading for performance:

| Phase | What | Why |
|-------|------|-----|
| **Eager** | Personalization (Target/AJO propositions) | Must fire before first paint to avoid flicker |
| **Lazy** | Analytics page view beacon | After LCP to not block rendering |
| **Delayed** | Everything else (container with remaining tags) | 3s timeout or `requestIdleCallback` |

This follows [Adobe's top/bottom page event pattern](https://experienceleague.adobe.com/en/docs/experience-platform/collection/use-cases/personalization/top-bottom-page-events).

---

## Workflow Steps

### Step 1: Detect Stack

**Action:** Run extraction scripts via Playwright to identify what's present.

```
[CHECKPOINT 1.1: EXTRACTION COMPLETE]
```

**Signals to detect:**

| Signal | Indicates |
|--------|-----------|
| `assets.adobedtm.com` script | Adobe Launch present |
| `window._satellite` | Launch container loaded |
| `window.alloy` | WebSDK already in use |
| `tt.omtrdc.net` network calls | Target active |
| `edge.adobedc.net` network calls | AEP Edge active |
| `s.t()` / `s.tl()` in inline scripts | Legacy AppMeasurement |
| `mbox` cookie | Target cookies set |
| `kndctr_*_AdobeOrg_*` cookies | ECID/AEP identity |
| `window.adobe.target` | at.js present |
| `dataLayer` or `adobeDataLayer` | Data layer in use |

**Output:** Stack classification:

```yaml
stack_type: "full_adobe" | "launch_only" | "target_only" | "legacy_appmeasurement" | "gtm_only" | "hybrid"
container_urls:
  - https://assets.adobedtm.com/.../launch-....min.js
personalization_detected: true | false
analytics_detected: true | false
data_layer_type: "adobeDataLayer" | "dataLayer" | "custom" | "none"
consent_tool: "onetrust" | "cookiebot" | "custom" | "none"
```

### Step 2: Extract Configuration Values

**Action:** Gather IDs and config from source site and customer input.

```
[CHECKPOINT 1.2: CONFIG EXTRACTED]
```

**Required values:**

| Value | Source | Format |
|-------|--------|--------|
| Datastream ID | AEP Console or customer | UUID |
| IMS Org ID | Adobe Admin Console | `XXXXX@AdobeOrg` |
| Launch container URL | Page source | `https://assets.adobedtm.com/...` |
| Target property token | Target UI (if applicable) | String |
| Analytics RSID | Analytics Admin (if applicable) | String |

**If customer cannot provide IDs:**
- Flag as `[REQUIRES_CUSTOMER_INPUT]`
- Generate placeholder config with clear setup comments
- List where to find each value in Adobe consoles

### Step 3: Analyze Data Layer

**Action:** Capture and analyze the existing data layer structure.

```
[CHECKPOINT 1.3: DATA LAYER ANALYZED]
```

**Extract:**
1. Data layer variable name (`adobeDataLayer`, `dataLayer`, custom)
2. Schema structure (XDM fields, custom properties)
3. Page view event shape
4. Any custom events being pushed

**Map to EDS equivalent:**
- Identify which fields map to standard XDM
- Flag custom fields that need preservation
- Note any server-side data population patterns

### Step 4: Select Approach

**Decision tree:**

```
Full Adobe stack detected (Launch + Target + Analytics)?
├── YES → Use aem-martech plugin (Approach 1)
│         - Handles eager/lazy/delayed automatically
│         - Best performance characteristics
│         - Recommended for enterprise deployments
│
└── NO → Check what's present
         ├── Target only → Standalone alloy integration
         │                 (see Step 3 — alloy init in scripts.js)
         │
         ├── Launch only (no Target) → Load container in delayed.js
         │                              (see Step 3 — delayed.js container pattern)
         │
         └── Legacy AppMeasurement → Migrate to Launch + alloy
                                     (full stack migration)
```

```
[CHECKPOINT 2: APPROACH SELECTED]
```

**Output:**

```yaml
selected_approach: "aem-martech-plugin" | "standalone-alloy" | "delayed-container" | "full-migration"
reasoning: "Full Adobe stack detected with Target personalization active"
manual_review_items:
  - "Custom data layer field 'user.segment' needs manual XDM mapping"
  - "Cookie consent (OneTrust) requires integration — see consent-gated-architecture.md"
```

### Step 5: Generate Migration Plan

**Action:** Create detailed plan for human review before applying changes.

```
[CHECKPOINT 3: PLAN GENERATED]
```

**Plan structure:**

```markdown
## Migration Plan: {site_name}

### Stack Summary
- **Source:** Launch + Target + Analytics
- **Approach:** aem-martech plugin
- **Confidence:** High

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `scripts/scripts.js` | Modify | Add plugin initialization in loadEager |
| `scripts/delayed.js` | Modify | Load Launch container for remaining tags |
| `head.html` | Modify | Add preconnect to edge.adobedc.net |
| `scripts/alloy.js` | Create | Commit alloy.js from CDN |

### Configuration Required

| Variable | Value | Where to Set |
|----------|-------|--------------|
| `datastreamId` | `{PLACEHOLDER}` | Plugin config |
| `orgId` | `{PLACEHOLDER}` | Plugin config |

### Data Layer Mapping

| Original Field | EDS Field | Notes |
|----------------|-----------|-------|
| `digitalData.page.pageName` | `xdm.web.webPageDetails.name` | Direct map |
| `user.segment` | `xdm._custom.userSegment` | Custom XDM extension |

### Eager Phase (Personalization)
- alloy.js loads and configures
- sendEvent fetches Target propositions
- Propositions applied as blocks decorate

### Lazy Phase (Analytics)
- Page view beacon fires after LCP
- Data layer state captured

### Delayed Phase (Container)
- Original Launch container loads at 3s
- All non-extracted tags fire normally
- Social pixels, RUM, remaining rules

### Risk Assessment
- **Performance:** Expected +0.2s LCP (no matches) to +0.6s (with modifications)
- **Flicker:** Eliminated by eager loading
- **Regressions:** None expected — all tags preserved in container

### Requires Human Review
1. Verify datastream ID is correct for production
2. Confirm Target activities are using the correct workspace
3. Test consent flow with OneTrust integration
```

**Wait for user confirmation before proceeding.**

### Step 6: Apply Migration

**Action:** Generate and write code to EDS project files.

```
[CHECKPOINT 4: CODE APPLIED]
```

**For aem-martech plugin approach:**

1. **Add plugin to project** (if not present)
   - Reference: https://github.com/adobe-rnd/aem-martech

2. **Modify `scripts/scripts.js`:**
   - Import plugin
   - Configure in `loadEager`
   - Set up data layer bridge

3. **Modify `scripts/delayed.js`:**
   - Add Launch container loader
   - Gate behind consent if required

4. **Modify `head.html`:**
   - Add preconnect hints

5. **Add `scripts/alloy.js`:**
   - Download from https://github.com/adobe/alloy/releases

### Step 7: Validate Migration

**Action:** Capture current network state, run the validation script, then measure performance.

```
[CHECKPOINT 5: VALIDATION COMPLETE]
```

#### 7.1 — Capture Current Network State

Use the same Playwright extraction scripts from `references/extraction-scripts.md` on the **migrated preview URL** to produce `current-network.json`:

```bash
# Navigate Playwright browser to the migrated preview URL, then run:
playwright-cli eval --tab=ID 'JSON.stringify(window.__NETWORK_BASELINE__)'
# Save output as current-network.json
```

#### 7.2 — Run Validation Script

```bash
node scripts/validate-migration.js \
  --baseline baseline-network.json \
  --current current-network.json \
  --output validation-result.json
```

The script checks five things automatically and exits `0` (PASS) or `1` (FAIL):

| Check | Pass Criteria |
|-------|---------------|
| **AEP Edge Calls** | `edge.adobedc.net/interact` present |
| **Launch Container Timing** | `adobedtm.com` loads at 2500–6000ms |
| **Network Call Regression** | No baseline calls missing in migrated site |
| **Personalization Timing** | `/interact` fires before LCP |
| **Duplicate Analytics** | No endpoint called more than once |

If the script exits `1`, read `validation-result.json` for the failing check and recommendation, fix the issue, re-deploy, and re-run from Step 7.1.

> **Need automated iteration?** If validation fails and you want the agent to diagnose and retry autonomously, use **Workflow 2** (`workflows/agentic-optimization-loop.md`).

#### 7.3 — Performance Validation (Deep-PSI)

Open deep-PSI via Playwright, enter both the original URL and the migrated preview URL in the two URL fields, and compare:

```
https://tools.aem.live/tools/deep-psi/deep-psi.html
```

| Metric | Baseline | Migrated | Pass Criteria |
|--------|----------|----------|---------------|
| LCP | X.Xs | X.Xs | ≤ baseline + 0.2s |
| CLS | X.XX | X.XX | ≤ baseline |
| TBT | Xms | Xms | ≤ baseline + 50ms |

#### 7.4 — Manual Spot Checks

| Check | Method |
|-------|--------|
| No visual flicker | Load page in browser, observe first paint |
| Cookies set | DevTools → Application → Cookies: `kndctr_*`, `mbox` |
| No console errors | DevTools → Console: no alloy/satellite errors |

### Step 8: Container Cleanup Analysis

**Action:** Analyze the original container to identify rules/tags to disable.

```
[CHECKPOINT 6: CONTAINER ANALYZED]
```

The migrated EDS code now handles personalization and analytics directly via alloy. But the **original rules still exist** in the Launch/GTM container and will fire redundantly unless disabled.

**Run container analysis scripts** (from `references/container-analysis-scripts.md`):

1. **Fetch and parse** the container JS
2. **Identify rules by pattern:**
   - Personalization rules → DISABLE (now in eager phase)
   - Page view analytics rules → DISABLE (now in lazy phase)
   - Event tracking rules → KEEP
   - Social pixels → KEEP
   - Unknown → FLAG for review
3. **Generate cleanup checklist**

**Output to user:**

```markdown
## Container Cleanup Required

After migration, disable these redundant rules in your Launch UI:

### HIGH PRIORITY — Disable Immediately
| Rule Name | Why |
|-----------|-----|
| Adobe Target - Page Load | Now handled by alloy in eager phase |
| Analytics - Page View Beacon | Now handled by alloy in lazy phase |
| Send Propositions on DOM Ready | Duplicate of alloy sendEvent |

### MEDIUM PRIORITY — Review
| Item | Recommendation |
|------|----------------|
| Adobe Target extension | Consider removing — alloy handles Target now |
| Analytics extension | May only be needed for event rules, not page views |

### Keep As-Is
| Rule Name | Why |
|-----------|-----|
| Track CTA Clicks | Event tracking still fires from delayed container |
| Facebook Pixel - Page View | Social pixel, loads in delayed phase |
| Form Submit Tracking | Event-based, stays in container |

### Steps to Clean Up
1. Open Launch UI → Rules
2. For each HIGH PRIORITY rule: toggle off (don't delete yet)
3. Publish new container version to staging
4. Test: verify no duplicate calls in Network tab
5. If clean, publish to production

**Note:** Don't delete rules immediately — disable first, verify, then delete after confirming migration works.
```

---

### Step 9: Generate Summary

**Output to user:**

```markdown
## Migration Complete

### Files Changed
- `scripts/scripts.js` — Added aem-martech plugin initialization
- `scripts/delayed.js` — Added Launch container loader
- `head.html` — Added preconnect hint
- `scripts/alloy.js` — Added WebSDK library

### Configuration to Complete
1. Set `datastreamId` to your production datastream ID
2. Set `orgId` to your IMS Org ID (format: XXXXX@AdobeOrg)

### Container Cleanup Required
See cleanup checklist above — disable redundant rules in Launch/GTM to prevent duplicate tracking.

### Verification Steps
1. Open browser DevTools → Network tab
2. Load page and verify:
   - `edge.adobedc.net/ee/v1/interact` fires during page load (not at 3s)
   - `edge.adobedc.net/ee/v1/collect` fires for analytics
   - Launch container loads at ~3s mark
   - No duplicate analytics calls after container cleanup
3. Run deep-PSI and compare to baseline

### Manual Review Required
- [ ] Verify Target activities render correctly
- [ ] Confirm analytics data appears in reports (not doubled)
- [ ] Test consent banner interaction (if applicable)
- [ ] Disable redundant rules in Launch/GTM UI
- [ ] Publish updated container
```

---

> **Need automated iteration?** If validation fails or you want benchmark-driven optimization without manual steps, use **Workflow 2** (`workflows/agentic-optimization-loop.md`) instead. It runs the migration, measures performance, and iterates autonomously until metrics meet target.

---

## External Resources

| Resource | URL |
|----------|-----|
| aem-martech plugin | https://github.com/adobe-rnd/aem-martech |
| aem-gtm-martech plugin | https://github.com/adobe-rnd/aem-gtm-martech |
| EDS Martech Guide | https://www.aem.live/developer/martech-integration |
| EDS Target Guide | https://www.aem.live/developer/target-integration |
| Top/Bottom Events | https://experienceleague.adobe.com/en/docs/experience-platform/collection/use-cases/personalization/top-bottom-page-events |
| WKND Martech Hybrid | https://github.com/hlxsites/wknd/blob/adobe-martech-hybrid/scripts/scripts.js |
| Deep PSI Tool | https://tools.aem.live/tools/deep-psi/deep-psi.html |
