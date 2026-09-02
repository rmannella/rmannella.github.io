// Watches the device position and fires onArrive when it first enters a
// saved location's radius. Foreground-only: browsers give a web app no
// reliable background geolocation, so this stops when the tab does.

const GEOFENCE_RADIUS_M = 150;

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

class Geofencer {
  constructor({ getLocations, onArrive }) {
    this.getLocations = getLocations;
    this.onArrive = onArrive;
    this.watchId = null;
    this.inside = new Set();
  }

  start() {
    if (!('geolocation' in navigator) || this.watchId !== null) return;
    this.watchId = navigator.geolocation.watchPosition(
      pos => this.check(pos.coords.latitude, pos.coords.longitude),
      () => {},
      { enableHighAccuracy: false, maximumAge: 60000, timeout: 30000 }
    );
  }

  stop() {
    if (this.watchId === null) return;
    navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }

  check(lat, lng) {
    for (const loc of this.getLocations()) {
      // Locations created from speech ("when I get to the dentist") have no
      // address yet, so there is nothing to measure against.
      if (loc.lat == null || loc.lng == null) continue;
      const isInside = haversineMeters(lat, lng, loc.lat, loc.lng) <= GEOFENCE_RADIUS_M;
      const wasInside = this.inside.has(loc.id);
      if (isInside && !wasInside) {
        this.inside.add(loc.id);
        this.onArrive(loc);
      } else if (!isInside && wasInside) {
        this.inside.delete(loc.id);
      }
    }
  }
}
