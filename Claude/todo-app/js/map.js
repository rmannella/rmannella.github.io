// Location picker map + address lookup.
//
// Locations are addresses as far as the user is concerned. Coordinates still
// exist because the geofence needs them, but they are derived from an address
// (or from a dropped pin, reverse-geocoded back into one) and never shown.

const LocationMap = (() => {
  const DEFAULT_CENTER = [39.8283, -98.5795]; // continental US, zoomed out
  const DEFAULT_ZOOM = 4;
  const PIN_ZOOM = 16;
  const GEOFENCE_RADIUS_M = 150;

  const NOMINATIM = 'https://nominatim.openstreetmap.org';
  const MIN_REQUEST_GAP_MS = 1100; // Nominatim's usage policy: <= 1 req/sec

  let map = null;
  let marker = null;
  let radiusCircle = null;
  let onPick = null;
  let lastRequestAt = 0;

  const available = () => typeof L !== 'undefined';

  // Read the live design tokens so the map's marker and geofence ring stay in
  // step with the palette instead of hardcoding a second copy of it.
  function token(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  function pinIcon() {
    const accent = token('--accent', '#8a9a7b');
    const surface = token('--surface', '#ffffff');
    return L.divIcon({
      className: 'map-pin',
      html:
        `<svg width="30" height="40" viewBox="0 0 30 40" xmlns="http://www.w3.org/2000/svg">` +
        `<path d="M15 39C15 39 28 24.5 28 14.5A13 13 0 1 0 2 14.5C2 24.5 15 39 15 39Z" ` +
        `fill="${accent}" stroke="${surface}" stroke-width="2.5"/>` +
        `<circle cx="15" cy="14.5" r="4.6" fill="${surface}"/></svg>`,
      iconSize: [30, 40],
      iconAnchor: [15, 39],
    });
  }

  function init(containerId, onPickFn) {
    if (!available()) return null;
    onPick = onPickFn;
    if (map) destroy();

    map = L.map(containerId, { zoomControl: true, attributionControl: true })
      .setView(DEFAULT_CENTER, DEFAULT_ZOOM);

    // CARTO Positron: a light, low-saturation basemap. The app's warm tint is
    // applied on top in CSS (.location-map .leaflet-tile-pane) so the map
    // reads as part of the page rather than a pasted-in widget.
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd',
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(map);

    map.on('click', e => setPin(e.latlng.lat, e.latlng.lng, { reverse: true }));

    // Centre on the user if they've already granted location, so the picker
    // opens somewhere useful instead of the middle of Kansas.
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        pos => {
          if (!marker && map) map.setView([pos.coords.latitude, pos.coords.longitude], 13);
        },
        () => {},
        { enableHighAccuracy: false, maximumAge: 300000, timeout: 5000 }
      );
    }
    return map;
  }

  // Places the pin plus its geofence ring. `reverse: true` also looks the
  // address up so a tapped point still produces a human-readable location.
  function setPin(lat, lng, { pan = true, reverse = false } = {}) {
    if (!available() || !map) return;

    if (marker) {
      marker.setLatLng([lat, lng]);
    } else {
      marker = L.marker([lat, lng], { draggable: true, icon: pinIcon() }).addTo(map);
      marker.on('dragend', () => {
        const p = marker.getLatLng();
        setPin(p.lat, p.lng, { pan: false, reverse: true });
      });
    }

    const accent = token('--accent', '#8a9a7b');
    if (radiusCircle) {
      radiusCircle.setLatLng([lat, lng]);
    } else {
      radiusCircle = L.circle([lat, lng], {
        radius: GEOFENCE_RADIUS_M,
        color: accent,
        weight: 1.5,
        opacity: 0.65,
        fillColor: accent,
        fillOpacity: 0.12,
      }).addTo(map);
    }

    if (pan) map.setView([lat, lng], Math.max(map.getZoom(), PIN_ZOOM));
    if (onPick) onPick({ lat, lng, reverse });
  }

  function clearPin() {
    if (marker) {
      map.removeLayer(marker);
      marker = null;
    }
    if (radiusCircle) {
      map.removeLayer(radiusCircle);
      radiusCircle = null;
    }
  }

  function invalidate() {
    if (map) map.invalidateSize();
  }

  function destroy() {
    if (map) map.remove();
    map = null;
    marker = null;
    radiusCircle = null;
  }

  /* ---------- geocoding ---------- */

  async function throttled(url) {
    const wait = Math.max(0, MIN_REQUEST_GAP_MS - (Date.now() - lastRequestAt));
    if (wait) await new Promise(r => setTimeout(r, wait));
    lastRequestAt = Date.now();
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Address lookup failed (${res.status})`);
    return res.json();
  }

  async function search(query) {
    const rows = await throttled(
      `${NOMINATIM}/search?format=jsonv2&addressdetails=1&limit=5&q=${encodeURIComponent(query)}`
    );
    return rows.map(r => ({
      address: r.display_name,
      shortLabel: shortLabelFor(r),
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon),
    }));
  }

  async function reverse(lat, lng) {
    const r = await throttled(
      `${NOMINATIM}/reverse?format=jsonv2&addressdetails=1&lat=${lat}&lon=${lng}`
    );
    if (!r || !r.display_name) return null;
    return { address: r.display_name, shortLabel: shortLabelFor(r), lat, lng };
  }

  // A suggested name for the location, e.g. a business name, else the street.
  function shortLabelFor(r) {
    const a = r.address || {};
    return (
      r.name ||
      a.amenity ||
      a.shop ||
      a.building ||
      [a.house_number, a.road].filter(Boolean).join(' ') ||
      a.suburb ||
      a.city ||
      ''
    );
  }

  return { init, setPin, clearPin, invalidate, destroy, search, reverse, GEOFENCE_RADIUS_M };
})();
