// Fusion → 3-state (spec §5) + hysteresis/smoothing (spec §6).
//
// Rationale (keep verbatim): gaze-off-screen + active regulation behaviors (eyebrow,
// lean-forward, self-touch) = a learner thinking/struggling, not gone. The WEDAR layer
// exists precisely to rescue this case from a false "disengaged." This is the
// integrity-as-support framing, not proctoring.

export function createFusion(config) {
  const C = config;
  const confirmBuf = [];        // recent raw states for N-of-M
  let committed = 'unknown';
  let committedSince = null;    // ts of last commit

  function rawClassify(win) {
    if (win.unknown) return 'unknown';
    if (win.gazeOnScreen >= C.GAZE_ENGAGED) return 'engaged';
    if (win.regulationDensity >= C.REG_THRESHOLD) return 'drifting_but_regulating';
    return 'disengaged';
  }

  // N-of-M: commit a change only if new raw state holds for STATE_CONFIRM of last STATE_WINDOW.
  function update(win) {
    const raw = rawClassify(win);
    const tsMs = win.windowEnd;

    confirmBuf.push(raw);
    while (confirmBuf.length > C.STATE_WINDOW) confirmBuf.shift();

    if (committedSince === null) { committed = raw; committedSince = tsMs; }
    else if (raw !== committed) {
      const count = confirmBuf.filter(s => s === raw).length;
      if (count >= C.STATE_CONFIRM) { committed = raw; committedSince = tsMs; }
    }
    const dwellMs = committedSince === null ? 0 : tsMs - committedSince;

    return {
      windowEnd: tsMs,
      committedState: committed,
      rawState: raw,
      dwellMs,
      gazeOnScreen: win.gazeOnScreen ?? null,
      regulationDensity: win.regulationDensity ?? null,
      rates: win.rates ?? null,
      handAvailable: win.handAvailable ?? false,
      confirmBuf: [...confirmBuf],
    };
  }

  function reset() { confirmBuf.length = 0; committed = 'unknown'; committedSince = null; }

  return { update, reset };
}
