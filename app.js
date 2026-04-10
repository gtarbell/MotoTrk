const REFRESH_MS = 3000;
const GOOGLE_MAPS_API_KEY = "AIzaSyDeMv0ZpNSlyoxFGCmMyr99eKHYhIkdgQY";
const EVENTS_API_PATH = "/api/events";
const BEACON_PASS_API_PATH = "/api/beacon-pass";
const TEST_SEQUENCE_API_PATH = "/api/test/generate";

const state = {
  course: {
    points: [],
    distances: [],
    totalDistance: 0,
    bounds: null,
  },
  beacons: [],
  riders: [],
  riderMap: new Map(),
  intervalId: null,
  map: {
    instance: null,
    coursePolyline: null,
    beaconMarkers: [],
    riderMarkers: new Map(),
    needsViewportFit: false,
    apiLoaded: false,
    apiLoadingPromise: null,
  },
  service: {
    eventSource: null,
    reconnectTimer: null,
    connected: false,
  },
};

const dom = {
  gpxFile: document.getElementById("gpxFile"),
  beaconFile: document.getElementById("beaconFile"),
  ridersInput: document.getElementById("ridersInput"),
  loadDataBtn: document.getElementById("loadDataBtn"),
  loadSampleBtn: document.getElementById("loadSampleBtn"),
  riderSelect: document.getElementById("riderSelect"),
  beaconSelect: document.getElementById("beaconSelect"),
  placeInput: document.getElementById("placeInput"),
  recordPassBtn: document.getElementById("recordPassBtn"),
  runTestBtn: document.getElementById("runTestBtn"),
  status: document.getElementById("status"),
  mapCanvas: document.getElementById("mapCanvas"),
  ridersTableBody: document.getElementById("ridersTableBody"),
};

init();

function init() {
  wireActions();
  resetUiForEmptyState();
  startBeaconPassStream();
}

function wireActions() {
  dom.loadDataBtn.addEventListener("click", loadRaceData);
  dom.loadSampleBtn.addEventListener("click", loadSampleData);
  dom.recordPassBtn.addEventListener("click", async () => {
    const riderId = dom.riderSelect.value;
    const beaconId = dom.beaconSelect.value;
    const place = dom.placeInput.value ? Number(dom.placeInput.value) : null;
    if (!riderId || !beaconId) {
      setStatus("Select a rider and beacon before recording a pass.", true);
      return;
    }
    try {
      await postBeaconPass({ riderId, beaconId, place, timestamp: Date.now() });
      setStatus(`Beacon pass sent to service: rider ${riderId}, beacon ${beaconId}.`);
    } catch (error) {
      setStatus(error.message, true);
    }
  });
  dom.runTestBtn.addEventListener("click", async () => {
    try {
      const run = await startTestSequence();
      setStatus(`Test sequence started (${run.totalEvents} events).`);
    } catch (error) {
      setStatus(error.message, true);
    }
  });
}

function resetUiForEmptyState() {
  dom.riderSelect.innerHTML = "";
  dom.beaconSelect.innerHTML = "";
  dom.ridersTableBody.innerHTML = "";
}

async function loadRaceData() {
  try {
    await ensureGoogleMapsLoaded(GOOGLE_MAPS_API_KEY);
    ensureMapReady();

    const gpxFile = dom.gpxFile.files[0];
    if (!gpxFile) {
      throw new Error("Select a GPX file first.");
    }
    const beaconFile = dom.beaconFile.files[0];
    if (!beaconFile) {
      throw new Error("Select a beacon JSON file first.");
    }

    const gpxText = await gpxFile.text();
    const beaconInput = safeJsonParse(await beaconFile.text(), "beacons");

    const course = parseGpx(gpxText);
    if (course.points.length < 2) {
      throw new Error("GPX must include at least 2 track points.");
    }

    const riderInput = safeJsonParse(dom.ridersInput.value, "riders");

    const beacons = normalizeBeacons(beaconInput, course);
    const riders = normalizeRiders(riderInput);

    state.course = course;
    state.beacons = beacons;
    state.riders = riders;
    state.riderMap = new Map(riders.map((r) => [r.id, r]));
    state.map.needsViewportFit = true;

    populateSelects();
    restartProjectionLoop();
    renderAll();
    setStatus("Race data loaded. Waiting for beacon pass events from service.");
  } catch (error) {
    setStatus(error.message, true);
  }
}

