# Container Analysis Scripts

Scripts to analyze Launch and GTM containers to identify rules/tags that should be disabled after migration.

## Why This Matters

After migrating personalization and analytics to EDS eager/lazy phases, the original rules **still exist** in the container and will fire redundantly (or conflict). This analysis identifies what to clean up inside Launch/GTM.

---

## Launch Container Analysis

Launch containers at `assets.adobedtm.com/.../launch-*.min.js` contain parseable rule definitions.

### Extract Launch Container Structure

```javascript
(async () => {
  // Find Launch container URL
  const launchScript = [...document.querySelectorAll('script[src*="adobedtm.com"]')]
    .map(s => s.src)[0];
  
  if (!launchScript) return { error: 'No Launch container found' };

  // Fetch and analyze container
  const response = await fetch(launchScript);
  const containerCode = await response.text();

  const analysis = {
    containerUrl: launchScript,
    extensions: [],
    rules: [],
    dataElements: [],
    recommendations: []
  };

  // Extract extensions (look for extension registration patterns)
  const extensionPatterns = [
    { name: 'Adobe Target', pattern: /adobe-target|at\.js|mbox/i },
    { name: 'Adobe Analytics', pattern: /adobe-analytics|AppMeasurement|s\.t\(\)|s\.tl\(\)/i },
    { name: 'Web SDK / Alloy', pattern: /alloy|edge\.adobedc|sendEvent/i },
    { name: 'ECID', pattern: /ecid|visitor\.js|Visitor\./i },
    { name: 'Adobe Client Data Layer', pattern: /adobeDataLayer|ACDL/i },
    { name: 'Google Analytics', pattern: /google-analytics|gtag|UA-|G-/i },
    { name: 'Meta Pixel', pattern: /facebook|fbq|fbevents/i },
    { name: 'LinkedIn', pattern: /linkedin|_linkedin/i },
    { name: 'Twitter', pattern: /twitter|twq/i },
    { name: 'Hotjar', pattern: /hotjar|hj\(/i }
  ];

  extensionPatterns.forEach(({ name, pattern }) => {
    if (pattern.test(containerCode)) {
      analysis.extensions.push(name);
    }
  });

  // Extract rule patterns (Launch minified format)
  // Rules typically appear as objects with 'name', 'events', 'conditions', 'actions'
  const ruleMatches = containerCode.match(/"name":"[^"]+"/g) || [];
  const ruleNames = ruleMatches.map(m => m.replace(/"name":"([^"]+)"/, '$1'));
  
  // Categorize rules by likely purpose
  ruleNames.forEach(name => {
    const lowerName = name.toLowerCase();
    let category = 'unknown';
    let recommendation = null;

    // Personalization patterns
    if (/target|personali|offer|experience|decisioning|proposition|mbox|ajo/i.test(lowerName)) {
      category = 'personalization';
      recommendation = 'DISABLE — now handled by alloy in eager phase';
    }
    // Analytics page view patterns
    else if (/page\s*view|page\s*load|pageview|track\s*page|analytics.*load/i.test(lowerName)) {
      category = 'analytics-pageview';
      recommendation = 'DISABLE — now handled by alloy in lazy phase';
    }
    // Analytics event patterns (keep these)
    else if (/click|event|track|cta|button|form|download|video/i.test(lowerName)) {
      category = 'analytics-events';
      recommendation = 'KEEP — event tracking still fires from container';
    }
    // Social pixels
    else if (/facebook|meta|linkedin|twitter|social|pixel/i.test(lowerName)) {
      category = 'social';
      recommendation = 'KEEP — loads in delayed phase';
    }
    // Consent
    else if (/consent|cookie|privacy|gdpr|ccpa|onetrust/i.test(lowerName)) {
      category = 'consent';
      recommendation = 'REVIEW — may need adjustment for EDS timing';
    }

    analysis.rules.push({ name, category, recommendation });
  });

  // Generate summary recommendations
  const toDisable = analysis.rules.filter(r => r.recommendation?.startsWith('DISABLE'));
  const toReview = analysis.rules.filter(r => r.recommendation?.startsWith('REVIEW'));

  if (toDisable.length > 0) {
    analysis.recommendations.push({
      action: 'DISABLE_RULES',
      count: toDisable.length,
      rules: toDisable.map(r => r.name),
      reason: 'These rules are now handled by direct alloy calls in EDS. Keeping them causes duplicate tracking or conflicts.'
    });
  }

  if (analysis.extensions.includes('Adobe Target') && analysis.extensions.includes('Web SDK / Alloy')) {
    analysis.recommendations.push({
      action: 'REMOVE_TARGET_EXTENSION',
      reason: 'Both Target VEC extension and Web SDK detected. After migration, Target is handled via Web SDK — the Target extension can be removed.'
    });
  }

  if (analysis.extensions.includes('Adobe Analytics') && analysis.extensions.includes('Web SDK / Alloy')) {
    analysis.recommendations.push({
      action: 'REVIEW_ANALYTICS_EXTENSION',
      reason: 'Both Analytics extension and Web SDK detected. Page views now go through Web SDK. Analytics extension may only be needed for specific event rules.'
    });
  }

  return JSON.stringify(analysis, null, 2);
})()
```

