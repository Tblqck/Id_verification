import { FaceLandmarker, FilesetResolver } from '/liveness/vision_bundle.mjs';

// --- DOM ---
const video        = document.getElementById('vid');
const overlay      = document.getElementById('overlay');
const ctx          = overlay.getContext('2d');
const toast        = document.getElementById('toast');
const instrEl      = document.getElementById('instr');
const listEl       = document.getElementById('challenge-list');
const progEl       = document.getElementById('progress');
const cdEl         = document.getElementById('countdown');
const scrim        = document.getElementById('model-loading');
const previewBlock = document.getElementById('preview-block');
const previewImg   = document.getElementById('preview');
const previewScore = document.getElementById('preview-score');
const previewStrip = document.getElementById('preview-strip');
const previewLog   = document.getElementById('preview-log');
const restartBtn   = document.getElementById('restart-btn');
const pillBright   = document.getElementById('pill-bright');
const pillEven     = document.getElementById('pill-even');
const doneLayer    = document.getElementById('done-layer');

// Guard: must have captured an ID before reaching liveness
(function () {
  try {
    const raw  = window.sessionStorage.getItem('kyc-flow-v2');
    const sess = raw ? JSON.parse(raw) : {};
    if (!sess.idFrame) window.location.href = 'index.html';
  } catch (_) {}
}());

const CHALLENGES = [
  { type: 'turn_left',  label: 'Turn head left'  },
  { type: 'turn_right', label: 'Turn head right' },
];

const STAGES = {
  ALIGN:    'align',
  LIVENESS: 'liveness',
  COMPLETE: 'complete',
};

const ALIGN_HOLD_MS = 1000;
const CENTER_CAPTURE_YAW = 6;

const CAPTURE_TYPES = {
  ALIGN_REFERENCE: 'align_reference',
  BETWEEN_CHALLENGES: 'between_challenges',
  POST_CHALLENGES: 'post_challenges',
  TASK: 'task',
};

// Oval geometry (normalized): matches existing overlay
const OVAL = { cx: 0.5, cy: 0.42, rx: 0.26, ry: 0.34 };

const FACE_OUTLINE = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323,
  361, 288, 397, 365, 379, 378, 400, 377, 152, 148,
  176, 149, 150, 136, 172, 58, 132, 93, 234, 127,
  162, 21, 54, 103, 67, 109, 10,
];

const s = {
  model:         null,
  stream:        null,
  raf:           null,
  challenges:    [],
  idx:           0,
  holdFrames:    0,
  stage:         STAGES.ALIGN,
  alignStart:    null,
  captureFrame:  null,
  captureMeta:   null,
  captureFrames: [],
  pendingCaptures: [],
  lastLight: null,
  motion:        { minYaw: Infinity, maxYaw: -Infinity },
  countdownTimer: null,
  countdownActive: false,
  emitted:        false,
};

init();

async function init() {
  restartBtn.addEventListener('click', restart);

  try {
    await loadModel();
    scrim.classList.add('hidden');
    await startCamera();
  } catch (err) {
    scrim.classList.add('hidden');
    msg('Cannot load model or camera. Check permissions and refresh.', 'Camera error.');
    console.error(err);
  }
}

// ── Model ───────────────────────────────────────────────────────────────────

async function loadModel() {
  const resolver = await FilesetResolver.forVisionTasks('/liveness');
  s.model = await FaceLandmarker.createFromOptions(resolver, {
    baseOptions: {
      modelAssetPath: '/liveness/face_landmarker.task',
      delegate: 'CPU',
    },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
  });
}

// ── Camera ──────────────────────────────────────────────────────────────────

async function startCamera() {
  stopCamera();
  resetState();
  buildChallengeList();

  previewBlock.hidden = true;
  previewImg.removeAttribute('src');
  previewScore.textContent = '';
  if (previewStrip) previewStrip.innerHTML = '';
  if (previewLog) previewLog.innerHTML = '';
  instrEl.textContent = 'Center your face to lock the reference photo.';
  toast.textContent = 'Center your face - we will capture automatically.';

  s.stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });

  video.srcObject = s.stream;
  await video.play();
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas, { passive: true });
  loop();
}

