# Google Maps

**Category:** Maps / Location
**Edge Delivery Services approach:** Custom block `blocks/map/`
**Load timing:** Lazy (on scroll into view)

## When to Use

Google Maps displays interactive maps, location markers, and directions on web pages. Use this integration when migrating sites with store locators, contact pages with location maps, or any embedded map functionality. Maps are loaded lazily to avoid impacting Core Web Vitals.

## What to Extract During Audit

| Value | How to find it |
|-------|---------------|
| API Key | View source, search for `key=` parameter in `maps.googleapis.com` URL |
| Map Type | Check for `google.maps.Map`, embedded iframe, or Static Maps API |
| Map Options | Look for map initialization: center coordinates, zoom level, markers |
| Embed URL (iframe) | If using iframe embed, extract the full `src` URL from Google Maps share |

## Config Variables

| Variable | Where to get it |
|----------|----------------|
| `GOOGLE_MAPS_API_KEY` | Google Cloud Console > APIs & Services > Credentials > API Key (with Maps JavaScript API enabled) |
| `MAP_ID` (optional) | Google Cloud Console > Google Maps Platform > Map management > Create Map ID — required for `AdvancedMarkerElement` and custom styling |

> **API key security:** Always add an **HTTP referrer restriction** to your API key in Google Cloud Console (restrict to your production domain). An unrestricted key is vulnerable to quota theft.

## Code - Maps Block (JavaScript API)

### `blocks/map/map.js`

```javascript
import { loadScript } from '../../scripts/aem.js';

const GOOGLE_MAPS_API_KEY = ''; // Set your Google Maps API key

// Singleton promise prevents double-loading when multiple map blocks appear on the same page.
let mapsLoadPromise = null;

function loadGoogleMaps() {
  if (!GOOGLE_MAPS_API_KEY) {
    // eslint-disable-next-line no-console
    console.warn('Google Maps: GOOGLE_MAPS_API_KEY not configured — map skipped');
    return Promise.resolve(false);
  }
  if (!mapsLoadPromise) {
    // loading=async enables the newer Maps JS API bootstrap (required for AdvancedMarkerElement)
    mapsLoadPromise = loadScript(
      `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}&loading=async&libraries=marker`,
    ).then(() => true);
  }
  return mapsLoadPromise;
}

function parseCoordinates(location) {
  const coordMatch = location.match(/^(-?\d+\.?\d*),\s*(-?\d+\.?\d*)$/);
  if (coordMatch) {
    return {
      lat: parseFloat(coordMatch[1]),
      lng: parseFloat(coordMatch[2]),
    };
  }
  return null;
}

async function geocodeAddress(address) {
  const geocoder = new window.google.maps.Geocoder();
  return new Promise((resolve, reject) => {
    geocoder.geocode({ address }, (results, status) => {
      if (status === 'OK' && results[0]) {
        resolve({
          lat: results[0].geometry.location.lat(),
          lng: results[0].geometry.location.lng(),
        });
      } else {
        reject(new Error(`Geocoding failed: ${status}`));
      }
    });
  });
}

export default async function decorate(block) {
  if (!GOOGLE_MAPS_API_KEY) {
    // eslint-disable-next-line no-console
    console.warn('Google Maps: GOOGLE_MAPS_API_KEY is not configured - skipping.');
    block.innerHTML = '<p>Map unavailable - API key not configured</p>';
    return;
  }

  // Extract block content
  const rows = [...block.children];
  const location = rows[0]?.textContent?.trim() || '';
  const zoom = parseInt(rows[1]?.textContent?.trim(), 10) || 14;
  const height = rows[2]?.textContent?.trim() || '400px';

  if (!location) {
    block.innerHTML = '<p>Map unavailable - no location specified</p>';
    return;
  }

  // Create map container
  const mapContainer = document.createElement('div');
  mapContainer.className = 'map-container';
  mapContainer.style.height = height;
  mapContainer.style.width = '100%';

  block.innerHTML = '';
  block.appendChild(mapContainer);

  // Load Google Maps API (returns false if no API key)
  const loaded = await loadGoogleMaps();
  if (!loaded) return;

  // Get coordinates
  let coords = parseCoordinates(location);
  if (!coords) {
    try {
      coords = await geocodeAddress(location);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Failed to geocode address:', err);
      mapContainer.innerHTML = '<p>Unable to load map for this location</p>';
      return;
    }
  }

  // Require a mapId for AdvancedMarkerElement (set in Google Cloud Console → Map IDs)
  // If no mapId is available, omit the marker and use a plain Map.
  const MAP_ID = ''; // ← Optional: set your Google Maps Map ID for styled maps + advanced markers

  const mapOptions = { center: coords, zoom, mapTypeControl: true, streetViewControl: true, fullscreenControl: true };
  if (MAP_ID) mapOptions.mapId = MAP_ID;
  const map = new window.google.maps.Map(mapContainer, mapOptions);

  // AdvancedMarkerElement replaces the deprecated google.maps.Marker (deprecated since v3.52).
  // Falls back gracefully if the marker library is unavailable.
  if (MAP_ID && window.google.maps.marker?.AdvancedMarkerElement) {
    const { AdvancedMarkerElement } = window.google.maps.marker;
    const marker = new AdvancedMarkerElement({ map, position: coords, title: location });
    const infoWindow = new window.google.maps.InfoWindow({ content: `<p>${location}</p>` });
    marker.addListener('click', () => infoWindow.open(map, marker));
  } else {
    // Fallback: legacy Marker (still functional but deprecated — upgrade mapId when possible)
    // eslint-disable-next-line no-new
    const marker = new window.google.maps.Marker({ position: coords, map, title: location });
    const infoWindow = new window.google.maps.InfoWindow({ content: `<p>${location}</p>` });
    marker.addListener('click', () => infoWindow.open(map, marker));
  }
}
```