### Launch Rule Timing Analysis

Identify rules that fire at page load (candidates for extraction):

```javascript
(async () => {
  const launchScript = [...document.querySelectorAll('script[src*="adobedtm.com"]')]
    .map(s => s.src)[0];
  
  if (!launchScript) return { error: 'No Launch container found' };

  const response = await fetch(launchScript);
  const code = await response.text();

  const timingAnalysis = {
    eagerCandidates: [],    // Fire before DOM ready — personalization
    lazyCandidates: [],     // Fire at page load — analytics
    eventBased: [],         // Fire on user interaction — keep in container
    unknown: []
  };

  // Look for event type patterns in minified code
  // Launch events are typically: 'Library Loaded', 'Page Bottom', 'DOM Ready', 'Window Loaded', 'Click', etc.
  
  const eventPatterns = [
    { type: 'eager', pattern: /libraryLoaded|library-loaded|DOMContentLoaded|domready/gi },
    { type: 'lazy', pattern: /pagebottom|page-bottom|windowloaded|window-loaded|pageview/gi },
    { type: 'event', pattern: /click|change|submit|hover|blur|focus|keypress|scroll|custom/gi }
  ];

  // This is heuristic — minified code structure varies
  // Extract what we can from identifiable patterns
  const ruleBlocks = code.split(/\{"name":/);
  
  ruleBlocks.forEach((block, i) => {
    if (i === 0) return; // First split is before any rules
    
    const nameMatch = block.match(/^"([^"]+)"/);
    if (!nameMatch) return;
    
    const ruleName = nameMatch[1];
    const blockLower = block.toLowerCase();

    let classified = false;
    
    if (/target|personali|mbox|proposition/i.test(ruleName) || 
        /libraryloaded|domready/.test(blockLower)) {
      timingAnalysis.eagerCandidates.push(ruleName);
      classified = true;
    }
    
    if (/pageview|page\s*load|analytics/i.test(ruleName) ||
        /pagebottom|windowloaded/.test(blockLower)) {
      timingAnalysis.lazyCandidates.push(ruleName);
      classified = true;
    }
    
    if (/click|submit|event|track/i.test(ruleName) ||
        /click|change|submit/.test(blockLower)) {
      timingAnalysis.eventBased.push(ruleName);
      classified = true;
    }

    if (!classified) {
      timingAnalysis.unknown.push(ruleName);
    }
  });

  timingAnalysis.summary = {
    eagerToDisable: timingAnalysis.eagerCandidates.length,
    lazyToDisable: timingAnalysis.lazyCandidates.length,
    eventToKeep: timingAnalysis.eventBased.length,
    needsReview: timingAnalysis.unknown.length
  };

  return JSON.stringify(timingAnalysis, null, 2);
})()
```

---

## GTM Container Analysis

GTM containers at `googletagmanager.com/gtm.js?id=GTM-XXX` contain tag definitions.

### Extract GTM Container Structure

