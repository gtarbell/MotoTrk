const http = require("http");
const fs = require("fs");
const path = require("path");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const MAX_BODY_BYTES = 1024 * 1024;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".gpx": "application/gpx+xml; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const sseClients = new Set();
let nextTestRunId = 1;

function send(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendJson(res, statusCode, value) {
  send(res, statusCode, JSON.stringify(value), "application/json; charset=utf-8");
}

function safePathFromUrl(urlPathname) {
  const decoded = decodeURIComponent(urlPathname);
  const relative = decoded === "/" ? "/index.html" : decoded;
  const normalized = path.normalize(relative).replace(/^([.][.][/\\])+/, "");
  const resolved = path.resolve(ROOT, `.${normalized}`);
  if (!resolved.startsWith(ROOT)) {
    return null;
  }
  return resolved;
}

function normalizePassEvent(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("Body must be a JSON object.");
  }

  const riderId = String(raw.riderId || "").trim();
  const beaconId = String(raw.beaconId || "").trim();
  const place = raw.place == null || raw.place === "" ? null : Number(raw.place);
  const timestamp = raw.timestamp == null ? Date.now() : Number(raw.timestamp);

  if (!riderId) {
    throw new Error("riderId is required.");
  }
  if (!beaconId) {
    throw new Error("beaconId is required.");
  }
  if (place != null && (!Number.isFinite(place) || place < 1)) {
    throw new Error("place must be a positive number when provided.");
  }
  if (!Number.isFinite(timestamp)) {
    throw new Error("timestamp must be a valid number when provided.");
  }

  return {
    riderId,
    beaconId,
    place,
    timestamp,
    receivedAt: Date.now(),
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let received = 0;
    let raw = "";

    req.on("data", (chunk) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        reject(new Error("Request body too large."));
        req.destroy();
        return;
      }
      raw += chunk.toString("utf8");
    });

    req.on("end", () => {
      if (!raw.trim()) {
        reject(new Error("Request body is required."));
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });

    req.on("error", () => {
      reject(new Error("Failed to read request body."));
    });
  });
}

function writeSseEvent(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcastBeaconPass(eventPayload) {
  for (const res of sseClients) {
    writeSseEvent(res, "beacon-pass", eventPayload);
  }
}

function randomIntInclusive(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function scheduleTestBeaconSequence(rawBody) {
  const riderIds = Array.isArray(rawBody?.riderIds) ? rawBody.riderIds : [];
  const beaconIds = Array.isArray(rawBody?.beaconIds) ? rawBody.beaconIds : [];
  const minDelaySeconds = Number(rawBody?.minDelaySeconds ?? 10);
  const maxDelaySeconds = Number(rawBody?.maxDelaySeconds ?? 15);

  if (riderIds.length === 0) {
    throw new Error("riderIds must be a non-empty array.");
  }
  if (beaconIds.length < 1) {
    throw new Error("beaconIds must contain at least 1 beacon id.");
  }
  if (!Number.isFinite(minDelaySeconds) || !Number.isFinite(maxDelaySeconds)) {
    throw new Error("minDelaySeconds/maxDelaySeconds must be numbers.");
  }
  if (minDelaySeconds < 1 || maxDelaySeconds < 1 || maxDelaySeconds < minDelaySeconds) {
    throw new Error("Delay bounds are invalid.");
  }

  const sequenceBeaconIds = beaconIds.map((id) => String(id).trim());
  if (sequenceBeaconIds.some((id) => !id)) {
    throw new Error("beaconIds entries must be non-empty strings.");
  }

  const normalizedRiderIds = riderIds.map((id) => String(id).trim());
  if (normalizedRiderIds.some((id) => !id)) {
    throw new Error("riderIds entries must be non-empty strings.");
  }

  const runId = `test-${nextTestRunId++}`;
  const scheduled = [];

  for (const riderId of normalizedRiderIds) {
    let riderDelayMs = 0;
    for (let i = 0; i < sequenceBeaconIds.length; i += 1) {
      const beaconId = sequenceBeaconIds[i];
      const place = null;

      scheduled.push({
        riderId,
        beaconId,
        place,
        delayMs: riderDelayMs,
      });

      if (i < sequenceBeaconIds.length - 1) {
        const delayForNextMs = randomIntInclusive(minDelaySeconds, maxDelaySeconds) * 1000;
        riderDelayMs += delayForNextMs;
      }
    }
  }

  for (const item of scheduled) {
    setTimeout(() => {
      const payload = normalizePassEvent({
        riderId: item.riderId,
        beaconId: item.beaconId,
        place: item.place,
        timestamp: Date.now(),
      });
      payload.testRunId = runId;
      broadcastBeaconPass(payload);
    }, item.delayMs);
  }

  return {
    id: runId,
    riderCount: normalizedRiderIds.length,
    sequenceBeaconIds,
    totalEvents: scheduled.length,
    minDelaySeconds,
    maxDelaySeconds,
  };
}

function handleEventsStream(_req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });

  res.write(": connected\n\n");
  sseClients.add(res);

  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 25000);

  res.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
}

function serveStatic(url, res) {
  const filePath = safePathFromUrl(url.pathname);
  if (!filePath) {
    send(res, 403, "Forbidden");
    return;
  }

  fs.stat(filePath, (statErr, stats) => {
    if (statErr) {
      send(res, 404, "Not Found");
      return;
    }

    const pathToRead = stats.isDirectory() ? path.join(filePath, "index.html") : filePath;

    fs.readFile(pathToRead, (readErr, data) => {
      if (readErr) {
        send(res, 404, "Not Found");
        return;
      }

      const ext = path.extname(pathToRead).toLowerCase();
      const type = MIME_TYPES[ext] || "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": type,
        "Cache-Control": "no-store",
      });
      res.end(data);
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.method) {
    send(res, 400, "Bad Request");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    handleEventsStream(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/beacon-pass") {
    try {
      const body = await readJsonBody(req);
      const eventPayload = normalizePassEvent(body);
      broadcastBeaconPass(eventPayload);
      sendJson(res, 200, { ok: true, event: eventPayload });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/test/generate") {
    try {
      const body = await readJsonBody(req);
      const run = scheduleTestBeaconSequence(body);
      sendJson(res, 200, { ok: true, run });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  serveStatic(url, res);
});

server.listen(PORT, HOST, () => {
  console.log(`MotoTrk server running at http://${HOST}:${PORT}`);
  console.log(`Beacon pass API: POST http://${HOST}:${PORT}/api/beacon-pass`);
  console.log(`Event stream: GET http://${HOST}:${PORT}/api/events`);
  console.log(`Test sequence API: POST http://${HOST}:${PORT}/api/test/generate`);
});
