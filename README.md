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

## Run

No build step required.

1. Open [`index.html`](./index.html) in a browser.
2. Choose `Course Source`:
   - `Upload GPX`: upload your own GPX and paste beacon JSON.
   - `Example Course (auto beacons)`: loads GPX from `example_Data/activity_22321227538.gpx` and beacons from `example_Data/beacons_5_even.json`.
3. Paste rider JSON (or click `Load Sample Data`).
4. Click `Load Race Data`.
5. Use `Live Beacon Pass` to input incoming beacon events.

Note: for `Example Course`, serve the app from a local web server (not `file://`) so browser `fetch` can read files from `example_Data`.

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

## Programmatic event ingestion

You can call this from console or future integration glue code:

```js
window.MotoTrk.recordBeaconPass({
  riderId: "17",
  beaconId: "B2",
  place: 3,
  timestamp: Date.now(),
});
```
