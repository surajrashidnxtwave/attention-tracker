// WEDAR logging (spec §8) — extends, never replaces, existing IntelliEye logging.
// One EmittedRecord per second. ONLY the derived record leaves the device — no frames,
// no landmarks, no raw scalars in production (raw stays client-side for the overlay, §9).
// Client-only by default: records buffered in-memory + CSV/JSON export. If config.POST_URL
// is set, batches are also POSTed to that endpoint.

export function createLogger(config, context) {
  const C = config;
  const all = [];            // every EmittedRecord this session (client-side)
  let pending = [];          // not-yet-flushed batch
  let lastFlush = 0;

  // context() -> { sessionId, learnerId, videoId, videoTimestampMs }
  function record(emitted) {
    const ctx = context();
    const rec = {
      sessionId: ctx.sessionId, learnerId: ctx.learnerId, videoId: ctx.videoId,
      videoTimestampMs: ctx.videoTimestampMs, wallClock: Date.now(),
      committedState: emitted.committedState, rawState: emitted.rawState,
      dwellMs: emitted.dwellMs, gazeOnScreen: emitted.gazeOnScreen,
      regulationDensity: emitted.regulationDensity, rates: emitted.rates,
      handAvailable: emitted.handAvailable, baselineDefault: ctx.baselineDefault,
    };
    all.push(rec); pending.push(rec);
    maybeFlush(emitted.windowEnd);
    return rec;
  }

  function maybeFlush(tsMs) {
    if (!lastFlush) lastFlush = tsMs;
    if (pending.length >= C.FLUSH_EVERY_N || tsMs - lastFlush >= C.FLUSH_EVERY_MS) flush();
  }

  function flush() {
    if (!pending.length) return;
    const batch = pending; pending = []; lastFlush = performance.now();
    if (C.POST_URL) {
      fetch(C.POST_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch), keepalive: true,
      }).catch(() => { /* network optional; records retained client-side */ });
    }
  }

  function exportJSON() {
    return new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' });
  }
  function exportCSV() {
    const head = ['wallClock', 'videoTimestampMs', 'committedState', 'rawState', 'dwellMs',
      'gazeOnScreen', 'regulationDensity', 'eyebrow', 'blink', 'mumble', 'hand', 'body',
      'neutral', 'handAvailable', 'baselineDefault'];
    const rows = all.map(r => [r.wallClock, r.videoTimestampMs, r.committedState, r.rawState,
      r.dwellMs, fmt(r.gazeOnScreen), fmt(r.regulationDensity),
      fmt(r.rates?.eyebrow), fmt(r.rates?.blink), fmt(r.rates?.mumble), fmt(r.rates?.hand),
      fmt(r.rates?.body), fmt(r.rates?.neutral), r.handAvailable, r.baselineDefault]);
    return new Blob([[head, ...rows].map(r => r.join(',')).join('\n')], { type: 'text/csv' });
  }
  const fmt = v => (v == null ? '' : (+v).toFixed(3));

  function reset() { all.length = 0; pending.length = 0; lastFlush = 0; }

  return { record, flush, exportJSON, exportCSV, reset, get all() { return all; } };
}
