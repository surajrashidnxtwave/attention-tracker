# Attention Test Harness

Browser-based real-time attention tracker for video lectures. Modern, dependency-free
stand-in for [IntelliEye](https://github.com/codesalad/ieyewidget)'s discontinued remote core.

- **Face + iris gaze tracking** via MediaPipe FaceLandmarker (loaded from CDN).
- **9-point gaze calibration** → predicts where on screen you look (head-pose compensated).
- Flags inattention: face lost, head turned, **eyes off screen**, eyes closed, tab hidden.
- **WEDAR attention-regulation layer** (`/wedar/`): 6 behavior detectors (eyebrow, blink
  flurry, mumble, hand-on-face, postural shift, neutral) → 8s sliding-window aggregation →
  3-state fusion (`engaged` / `drifting_but_regulating` / `disengaged` / `unknown`) with
  hysteresis. Per-learner baseline auto-captured after gaze calibration. Optional hand model
  + re-engagement probe. Debug overlay (toggle, hotkey `D`).
- Visual / pause alerts, attention timeline, gaze + WEDAR CSV/JSON export.
- **Privacy:** all webcam processing in-browser; only derived per-second WEDAR records (no
  frames/landmarks) would ever leave the device — and only if a backend `POST_URL` is set
  (off by default). Output is a data-quality/support signal, never a proctoring flag.

## Modules (`/wedar/`)
`wedarConfig.js` (all constants) · `baseline.js` · `frameDetectors.js` · `windowAggregator.js`
· `fusion.js` · `wedarLogger.js` · `debugOverlay.js` · `probe.js` · `wedar.js` (orchestrator).
Tune thresholds in `wedarConfig.js`. See `WEDAR_implementation_spec_v2.md`.

## Run locally
```bash
npx serve .
# open http://localhost:3000  (webcam needs https or localhost)
```

## Deploy
Static site, no build step. Single `index.html`. Host on Vercel (see repo instructions)
or any static host. Camera requires HTTPS — Vercel provides it.

## Usage
1. **Start tracking** → grant webcam.
2. **Calibrate gaze (9-point)** → follow the dot with your eyes, head still.
3. Load a sample video (file picker or demo clip) and watch.

Reference: Robal, Zhao, Lofi, Hauff. *"IntelliEye: Enhancing MOOC Learners' Video Watching
Experience through Real-Time Attention Tracking."* Hypertext 2018.
