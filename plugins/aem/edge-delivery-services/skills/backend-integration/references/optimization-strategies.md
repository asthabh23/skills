# Optimization Strategies — Full Implementation

Implementation for **Phase 6, Step 6.2** of [`workflows/agentic-optimization-loop.md`](../workflows/agentic-optimization-loop.md). Invoked from `applyOptimizationStrategy()` when the loop decision is `PARTIAL` (no regressions, but Deep-PSI didn't report improvement).

## Contract

Each strategy is an object with:

| Field | Type | Purpose |
|---|---|---|
| `name` | string | Stable id — used in iteration records and the review package |
| `description` | string | One-line human-readable summary |
| `condition` | `(ctx) => boolean` (optional) | Pre-flight check — strategy is skipped if false |
| `apply` | `async (repoPath, ctx) => { changed, file?, added? }` | Mutates project files, reports what happened |

**Idempotency rule:** every `apply` must be a no-op on its second call. Condition checks inside the function guarantee this — never rely on the loop skipping a strategy because it's been run before. This keeps the loop safe under restart or manual re-run.

Strategies rotate per iteration via `selectOptimizationForIteration(iteration)` in the workflow's Orchestration Helpers section.

## `OPTIMIZATION_STRATEGIES`

```javascript
const fs = require('fs');
const path = require('path');

const OPTIMIZATION_STRATEGIES = [
  {
    name: 'defer_non_critical_tags',
    description: 'Switch delayed.js from setTimeout(3000) to requestIdleCallback',
    apply: async (repoPath) => {
      const file = path.join(repoPath, 'scripts/delayed.js');
      const src = fs.readFileSync(file, 'utf8');
      if (src.includes('requestIdleCallback')) return { changed: false };
      const next = src.replace(
        /setTimeout\(\s*([A-Za-z_$][\w$]*)\s*,\s*3000\s*\)/,
        `('requestIdleCallback' in window ? requestIdleCallback($1, { timeout: 5000 }) : setTimeout($1, 3000))`,
      );
      if (next === src) return { changed: false };
      fs.writeFileSync(file, next);
      return { changed: true, file: 'scripts/delayed.js' };
    },
  },
  {
    name: 'add_preconnects',
    description: 'Add preconnect hints to head.html for the top third-party domains by call volume',
    // Skipped if no network calls were captured in the current iteration.
    condition: (ctx) => ctx.networkCalls?.length > 0,
    apply: async (repoPath, { networkCalls }) => {
      // Rank domains by call count — preconnecting the busiest ones gives the
      // biggest DNS/TLS savings for the delayed phase.
      const counts = networkCalls.reduce((acc, c) => {
        const host = new URL(c.url).hostname;
        acc.set(host, (acc.get(host) ?? 0) + 1);
        return acc;
      }, new Map());
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

      const file = path.join(repoPath, 'head.html');
      const src = fs.readFileSync(file, 'utf8');
      const tags = top
        .filter(([host]) => !src.includes(`href="https://${host}"`))
        .map(([host]) => `<link rel="preconnect" href="https://${host}" crossorigin>`);
      if (tags.length === 0) return { changed: false };
      fs.writeFileSync(file, `${src}\n${tags.join('\n')}\n`);
      return { changed: true, file: 'head.html', added: tags.length };
    },
  },
];
```

## Deferred strategies

These are intentionally not shipped yet because they need stable anchors we don't emit consistently:

| Name | Why deferred |
|---|---|
| `lazy_load_alloy` | Requires a known marker in `scripts.js` to move alloy init from eager to lazy. Until the `aem-martech` template emits a stable comment or export, regex-based rewriting is brittle. |
| `reduce_data_layer_payload` | Requires schema knowledge per customer (which XDM fields the analytics beacon actually needs). Scoping needs a project-specific mapping file. |

Both are tracked in **Open Questions & Risks** in the workflow doc.

## Adding a new strategy

1. Implement with the contract above — idempotent, single-file mutation preferred.
2. Add to `OPTIMIZATION_STRATEGIES` in the order you want it rotated.
3. If it depends on data from the current iteration (network calls, regression report, container analysis), declare that dependency via `condition` so it's skipped cleanly when the data isn't available.
4. No tests scaffolded yet — verify by running the loop on a staging project and inspecting `iteration.optimizations` on the returned record.
