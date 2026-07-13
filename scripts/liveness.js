import { dropFaceFrame } from './state.js';
import { FaceLandmarker, FilesetResolver } from '/liveness/vision_bundle.mjs';

const video        = document.getElementById('vid-face');
const overlay      = document.getElementById('overlay-face');
const ctx          = overlay.getContext('2d');
const toast        = document.getElementById('face-toast');
const instr        = document.getElementById('challenge-instr');
const list         = document.getElementById('challenge-list');
const progress     = document.getElementById('challenge-progress');
const countdownEl  = document.getElementById('countdown-face');
const previewBlock = document.getElementById('face-preview-block');
const previewImg   = document.getElementById('face-preview');
const previewStrip = document.getElementById('face-preview-strip');
const summaryList  = document.getElementById('challenge-summary');
const restartBtn   = document.getElementById('restart-btn');
const loadingLayer     = document.getElementById('model-loading');
const submittingLayer  = document.getElementById('submitting-layer');
const doneLayer        = document.getElementById('done-layer');

// Guard: must have captured ID before reaching liveness
(function () {
  try {
    const raw  = window.sessionStorage.getItem('kyc-flow-v2');
    const sess = raw ? JSON.parse(raw) : {};
    if (!sess.idFrame) window.location.href = 'index.html';
  } catch (_) {}
}());

const CHALLENGES = [
  { type: 'center',     label: 'Center your face'       },
  { type: 'turn_left',  label: 'Turn head left'         },
  { type: 'center',     label: 'Center your face again' },
  { type: 'turn_right', label: 'Turn head right'        },
];

const HOLD_MS  = 1400; // how long a pose must be held steady before we snap it
const PAUSE_MS = 1100; // breather after a capture before the next prompt goes live

const FACE_OUTLINE = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323,
  361, 288, 397, 365, 379, 378, 400, 377, 152, 148,
  176, 149, 150, 136, 172, 58, 132, 93, 234, 127,
  162, 21, 54, 103, 67, 109, 10,
];

const state = {
  model:          null,
  stream:         null,
  raf:            null,
  pauseTimer:     null,
  holdStart:      null,
  capturing:      false, // true during the post-capture breather, ignores pose checks
  challenges:     CHALLENGES.map(c => ({ ...c, status: 'pending' })),
  idx:            0,
  captureFrames:  [], // one frame per challenge
  emitted:        false,
};

buildChallengeList();
init();

async function init() {
  restartBtn.addEventListener('click', () => {
    dropFaceFrame();
    resetState();
    startCamera();
  });

  try {
    await loadModel();
    loadingLayer.classList.add('hidden');
    await startCamera();
  } catch (err) {
    console.error(err);
    toast.textContent = 'Cannot access camera or model. Refresh when permissions are granted.';
  }
}

async function loadModel() {
  const resolver = await FilesetResolver.forVisionTasks('/liveness');
  state.model = await FaceLandmarker.createFromOptions(resolver, {
    baseOptions: {
      modelAssetPath: '/liveness/face_landmarker.task',
      delegate: 'CPU',
    },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
  });
}

async function startCamera() {
  stopCamera();
  instr.textContent = 'Face your camera — detection starts automatically.';
  toast.textContent = 'Look straight at the camera.';

  state.stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });

  video.srcObject = state.stream;
  await video.play();
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas, { passive: true });
  loop();
}

function stopCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach(t => t.stop());
    state.stream = null;
  }
  cancelAnimationFrame(state.raf);
  clearTimeout(state.pauseTimer);
  state.pauseTimer = null;
}

function resizeCanvas() {
  overlay.width  = video.videoWidth  || overlay.clientWidth;
  overlay.height = video.videoHeight || overlay.clientHeight;
}

function loop() {
  if (!state.model || !video || video.readyState < 2) {
    state.raf = requestAnimationFrame(loop);
    return;
  }

  const result = state.model.detectForVideo(video, performance.now());
  ctx.clearRect(0, 0, overlay.width, overlay.height);

  const hasFace = result?.faceLandmarks?.length;
  if (hasFace) {
    const landmarks = result.faceLandmarks[0];
    const blend     = result.faceBlendshapes?.[0]?.categories || [];
    drawFaceOutline(landmarks);
    handleChallenges(landmarks, blend);
  } else {
    instr.textContent = 'Face not detected — ensure good lighting and remove masks.';
    toast.textContent = 'Face not detected.';
    cancelHold();
  }

  state.raf = requestAnimationFrame(loop);
}

