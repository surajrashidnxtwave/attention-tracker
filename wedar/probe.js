// Optional self-labeling re-engagement probe (spec §10).
// Dual purpose: (a) cheap ground-truth labels to tune thresholds, (b) gentle re-engagement
// nudge. OFF by default (config.PROBE_ENABLED). OFF in exam/assessment contexts. Respects
// reduced-motion: no flashing, dismissible by keyboard.

export function createProbe(config, opts) {
  // opts: { container (positioned el over video), getPlaybackMs, onLabel(label, rtMs, atMs) }
  const C = config;
  let timer = null, shownAt = 0, el = null, active = false;

  function scheduleNext() {
    clearTimeout(timer);
    if (!C.PROBE_ENABLED) return;
    const gap = C.PROBE_MIN_GAP_MS + Math.random() * (C.PROBE_MAX_GAP_MS - C.PROBE_MIN_GAP_MS);
    timer = setTimeout(fire, gap);
  }

  function fire() {
    // never during first/last 5s handled by caller via getPlaybackMs guard if desired
    show();
  }

  function show() {
    if (active) return;
    active = true; shownAt = performance.now();
    el = document.createElement('div');
    Object.assign(el.style, {
      position: 'absolute', inset: '0', display: 'flex', alignItems: 'center',
      justifyContent: 'center', background: 'rgba(11,13,17,.55)', zIndex: 50,
      borderRadius: '8px', cursor: 'pointer',
    });
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', 'Tap or press Enter to continue');
    el.innerHTML = `<div style="padding:14px 22px;border-radius:10px;background:#2563eb;color:#fff;font:600 14px system-ui">Tap to continue</div>`;
    const dismiss = () => done();
    el.addEventListener('click', dismiss);
    el.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); dismiss(); } });
    opts.container.appendChild(el);
    el.focus();
  }

  function done() {
    if (!active) return;
    const rt = performance.now() - shownAt;
    const label = rt > C.PROBE_SLOW_RT_MS ? 'distracted' : 'attentive';
    if (el) el.remove(); el = null; active = false;
    try { opts.onLabel(label, rt, opts.getPlaybackMs()); } catch {}
    scheduleNext();
  }

  function fireManual() { if (C.PROBE_ENABLED || true) show(); } // 'P' hotkey forces one

  function start() { scheduleNext(); }
  function stop() { clearTimeout(timer); if (el) { el.remove(); el = null; } active = false; }

  return { start, stop, fireManual };
}
