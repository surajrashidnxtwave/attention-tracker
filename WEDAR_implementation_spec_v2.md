# WEDAR Attention-Regulation Layer — Full Implementation Spec (v2)

## 0. What this is and how to read it
You are extending an existing browser-based attention tracker. The tracker already does: 9-point gaze calibration, IntelliEye logic (face-present + gaze-on-screen → binary attentive/inattentive), plus mouse-movement and tab-visibility sanity checks. **Do not rewrite or remove any of that.** This spec adds a parallel **WEDAR layer** that detects *attention-regulation behaviors* (the self-correcting things a learner does while re-engaging), and fuses the two signals into a 3-state output. Everything is client-side; no video or images ever leave the device.

This document is build-ready. Where a value is an engineering guess rather than from the WEDAR paper, it is marked `«tune»`. Implement in the order in §13.

Assumes **MediaPipe Tasks Vision (FaceLandmarker)** for face. If the current build uses a different face engine, keep the architecture identical and remap the blendshape names in §3 — flag this before starting.

---

## 1. File / module architecture
Add these modules; do not fold logic into existing files beyond the wiring noted.

```
/wedar/
  wedarConfig.js        // all constants (§11), single source of truth
  baseline.js           // per-learner neutral baseline capture + storage (§7)
  frameDetectors.js     // the 6 per-frame behavior detectors (§3)
  windowAggregator.js   // 8s sliding-window feature builder (§4)
  fusion.js             // combine IntelliEye + WEDAR → 3-state, w/ hysteresis (§5,§6)
  wedarLogger.js        // per-window record assembly + send (§8)
  debugOverlay.js       // dev-only on-screen overlay (§9)
  probe.js              // optional self-label re-engagement probe (§10)
  wedar.js              // orchestrator: subscribes to the existing frame loop, owns state
```

**Integration points (only these touch existing code):**
- The existing per-frame callback (where FaceLandmarker results arrive) calls `wedar.onFrame(result, tsMs)`.
- The existing IntelliEye per-frame attentive/inattentive boolean is passed in too: `wedar.onFrame(result, tsMs, { gazeAttentive })`.
- The existing 9-point calibration completion handler calls `baseline.captureNeutral(...)` (see §7).
- The existing logger transport (whatever POSTs to backend) is reused by `wedarLogger`.

`wedar.js` keeps a ring buffer of per-frame records and drives the window timer. Nothing else holds state.

---

## 2. Prerequisite: enable blendshapes, head pose, and (optionally) hands
FaceLandmarker must output blendshapes and the transformation matrix:
```js
faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
  baseOptions: { modelAssetPath: "face_landmarker.task", delegate: "GPU" },
  outputFaceBlendshapes: true,
  outputFacialTransformationMatrixes: true,
  runningMode: "VIDEO",
  numFaces: 1
});
```
Helper to read a blendshape by name (MediaPipe returns a categories array):
```js
function bs(result, name) {
  const cats = result.faceBlendshapes?.[0]?.categories;
  if (!cats) return 0;
  const c = cats.find(c => c.categoryName === name);
  return c ? c.score : 0;   // 0..1
}
```
Head pose (pitch/yaw/roll) is decoded from `result.facialTransformationMatrixes[0].data` (column-major 4x4). Provide `decodeHeadPose(matrix) -> {pitchDeg, yawDeg, rollDeg, tz}` using standard rotation-matrix-to-Euler extraction; `tz` is the Z translation (proxy for distance to camera).

Hand self-touch needs a second model (MediaPipe HandLandmarker). It is **optional**: if it fails to load or costs too much frame budget, set `hand: null` everywhere and exclude it from scoring (§4). System must run on the other five.

---

## 3. Per-frame behavior detectors (6 categories)
`frameDetectors.js` exports `detectFrame(result, handResult|null, tsMs, baseline, state) -> FrameRecord`. Each detector returns boolean. All numeric cutoffs come from `wedarConfig` and are applied **relative to the per-learner baseline** where a baseline exists (§7); the raw constant is the fallback before calibration.