function startBeaconPassStream() {
  if (state.service.eventSource) {
    state.service.eventSource.close();
    state.service.eventSource = null;
  }

  const source = new EventSource(EVENTS_API_PATH);
  state.service.eventSource = source;

  source.onopen = () => {
    state.service.connected = true;
    clearServiceReconnectTimer();
    setStatus("Connected to beacon event service.");
  };

  source.onerror = () => {
    state.service.connected = false;
    source.close();
    scheduleStreamReconnect();
    setStatus("Disconnected from beacon event service. Retrying...", true);
  };

  source.addEventListener("beacon-pass", (event) => {
    try {
      const payload = safeJsonParse(event.data, "beacon-pass event");
      recordBeaconPass(payload, { source: "service" });
    } catch (error) {
      setStatus(`Invalid beacon-pass event: ${error.message}`, true);
    }
  });
}

function scheduleStreamReconnect() {
  if (state.service.reconnectTimer) {
    return;
  }
  state.service.reconnectTimer = setTimeout(() => {
    state.service.reconnectTimer = null;
    startBeaconPassStream();
  }, 2000);
}

function clearServiceReconnectTimer() {
  if (!state.service.reconnectTimer) {
    return;
  }
  clearTimeout(state.service.reconnectTimer);
  state.service.reconnectTimer = null;
}

async function postBeaconPass(eventPayload) {
  let response;
  try {
    response = await fetch(BEACON_PASS_API_PATH, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(eventPayload),
    });
  } catch {
    throw new Error("Could not reach beacon event service. Is `npm start` running?");
  }

  let responseBody = null;
  try {
    responseBody = await response.json();
  } catch {
    responseBody = null;
  }

  if (!response.ok || !responseBody?.ok) {
    const reason = responseBody?.error || `HTTP ${response.status}`;
    throw new Error(`Beacon event rejected by service: ${reason}`);
  }
}

function getTestBeaconIds() {
  return state.beacons.map((b) => b.id);
}

async function startTestSequence() {
  if (state.riders.length === 0) {
    throw new Error("Load race data with riders before running test sequence.");
  }
  if (state.beacons.length < 1) {
    throw new Error("Need at least 1 beacon loaded to run test sequence.");
  }

  const riderIds = state.riders.map((r) => r.id);
  const beaconIds = getTestBeaconIds();
  if (beaconIds.length < 1) {
    throw new Error("Could not resolve beacon ids for test sequence.");
  }

  let response;
  try {
    response = await fetch(TEST_SEQUENCE_API_PATH, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        riderIds,
        beaconIds,
        minDelaySeconds: 10,
        maxDelaySeconds: 15,
      }),
    });
  } catch {
    throw new Error("Could not reach test sequence service. Is `npm start` running?");
  }

  let responseBody = null;
  try {
    responseBody = await response.json();
  } catch {
    responseBody = null;
  }

  if (!response.ok || !responseBody?.ok) {
    const reason = responseBody?.error || `HTTP ${response.status}`;
    throw new Error(`Test sequence rejected by service: ${reason}`);
  }

  return responseBody.run;
}

function ensureGoogleMapsLoaded(apiKey) {
  if (state.map.apiLoaded && window.google?.maps) {
    return Promise.resolve();
  }

  if (state.map.apiLoadingPromise) {
    return state.map.apiLoadingPromise;
  }

  state.map.apiLoadingPromise = new Promise((resolve, reject) => {
    const callbackName = "__motoTrkGoogleMapsReady";
    window[callbackName] = () => {
      state.map.apiLoaded = true;
      delete window[callbackName];
      resolve();
    };

    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&callback=${callbackName}`;
    script.async = true;
    script.defer = true;
    script.onerror = () => {
      delete window[callbackName];
      reject(new Error("Failed to load Google Maps. Check API key and network access."));
    };
    document.head.appendChild(script);
  });

  return state.map.apiLoadingPromise;
}

function ensureMapReady() {
  if (state.map.instance || !window.google?.maps) {
    return;
  }

  state.map.instance = new google.maps.Map(dom.mapCanvas, {
    center: { lat: 37.42, lng: -122.085 },
    zoom: 13,
    mapTypeId: "terrain",
    streetViewControl: false,
    fullscreenControl: true,
  });
}

function safeJsonParse(raw, label) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Invalid ${label} JSON.`);
  }
}