```javascript
(async () => {
  // GTM embeds container data in the page after loading
  if (!window.google_tag_manager) {
    return { error: 'GTM not loaded or not accessible' };
  }

  const analysis = {
    containerId: null,
    tags: [],
    triggers: [],
    variables: [],
    recommendations: []
  };

  // Find container ID
  const gtmScript = [...document.querySelectorAll('script[src*="googletagmanager.com"]')]
    .map(s => s.src)[0];
  const containerIdMatch = gtmScript?.match(/GTM-[A-Z0-9]+/);
  analysis.containerId = containerIdMatch ? containerIdMatch[0] : 'unknown';

  // GTM exposes dataLayer which shows what's firing
  if (window.dataLayer) {
    const events = window.dataLayer.filter(item => item.event);
    analysis.dataLayerEvents = [...new Set(events.map(e => e.event))];
  }

  // Analyze network calls to identify what GTM is firing
  const resources = performance.getEntriesByType('resource');
  const gtmRelatedCalls = resources.filter(r => 
    r.name.includes('google') || 
    r.name.includes('facebook') || 
    r.name.includes('analytics') ||
    r.name.includes('doubleclick') ||
    r.name.includes('linkedin') ||
    r.name.includes('twitter')
  );

  const tagPatterns = [
    { name: 'Google Analytics 4', pattern: /google-analytics.*collect|analytics\.google/i, category: 'analytics' },
    { name: 'Google Analytics UA', pattern: /google-analytics\.com.*collect\?v=1/i, category: 'analytics-legacy' },
    { name: 'Google Ads', pattern: /googleads|doubleclick|googlesyndication/i, category: 'advertising' },
    { name: 'Meta Pixel', pattern: /facebook\.com.*tr|connect\.facebook/i, category: 'social' },
    { name: 'LinkedIn Insight', pattern: /linkedin.*insight|snap\.licdn/i, category: 'social' },
    { name: 'Twitter Pixel', pattern: /static\.ads-twitter|analytics\.twitter/i, category: 'social' },
    { name: 'Hotjar', pattern: /hotjar|static\.hotjar/i, category: 'rum' },
    { name: 'Adobe Target', pattern: /tt\.omtrdc|mbox/i, category: 'personalization' },
    { name: 'Adobe Analytics', pattern: /2o7\.net|omtrdc\.net.*b\/ss/i, category: 'analytics' }
  ];

  gtmRelatedCalls.forEach(call => {
    tagPatterns.forEach(({ name, pattern, category }) => {
      if (pattern.test(call.name)) {
        const existing = analysis.tags.find(t => t.name === name);
        if (!existing) {
          let recommendation = 'KEEP — fires in delayed phase';
          
          if (category === 'personalization') {
            recommendation = 'DISABLE — migrate to alloy in eager phase';
          } else if (category === 'analytics' && call.name.includes('page')) {
            recommendation = 'REVIEW — page view may conflict with EDS analytics';
          }

          analysis.tags.push({
            name,
            category,
            url: call.name.substring(0, 100),
            timing: Math.round(call.startTime) + 'ms',
            recommendation
          });
        }
      }
    });
  });

  // Generate recommendations
  const personalizationTags = analysis.tags.filter(t => t.category === 'personalization');
  if (personalizationTags.length > 0) {
    analysis.recommendations.push({
      action: 'MIGRATE_PERSONALIZATION',
      tags: personalizationTags.map(t => t.name),
      reason: 'Personalization via GTM fires too late. Migrate to alloy in EDS eager phase, then disable these tags.'
    });
  }

  const analyticsTags = analysis.tags.filter(t => t.category === 'analytics');
  if (analyticsTags.length > 0) {
    analysis.recommendations.push({
      action: 'REVIEW_ANALYTICS',
      tags: analyticsTags.map(t => t.name),
      reason: 'If using EDS analytics via alloy, check for duplicate page view tracking. May need to disable GTM page view trigger.'
    });
  }

  return JSON.stringify(analysis, null, 2);
})()
```

### GTM Trigger Analysis

```javascript
(() => {
  // Analyze dataLayer pushes to understand trigger patterns
  if (!window.dataLayer) return { error: 'dataLayer not found' };

  const triggerAnalysis = {
    pageViewTriggers: [],
    eventTriggers: [],
    customTriggers: []
  };

  // Common GTM trigger events
  const triggerPatterns = {
    pageView: ['gtm.js', 'gtm.dom', 'gtm.load', 'pageview', 'page_view'],
    userEvent: ['gtm.click', 'gtm.linkClick', 'gtm.formSubmit', 'gtm.scrollDepth'],
  };

  window.dataLayer.forEach(item => {
    if (!item.event) return;
    
    if (triggerPatterns.pageView.includes(item.event)) {
      triggerAnalysis.pageViewTriggers.push({
        event: item.event,
        recommendation: 'REVIEW — may fire analytics that conflicts with EDS lazy phase'
      });
    } else if (triggerPatterns.userEvent.includes(item.event)) {
      triggerAnalysis.eventTriggers.push({
        event: item.event,
        recommendation: 'KEEP — user interaction tracking stays in GTM'
      });
    } else {
      triggerAnalysis.customTriggers.push({
        event: item.event,
        recommendation: 'REVIEW — custom trigger, check what tags it fires'
      });
    }
  });

  triggerAnalysis.summary = {
    pageViewToReview: triggerAnalysis.pageViewTriggers.length,
    eventToKeep: triggerAnalysis.eventTriggers.length,
    customToReview: triggerAnalysis.customTriggers.length
  };

  return JSON.stringify(triggerAnalysis, null, 2);
})()
```

