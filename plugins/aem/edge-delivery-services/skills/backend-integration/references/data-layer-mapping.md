# Data Layer Mapping

When extracting personalization and analytics from a container into EDS code, all data that was previously populated inside the container must still be populated — in EDS code, before the `alloy.sendEvent` or GA4 beacon fires.

## What Needs to Be Mapped

| Container artifact | EDS equivalent |
|-------------------|----------------|
| Adobe Analytics eVars / props | XDM fields in `window.adobeDataLayer.push(...)` |
| XDM fields set in Launch data elements | Same XDM fields in `loadLazy` before `sendEvent` |
| GA4 custom dimensions / parameters | `window.dataLayer.push(...)` before GTM fires |
| `s.pageName`, `s.channel`, etc. | `xdm.web.webPageDetails.name`, `xdm.web.webPageDetails.siteSection` |

## Step 1: Extract Original Data Layer Schema

```javascript
async function extractDataLayerSchema(containerAnalysis) {
  const schema = {
    adobe: {
      xdm: [],      // XDM fields used
      eVars: [],    // Adobe Analytics eVars
      props: [],    // Adobe Analytics props
      events: []    // Adobe Analytics events
    },
    google: {
      dimensions: [],  // GA custom dimensions
      metrics: [],     // GA custom metrics
      parameters: []   // Event parameters
    }
  };

  // Parse data elements from container
  for (const dataElement of containerAnalysis.dataElements || []) {
    const mapping = inferDataElementMapping(dataElement);
    if (mapping.type === 'xdm') schema.adobe.xdm.push(mapping);
    else if (mapping.type === 'evar') schema.adobe.eVars.push(mapping);
    else if (mapping.type === 'prop') schema.adobe.props.push(mapping);
    else if (mapping.type === 'ga4_param') schema.google.parameters.push(mapping);
  }

  return schema;
}

function inferDataElementMapping(dataElement) {
  const name = (dataElement.attributes?.name || '').toLowerCase();
  const type = dataElement.attributes?.type_id || '';

  // XDM path data elements
  if (type === 'variable' && name.includes('xdm')) {
    return { type: 'xdm', field: name, source: dataElement.attributes?.settings?.path };
  }
  // eVar mappings
  const evarMatch = name.match(/evar(\d+)/i);
  if (evarMatch) {
    return { type: 'evar', field: `eVar${evarMatch[1]}`, index: evarMatch[1], source: name };
  }
  // Prop mappings
  const propMatch = name.match(/prop(\d+)/i);
  if (propMatch) {
    return { type: 'prop', field: `prop${propMatch[1]}`, index: propMatch[1], source: name };
  }
  return { type: 'unknown', field: name };
}
```

## Step 2: Generate EDS Data Layer Population

```javascript
function generateDataLayerCode(schema, boilerplate) {
  // Adobe stack (aem.js)
  const adobeLayer = `
window.adobeDataLayer = window.adobeDataLayer || [];
window.adobeDataLayer.push({
  event: 'pageView',
  web: {
    webPageDetails: {
      pageViews: { value: 1 },
      name: getPageName(),
      URL: window.location.href,
    }
  },
  _custom: {
${schema.adobe.eVars.map(e => `    ${e.field}: getMetadata('${e.source}') || '', // eVar${e.index}`).join('\n')}
  }
});`;

  // Google stack
  const googleLayer = `
window.dataLayer = window.dataLayer || [];
window.dataLayer.push({
  event: 'pageView',
${schema.google.parameters.map(p => `  ${p.field}: getMetadata('${p.source}') || '',`).join('\n')}
});`;

  return schema.adobe.xdm.length > 0 ? adobeLayer : googleLayer;
}
```

## Step 3: Validate Mapping Completeness

```javascript
function validateDataLayerMapping(originalSchema, migratedCode) {
  const missing = [];
  const covered = [];

  for (const field of [...originalSchema.adobe.xdm, ...originalSchema.adobe.eVars]) {
    if (migratedCode.includes(field.field)) {
      covered.push(field);
    } else {
      missing.push({
        field: field.field,
        source: field.source,
        impact: 'Analytics data may be incomplete',
        action: 'REQUIRES_MANUAL_REVIEW'
      });
    }
  }

  return { covered, missing, complete: missing.length === 0 };
}
```

## Ambiguous Mappings

Flag the following for human review (set `confidence: 'low'`):

- Data elements with generic names (`data_element_1`, `custom_var`, etc.)
- XDM fields that read from DOM elements (path depends on page structure)
- Fields set only on specific page templates (not global page view)
- Calculated fields (e.g., `s.pageName = section + ':' + pageTitle`)

> Always include `manual_review_items` in the output report listing every field with `confidence: 'low'` so the developer can verify them before sign-off.