### `blocks/map/map.css`

```css
.map {
  width: 100%;
  margin: 2rem 0;
}

.map .map-container {
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 2px 8px rgb(0 0 0 / 10%);
}

.map p {
  padding: 2rem;
  text-align: center;
  background-color: var(--light-color, #f5f5f5);
  color: var(--text-color, #333);
}
```

## Code - Embed Block (iframe - No API Key)

For simple embeds without API key requirements:

### `blocks/map/map.js`

```javascript
export default function decorate(block) {
  const rows = [...block.children];
  const embedUrl = rows[0]?.textContent?.trim() || '';
  const height = rows[1]?.textContent?.trim() || '400px';

  if (!embedUrl) {
    block.innerHTML = '<p>Map unavailable - no embed URL specified</p>';
    return;
  }

  let iframeSrc = embedUrl;
  if (embedUrl.includes('google.com/maps') && !embedUrl.includes('/embed')) {
    const placeMatch = embedUrl.match(/place\/([^/]+)/);
    if (placeMatch) {
      const place = placeMatch[1];
      iframeSrc = `https://www.google.com/maps/embed/v1/place?key=&q=${encodeURIComponent(place)}`;
    }
  }

  const iframe = document.createElement('iframe');
  iframe.src = iframeSrc;
  iframe.style.border = '0';
  iframe.style.width = '100%';
  iframe.style.height = height;
  iframe.loading = 'lazy';
  iframe.allowFullscreen = true;
  iframe.referrerPolicy = 'no-referrer-when-downgrade';

  block.innerHTML = '';
  block.appendChild(iframe);
}
```

## Code - `head.html`

```html
<link rel="preconnect" href="https://maps.googleapis.com">
<link rel="preconnect" href="https://maps.gstatic.com" crossorigin>
```

## Authoring Instructions

Authors create a map block in their document with:

| Map |
|-----|
| 1600 Amphitheatre Parkway, Mountain View, CA |
| 15 |
| 450px |

- **Row 1:** Address or coordinates (required)
- **Row 2:** Zoom level 1-20 (optional, default: 14)
- **Row 3:** Map height (optional, default: 400px)

## Verification

- **Network tab:** Request to `maps.googleapis.com/maps/api/js` with your API key
- **Console:** `window.google.maps` should be defined after script loads
- **DOM:** `div.map-container` with Google Maps canvas inside
- **Visual:** Interactive map displays with marker at specified location