**FrameRecord shape:**
```
{ t:Number, eyebrow:Bool, blink:Bool, mumble:Bool, hand:Bool|null, body:Bool, neutral:Bool,
  // raw scalars kept for the overlay + threshold tuning:
  raw:{ browInnerUp, browDown, eyeBlinkL, eyeBlinkR, jawOpen, jawStdev,
        smileL, smileR, pitchDeg, yawDeg, faceScale, handOnFace } }
```

**1. eyebrow** — cognitive effort / "wanting to know more"
- `browUp = bs(r,'browInnerUp')`
- `browDown = min(bs(r,'browDownLeft'), bs(r,'browDownRight'))`
- TRUE if `browUp > T.BROW_UP` OR `browDown > T.BROW_DOWN`
- Baseline-relative: subtract resting brow values; compare delta to `«tune»` deltas.

**2. blink** — flurry or prolonged only (a normal blink is NOT a regulator signal)
- Eye closed this frame if `min(eyeBlinkLeft, eyeBlinkRight) > T.BLINK`.
- Rising edge (was open, now closed) pushes `tsMs` into a blink-event queue; drop events older than `T.FLURRY_WINDOW_MS`.
- `blinkFlurry = queue.length >= T.FLURRY_COUNT`
- `prolongedBlink = (continuous closed duration) > T.PROLONGED_BLINK_MS`
- behavior = `blinkFlurry || prolongedBlink`

**3. mumble** — semi-spontaneous sub-vocalization (noisiest; weight low)
- Maintain rolling buffer of `jawOpen` over last `T.MUMBLE_WIN_MS` (~1000ms).
- `jawStdev = stdev(buffer)`
- TRUE if `jawStdev > T.MUMBLE_JAW_STDEV` AND `max(smileL,smileR) < T.SMILE_EXCLUDE` AND `jawOpen` mean < `«tune»` (exclude wide-open yawns/talking).

**4. hand** — self-touch / refocus (needs HandLandmarker)
- Compute face bbox from face landmarks (min/max x,y, padded by `«tune»` 15%).
- TRUE if any hand landmark lies inside padded bbox continuously ≥ `T.HAND_ON_FACE_MS`.
- If no hand model → `null`.

**5. body** — postural shift / lean-forward (active engagement)
- `faceScale` = bbox diagonal in normalized units; baseline captured in §7.
- `leanForward = (faceScale - baseline.faceScale)/baseline.faceScale > T.LEAN_SCALE_DELTA`
- `posturalShift` = |pitch−baseline.pitch| or |yaw−baseline.yaw| exceeds `T.POSTURE_ANGLE_DELTA_DEG` within `«tune»` 1000ms then re-stabilizes.
- behavior = `leanForward || posturalShift`

**6. neutral** — none of the five above true this frame (hand `null` counts as not-true).

Detectors must be pure given (result, state); keep all temporal state (queues, rolling buffers) in `state` owned by `wedar.js` so detectors stay testable.

---

## 4. 8-second sliding-window aggregation (CRITICAL — single biggest finding)
Per-frame verdicts are unreliable: the source paper's attention-state accuracy was ~58% at a 2s window vs ~89% at 8s. **Never emit a per-frame attention verdict.**

`windowAggregator.js`:
- Maintains ring buffer of FrameRecords.
- Window = `T.WINDOW_MS` (8000), recompute every `T.WINDOW_STEP_MS` (1000) → one verdict/sec, each reflecting 8s.
- Downsample to `T.TARGET_FPS` (8) before counting (30fps is redundant; subsample by timestamp).
- For each behavior, `rate = framesActive / framesInWindow`.
- `regulationDensity = 1 - neutralRate`.
- Discard window verdict if `framesInWindow < T.MIN_FRAMES_FOR_WINDOW` (`«tune»` e.g. 0.5*expected) → emit `state:"unknown"` (camera lost, face missing — see §12).

**WindowFeature shape:**
```
{ windowEnd:Number, framesInWindow:Number,
  rates:{ eyebrow, blink, mumble, hand, body, neutral },
  regulationDensity:Number, handAvailable:Bool }
```

---

## 5. Fusion → 3-state
`fusion.js` consumes `WindowFeature` + windowed IntelliEye gaze.
- `gazeOnScreen` = fraction of frames in the same window IntelliEye judged attentive.