function normalizeBeacons(raw, course) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("Beacons JSON must be a non-empty array.");
  }

  // Preserve beacon order from input JSON. For loop tracks, first and last
  // beacons can be at similar coordinates, so distance sorting breaks sequence.
  return raw
    .map((item, index) => {
      if (!item?.id || typeof item.lat !== "number" || typeof item.lon !== "number") {
        throw new Error(`Beacon at index ${index} must have id, lat, and lon.`);
      }
      const snapped = snapToCourse(item.lat, item.lon, course);
      return {
        id: String(item.id),
        lat: item.lat,
        lon: item.lon,
        coursePointIndex: snapped.pointIndex,
        distanceAlongCourse: snapped.distance,
      };
    });
}

function normalizeRiders(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("Riders JSON must be a non-empty array.");
  }

  const seenIds = new Set();
  return raw.map((item, index) => {
    const firstName = String(item?.firstName || "").trim();
    const lastName = String(item?.lastName || "").trim();
    const plate = String(item?.plate || "").trim();

    if (!firstName || !lastName || !plate) {
      throw new Error(`Rider at index ${index} must include firstName, lastName, and plate.`);
    }

    const id = item.id ? String(item.id) : plate;
    if (seenIds.has(id)) {
      throw new Error(`Duplicate rider id: ${id}`);
    }
    seenIds.add(id);

    return {
      id,
      firstName,
      lastName,
      plate,
      events: [],
      confirmedDistance: 0,
      projectedDistance: 0,
      paceMps: null,
      frozenAtBeaconId: null,
      latestPlace: null,
      finished: false,
    };
  });
}

function parseGpx(gpxText) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(gpxText, "application/xml");
  if (xml.querySelector("parsererror")) {
    throw new Error("Could not parse GPX file.");
  }

  const trackPoints = Array.from(xml.querySelectorAll("trkpt"));
  const routePoints = Array.from(xml.querySelectorAll("rtept"));
  const nodes = trackPoints.length > 0 ? trackPoints : routePoints;

  const points = nodes.map((node) => ({
    lat: Number(node.getAttribute("lat")),
    lon: Number(node.getAttribute("lon")),
  }));

  if (points.some((p) => Number.isNaN(p.lat) || Number.isNaN(p.lon))) {
    throw new Error("GPX contains invalid lat/lon values.");
  }

  const distances = [0];
  let cumulative = 0;
  for (let i = 1; i < points.length; i += 1) {
    cumulative += haversineMeters(points[i - 1], points[i]);
    distances.push(cumulative);
  }

  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);

  return {
    points,
    distances,
    totalDistance: cumulative,
    bounds: {
      minLat: Math.min(...lats),
      maxLat: Math.max(...lats),
      minLon: Math.min(...lons),
      maxLon: Math.max(...lons),
    },
  };
}

function haversineMeters(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  const h = s1 * s1 + Math.cos(lat1) * Math.cos(lat2) * s2 * s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function snapToCourse(lat, lon, course) {
  const target = { lat, lon };
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let i = 0; i < course.points.length; i += 1) {
    const pointDistance = haversineMeters(target, course.points[i]);
    if (pointDistance < bestDistance) {
      bestDistance = pointDistance;
      bestIndex = i;
    }
  }

  return {
    pointIndex: bestIndex,
    distance: course.distances[bestIndex],
  };
}

function populateSelects() {
  dom.riderSelect.innerHTML = state.riders
    .map((r) => `<option value="${r.id}">${r.plate} - ${r.firstName} ${r.lastName}</option>`)
    .join("");

  dom.beaconSelect.innerHTML = state.beacons
    .map((b) => `<option value="${b.id}">${b.id}</option>`)
    .join("");
}

function recordBeaconPass({ riderId, beaconId, place = null, timestamp = Date.now() }, options = {}) {
  const rider = state.riderMap.get(riderId);
  const beacon = state.beacons.find((b) => b.id === beaconId);
  if (!rider || !beacon) {
    if (options.source === "service") {
      return;
    }
    setStatus("Invalid rider or beacon in pass event.", true);
    return;
  }

  const event = {
    beaconId,
    beaconDistance: beacon.distanceAlongCourse,
    timestamp,
    place,
  };

  rider.events.push(event);
  rider.events.sort((a, b) => a.timestamp - b.timestamp);

  rider.confirmedDistance = Math.max(rider.confirmedDistance, beacon.distanceAlongCourse);
  rider.projectedDistance = rider.confirmedDistance;
  rider.latestPlace = place;
  const lastBeacon = state.beacons[state.beacons.length - 1];
  if (lastBeacon && beacon.id === lastBeacon.id) {
    rider.finished = true;
  }
  if (rider.frozenAtBeaconId === beaconId) {
    rider.frozenAtBeaconId = null;
  }

  recalculateRiderPace(rider);

  renderAll();
  setStatus(`Pass recorded from ${options.source || "local"}: ${rider.plate} at beacon ${beaconId}.`);
}

