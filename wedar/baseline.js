// Per-learner neutral baseline capture (spec §7).
// Hook the 9-point calibration completion → 5–10s neutral capture → store medians.
// Robust to outliers (median). In-memory for the session (backend persist gated by consent §14).

const median = arr => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function createBaseline(config) {
  let capturing = false;
  let buf = [];                 // {faceScale,pitchDeg,yawDeg,browInnerUp,browDown,eyeBlink,jawOpen,blinkEdge}
  let startTs = 0;
  let data = null;              // computed medians
  let isDefault = true;         // true until a real capture succeeds

  return {
    get isDefault() { return isDefault; },
    get capturing() { return capturing; },
    get data() { return data; },

    // begin neutral capture; wedar pushes scalars each frame while capturing
    begin(tsMs) {
      capturing = true; buf = []; startTs = tsMs;
    },

    // called per frame by wedar while capturing
    push(scalars) {
      if (capturing) buf.push(scalars);
    },

    // returns true when capture window elapsed (wedar polls)
    shouldEnd(tsMs) {
      return capturing && (tsMs - startTs) >= config.BASELINE_CAPTURE_MS;
    },

    end() {
      capturing = false;
      if (buf.length < 5) { isDefault = true; return null; }
      const durMin = Math.max(1e-3, (buf[buf.length - 1].t - buf[0].t) / 60000);
      const blinkEdges = buf.reduce((a, f) => a + (f.blinkEdge ? 1 : 0), 0);
      data = {
        faceScale: median(buf.map(f => f.faceScale)),
        pitchDeg: median(buf.map(f => f.pitchDeg)),
        yawDeg: median(buf.map(f => f.yawDeg)),
        browInnerUp: median(buf.map(f => f.browInnerUp)),
        browDown: median(buf.map(f => f.browDown)),
        eyeBlink: median(buf.map(f => f.eyeBlink)),        // resting closed fraction
        jawOpen: median(buf.map(f => f.jawOpen)),
        restingBlinkRatePerMin: blinkEdges / durMin,
      };
      isDefault = false;
      buf = [];
      return data;
    },

    reset() { capturing = false; buf = []; data = null; isDefault = true; },
  };
}