---

## Generating Cleanup Report

After running analysis, generate a human-readable cleanup checklist:

```javascript
((launchAnalysis, gtmAnalysis) => {
  // launchAnalysis and gtmAnalysis are the outputs from above scripts
  
  const report = {
    title: 'Container Cleanup Checklist',
    generated: new Date().toISOString(),
    sections: []
  };

  // Launch cleanup section
  if (launchAnalysis && !launchAnalysis.error) {
    const launchSection = {
      container: 'Adobe Launch',
      url: launchAnalysis.containerUrl,
      actions: []
    };

    // Rules to disable
    const toDisable = launchAnalysis.rules?.filter(r => r.recommendation?.startsWith('DISABLE')) || [];
    if (toDisable.length > 0) {
      launchSection.actions.push({
        priority: 'HIGH',
        action: 'Disable these rules in Launch UI',
        items: toDisable.map(r => r.name),
        path: 'Launch → Rules → [Rule Name] → Toggle off',
        reason: 'Now handled by alloy.js in EDS — leaving enabled causes duplicate tracking'
      });
    }

    // Extensions to review
    launchAnalysis.recommendations?.forEach(rec => {
      if (rec.action === 'REMOVE_TARGET_EXTENSION') {
        launchSection.actions.push({
          priority: 'MEDIUM',
          action: 'Consider removing Adobe Target extension',
          path: 'Launch → Extensions → Adobe Target → Uninstall',
          reason: rec.reason
        });
      }
    });

    report.sections.push(launchSection);
  }

  // GTM cleanup section
  if (gtmAnalysis && !gtmAnalysis.error) {
    const gtmSection = {
      container: 'Google Tag Manager',
      containerId: gtmAnalysis.containerId,
      actions: []
    };

    // Tags to review
    const toMigrate = gtmAnalysis.tags?.filter(t => t.category === 'personalization') || [];
    if (toMigrate.length > 0) {
      gtmSection.actions.push({
        priority: 'HIGH',
        action: 'Disable personalization tags',
        items: toMigrate.map(t => t.name),
        path: 'GTM → Tags → [Tag Name] → Pause',
        reason: 'Personalization must run in EDS eager phase, not via GTM'
      });
    }

    // Page view triggers
    const pageViewTriggers = gtmAnalysis.recommendations?.find(r => r.action === 'REVIEW_ANALYTICS');
    if (pageViewTriggers) {
      gtmSection.actions.push({
        priority: 'MEDIUM',
        action: 'Review page view triggers',
        items: pageViewTriggers.tags,
        path: 'GTM → Triggers → All Pages / Page View → Check firing',
        reason: 'May duplicate EDS analytics if both fire page views'
      });
    }

    report.sections.push(gtmSection);
  }

  // Add verification steps
  report.verification = [
    'After disabling rules/tags, publish a new container version',
    'Clear CDN cache if using cached container URLs',
    'Test on staging: verify no duplicate analytics calls in Network tab',
    'Check Analytics/GA reports: page view count should not double',
    'Verify Target activities still render (now via alloy, not container)'
  ];

  return JSON.stringify(report, null, 2);
})
```

---

## Usage in Workflow

Add this step after migration is applied:

```
┌─────────────────────────────────────────────────────────────────┐
│ STEP 6: CONTAINER CLEANUP ANALYSIS                              │
│                                                                 │
│ Agent runs container analysis scripts                           │
│                                                                 │
│ Output to user:                                                 │
│ "I've analyzed your Launch container. Here's what to clean up:  │
│                                                                 │
│  HIGH PRIORITY — Disable these rules:                           │
│  • 'Adobe Target - Page Load' → now handled by alloy            │
│  • 'Analytics - Page View' → now handled by alloy               │
│                                                                 │
│  MEDIUM PRIORITY — Review:                                      │
│  • Consider removing Target extension entirely                  │
│                                                                 │
│  Path: Launch UI → Rules → [name] → Toggle off                  │
│                                                                 │
│  After cleanup, publish new container version."                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Limitations

| What We Can Detect | What We Cannot Detect |
|--------------------|----------------------|
| Rule names and rough categorization | Exact rule logic and conditions |
| Extensions present | Extension configuration details |
| Network calls made by tags | Which tag made which call |
| Data layer events | Data element values |

The analysis is **heuristic** — it identifies likely candidates for cleanup based on naming patterns and timing. Human review in the Launch/GTM UI is still required to confirm before disabling anything.
