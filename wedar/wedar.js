// WEDAR orchestrator (spec §1). Subscribes to the existing frame loop, owns ALL temporal
// state, drives the window timer. Nothing else holds state.
//
// SCOPE CAVEAT (spec §16, keep verbatim): WEDAR measures *behavioral proxies* for attention,
// not cognition. A learner can look engaged and absorb nothing, or look away while thinking —
// these signals reduce but do not eliminate that ambiguity. Source for the construct and the
// 8-second-window finding: Lee, Chen, Zhao, Specht, "WEDAR" (ICMI 2022, CC-BY). All numeric
// thresholds here are engineering starting points, not paper values, and must be tuned against
// real learners using the §10 probe labels. Output is a data-quality / support signal, never a
// disciplinary or proctoring flag.

import { wedarConfig } from './wedarConfig.js';
import { createBaseline } from './baseline.js';
import { detectFrame, faceMetrics, bs } from './frameDetectors.js';
import { createAggregator } from './windowAggregator.js';
import { createFusion } from './fusion.js';
import { createLogger } from './wedarLogger.js';
import { createOverlay } from './debugOverlay.js';
import { createProbe } from './probe.js';

// column-major 4x4 → Euler (deg) + tz (distance proxy)
function decodeHeadPose(m) {
  if (!m || !m.data) return null;
  const d = m.data, R = (r, c) => d[c * 4 + r];
  const sy = Math.hypot(R(0, 0), R(1, 0));
  const deg = x => x * 180 / Math.PI;
  return {
    pitchDeg: deg(Math.atan2(R(2, 1), R(2, 2))),
    yawDeg: deg(Math.atan2(-R(2, 0), sy)),
    rollDeg: deg(Math.atan2(R(1, 0), R(0, 0))),
    tz: d[14],
  };
}

