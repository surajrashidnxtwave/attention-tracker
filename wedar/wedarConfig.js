// WEDAR config — single source of truth (spec §11).
// Every «tune» value is an engineering starting guess, NOT from the WEDAR paper.
// The paper provides the 6 behavior categories and the 8s-window finding only.
export const wedarConfig = {
  DEBUG: false,

  // detectors (absolute fallbacks; baseline-relative deltas used when calibrated)
  BROW_UP: 0.40, BROW_DOWN: 0.30,                                   // «tune»
  BLINK: 0.50, FLURRY_COUNT: 3, FLURRY_WINDOW_MS: 3000, PROLONGED_BLINK_MS: 400,
  MUMBLE_WIN_MS: 1000, MUMBLE_JAW_STDEV: 0.05, SMILE_EXCLUDE: 0.30, // «tune»
  MUMBLE_JAW_MEAN_MAX: 0.35,                                        // «tune» exclude yawns/talking
  HAND_ON_FACE_MS: 500, FACE_BBOX_PAD: 0.15,                        // «tune»
  LEAN_SCALE_DELTA: 0.08, POSTURE_ANGLE_DELTA_DEG: 10, POSTURE_WIN_MS: 1000, // «tune»

  // baseline-relative deltas
  BROW_UP_DELTA: 0.15, BROW_DOWN_DELTA: 0.15,                       // «tune»

  // windowing
  WINDOW_MS: 8000, WINDOW_STEP_MS: 1000, TARGET_FPS: 8,
  MIN_FRAMES_FOR_WINDOW: 32,                                        // «tune» ~0.5*(8s*8fps)

  // quality
  LOW_QUALITY_WINDOW_FRAC: 0.5,                                     // «tune» windows above this → unknown

  // fusion
  GAZE_ENGAGED: 0.60, REG_THRESHOLD: 0.15,                         // «tune»

  // hysteresis
  STATE_CONFIRM: 3, STATE_WINDOW: 4,                               // «tune»

  // logging (client-only by default; set POST_URL to enable network transport)
  FLUSH_EVERY_MS: 10000, FLUSH_EVERY_N: 10,
  POST_URL: null,

  // baseline capture
  BASELINE_CAPTURE_MS: 7000,

  // hand model
  HAND_ENABLED: true, HAND_CADENCE: 2,                            // run hand every Nth frame

  // probe
  PROBE_ENABLED: false, PROBE_MIN_GAP_MS: 60000, PROBE_MAX_GAP_MS: 120000,
  PROBE_SLOW_RT_MS: 2500,                                          // «tune»

  // performance
  FRAME_BUDGET_MS: 10,                                            // «tune» degrade above this
};
