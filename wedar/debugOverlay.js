// Dev-only debug overlay (spec §9). Mounted only when config.DEBUG === true.
// Self-contained inline styles (no app CSS dependency) so it can ship disabled and never
// affect production layout. Fastest way to tune thresholds by eye.

export function createOverlay(config) {
  let el = null, visible = false;
  const C = config;

  function mount() {
    if (el) return;
    el = document.createElement('div');
    el.id = 'wedarDebug';
    Object.assign(el.style, {
      position: 'fixed', top: '8px', right: '8px', width: '320px', zIndex: 100000,
      background: 'rgba(10,12,16,.88)', color: '#e6e9ef', font: '11px/1.4 ui-monospace,Consolas,monospace',
      border: '1px solid #2a2f3a', borderRadius: '8px', padding: '8px', pointerEvents: 'none',
      maxHeight: '96vh', overflow: 'hidden', whiteSpace: 'pre-wrap',
    });
    document.body.appendChild(el);
    visible = true;
  }

  function pill(label, v) {
    const c = v === true ? '#36d399' : v === null ? 'transparent' : '#3a4150';
    const br = v === null ? '#5a6172' : c;
    return `<span style="display:inline-block;margin:1px 3px 1px 0;padding:1px 6px;border-radius:8px;background:${c};border:1px solid ${br};color:#0b0d11;font-weight:700">${label}</span>`;
  }
  const bar = (label, v) => {
    const w = Math.round((v || 0) * 100);
    return `${label.padEnd(8)} <span style="display:inline-block;width:120px;height:8px;background:#1b1f27;border-radius:4px;vertical-align:middle"><span style="display:inline-block;width:${w}%;height:8px;background:#2563eb;border-radius:4px"></span></span> ${(v||0).toFixed(2)}`;
  };
  const dots = (buf, n) => Array.from({ length: n }, (_, i) =>
    `<span style="color:${buf[i] ? '#36d399' : '#3a4150'}">●</span>`).join('');

  function update(p) {
    if (!config.DEBUG || !el || !visible) return;
    const r = p.frame?.raw || {};
    const f = p.frame || {};
    const w = p.window || {};
    const e = p.emitted || {};
    const b = p.baseline;
    const stateColor = { engaged: '#36d399', drifting_but_regulating: '#fbbd23',
      disengaged: '#f87272', unknown: '#9aa3b2' }[e.committedState] || '#9aa3b2';

    el.innerHTML =
`<b>WEDAR debug</b>  (D hide · B baseline · L dump · P probe)
── per-frame ──────────────
${pill('brow', f.eyebrow)}${pill('blink', f.blink)}${pill('mumble', f.mumble)}${pill('hand', f.hand)}${pill('body', f.body)}${pill('neutral', f.neutral)}
browUp ${r.browInnerUp?.toFixed(2)}  browDn ${r.browDown?.toFixed(2)}  blinkMin ${Math.min(r.eyeBlinkL||0,r.eyeBlinkR||0).toFixed(2)}
jawOpen ${r.jawOpen?.toFixed(2)}  jawStd ${r.jawStdev?.toFixed(3)} (T ${C.MUMBLE_JAW_STDEV})
pitch ${r.pitchDeg?.toFixed(1)}  yaw ${r.yawDeg?.toFixed(1)}  faceScale ${r.faceScale?.toFixed(3)}
blinkQ ${r.blinkQueue} (flurry≥${C.FLURRY_COUNT})  closedMs ${Math.round(r.prolongedMs||0)} (T ${C.PROLONGED_BLINK_MS})  lowQ ${f.lowQuality?'Y':'n'}
── window (${w.framesInWindow||0} fr${w.unknown?', '+w.reason:''}) ──
${w.unknown ? '(unknown — no verdict)' :
`${bar('eyebrow', w.rates?.eyebrow)}
${bar('blink', w.rates?.blink)}
${bar('mumble', w.rates?.mumble)}
${bar('hand', w.rates?.hand)}
${bar('body', w.rates?.body)}
${bar('neutral', w.rates?.neutral)}
regDensity ${w.regulationDensity?.toFixed(2)} (T ${C.REG_THRESHOLD})  gazeOn ${w.gazeOnScreen?.toFixed(2)} (T ${C.GAZE_ENGAGED})  hand ${w.handAvailable?'on':'off'}`}
── state ──────────────────
<b style="color:${stateColor};font-size:13px">${e.committedState||'—'}</b>  raw:${e.rawState||'—'}  dwell ${Math.round((e.dwellMs||0)/100)/10}s
confirm ${dots(buildConfirm(e), C.STATE_WINDOW)}  (need ${C.STATE_CONFIRM}/${C.STATE_WINDOW})
── baseline ───────────────
${b && !b.isDefault ? `faceScale ${b.data.faceScale.toFixed(3)} pitch ${b.data.pitchDeg.toFixed(1)} yaw ${b.data.yawDeg.toFixed(1)} brow ${b.data.browInnerUp.toFixed(2)} blinkRate ${b.data.restingBlinkRatePerMin.toFixed(1)}/min` : '(default — not calibrated)'}
── perf ───────────────────
proc ${p.perf?.ms?.toFixed(1)}ms/frame  fps ${p.perf?.fps?.toFixed(0)}  dropped ${p.perf?.dropped||0}`;
  }

  // map confirm buffer (recent raw states) to booleans matching current committed state
  function buildConfirm(e) {
    if (!e.confirmBuf) return [];
    return e.confirmBuf.map(s => s === e.committedState);
  }

  function toggle() {
    if (!config.DEBUG) return;
    if (!el) { mount(); return; }
    visible = !visible;
    el.style.display = visible ? 'block' : 'none';
  }

  function destroy() { if (el) { el.remove(); el = null; visible = false; } }

  return { mount, update, toggle, destroy };
}