export function createWedar({ config = wedarConfig, video, onEmit, context, probeContainer }) {
  const C = config;
  const baseline = createBaseline(C);
  const aggregator = createAggregator(C);
  const fusion = createFusion(C);
  const logger = createLogger(C, () => {
    const ctx = (context && context()) || {};
    return {
      sessionId: ctx.sessionId || 'local', learnerId: ctx.learnerId || 'local',
      videoId: ctx.videoId || (video?.currentSrc || 'video'),
      videoTimestampMs: Math.round((video?.currentTime || 0) * 1000),
      baselineDefault: baseline.isDefault,
    };
  });
  const overlay = createOverlay(C);
  const probe = createProbe(C, {
    container: probeContainer || document.body,
    getPlaybackMs: () => Math.round((video?.currentTime || 0) * 1000),
    onLabel: (label, rt, atMs) => { probeLabels.push({ label, rt, atMs, wall: Date.now() }); },
  });
  const probeLabels = [];

  // temporal state owned here (detectors stay pure)
  const state = {
    blink: { queue: [], closed: false, closedSince: 0 },
    jawBuf: [],
    hand: { insideSince: 0 },
    frameCount: 0,
  };

  let handLandmarker = null, lastHand = undefined, lastHandTs = 0, handThrottle = false;
  let lastWindowTs = 0, lastFrameTs = 0;
  let lastWindow = null, lastEmitted = null, lastFrame = null;
  let running = false, degraded = false;
  const perf = { ms: 0, fps: 0, dropped: 0, _last: 0 };
  const dumpRing = []; // last ~60s of FrameRecords for the 'L' hotkey

  function setHandLandmarker(hl) { handLandmarker = hl; }

  function captureNeutral() {
    baseline.begin(performance.now());
  }

  function onFrame(result, tsMs, { gazeAttentive } = {}) {
    if (!running) return;
    const t0 = performance.now();

    // resume-gap handling: stale buffer if we paused for > a window
    if (lastFrameTs && tsMs - lastFrameTs > C.WINDOW_MS) {
      aggregator.clear(); fusion.reset(); state.blink.queue = []; state.jawBuf = [];
    }
    lastFrameTs = tsMs;
    state.frameCount++;

    const hasFace = !!(result.faceLandmarks && result.faceLandmarks[0]);
    const fm = hasFace ? faceMetrics(result.faceLandmarks[0]) : { bbox: null, faceScale: 0 };
    const headPose = decodeHeadPose(result.facialTransformationMatrixes?.[0]);

    // hand at reduced cadence; undefined = model disabled, null = loaded but no hands
    let handResult = undefined;
    if (handLandmarker && C.HAND_ENABLED && !handThrottle) {
      if (state.frameCount % C.HAND_CADENCE === 0) {
        const hts = Math.max(tsMs, lastHandTs + 1); lastHandTs = hts;
        try { const hr = handLandmarker.detectForVideo(video, hts); lastHand = (hr.landmarks?.length ? hr : null); }
        catch { lastHand = null; }
      }
      handResult = lastHand;
    }

    const rec = detectFrame(result, handResult, tsMs, baseline, state, C, headPose, fm);
    rec._gaze = gazeAttentive === true;
    lastFrame = rec;

    // feed baseline capture
    if (baseline.capturing && rec.valid) {
      const closed = Math.min(rec.raw.eyeBlinkL, rec.raw.eyeBlinkR) > C.BLINK;
      baseline.push({
        t: tsMs, faceScale: rec.raw.faceScale, pitchDeg: rec.raw.pitchDeg, yawDeg: rec.raw.yawDeg,
        browInnerUp: rec.raw.browInnerUp, browDown: rec.raw.browDown,
        eyeBlink: Math.min(rec.raw.eyeBlinkL, rec.raw.eyeBlinkR), jawOpen: rec.raw.jawOpen,
        blinkEdge: rec.raw.blinkQueue > (state._prevBlinkQ || 0),
      });
      state._prevBlinkQ = rec.raw.blinkQueue;
      if (baseline.shouldEnd(tsMs)) {
        const d = baseline.end();
        if (d && onEmit) onEmit({ kind: 'baseline', baselineDefault: false, data: d });
      }
    }

    aggregator.push(rec);
    dumpRing.push(rec);
    while (dumpRing.length && tsMs - dumpRing[0].t > 60000) dumpRing.shift();

    // window step → verdict (suspend while paused)
    const watching = video && !video.paused && !document.hidden;
    if (watching && tsMs - lastWindowTs >= C.WINDOW_STEP_MS) {
      lastWindowTs = tsMs;
      const win = aggregator.compute(tsMs);
      lastWindow = win;
      const emitted = fusion.update(win);
      lastEmitted = emitted;
      logger.record(emitted);
      if (onEmit) onEmit({ kind: 'state', ...emitted });
    }

    // perf meter + degradation
    const ms = performance.now() - t0;
    perf.ms = perf.ms ? 0.9 * perf.ms + 0.1 * ms : ms;
    const dnow = performance.now();
    if (perf._last) perf.fps = 0.9 * perf.fps + 0.1 * (1000 / (dnow - perf._last));
    perf._last = dnow;
    if (perf.ms > C.FRAME_BUDGET_MS) { perf.dropped++; if (!degraded && perf.dropped > 30) degrade(); }

    overlay.update({ frame: lastFrame, window: lastWindow, emitted: lastEmitted,
      baseline: { isDefault: baseline.isDefault, data: baseline.data }, perf });
  }

  function degrade() {
    degraded = true; handThrottle = true; // drop the hand model first (its main cost)
    console.warn('[WEDAR] frame budget exceeded — disabling hand model');
  }

  function onKey(e) {
    if (e.key === 'd' || e.key === 'D') overlay.toggle();
    else if (e.key === 'b' || e.key === 'B') captureNeutral();
    else if (e.key === 'l' || e.key === 'L') console.log('[WEDAR] last 60s frames', JSON.stringify(dumpRing));
    else if (e.key === 'p' || e.key === 'P') probe.fireManual();
  }

  function start() {
    running = true;
    if (C.DEBUG) overlay.mount();
    probe.start();
    window.addEventListener('keydown', onKey);
  }
  function stop() {
    running = false; probe.stop(); logger.flush();
    window.removeEventListener('keydown', onKey);
    aggregator.clear(); fusion.reset();
    lastWindowTs = 0; lastFrameTs = 0; state.frameCount = 0;
    state.blink = { queue: [], closed: false, closedSince: 0 }; state.jawBuf = []; state.hand = { insideSince: 0 };
  }

  return {
    start, stop, onFrame, setHandLandmarker, captureNeutral,
    logger, baseline, overlay,
    get probeLabels() { return probeLabels; },
    get lastEmitted() { return lastEmitted; },
  };
}