function stopCamera() {
  s.stream?.getTracks().forEach(track => track.stop());
  s.stream = null;
  cancelAnimationFrame(s.raf);
  clearInterval(s.countdownTimer);
  s.countdownTimer  = null;
  s.countdownActive = false;
  cdEl.classList.remove('show');
}

function resizeCanvas() {
  overlay.width  = video.videoWidth  || overlay.clientWidth;
  overlay.height = video.videoHeight || overlay.clientHeight;
}

// ── Main loop ───────────────────────────────────────────────────────────────

function loop() {
  if (!s.model || video.readyState < 2) {
    s.raf = requestAnimationFrame(loop);
    return;
  }

  const now     = performance.now();
  const result  = s.model.detectForVideo(video, now);
  const face    = result?.faceLandmarks?.[0];

  ctx.clearRect(0, 0, overlay.width, overlay.height);

  if (!face) {
    drawOval();
    pillOff();
    msg('No face detected. Remove masks and face the camera.', 'No face detected.');
    cancelCountdown();
    s.alignStart = null;
    s.raf = requestAnimationFrame(loop);
    return;
  }

  if (!faceInOval(face)) {
    drawOval();
    drawFaceOutline(face);
    pillOff();
    msg('Move closer and center inside the oval.', 'Center your face.');
    cancelCountdown();
    s.alignStart = null;
    s.raf = requestAnimationFrame(loop);
    return;
  }

  const light = measureFaceLighting(face);
  s.lastLight = light;

  updatePills(light);

  if (light.shouldBlock) {
    drawOval();
    drawFaceOutline(face);
    msg(light.hint, light.hint);
    cancelCountdown();
    s.alignStart = null;
    s.raf = requestAnimationFrame(loop);
    return;
  }

  drawOval();
  drawFaceOutline(face);

  if (light.uneven && s.stage === STAGES.ALIGN) {
    toast.textContent = 'Face the light evenly if you can.';
  }

  if (s.stage === STAGES.ALIGN) {
    handleAlignment(light, now);
  } else if (s.stage === STAGES.LIVENESS) {
    runChallenges(face);
  }

  s.raf = requestAnimationFrame(loop);
}

// ── Alignment stage ─────────────────────────────────────────────────────────

function handleAlignment(light, now) {
  if (s.alignStart === null) {
    s.alignStart = now;
  }

  const elapsed   = (now - s.alignStart) / 1000;
  const remaining = Math.max(0, ALIGN_HOLD_MS / 1000 - elapsed);

  msg('Hold steady - locking your reference photo.', remaining > 0 ? `Hold steady ${remaining.toFixed(1)}s` : 'Capturing reference...');
  toast.textContent = 'Hold steady - do not move.';
  cdEl.textContent  = remaining > 0 ? remaining.toFixed(1) : '0';
  cdEl.classList.add('show');

  if (elapsed >= ALIGN_HOLD_MS / 1000) {
    lockReferenceFrame(light);
  }
}

function lockReferenceFrame(light) {
  const capture = storeCapture(CAPTURE_TYPES.ALIGN_REFERENCE, light, { label: 'Reference locked' });
  s.captureFrame = capture.data;
  s.captureMeta = {
    captured_at:   capture.captured_at,
    lighting_score: light.score,
    brightness_avg: light.avgLum,
    reference_count: s.captureFrames.length,
  };

  cdEl.classList.remove('show');

  msg('Reference photo captured. Follow the prompts in real time.', 'Reference captured - stay in frame.');
  s.stage      = STAGES.LIVENESS;
  s.alignStart = null;
}

// ── Challenges ───────────────────────────────────────────────────────────────

function runChallenges(landmarks) {
  const current = s.challenges[s.idx];
  const yaw     = computeYaw(landmarks);

  attemptPendingCapture(landmarks, yaw);

  if (Number.isFinite(yaw)) {
    s.motion.minYaw = Math.min(s.motion.minYaw, yaw);
    s.motion.maxYaw = Math.max(s.motion.maxYaw, yaw);
  }

  if (!current) {
    msg('Hold still - streaming completion to the server.', 'Hold still - capturing log.');
    if (!s.countdownActive) beginCountdown();
    return;
  }

  msg(current.label, current.label);

  const passed = current.type === 'turn_left' ? yaw > 16 : yaw < -16;

  if (passed) {
    if (++s.holdFrames >= 3) {
      completeChallenge(yaw);
    }
  } else {
    s.holdFrames = 0;
  }
}