Raw classification (before hysteresis §6):
```
if (gazeOnScreen >= T.GAZE_ENGAGED)                  raw = "engaged"
else if (regulationDensity >= T.REG_THRESHOLD)        raw = "drifting_but_regulating"
else                                                  raw = "disengaged"
```
**Rationale (keep as code comment):** gaze-off-screen + active regulation behaviors (eyebrow, lean-forward, self-touch) = a learner thinking/struggling, not gone. The WEDAR layer exists precisely to rescue this case from a false "disengaged." This is the integrity-as-support framing, not proctoring.

`handAvailable=false` must not penalize: when hand is null, `regulationDensity` is computed over the available 5 behaviors (renormalize neutralRate accordingly).

---

## 6. Hysteresis + smoothing (prevents state flicker)
A new verdict every second will chatter without damping.
- Apply an N-of-M rule: a state change commits only if the new raw state holds for `T.STATE_CONFIRM` (`«tune»` 3) of the last `T.STATE_WINDOW` (`«tune»` 4) windows. Otherwise keep prior committed state.
- Track `dwellMs` per committed state.
- Emit a `committedState` plus the instantaneous `raw` (overlay shows both).

EmittedRecord:
```
{ windowEnd, committedState, rawState, dwellMs,
  gazeOnScreen, regulationDensity, rates:{...}, handAvailable }
```

---

## 7. Per-learner baseline + adaptive thresholds
Subject-independent accuracy was far weaker than subject-dependent, so personalize.

`baseline.js`:
- Hook the existing 9-point calibration completion. Immediately after, run a **5–10s neutral capture**: show "Look at the screen normally and read this line" while recording frames.
- Store medians (robust to outliers): `faceScale, pitchDeg, yawDeg, browInnerUp, browDown, eyeBlink (resting closed-fraction), jawOpen, restingBlinkRatePerMin`.
- Persist in memory for the session. Optional: persist to backend keyed by learner id so calibration isn't repeated every video (only if consent covers it — §14).
- Adaptive thresholds: where a detector supports baseline-relative mode, threshold = baseline + `delta`, with `delta` from config. Eyebrow/blink/body use baseline-relative; mumble/hand use absolute (no stable resting baseline).
- If calibration is skipped/declined, fall back to absolute constants and set `baseline.isDefault=true` (log it; accuracy will be lower).

---

## 8. Logging (extend existing, never replace)
`wedarLogger.js`:
- Keep all existing IntelliEye event logging untouched.
- Emit **one EmittedRecord per second** through the existing transport. Batch (e.g. flush every `«tune»` 10s or 10 records) to limit requests.
- **Only the derived record leaves the device.** No frames, no landmarks, no raw scalars in production (raw scalars stay client-side for the overlay only; gate them behind `DEBUG`).
- Attach `videoId`, `videoTimestampMs` (position in the lecture), `sessionId`, `learnerId`.

**Backend record (per second):**
```json
{ "sessionId":"...", "learnerId":"...", "videoId":"...",
  "videoTimestampMs":123000, "wallClock":169...,
  "committedState":"drifting_but_regulating",
  "rawState":"disengaged", "dwellMs":4000,
  "gazeOnScreen":0.42, "regulationDensity":0.31,
  "rates":{"eyebrow":0.12,"blink":0.05,"mumble":0.0,"hand":0.08,"body":0.18,"neutral":0.69},
  "handAvailable":true, "baselineDefault":false }
```

**Aggregation (analytics, separate job):** group by `videoId, videoTimestampMs` across learners. If `disengaged` share at a timestamp exceeds `«tune»` (e.g. 40% of the cohort), flag the *content segment*, not the learners. This is the LEE/CVG-validation use case: it tells you when low engagement is a video problem vs. a learner problem. Per-learner: roll EmittedRecords into a session attention profile (%time in each state, longest disengaged run) and expose it as a *data-quality weight* on that session's LEE/CVG, never as a disciplinary flag.

---

## 9. Debug overlay (dev-only) — Step 2.5
`debugOverlay.js`, mounted only when `wedarConfig.DEBUG === true`. A fixed-position panel (top-right, semi-transparent, `pointer-events:none`) over the video. It is the fastest way to tune thresholds by eye.

