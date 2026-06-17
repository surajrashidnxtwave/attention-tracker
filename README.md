# Attention Test Harness

Browser-based real-time attention tracker for video lectures. Modern, dependency-free
stand-in for [IntelliEye](https://github.com/codesalad/ieyewidget)'s discontinued remote core.

- **Face + iris gaze tracking** via MediaPipe FaceLandmarker (loaded from CDN).
- **9-point gaze calibration** → predicts where on screen you look (head-pose compensated).
- Flags inattention: face lost, head turned, **eyes off screen**, eyes closed, tab hidden.
- Visual / pause alerts, attention timeline, CSV export.
- **Privacy:** all webcam processing in-browser; nothing is uploaded.

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
