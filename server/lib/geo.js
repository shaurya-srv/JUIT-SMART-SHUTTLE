// GPS geometry for Phase 3 (pure functions, no DB, no I/O).
// All coordinates are { lat, lng } in decimal degrees.

// Great-circle distance in meters (haversine).
function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Project `p` onto segment a→b: distance from the line (meters) + the
// along-direction t (0 at a, 1 at b, outside clamps to the nearest end).
// Uses a local equirectangular frame — accurate at campus scale (km, not degrees).
function projectOntoSegment(p, a, b) {
  const kx = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  const toM = (d, k) => d * 111320 * k;
  const ax = toM(a.lng, kx), ay = toM(a.lat, 1);
  const bx = toM(b.lng, kx), by = toM(b.lat, 1);
  const px = toM(p.lng, kx), py = toM(p.lat, 1);
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const cx = ax + t * dx, cy = ay + t * dy;
  return { distanceM: Math.hypot(px - cx, py - cy), t };
}

// Has the bus already passed the student's stop along its a→b corridor?
// The stop ORDER is derived from coordinates via corridor projection —
// never assumed from location indexes, so fixing a coordinate in
// route_stops automatically fixes the behavior.
function stopPassed(bus, stop, a, b, maxOffRouteM = 2000) {
  const busT = projectOntoSegment(bus, a, b);
  const stopT = projectOntoSegment(stop, a, b);
  if (busT.distanceM > maxOffRouteM || stopT.distanceM > maxOffRouteM) {
    return { ok: false, error: 'position_far_from_route' };
  }
  // Same projected point (tiny corridor): allow the join — the bus is
  // effectively at the stop.
  if (Math.abs(busT.t - stopT.t) < 0.02) return { ok: true, passed: false };
  return { ok: true, passed: busT.t > stopT.t };
}

// §7.18: a fix older than this is STALE — shown as "last seen X min ago",
// never extrapolated, and join decisions never rely on it.
function isFixStale(fix, now = new Date(), staleAfterMs = 90 * 1000) {
  if (!fix || !fix.recorded_at) return true;
  const t = fix.recorded_at instanceof Date ? fix.recorded_at.getTime() : new Date(fix.recorded_at).getTime();
  if (isNaN(t)) return true;
  return now.getTime() - t > staleAfterMs;
}

// §7.23 server-side dedupe: reject fixes less than this many ms after the
// trip's last stored fix (the client also throttles at 15 s; the server
// window is a backstop against hammering/multiple tabs).
function withinDedupeWindow(lastFix, now = new Date(), minGapMs = 5000) {
  if (!lastFix || !lastFix.recorded_at) return false;
  const t = lastFix.recorded_at instanceof Date ? lastFix.recorded_at.getTime() : new Date(lastFix.recorded_at).getTime();
  if (isNaN(t)) return false;
  return now.getTime() - t < minGapMs;
}

// Coordinates sanity: reject obvious garbage before it enters history.
function plausibleFix(fix) {
  return Number.isFinite(fix.lat) && Number.isFinite(fix.lng)
    && Math.abs(fix.lat) <= 90 && Math.abs(fix.lng) <= 180
    && !(fix.lat === 0 && fix.lng === 0);
}

module.exports = {
  haversineMeters, projectOntoSegment, stopPassed,
  isFixStale, withinDedupeWindow, plausibleFix,
};