Show, updating every frame / window:
1. **Live face thumbnail** (the existing video element is fine) with drawn face bbox + hand landmarks if present.
2. **Per-frame booleans** as 6 colored pills (eyebrow/blink/mumble/hand/body/neutral): green=true, grey=false, hollow=null/unavailable.
3. **Raw scalars** as live numbers + tiny sparklines: browInnerUp, browDown, eyeBlink min, jawOpen, jawStdev, pitchDeg, yawDeg, faceScale, plus the active blink-queue count and current prolonged-closed ms.
4. **Threshold markers** on each sparkline at the current config value so you can see how far a signal sits from firing.
5. **Window panel:** the 6 rates as horizontal bars, `regulationDensity`, `gazeOnScreen`, `framesInWindow`.
6. **State panel:** big `committedState`, smaller `rawState`, `dwellMs`, and the N-of-M confirm buffer as a row of dots.
7. **Baseline panel:** captured baseline medians + whether `isDefault`.
8. **FPS + frame-budget meter** (§13 perf): processing ms/frame, dropped frames.
9. **Hotkeys:** `D` toggle overlay, `B` re-run baseline capture, `L` dump last 60s of FrameRecords to console as JSON (for offline threshold analysis), `P` fire a probe manually (§10).

Keep the overlay self-contained (no app CSS dependency) so it can ship disabled and never affect production layout.

---

## 10. Self-labeling re-engagement probe (optional, dual purpose)
Borrowed from WEDAR's blur-stimulus + reaction-time mechanism. Serves two jobs: (a) cheap ground-truth labels to tune your thresholds, (b) a gentle re-engagement nudge.

`probe.js`:
- At a random point within `«tune»` each 60–120s of playback (and never during the first/last 5s), show a small unobtrusive prompt overlaid on the video — e.g. a soft dimming of the frame with a single "Tap to continue" target, or a 1-question micro-check.
- Log **reaction time** from prompt-shown to dismissed. Slow RT (> `«tune»` 2500ms) ≈ learner had drifted → label the preceding 8s window `distracted`; fast RT ≈ `attentive`.
- These labels are the y-values for tuning §11 thresholds and (later) for training a small classifier to replace the hand-tuned fusion rule.
- Make probe frequency configurable and **off by default in exam/assessment contexts** (intrusive); on by default only in self-paced video if product agrees.
- Respect reduced-motion / accessibility: no flashing, dismissible by keyboard.

---

## 11. Config — single source of truth (`wedarConfig.js`)
```js
export const wedarConfig = {
  DEBUG: false,

  // detectors (absolute fallbacks; baseline-relative deltas used when calibrated)
  BROW_UP: 0.40, BROW_DOWN: 0.30,            // «tune»
  BLINK: 0.50, FLURRY_COUNT: 3, FLURRY_WINDOW_MS: 3000, PROLONGED_BLINK_MS: 400,
  MUMBLE_WIN_MS: 1000, MUMBLE_JAW_STDEV: 0.05, SMILE_EXCLUDE: 0.30, // «tune»
  HAND_ON_FACE_MS: 500, FACE_BBOX_PAD: 0.15, // «tune»
  LEAN_SCALE_DELTA: 0.08, POSTURE_ANGLE_DELTA_DEG: 10, POSTURE_WIN_MS: 1000, // «tune»

  // baseline-relative deltas
  BROW_UP_DELTA: 0.15, BROW_DOWN_DELTA: 0.15, // «tune»

  // windowing
  WINDOW_MS: 8000, WINDOW_STEP_MS: 1000, TARGET_FPS: 8,
  MIN_FRAMES_FOR_WINDOW: 32,                  // «tune» ~0.5 * (8s*8fps)

  // fusion
  GAZE_ENGAGED: 0.60, REG_THRESHOLD: 0.15,    // «tune»

  // hysteresis
  STATE_CONFIRM: 3, STATE_WINDOW: 4,          // «tune»

  // logging
  FLUSH_EVERY_MS: 10000, FLUSH_EVERY_N: 10,

  // probe
  PROBE_ENABLED: false, PROBE_MIN_GAP_MS: 60000, PROBE_MAX_GAP_MS: 120000,
  PROBE_SLOW_RT_MS: 2500,                      // «tune»
};
```
Every `«tune»` value is a starting guess by the spec author, **not** from the WEDAR paper. The paper provides the behavior categories and the 8s-window finding only.

