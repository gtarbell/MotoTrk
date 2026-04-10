const REFRESH_MS = 3000;
const GOOGLE_MAPS_API_KEY = "AIzaSyDeMv0ZpNSlyoxFGCmMyr99eKHYhIkdgQY";
const EXAMPLE_GPX_PATH = "./example_Data/activity_22321227538.gpx";
const EXAMPLE_BEACONS_PATH = "./example_Data/beacons_5_even.json";
const EMBEDDED_EXAMPLE_BEACONS = [
  { id: "B1", lat: 45.380645, lon: -122.029773 },
  { id: "B2", lat: 45.393574, lon: -122.015707 },
  { id: "B3", lat: 45.397709, lon: -122.015538 },
  { id: "B4", lat: 45.3906, lon: -122.018963 },
  { id: "B5", lat: 45.380847, lon: -122.030069 },
];

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
};

const dom = {
  courseSource: document.getElementById("courseSource"),
  gpxFile: document.getElementById("gpxFile"),
  beaconsInput: document.getElementById("beaconsInput"),
  ridersInput: document.getElementById("ridersInput"),
  loadDataBtn: document.getElementById("loadDataBtn"),
  loadSampleBtn: document.getElementById("loadSampleBtn"),
  riderSelect: document.getElementById("riderSelect"),
  beaconSelect: document.getElementById("beaconSelect"),
  placeInput: document.getElementById("placeInput"),
  recordPassBtn: document.getElementById("recordPassBtn"),
  status: document.getElementById("status"),
  mapCanvas: document.getElementById("mapCanvas"),
  ridersTableBody: document.getElementById("ridersTableBody"),
};

init();

function init() {
  wireActions();
  resetUiForEmptyState();
}

function wireActions() {
  dom.courseSource.addEventListener("change", onCourseSourceChanged);
  dom.loadDataBtn.addEventListener("click", loadRaceData);
  dom.loadSampleBtn.addEventListener("click", loadSampleData);
  dom.recordPassBtn.addEventListener("click", () => {
    const riderId = dom.riderSelect.value;
    const beaconId = dom.beaconSelect.value;
    const place = dom.placeInput.value ? Number(dom.placeInput.value) : null;
    if (!riderId || !beaconId) {
      setStatus("Select a rider and beacon before recording a pass.", true);
      return;
    }
    recordBeaconPass({ riderId, beaconId, place, timestamp: Date.now() });
  });
}

function resetUiForEmptyState() {
  dom.riderSelect.innerHTML = "";
  dom.beaconSelect.innerHTML = "";
  dom.ridersTableBody.innerHTML = "";
  onCourseSourceChanged();
}

async function loadRaceData() {
  try {
    const source = dom.courseSource.value;

    await ensureGoogleMapsLoaded(GOOGLE_MAPS_API_KEY);
    ensureMapReady();

    let gpxText = "";
    let beaconInput = null;

    if (source === "example") {
      const [exampleGpxText, exampleBeaconInput] = await Promise.all([
        fetchText(EXAMPLE_GPX_PATH),
        loadExampleBeacons(),
      ]);
      gpxText = exampleGpxText;
      beaconInput = exampleBeaconInput;
      dom.beaconsInput.value = JSON.stringify(beaconInput, null, 2);
    } else {
      const gpxFile = dom.gpxFile.files[0];
      if (!gpxFile) {
        throw new Error("Select a GPX file first.");
      }
      gpxText = await gpxFile.text();
      beaconInput = safeJsonParse(dom.beaconsInput.value, "beacons");
    }

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
    setStatus("Race data loaded. Record beacon passes as events arrive.");
  } catch (error) {
    setStatus(error.message, true);
  }
}

function onCourseSourceChanged() {
  const useExample = dom.courseSource.value === "example";
  dom.gpxFile.disabled = useExample;
  dom.beaconsInput.disabled = useExample;
}

async function fetchText(url) {
  let response;
  try {
    response = await fetch(url, { cache: "no-store" });
  } catch {
    throw new Error(
      `Could not fetch ${url}. If you opened index.html directly, run a local web server so example files can be loaded.`,
    );
  }
  if (!response.ok) {
    throw new Error(`Failed to load ${url} (${response.status}).`);
  }
  return response.text();
}

async function loadExampleBeacons() {
  try {
    const exampleBeaconsText = await fetchText(EXAMPLE_BEACONS_PATH);
    return safeJsonParse(exampleBeaconsText, "example beacons");
  } catch (error) {
    if (window.location.protocol === "file:") {
      return EMBEDDED_EXAMPLE_BEACONS;
    }
    throw error;
  }
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
    })
    .sort((a, b) => a.distanceAlongCourse - b.distanceAlongCourse);
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

function recordBeaconPass({ riderId, beaconId, place = null, timestamp = Date.now() }) {
  const rider = state.riderMap.get(riderId);
  const beacon = state.beacons.find((b) => b.id === beaconId);
  if (!rider || !beacon) {
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
  if (rider.frozenAtBeaconId === beaconId) {
    rider.frozenAtBeaconId = null;
  }

  recalculateRiderPace(rider);

  renderAll();
  setStatus(`Pass recorded: ${rider.plate} at beacon ${beaconId}.`);
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
      const riderState = r.frozenAtBeaconId
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
    const beaconInput = await loadExampleBeacons();
    dom.beaconsInput.value = JSON.stringify(beaconInput, null, 2);

    dom.ridersInput.value = JSON.stringify(
      [
        { firstName: "Geddy", lastName: "Tarbell", plate: "17" },
        { firstName: "Zach", lastName: "Nelson", plate: "52" },
        { firstName: "Travis", lastName: "Pastrana", plate: "199" },
      ],
      null,
      2,
    );

    setStatus("Sample riders/beacons loaded. Choose a source and click Load Race Data.");
  } catch (error) {
    setStatus(error.message, true);
  }
}

window.MotoTrk = {
  recordBeaconPass,
};
