// 6 per-frame behavior detectors (spec §3).
// Pure given (result, handResult, state): all temporal state (queues, buffers) lives in `state`
// (owned by wedar.js) so detectors stay testable. Cutoffs are baseline-relative where a
// baseline exists, else absolute fallbacks from config.

export function bs(result, name) {
  const cats = result.faceBlendshapes?.[0]?.categories;
  if (!cats) return 0;
  const c = cats.find(c => c.categoryName === name);
  return c ? c.score : 0; // 0..1
}

// face bbox + scale (diagonal) from normalized landmarks
export function faceMetrics(lm) {
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const p of lm) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const dx = maxX - minX, dy = maxY - minY;
  return { bbox: { minX, minY, maxX, maxY }, faceScale: Math.hypot(dx, dy) };
}

function handInsideFace(handResult, bbox, pad) {
  const px = (bbox.maxX - bbox.minX) * pad, py = (bbox.maxY - bbox.minY) * pad;
  const x0 = bbox.minX - px, x1 = bbox.maxX + px, y0 = bbox.minY - py, y1 = bbox.maxY + py;
  const hands = handResult.landmarks || [];
  for (const hand of hands) {
    for (const p of hand) {
      if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) return true;
    }
  }
  return false;
}

function nullRecord(t) {
  return { t, valid: false, eyebrow: null, blink: null, mumble: null, hand: null,
    body: null, neutral: false, lowQuality: true, _gaze: undefined,
    raw: { browInnerUp: 0, browDown: 0, eyeBlinkL: 0, eyeBlinkR: 0, jawOpen: 0, jawStdev: 0,
      smileL: 0, smileR: 0, pitchDeg: 0, yawDeg: 0, faceScale: 0, handOnFace: 0,
      blinkQueue: 0, prolongedMs: 0 } };
}

// handResult: array-result | null (model loaded but no hands) | undefined (model disabled)
export function detectFrame(result, handResult, tsMs, baseline, state, config, headPose, fm) {
  const C = config;
  const hasFace = !!(result.faceLandmarks && result.faceLandmarks[0]) &&
    !!result.faceBlendshapes?.[0]?.categories;
  if (!hasFace) return nullRecord(tsMs);

  const browInnerUp = bs(result, 'browInnerUp');
  const browDown = Math.min(bs(result, 'browDownLeft'), bs(result, 'browDownRight'));
  const eyeBlinkL = bs(result, 'eyeBlinkLeft'), eyeBlinkR = bs(result, 'eyeBlinkRight');
  const jawOpen = bs(result, 'jawOpen');
  const smileL = bs(result, 'mouthSmileLeft'), smileR = bs(result, 'mouthSmileRight');
  const pitchDeg = headPose?.pitchDeg ?? 0, yawDeg = headPose?.yawDeg ?? 0;
  const faceScale = fm.faceScale;
  const b = baseline.data;

  // 1. eyebrow — cognitive effort / wanting to know more
  const eyebrow = b
    ? (browInnerUp - b.browInnerUp) > C.BROW_UP_DELTA || (browDown - b.browDown) > C.BROW_DOWN_DELTA
    : browInnerUp > C.BROW_UP || browDown > C.BROW_DOWN;

  // 2. blink — flurry or prolonged only (normal blink is NOT a regulator)
  const closed = Math.min(eyeBlinkL, eyeBlinkR) > C.BLINK;
  const bl = state.blink;
  if (closed && !bl.closed) { bl.queue.push(tsMs); bl.closedSince = tsMs; }
  if (!closed) bl.closedSince = 0;
  bl.closed = closed;
  while (bl.queue.length && tsMs - bl.queue[0] > C.FLURRY_WINDOW_MS) bl.queue.shift();
  const blinkFlurry = bl.queue.length >= C.FLURRY_COUNT;
  const prolongedMs = (closed && bl.closedSince) ? (tsMs - bl.closedSince) : 0;
  const blink = blinkFlurry || prolongedMs > C.PROLONGED_BLINK_MS;

  // 3. mumble — semi-spontaneous sub-vocalization (noisiest; weight low)
  const jb = state.jawBuf;
  jb.push({ t: tsMs, v: jawOpen });
  while (jb.length && tsMs - jb[0].t > C.MUMBLE_WIN_MS) jb.shift();
  const jv = jb.map(o => o.v);
  const jawMean = jv.reduce((a, c) => a + c, 0) / (jv.length || 1);
  const jawStdev = Math.sqrt(jv.reduce((a, c) => a + (c - jawMean) ** 2, 0) / (jv.length || 1));
  const mumble = jawStdev > C.MUMBLE_JAW_STDEV && Math.max(smileL, smileR) < C.SMILE_EXCLUDE
    && jawMean < C.MUMBLE_JAW_MEAN_MAX;

  // 4. hand — self-touch / refocus (needs HandLandmarker; null when unavailable)
  let hand = null, handOnFace = 0;
  if (handResult !== undefined) {
    if (handResult === null) { hand = null; state.hand.insideSince = 0; }
    else {
      const inside = handInsideFace(handResult, fm.bbox, C.FACE_BBOX_PAD);
      handOnFace = inside ? 1 : 0;
      const h = state.hand;
      if (inside) { if (!h.insideSince) h.insideSince = tsMs; }
      else h.insideSince = 0;
      hand = !!(h.insideSince && tsMs - h.insideSince >= C.HAND_ON_FACE_MS);
    }
  }

  // 5. body — postural shift / lean-forward (active engagement); baseline-relative
  let body = false;
  if (b) {
    const leanForward = (faceScale - b.faceScale) / (b.faceScale || 1e-3) > C.LEAN_SCALE_DELTA;
    const posturalShift = Math.abs(pitchDeg - b.pitchDeg) > C.POSTURE_ANGLE_DELTA_DEG ||
      Math.abs(yawDeg - b.yawDeg) > C.POSTURE_ANGLE_DELTA_DEG;
    body = leanForward || posturalShift;
  }

  // 6. neutral — none of the five true (hand===true required; null counts as not-true)
  const neutral = !eyebrow && !blink && !mumble && hand !== true && !body;

  // crude low-quality heuristic (§12): implausible saturation
  const lowQuality = eyeBlinkL > 0.97 && eyeBlinkR > 0.97 && browInnerUp > 0.85;

  return {
    t: tsMs, valid: true, eyebrow, blink, mumble, hand, body, neutral, lowQuality, _gaze: undefined,
    raw: { browInnerUp, browDown, eyeBlinkL, eyeBlinkR, jawOpen, jawStdev, smileL, smileR,
      pitchDeg, yawDeg, faceScale, handOnFace, blinkQueue: bl.queue.length, prolongedMs },
  };
}