---

## 12. Edge cases & failure handling (must implement)
- **No face / camera lost:** FrameRecord = all null; window with `framesInWindow < MIN` → `state:"unknown"`; do not log engaged/disengaged. Reuse existing IntelliEye `face_not_detected` handling; WEDAR just emits `unknown`.
- **Multiple faces:** out of scope for behavior (numFaces:1); defer to existing IntelliEye multi-face logic; WEDAR emits `unknown` for those windows.
- **Glasses / lighting / dark room:** blendshapes get noisy. If `result` confidence low or blink/eyebrow signals saturate implausibly, mark a per-frame `lowQuality` flag; windows above `«tune»` lowQuality fraction → `unknown`. Surface lowQuality rate in the overlay.
- **Hand model absent or slow:** `hand:null`, renormalize (§5). Never block.
- **Tab hidden / video paused:** suspend windowing (no verdicts while not watching); reuse existing Page Visibility hook. Resume cleanly (clear stale ring buffer on resume gap > WINDOW_MS).
- **Frame budget exceeded:** if processing ms/frame trends above `«tune»` budget, auto-drop to a lower TARGET_FPS and/or skip the hand model; log degradation.
- **Calibration declined:** absolute thresholds, `baselineDefault:true`.

---

## 13. Performance budget
- Target ≤ `«tune»` 8–10 ms added processing per frame on a mid laptop; the existing FaceLandmarker inference dominates, WEDAR detectors are cheap arithmetic.
- Do detector math on the same frame result already produced for gaze — **do not run a second FaceLandmarker pass.**
- Hand model is the only real cost; load lazily, run at reduced cadence (e.g. every other frame) if needed.
- Ring buffers fixed-size; no per-frame allocation in hot path (reuse objects).

---

## 14. Privacy / consent (gate before any camera use)
- Explicit opt-in before camera starts; plain-language explanation that the camera analyzes attention **on-device** and that **no video or images are sent or stored**.
- Provide a working **camera-off fallback**: the tracker must still function on behavioral signals only (tab visibility, playback, probe RT) with WEDAR disabled. Attention then = a coarser signal, clearly marked lower-confidence.
- Persisting baseline to backend (per §7) requires the consent text to cover storing derived facial metrics; if not covered, keep baseline in-memory only.
- Output is a **data-quality weight / support signal**, never a disciplinary or proctoring flag. Keep this sentence in the module header.

---

## 15. Acceptance tests (definition of done)
1. With DEBUG on, each of the 6 pills can be made to fire deliberately on camera (raise brows, blink rapidly, mouth words, touch face, lean in, sit still) and the corresponding raw scalar crosses its marker.
2. Per-frame verdicts are never logged; only per-second EmittedRecords reach the transport (verify in network tab).
3. Covering the camera yields `unknown`, not `disengaged`.
4. Gaze-off-screen + sustained eyebrow/lean/hand yields `drifting_but_regulating`, not `disengaged` (script this: look away from screen while squinting + leaning in).
5. State does not flicker faster than the hysteresis allows (no >1 commit change per `STATE_WINDOW` seconds under steady behavior).
6. Hand model disabled → system still produces all states; `handAvailable:false` in records; no penalty (compare regulationDensity math).
7. Skipping calibration sets `baselineDefault:true` and still runs.
8. Backend receives the exact §8 schema; cohort aggregation flags a synthetic segment where >40% are disengaged.
9. Frame-budget meter stays under target on the reference machine; degradation path triggers correctly when throttled.
10. Camera-off fallback path runs with WEDAR disabled and the rest of the tracker intact.

---

## 16. Scope caveat (keep verbatim in `wedar.js` header)
WEDAR measures *behavioral proxies* for attention, not cognition. A learner can look engaged and absorb nothing, or look away while thinking — these signals reduce but do not eliminate that ambiguity. Source for the construct and the 8-second-window finding: Lee, Chen, Zhao, Specht, "WEDAR" (ICMI 2022, CC-BY). All numeric thresholds in this build are engineering starting points, not paper values, and must be tuned against real learners using the §10 probe labels.