function completeChallenge(yaw) {
  const finished = s.challenges[s.idx];
  finished.status = 'done';
  captureTaskFrame(finished, yaw);
  s.idx += 1;
  s.holdFrames = 0;
  updateChallengeUI();

  if (s.idx < s.challenges.length) {
    const next = s.challenges[s.idx];
    scheduleCenterCapture(CAPTURE_TYPES.BETWEEN_CHALLENGES, {
      after: finished.type,
      before: next.type,
      toast: 'Centered frame saved - continue with the next prompt.',
    });
  } else {
    scheduleCenterCapture(CAPTURE_TYPES.POST_CHALLENGES, {
      after: finished.type,
      toast: 'Final centered frame saved.',
    });
  }
}

function captureTaskFrame(challenge, yaw) {
  const safeYaw = Number.isFinite(yaw) ? yaw : null;
  const type = `${CAPTURE_TYPES.TASK}_${challenge.type}`;
  storeCapture(type, s.lastLight, {
    label: `Task – ${formatPromptKey(challenge.type)}`,
    yaw: safeYaw,
    challenge: challenge.type,
  });
}

function scheduleCenterCapture(type, meta = {}) {
  s.pendingCaptures.push({ type, meta });
}

function attemptPendingCapture(landmarks, yaw) {
  if (!s.pendingCaptures.length) return;
  const pending = s.pendingCaptures[0];
  const centeredYaw = Math.abs(yaw ?? computeYaw(landmarks));
  if (!Number.isFinite(centeredYaw) || centeredYaw > CENTER_CAPTURE_YAW) {
    return;
  }
  if (!faceInOval(landmarks)) return;
  if (!s.lastLight || s.lastLight.shouldBlock) return;

  const capture = storeCapture(pending.type, s.lastLight, {
    ...pending.meta,
    yaw: centeredYaw,
  });
  const toastMsg = pending.meta?.toast || `${capture.label || 'Frame'} saved.`;
  toast.textContent = toastMsg;
  s.pendingCaptures.shift();
}

// ── Countdown & completion ───────────────────────────────────────────────────

function beginCountdown() {
  s.countdownActive = true;
  let value = 2;
  cdEl.textContent = value;
  cdEl.classList.add('show');
  s.countdownTimer = setInterval(() => {
    value -= 1;
    if (value <= 0) {
      cancelCountdown();
      finalize();
    } else {
      cdEl.textContent = value;
    }
  }, 900);
}

function cancelCountdown() {
  clearInterval(s.countdownTimer);
  s.countdownTimer  = null;
  s.countdownActive = false;
  cdEl.classList.remove('show');
}