function recalculateRiderPace(rider) {
  if (rider.events.length < 2) {
    rider.paceMps = null;
    return;
  }

  const last = rider.events[rider.events.length - 1];
  let prev = null;

  for (let i = rider.events.length - 2; i >= 0; i -= 1) {
    if (rider.events[i].beaconDistance < last.beaconDistance) {
      prev = rider.events[i];
      break;
    }
  }

  if (!prev) {
    rider.paceMps = null;
    return;
  }

  const dtSeconds = (last.timestamp - prev.timestamp) / 1000;
  const ddMeters = last.beaconDistance - prev.beaconDistance;
  if (dtSeconds <= 0 || ddMeters <= 0) {
    rider.paceMps = null;
    return;
  }

  rider.paceMps = ddMeters / dtSeconds;
}

function restartProjectionLoop() {
  if (state.intervalId) {
    clearInterval(state.intervalId);
  }

  state.intervalId = setInterval(() => {
    updateProjectedLocations();
    renderAll();
  }, REFRESH_MS);
}

function updateProjectedLocations() {
  const now = Date.now();
  for (const rider of state.riders) {
    if (rider.finished) {
      rider.frozenAtBeaconId = null;
      rider.projectedDistance = rider.confirmedDistance;
      continue;
    }

    if (!rider.paceMps || rider.events.length < 2) {
      rider.projectedDistance = rider.confirmedDistance;
      continue;
    }

    const lastEvent = rider.events[rider.events.length - 1];
    const elapsedSeconds = (now - lastEvent.timestamp) / 1000;
    let projected = rider.confirmedDistance + rider.paceMps * Math.max(0, elapsedSeconds);

    const nextBeacon = findNextBeaconForRider(rider);

    if (nextBeacon && projected >= nextBeacon.distanceAlongCourse) {
      projected = nextBeacon.distanceAlongCourse;
      rider.frozenAtBeaconId = nextBeacon.id;
    } else {
      rider.frozenAtBeaconId = null;
    }

    rider.projectedDistance = clamp(projected, 0, state.course.totalDistance);
  }
}

function findNextBeaconForRider(rider) {
  const passed = new Set(rider.events.map((e) => e.beaconId));
  for (const beacon of state.beacons) {
    if (beacon.distanceAlongCourse > rider.confirmedDistance && !passed.has(beacon.id)) {
      return beacon;
    }
  }
  return null;
}

function distanceToPoint(distance) {
  const d = clamp(distance, 0, state.course.totalDistance || 0);
  const distances = state.course.distances;
  const points = state.course.points;

  if (points.length === 0) {
    return null;
  }

  if (d <= 0) {
    return points[0];
  }

  if (d >= distances[distances.length - 1]) {
    return points[points.length - 1];
  }

  let i = 1;
  while (i < distances.length && distances[i] < d) {
    i += 1;
  }

  const d0 = distances[i - 1];
  const d1 = distances[i];
  const ratio = d1 === d0 ? 0 : (d - d0) / (d1 - d0);

  return {
    lat: points[i - 1].lat + (points[i].lat - points[i - 1].lat) * ratio,
    lon: points[i - 1].lon + (points[i].lon - points[i - 1].lon) * ratio,
  };
}

function renderAll() {
  drawMap();
  renderRidersTable();
}

function drawMap() {
  if (!state.map.instance || !window.google?.maps) {
    return;
  }

  drawCoursePolyline();
  drawBeaconMarkers();
  drawRiderMarkers();
}

function drawCoursePolyline() {
  if (!state.map.instance) {
    return;
  }

  if (state.map.coursePolyline) {
    state.map.coursePolyline.setMap(null);
    state.map.coursePolyline = null;
  }

  if (state.course.points.length < 2) {
    return;
  }

  const path = state.course.points.map((p) => ({ lat: p.lat, lng: p.lon }));
  state.map.coursePolyline = new google.maps.Polyline({
    path,
    geodesic: true,
    strokeColor: "#7aa8ff",
    strokeOpacity: 0.95,
    strokeWeight: 4,
    map: state.map.instance,
  });

  if (state.map.needsViewportFit) {
    const bounds = new google.maps.LatLngBounds();
    for (const p of path) {
      bounds.extend(p);
    }
    state.map.instance.fitBounds(bounds);
    state.map.needsViewportFit = false;
  }
}

