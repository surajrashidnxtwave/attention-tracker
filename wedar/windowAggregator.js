// 8-second sliding-window aggregation (spec §4) — single biggest finding.
// Per-frame verdicts are unreliable (~58% @2s vs ~89% @8s). NEVER emit a per-frame verdict.
// Recompute every WINDOW_STEP_MS → one verdict/sec, each reflecting WINDOW_MS of behavior.

export function createAggregator(config) {
  const C = config;
  const ring = [];            // FrameRecords, time-ordered
  const cap = Math.ceil((C.WINDOW_MS / 1000) * 60) + 16; // generous (up to ~60fps) + slack

  function push(rec) {
    ring.push(rec);
    while (ring.length > cap) ring.shift();
    // also bound by time
    const cutoff = rec.t - C.WINDOW_MS - 1000;
    while (ring.length && ring[0].t < cutoff) ring.shift();
  }

  // downsample to TARGET_FPS by timestamp bucket, then count
  function compute(windowEnd) {
    const start = windowEnd - C.WINDOW_MS;
    const inWin = ring.filter(r => r.t > start && r.t <= windowEnd);
    const bucketMs = 1000 / C.TARGET_FPS;
    const byBucket = new Map();
    for (const r of inWin) {
      const k = Math.floor((r.t - start) / bucketMs);
      if (!byBucket.has(k)) byBucket.set(k, r); // first in bucket
    }
    const frames = [...byBucket.values()];
    const n = frames.length;

    if (n < C.MIN_FRAMES_FOR_WINDOW) {
      return { windowEnd, framesInWindow: n, unknown: true, reason: 'too_few_frames' };
    }
    const lowQ = frames.filter(f => f.lowQuality).length / n;
    if (lowQ > C.LOW_QUALITY_WINDOW_FRAC) {
      return { windowEnd, framesInWindow: n, unknown: true, reason: 'low_quality', lowQualityRate: lowQ };
    }
    const validFrames = frames.filter(f => f.valid);
    if (validFrames.length < C.MIN_FRAMES_FOR_WINDOW) {
      return { windowEnd, framesInWindow: validFrames.length, unknown: true, reason: 'face_missing' };
    }

    const handAvailable = validFrames.some(f => f.hand !== null);
    const rate = key => validFrames.filter(f => f[key] === true).length / validFrames.length;

    const rates = {
      eyebrow: rate('eyebrow'),
      blink: rate('blink'),
      mumble: rate('mumble'),
      hand: handAvailable ? rate('hand') : 0,
      body: rate('body'),
      neutral: validFrames.filter(f => f.neutral).length / validFrames.length,
    };
    // regulationDensity over available behaviors (hand excluded when unavailable → neutral already accounts)
    const regulationDensity = 1 - rates.neutral;
    const gazeOnScreen = validFrames.filter(f => f._gaze === true).length / validFrames.length;

    return {
      windowEnd, framesInWindow: validFrames.length, unknown: false,
      rates, regulationDensity, gazeOnScreen, handAvailable,
      lowQualityRate: lowQ,
    };
  }

  function clear() { ring.length = 0; }

  return { push, compute, clear, get size() { return ring.length; } };
}