function drawFaceOutline(landmarks) {
  if (!landmarks || !landmarks.length) return;
  const w = overlay.width  || video.videoWidth  || 0;
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
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

function handleChallenges(landmarks, blend) {
  if (state.capturing) return; // breather after a capture — ignore pose until it's over

  const current = state.challenges[state.idx];
  if (!current) return; // all done, waiting on the emit path

  const satisfied = checkChallenge(current.type, landmarks, blend);

  if (!satisfied) {
    cancelHold();
    instr.textContent = current.label;
    toast.textContent = current.label;
    return;
  }

  if (state.holdStart == null) state.holdStart = performance.now();
  const remainingMs = HOLD_MS - (performance.now() - state.holdStart);

  if (remainingMs <= 0) {
    cancelHold();
    completeChallenge(current);
    return;
  }

  const secs = Math.ceil(remainingMs / 1000);
  instr.textContent = current.label;
  toast.textContent = 'Hold still…';
  countdownEl.textContent = secs;
  countdownEl.classList.add('show');
}

function cancelHold() {
  state.holdStart = null;
  countdownEl.classList.remove('show');
}

function completeChallenge(current) {
  const frame = snapFrame();
  state.captureFrames.push({ type: current.type, label: formatLabel(current.type), data: frame, captured_at: new Date().toISOString() });
  addPreviewThumb(frame, formatLabel(current.type));

  state.challenges[state.idx].status = 'done';
  state.idx += 1;
  updateChallengeUI();

  toast.textContent = 'Captured ✓';
  instr.textContent  = state.idx < state.challenges.length
    ? 'Nice — get ready for the next prompt.'
    : 'All done — submitting…';

  // Brief breather so the next prompt isn't sprung on the user mid-motion.
  state.capturing = true;
  clearTimeout(state.pauseTimer);
  state.pauseTimer = setTimeout(() => {
    state.capturing = false;
    if (state.idx >= state.challenges.length) captureFinalAndEmit();
  }, PAUSE_MS);
}

function snapFrame() {
  const canvas = document.createElement('canvas');
  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;
  const cctx = canvas.getContext('2d');
  cctx.save();
  cctx.scale(-1, 1);
  cctx.drawImage(video, -canvas.width, 0, canvas.width, canvas.height);
  cctx.restore();
  return canvas.toDataURL('image/jpeg', 0.92);
}

function captureFinalAndEmit() {
  if (state.emitted) return;
  state.emitted = true;

  const finalFrame = state.captureFrames[state.captureFrames.length - 1]?.data;

  // Show preview
  previewImg.src = finalFrame;
  summaryList.innerHTML = '';
  state.challenges.forEach(ch => {
    const li = document.createElement('li');
    li.textContent = `${ch.label}: ${ch.status === 'done' ? '✔' : 'pending'}`;
    summaryList.appendChild(li);
  });
  previewBlock.hidden = false;

  stopCamera();
  if (submittingLayer) submittingLayer.classList.remove('hidden');

  emit();
}

function addPreviewThumb(dataUrl, label) {
  if (!previewStrip) return;
  const img = document.createElement('img');
  img.src   = dataUrl;
  img.alt   = label;
  img.title = label;
  previewStrip.appendChild(img);
}

function readSession() {
  try {
    const raw = window.sessionStorage.getItem('kyc-flow-v2');
    return raw ? JSON.parse(raw) : {};
  } catch (_) { return {}; }
}

async function emit() {
  const sess = readSession();

  const faceFrames = state.captureFrames.map(f => f.data).filter(Boolean);

  const payload = {
    mode:            'id+liveness',
    country:         sess.country      || null,
    doc_type:        sess.docType      || null,
    id_frame:        sess.idFrame      || null,
    id_frame_back:   sess.idFrameBack  || null,
    id_quality:      sess.idMeta       || null,
    id_quality_back: sess.idMetaBack   || null,
    face_frame:      faceFrames[0]     || null,
    face_frames:     faceFrames,
    capture_pack:    state.captureFrames.map(f => ({
      type:        f.type,
      label:       f.label,
      captured_at: f.captured_at,
    })),
    captured_at: state.captureFrames[0]?.captured_at || new Date().toISOString(),
    challenges:  state.challenges.map(ch => ({ type: ch.type, label: ch.label, status: ch.status })),
    device: {
      userAgent: navigator.userAgent,
      timezone:  Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  };

  window.dispatchEvent(new CustomEvent('liveness:captured', { detail: payload }));

  if (window.LIVENESS_ENDPOINT) {
    fetch(window.LIVENESS_ENDPOINT, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    }).catch(err => console.warn('save error (non-fatal):', err));
  }

  await sendToVerify(payload);
  showDone();
}

function showDone() {
  if (submittingLayer) submittingLayer.classList.add('hidden');
  if (doneLayer) doneLayer.classList.remove('hidden');
}

async function sendToVerify(payload) {
  const url = window.VERIFY_API_URL;
  if (!url) return null;

  try {
    const fd = new FormData();
    fd.append('country', normalizeCountry(payload.country));
    fd.append('doc_type', payload.doc_type || payload.docType || 'national_id');
    fd.append('mode', '3');
    fd.append('user_ref', (payload.device && payload.device.userAgent) || 'web');
    fd.append('issue_year', String((payload.id_quality || {}).issue_year || 2025));

    appendDataUri(fd, 'id_image', payload.id_frame, 'id_front.jpg');
    if (payload.id_frame_back) appendDataUri(fd, 'id_image_back', payload.id_frame_back, 'id_back.jpg');

    (payload.face_frames || []).slice(0, 5).forEach((uri, i) => {
      appendDataUri(fd, 'liveness_frames', uri, `frame_${i + 1}.jpg`);
    });

    // Generate Link's single-use token, if this session started from one —
    // readSession() reads the same sessionStorage blob state.js's
    // saveToken()/getToken() write to; this file bypasses state.js's own
    // helpers elsewhere too, so it reads the raw blob directly for consistency.
    const headers = {};
    const token = readSession().token;
    if (token) headers['X-Session-Token'] = token;

    const resp = await fetch(url, { method: 'POST', body: fd, headers });
    return await resp.json();
  } catch (err) {
    console.error('verify error', err);
    return null;
  }
}

function appendDataUri(fd, field, uri, filename) {
  const blob = dataUriToBlob(uri);
  if (blob) fd.append(field, blob, filename);
}

function dataUriToBlob(uri) {
  if (!uri || typeof uri !== 'string') return null;
  const parts = uri.split(',');
  if (parts.length < 2) return null;
  const mime = (parts[0].match(/data:(.*?);base64/) || [])[1] || 'image/jpeg';
  try {
    const bin = atob(parts[1]);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  } catch (_) {
    return null;
  }
}

function normalizeCountry(country) {
  if (typeof country === 'string') return country;
  if (country && typeof country === 'object') return country.code2 || country.code3 || country.name || '';
  return '';
}

function checkChallenge(type, landmarks, blend) {
  const yaw = computeYaw(landmarks);
  if (type === 'center')     return Math.abs(yaw) < 8;
  if (type === 'turn_left')  return yaw > 16;
  if (type === 'turn_right') return yaw < -16;
  return false;
}

function computeYaw(landmarks) {
  const le  = landmarks[33].x;
  const re  = landmarks[263].x;
  const w   = Math.abs(re - le) + 1e-3;
  const mid = (le + re) / 2;
  return ((landmarks[4].x - mid) / w) * 90;
}

function formatLabel(type) {
  return type.split('_').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

function buildChallengeList() {
  list.innerHTML = '';
  state.challenges.forEach((ch, idx) => {
    const div = document.createElement('div');
    div.className = 'challenge-item' + (idx === 0 ? ' active' : '');
    div.id        = `challenge-${idx}`;
    div.textContent = ch.label;
    list.appendChild(div);
  });
  updateChallengeUI();
}

function updateChallengeUI() {
  const done = state.challenges.filter(ch => ch.status === 'done').length;
  progress.style.width = `${(done / state.challenges.length) * 100}%`;
  state.challenges.forEach((ch, idx) => {
    const el = document.getElementById(`challenge-${idx}`);
    if (!el) return;
    el.classList.toggle('done',   ch.status === 'done');
    el.classList.toggle('active', idx === state.idx && ch.status !== 'done');
  });
}

function resetState() {
  cancelAnimationFrame(state.raf);
  clearTimeout(state.pauseTimer);
  state.pauseTimer     = null;
  state.holdStart      = null;
  state.capturing      = false;
  state.idx            = 0;
  state.challenges     = CHALLENGES.map(c => ({ ...c, status: 'pending' }));
  state.captureFrames  = [];
  state.emitted        = false;
  buildChallengeList();
  previewBlock.hidden = true;
  if (previewStrip) previewStrip.innerHTML = '';
  if (doneLayer) doneLayer.classList.add('hidden');
}