function drawBeaconMarkers() {
  if (!state.map.instance) {
    return;
  }

  for (const marker of state.map.beaconMarkers) {
    marker.setMap(null);
  }
  state.map.beaconMarkers = [];

  for (const beacon of state.beacons) {
    const marker = new google.maps.Marker({
      map: state.map.instance,
      position: { lat: beacon.lat, lng: beacon.lon },
      title: `Beacon ${beacon.id}`,
      label: {
        text: beacon.id,
        color: "#1f1300",
        fontSize: "11px",
        fontWeight: "700",
      },
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 8,
        fillColor: "#ffc14d",
        fillOpacity: 1,
        strokeColor: "#7a5200",
        strokeWeight: 2,
      },
      zIndex: 5,
    });

    state.map.beaconMarkers.push(marker);
  }
}

function drawRiderMarkers() {
  if (!state.map.instance) {
    return;
  }

  const activeRiderIds = new Set(state.riders.map((r) => r.id));
  for (const [riderId, marker] of state.map.riderMarkers.entries()) {
    if (!activeRiderIds.has(riderId)) {
      marker.setMap(null);
      state.map.riderMarkers.delete(riderId);
    }
  }

  for (const rider of state.riders) {
    const point = distanceToPoint(rider.projectedDistance || rider.confirmedDistance);
    if (!point) {
      continue;
    }

    const pos = { lat: point.lat, lng: point.lon };
    let marker = state.map.riderMarkers.get(rider.id);

    if (!marker) {
      marker = new google.maps.Marker({
        map: state.map.instance,
        position: pos,
        title: `${rider.plate} - ${rider.firstName} ${rider.lastName}`,
        label: {
          text: rider.plate,
          color: "#04241a",
          fontSize: "11px",
          fontWeight: "700",
        },
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 9,
          fillColor: "#43d6a8",
          fillOpacity: 1,
          strokeColor: "#0d5a44",
          strokeWeight: 2,
        },
        zIndex: 10,
      });
      state.map.riderMarkers.set(rider.id, marker);
    } else {
      marker.setPosition(pos);
    }
  }
}

function renderRidersTable() {
  const rows = state.riders
    .map((r) => {
      const lastEvent = r.events[r.events.length - 1];
      const lastBeacon = lastEvent ? lastEvent.beaconId : "-";
      const pace = r.paceMps ? `${(r.paceMps * 3.6).toFixed(1)} km/h` : "-";
      const projectedKm = (r.projectedDistance / 1000).toFixed(2);
      const riderState = r.finished
        ? "Finished"
        : r.frozenAtBeaconId
        ? `Waiting @ ${r.frozenAtBeaconId}`
        : r.events.length > 0
          ? "Moving"
          : "Not started";

      return `<tr>
        <td>${escapeHtml(r.plate)}</td>
        <td>${escapeHtml(r.firstName)} ${escapeHtml(r.lastName)}</td>
        <td>${escapeHtml(lastBeacon)}</td>
        <td>${pace}</td>
        <td>${projectedKm} km</td>
        <td>${escapeHtml(riderState)}</td>
      </tr>`;
    })
    .join("");

  dom.ridersTableBody.innerHTML = rows;
}

function setStatus(message, isError = false) {
  dom.status.textContent = message;
  dom.status.classList.toggle("error", isError);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function escapeHtml(raw) {
  return String(raw)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function loadSampleData() {
  try {
    dom.ridersInput.value = JSON.stringify(
      [
        { firstName: "Geddy", lastName: "Tarbell", plate: "17" },
        { firstName: "Zach", lastName: "Nelson", plate: "52" },
        { firstName: "Travis", lastName: "Pastrana", plate: "199" },
      ],
      null,
      2,
    );

    setStatus("Sample riders loaded. Select GPX and beacon JSON files, then click Load Race Data.");
  } catch (error) {
    setStatus(error.message, true);
  }
}

window.MotoTrk = {
  recordBeaconPass,
  postBeaconPass,
  startTestSequence,
};
