# MotoTrk (Vanilla JS + Google Maps)

A browser-based race tracker for motorcycle riders on a fixed GPX course.

## Features

- Loads a GPX course file (`trkpt` preferred, `rtept` supported).
- Overlays course, beacons, and riders on Google Maps.
- Loads beacon list and rider list from JSON.
- Records live rider beacon-pass events.
- Calculates a rough rider pace after at least 2 beacon passes.
- Reprojects rider locations every 3 seconds.
- Stops projected rider movement at the next beacon until real pass event arrives.
- Includes a Node.js beacon event service (`POST /api/beacon-pass` + `GET /api/events`).

## Run

1. In this folder, start the local Node.js server:
   - `npm start`
2. Open `http://127.0.0.1:3000` in a browser.
3. Select a GPX file.
4. Select a beacon JSON file.
5. Paste rider JSON (or click `Load Sample Data`).
6. Click `Load Race Data`.
7. Use `Live Beacon Pass` to send events to the backend service, or post to the API from another system.

## Beacon JSON format

```json
[
  { "id": "B1", "lat": 37.123, "lon": -122.456 },
  { "id": "B2", "lat": 37.124, "lon": -122.457 }
]
```

## Rider JSON format

```json
[
  { "firstName": "Alex", "lastName": "Turner", "plate": "17" },
  { "firstName": "Jamie", "lastName": "Singh", "plate": "52" }
]
```

Optional rider `id` is supported; if omitted, `plate` is used as the unique id.

## Beacon Event Service

The server exposes:

- `POST /api/beacon-pass` with JSON body:

```json
{
  "riderId": "17",
  "beaconId": "B2",
  "place": 3,
  "timestamp": 1775818200000
}
```

- `GET /api/events` as an SSE stream that emits `beacon-pass` events.
- `POST /api/test/generate` to emit a test sequence (first beacon through last beacon) for each rider with random delay between events.

Example test trigger payload:

```json
{
  "riderIds": ["17", "52", "199"],
  "beaconIds": ["B1", "B2", "B3", "B4", "B5", "B6"],
  "minDelaySeconds": 10,
  "maxDelaySeconds": 15
}
```

The web UI automatically subscribes to `/api/events` and updates riders when events are broadcast.
The `Run Test Beacon Sequence` button calls `/api/test/generate` using currently loaded riders and beacons.

## Programmatic event ingestion

You can call this from console or future integration glue code:

```js
window.MotoTrk.postBeaconPass({
  riderId: "17",
  beaconId: "B2",
  place: 3,
  timestamp: Date.now(),
});

window.MotoTrk.startTestSequence();
```