function finalize() {
  stopCamera();
  s.stage = STAGES.COMPLETE;
  if (!s.captureFrame) {
    if (previewImg.src) {
      s.captureFrame = previewImg.src;
    } else if (video.videoWidth) {
      s.captureFrame = snapFrame();
    }
  }
  msg('Liveness confirmed - submitting automatically.', 'Liveness complete.');
  previewScore.textContent = 'Liveness prompts complete · submitting...';
  emit();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function snapFrame() {
  const canvas = document.createElement('canvas');
  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;
  const cctx = canvas.getContext('2d');
  drawMirroredVideoFrame(video, cctx, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.92);
}

function storeCapture(type, light, meta = {}) {
  const dataUri = snapFrame();
  const capture = {
    type,
    label: captureLabel(type, meta),
    data: dataUri,
    captured_at: new Date().toISOString(),
    lighting_score: light?.score ?? null,
    brightness_avg: light?.avgLum ?? null,
    yaw: typeof meta.yaw === 'number' ? meta.yaw : null,
    challenge: meta.challenge || null,
  };
  s.captureFrames.push(capture);
  if (!s.captureFrame) {
    s.captureFrame = dataUri;
  }
  if (s.captureMeta) {
    s.captureMeta.reference_count = s.captureFrames.length;
  }
  updatePreviewGallery();
  return capture;
}

function updatePreviewGallery() {
  if (!previewBlock) return;
  if (!s.captureFrames.length) {
    previewBlock.hidden = true;
    previewImg?.removeAttribute('src');
    if (previewStrip) previewStrip.innerHTML = '';
    if (previewLog) previewLog.innerHTML = '';
    if (previewScore) previewScore.textContent = '';
    return;
  }

  previewBlock.hidden = false;
  const latest = s.captureFrames[s.captureFrames.length - 1];
  if (previewImg) {
    previewImg.src = latest.data;
  }
  if (previewScore) {
    if (s.captureFrames.length === 1 && latest.lighting_score != null) {
      previewScore.textContent = `Reference locked · lighting ${Math.round(latest.lighting_score * 100)}%`;
    } else {
      previewScore.textContent = `${s.captureFrames.length} frames captured · Latest: ${latest.label}`;
    }
  }

  if (previewStrip) {
    previewStrip.innerHTML = '';
    s.captureFrames.forEach((capture, idx) => {
      const img = document.createElement('img');
      img.src = capture.data;
      img.alt = capture.label || `Capture ${idx + 1}`;
      img.title = capture.label || `Capture ${idx + 1}`;
      previewStrip.appendChild(img);
    });
  }

  if (previewLog) {
    previewLog.innerHTML = '';
    s.captureFrames.forEach((capture, idx) => {
      const li = document.createElement('li');
      const lightText = capture.lighting_score != null
        ? ` · light ${(capture.lighting_score * 100).toFixed(0)}%`
        : '';
      li.textContent = `#${idx + 1} ${capture.label || capture.type}${lightText}`;
      previewLog.appendChild(li);
    });
  }
}

function captureLabel(type, meta = {}) {
  if (meta.label) return meta.label;
  if (type === CAPTURE_TYPES.ALIGN_REFERENCE) {
    return 'Reference locked';
  }
  if (type === CAPTURE_TYPES.BETWEEN_CHALLENGES) {
    if (meta.after && meta.before) {
      return `Between ${formatPromptKey(meta.after)} → ${formatPromptKey(meta.before)}`;
    }
    return 'Between prompts';
  }
  if (type === CAPTURE_TYPES.POST_CHALLENGES) {
    return 'Completion hold';
  }
  if (typeof type === 'string' && type.startsWith(`${CAPTURE_TYPES.TASK}_`)) {
    const prompt = type.slice(CAPTURE_TYPES.TASK.length + 1);
    return `Task – ${formatPromptKey(prompt)}`;
  }
  return type;
}

function formatPromptKey(key) {
  if (typeof key !== 'string') return '';
  return key
    .split('_')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function drawOval() {
  ctx.clearRect(0, 0, overlay.width, overlay.height);
}

function drawFaceOutline(landmarks) {
  if (!landmarks || !landmarks.length) return;
  const w = overlay.width || video.videoWidth || 0;
  const h = overlay.height || video.videoHeight || 0;
  if (!w || !h) return;
  const pts = FACE_OUTLINE
    .map(i => landmarks[i])
    .filter(Boolean)
    .map(l => ({ x: l.x * w, y: l.y * h }));
  if (pts.length < 3) return;

  ctx.save();
  ctx.strokeStyle = 'rgba(94,255,208,0.95)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    ctx.lineTo(pts[i].x, pts[i].y);
  }
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

function drawMirroredVideoFrame(srcVideo, targetCtx, width, height) {
  if (!width || !height) return;
  targetCtx.save();
  targetCtx.scale(-1, 1);
  targetCtx.drawImage(srcVideo, -width, 0, width, height);
  targetCtx.restore();
}

function faceInOval(landmarks) {
  return [4, 33, 263, 61, 291].every(i => {
    const dx = (landmarks[i].x - OVAL.cx) / OVAL.rx;
    const dy = (landmarks[i].y - OVAL.cy) / OVAL.ry;
    return dx * dx + dy * dy <= 1;
  });
}

function updatePills(light) {
  if (light) {
    pillBright.classList.toggle('ok',   !light.tooDark && !light.tooBright);
    pillBright.classList.toggle('warn', light.tooDark || light.tooBright);
    pillEven.classList.toggle('ok',     !light.uneven);
    pillEven.classList.toggle('warn',    light.uneven);
  } else {
    pillBright.classList.remove('ok', 'warn');
    pillEven.classList.remove('ok', 'warn');
  }
}

function pillOff() {
  [pillBright, pillEven].forEach(pill => pill?.classList.remove('ok', 'warn'));
}

function msg(instrText, toastText) {
  instrEl.textContent = instrText;
  toast.textContent   = toastText || instrText;
}

function buildChallengeList() {
  listEl.innerHTML = '';
  s.challenges.forEach((ch, idx) => {
    const div = document.createElement('div');
    div.id = `ch-${idx}`;
    div.className = 'challenge-item' + (idx === 0 ? ' active' : '');
    div.textContent = ch.label;
    listEl.appendChild(div);
  });
  updateChallengeUI();
}

function updateChallengeUI() {
  const done = s.challenges.filter(c => c.status === 'done').length;
  progEl.style.width = `${(done / s.challenges.length) * 100}%`;
  s.challenges.forEach((ch, idx) => {
    const el = document.getElementById(`ch-${idx}`);
    if (!el) return;
    el.classList.toggle('done', ch.status === 'done');
    el.classList.toggle('active', idx === s.idx && ch.status !== 'done');
  });
}

function resetState() {
  s.challenges      = CHALLENGES.map(ch => ({ ...ch, status: 'pending' }));
  s.idx             = 0;
  s.holdFrames      = 0;
  s.stage           = STAGES.ALIGN;
  s.alignStart      = null;
  s.captureFrame    = null;
  s.captureFrames   = [];
  s.captureMeta     = null;
  s.pendingCaptures = [];
  s.lastLight = null;
  s.motion          = { minYaw: Infinity, maxYaw: -Infinity };
  s.countdownTimer  = null;
  s.countdownActive = false;
  s.emitted         = false;
  cdEl.classList.remove('show');
  pillOff();
}

function restart() {
  startCamera().catch(console.error);
}

// ── Metrics helpers ─────────────────────────────────────────────────────────

function getFaceBounds(landmarks) {
  const cw = overlay.width  || video.videoWidth  || 640;
  const ch = overlay.height || video.videoHeight || 360;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const l of landmarks) {
    const x = l.x * cw;
    const y = l.y * ch;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  minX = Math.max(0, Math.floor(minX));
  maxX = Math.min(cw - 1, Math.ceil(maxX));
  minY = Math.max(0, Math.floor(minY));
  maxY = Math.min(ch - 1, Math.ceil(maxY));
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY, cw, ch };
}

function measureFaceLighting(landmarks) {
  const bounds = getFaceBounds(landmarks);
  const faceW  = bounds.width;
  const faceH  = bounds.height;

  if (faceW < 20 || faceH < 20) {
    return {
      ok: false,
      shouldBlock: true,
      hint: 'Move closer.',
      score: 0,
      tooDark: false,
      tooBright: false,
      uneven: false,
      avgLum: 0,
      topAvg: 0,
      bottomAvg: 0,
      bounds,
    };
  }

  const off = document.createElement('canvas');
  off.width  = Math.max(1, Math.round(faceW * 0.25));
  off.height = Math.max(1, Math.round(faceH * 0.25));

  off.getContext('2d').drawImage(
    video,
    bounds.minX,
    bounds.minY,
    faceW,
    faceH,
    0,
    0,
    off.width,
    off.height
  );

  const data     = off.getContext('2d').getImageData(0, 0, off.width, off.height).data;
  const total    = off.width * off.height;
  const halfX    = off.width / 2;
  const topCut   = off.height * 0.3;
  const bottomCut = off.height * 0.7;

  let sumL = 0, sumR = 0, cntL = 0, cntR = 0;
  let sumTop = 0, cntTop = 0, sumBottom = 0, cntBottom = 0;

  for (let i = 0; i < total; i++) {
    const lum = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    const col = i % off.width;
    const row = Math.floor(i / off.width);

    if (col < halfX) { sumL += lum; cntL++; }
    else             { sumR += lum; cntR++; }

    if (row < topCut) {
      sumTop += lum;
      cntTop++;
    } else if (row > bottomCut) {
      sumBottom += lum;
      cntBottom++;
    }
  }

  const avgL   = cntL ? sumL / cntL : 0;
  const avgR   = cntR ? sumR / cntR : 0;
  const avg    = (sumL + sumR) / Math.max(1, (cntL + cntR));
  const asymm  = Math.abs(avgL - avgR) / (avg + 1);
  const topAvg = cntTop ? sumTop / cntTop : avg;
  const bottomAvg = cntBottom ? sumBottom / cntBottom : avg;

  const tooDark   = avg < 55;
  const tooBright = avg > 215;
  const uneven    = asymm > 0.35;

  const hint =
    tooDark   ? 'Too dark - face a light source.' :
    tooBright ? 'Too bright - reduce direct light.' :
                'Lighting looks good.';

  const shouldBlock = tooDark || tooBright;
  const centerness = 1 - Math.abs(avg - 130) / 130;
  const evenness   = 1 - Math.min(asymm, 1);
  const score      = Math.max(0, centerness * 0.6 + evenness * 0.4);

  return { ok: !shouldBlock, shouldBlock, hint, score, tooDark, tooBright, uneven, avgLum: avg, topAvg, bottomAvg, bounds };
}

function computeYaw(landmarks) {
  const le  = landmarks[33].x;
  const re  = landmarks[263].x;
  const w   = Math.abs(re - le) + 1e-3;
  const mid = (le + re) / 2;
  return ((landmarks[4].x - mid) / w) * 90;
}

// ── Output ───────────────────────────────────────────────────────────────────

function readSession() {
  try {
    const raw = window.sessionStorage.getItem('kyc-flow-v2');
    return raw ? JSON.parse(raw) : {};
  } catch (_) { return {}; }
}

function showDone() {
  if (doneLayer) {
    doneLayer.classList.remove('hidden');
  }
}

function emit() {
  if (s.emitted) return;
  s.emitted = true;

  if (!s.captureFrame) {
    if (previewImg.src) {
      s.captureFrame = previewImg.src;
    } else if (video.videoWidth) {
      s.captureFrame = snapFrame();
    }
  }

  const motion = {
    yaw_left:  Number.isFinite(s.motion.maxYaw) ? s.motion.maxYaw : null,
    yaw_right: Number.isFinite(s.motion.minYaw) ? s.motion.minYaw : null,
  };
  motion.yaw_range = motion.yaw_left !== null && motion.yaw_right !== null
    ? motion.yaw_left - motion.yaw_right
    : null;

  const faceFrames = s.captureFrames.map(c => c.data).filter(Boolean);
  if (!faceFrames.length && s.captureFrame) {
    faceFrames.push(s.captureFrame);
  }

  const sess = readSession();

  const payload = {
    mode:            'id+liveness',
    country:         sess.country  || null,
    doc_type:        sess.docType  || null,
    id_frame:        sess.idFrame  || null,
    id_frame_back:   sess.idFrameBack || null,
    id_quality:      sess.idMeta   || null,
    id_quality_back: sess.idMetaBack || null,
    face_frame:      faceFrames[0] || s.captureFrame || null,
    face_frames:     faceFrames,
    capture_pack:    s.captureFrames.map(capture => ({
      type:           capture.type,
      label:          capture.label,
      captured_at:    capture.captured_at,
      lighting_score: capture.lighting_score,
      brightness_avg: capture.brightness_avg,
      yaw:            capture.yaw,
      challenge:      capture.challenge,
    })),
    captured_at:    s.captureMeta?.captured_at || s.captureFrames[0]?.captured_at || new Date().toISOString(),
    lighting_score: s.captureMeta?.lighting_score ?? s.captureFrames[0]?.lighting_score ?? null,
    challenges:     s.challenges.map(ch => ({ type: ch.type, label: ch.label, status: ch.status })),
    motion,
    device: {
      userAgent: navigator.userAgent,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  };

  if (!payload.face_frame && video.videoWidth) {
    payload.face_frame = snapFrame();
    if (!payload.face_frames.length) {
      payload.face_frames.push(payload.face_frame);
    }
  }

  window.dispatchEvent(new CustomEvent('liveness:captured', { detail: payload }));

  if (window.LIVENESS_ENDPOINT) {
    fetch(window.LIVENESS_ENDPOINT, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    })
      .then(() => showDone())
      .catch(err => { console.error(err); showDone(); });
  } else {
    showDone();
  }
}
