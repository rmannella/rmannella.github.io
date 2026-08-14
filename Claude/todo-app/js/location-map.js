const DEFAULT_MAP_CENTER = [39.8283, -98.5795];
const DEFAULT_MAP_ZOOM = 4;
const PIN_ZOOM = 15;

let mapInstance = null;
let markerInstance = null;
let onPositionChange = null;

function mapAvailable() {
  return typeof L !== 'undefined';
}

function initLocationMap(containerId, onChange) {
  if (!mapAvailable()) return null;
  onPositionChange = onChange;

  if (mapInstance) {
    mapInstance.remove();
    mapInstance = null;
    markerInstance = null;
  }

  mapInstance = L.map(containerId).setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(mapInstance);

  mapInstance.on('click', e => {
    setMapMarker(e.latlng.lat, e.latlng.lng);
  });

  if ('geolocation' in navigator) {
    navigator.geolocation.getCurrentPosition(
      pos => {
        if (!markerInstance) {
          mapInstance.setView([pos.coords.latitude, pos.coords.longitude], PIN_ZOOM);
        }
      },
      () => {},
      { enableHighAccuracy: false, maximumAge: 300000, timeout: 5000 }
    );
  }

  return mapInstance;
}

function setMapMarker(lat, lng, pan = true) {
  if (!mapAvailable() || !mapInstance) return;
  if (markerInstance) {
    markerInstance.setLatLng([lat, lng]);
  } else {
    markerInstance = L.marker([lat, lng], { draggable: true }).addTo(mapInstance);
    markerInstance.on('dragend', () => {
      const pos = markerInstance.getLatLng();
      if (onPositionChange) onPositionChange(pos.lat, pos.lng);
    });
  }
  if (pan) mapInstance.setView([lat, lng], Math.max(mapInstance.getZoom(), PIN_ZOOM));
  if (onPositionChange) onPositionChange(lat, lng);
}

function invalidateLocationMap() {
  if (mapInstance) mapInstance.invalidateSize();
}

function clearLocationMap() {
  if (mapInstance) {
    mapInstance.remove();
    mapInstance = null;
    markerInstance = null;
  }
}

async function geocodeAddress(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('Geocoding request failed');
  const results = await res.json();
  return results.map(r => ({
    displayName: r.display_name,
    lat: parseFloat(r.lat),
    lng: parseFloat(r.lon),
  }));
}
