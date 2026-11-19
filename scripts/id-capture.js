import { getState, saveIDFrame, saveIDFrameBack, dropIDFrame, saveSelection } from './state.js';

const countryFlag = window.countryFlag || (() => '');

const DOC_LABELS = {
  passport:         'Passport',
  national_id:      'National ID',
  drivers_license:  "Driver's License",
  residence_permit: 'Residence Permit',
};

const DOC_RATIO = {
  passport:         1.42,
  national_id:      1.585,
  drivers_license:  1.585,
  residence_permit: 1.585,
};

const DOC_NEEDS_BACK = ['national_id', 'drivers_license', 'residence_permit'];
function needsBack(docType) { return DOC_NEEDS_BACK.includes(docType); }

const GUIDE_FILL = 0.82; // guide square fills 82% of the frame width

// Cutoff detection tuning — captureFrame() crops exactly to the guide rect,
// so a document that overflows the guide gets literally cropped in the saved
// image. We sample a thin band just outside each guide edge; if that band
// looks like document (texture/brightness) rather than the flat dark
// background the tip instructs users to use, that side is overflowing.
const CUTOFF_BAND_FRAC       = 0.35; // fraction of the available margin used as the sample band
const CUTOFF_MIN_BAND_PX     = 3;
const CUTOFF_VARIANCE_THRESH = 180;  // luminance variance above this reads as "not flat background"

// Guide-square rect in *source pixel* coordinates (video or canvas natural size).
// Shared by quality measurement, the on-screen guide overlay, and the actual
// capture crop, so what the user sees lined up is exactly what gets saved.
function getGuideRect(sourceW, sourceH, ratio) {
  const cardW = sourceW * GUIDE_FILL;
  const cardH = cardW / ratio;
  return { x: (sourceW - cardW) / 2, y: (sourceH - cardH) / 2, width: cardW, height: cardH };
}

// ── Read selection from state ─────────────────────────────────────────────────
const stored = getState();
if (!stored.country || !stored.docType) {
  window.location.href = 'index.html';
}

const selectedCountry = stored.country;
const selectedDocType = stored.docType;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const backBtn        = document.getElementById('back-btn');
const badgeFlag      = document.getElementById('badge-flag');
const badgeLabel     = document.getElementById('badge-label');
const captureHeading = document.getElementById('capture-heading');
const captureSteps   = document.getElementById('capture-steps');
const stepFront      = document.getElementById('step-front');
const stepBack       = document.getElementById('step-back');
const frameBox       = document.getElementById('frame-id');
const cameraBlock    = document.getElementById('camera-block');
const qualityPanel   = document.getElementById('quality-panel');
const readyGate      = document.getElementById('ready-gate');
const readyTitle     = document.getElementById('ready-gate-title');
const readyHint      = document.getElementById('ready-gate-hint');
const readyBtn       = document.getElementById('ready-btn');
const readyUploadBtn = document.getElementById('ready-upload-btn');
let   video          = document.getElementById('vid-id');
const overlay        = document.getElementById('overlay-id');
const viewCanvas     = document.getElementById('view-id');
let   viewRaf        = null;
const ctx            = overlay.getContext('2d');
const toast          = document.getElementById('quality-toast');
const instr          = document.getElementById('quality-instr');
const progress       = document.getElementById('quality-progress');
const countdownEl    = document.getElementById('countdown-id');
const previewRow     = document.getElementById('preview-row');
const previewImg     = document.getElementById('id-preview');
const previewImgBack = document.getElementById('id-preview-back');
const backPreviewWrap = document.getElementById('back-preview-wrap');
const qualityList    = document.getElementById('quality-list');
const takeBtn        = document.getElementById('take-btn');
const continueBtn    = document.getElementById('continue-btn');
const retakeBtn      = document.getElementById('retake-btn');
const errorLayer     = document.getElementById('error-layer');
const errorText      = document.getElementById('error-text');
const pillFocus      = document.getElementById('pill-focus');
const pillLight      = document.getElementById('pill-light');
const pillGlare      = document.getElementById('pill-glare');
const pillAlign      = document.getElementById('pill-align');
const qualityChecks  = document.getElementById('quality-checks');
const uploadFront    = document.getElementById('upload-front');
const uploadBack     = document.getElementById('upload-back');
const uploadBackLabel = document.getElementById('upload-back-label');
const uploadHint     = document.getElementById('upload-hint');
const cropLayer      = document.getElementById('crop-layer');
const cropStage      = document.getElementById('crop-stage');
const cropImg        = document.getElementById('crop-img');
const cropZoom       = document.getElementById('crop-zoom');
const cropRotate     = document.getElementById('crop-rotate');
const cropRotateVal  = document.getElementById('crop-rotate-value');
const cropCancel     = document.getElementById('crop-cancel');
const cropConfirm    = document.getElementById('crop-confirm');

// Mobile gets a mandatory "I'm ready" tap before the camera opens and
// auto-capture starts trying — on a small screen there's no room to browse
// while quality checks are already firing, and the desktop layout (side by
// side, plenty of vertical space) doesn't have this problem, so it keeps
// auto-starting the camera like before.
const isMobile = window.matchMedia('(max-width: 640px)').matches;
const idPage   = document.querySelector('.id-page');

// ── Capture state ─────────────────────────────────────────────────────────────
let stream             = null;
let analyser           = null;
let countdownTimer     = null;
let countdownActive    = false;
let captured           = false;
let captureStep        = 'front';
let awaitingBackStart  = false; // front captured, waiting for the user to confirm they've flipped the document
let readyStreak        = 0; // consecutive analyser ticks with all 4 checks passing
let pendingReadySide   = null; // mobile only: 'front' | 'back' — which side the ready-gate tap should start

// Analyser runs every 140ms; require this many straight "ready" ticks before
// auto-firing the countdown, so a single lucky frame doesn't trigger capture.
const READY_HOLD_TICKS = 4;

// ── Boot ──────────────────────────────────────────────────────────────────────
badgeFlag.textContent  = countryFlag(selectedCountry.code2);
badgeLabel.textContent = DOC_LABELS[selectedDocType] || selectedDocType;
frameBox.classList.toggle('passport-mode', selectedDocType === 'passport');
captureSteps.hidden = !needsBack(selectedDocType);
if (uploadBackLabel) uploadBackLabel.hidden = !needsBack(selectedDocType);
updateStepUI();

backBtn.addEventListener('click', () => {
  stopCamera();
  window.location.href = 'index.html';
});

continueBtn.addEventListener('click', () => {
  window.location.href = 'liveness.html';
});

retakeBtn.addEventListener('click', () => {
  dropIDFrame();
  captureStep            = 'front';
  awaitingBackStart      = false;
  previewRow.hidden      = true;
  backPreviewWrap.hidden = true;
  cameraBlock.hidden     = false;
  takeBtn.hidden         = false;
  takeBtn.textContent    = 'Capture Now';
  continueBtn.disabled   = true;
  retakeBtn.disabled     = true;
  captured               = false;
  updateStepUI();
  if (isMobile) {
    stopCamera();
    showReadyGate('front');
  } else {
    hideReadyGate();
    startCamera();
  }
});

takeBtn.addEventListener('click', () => {
  if (awaitingBackStart) { beginBackCapture(); return; }
  if (countdownActive || captured) return;
  beginCountdown();
});

readyBtn.addEventListener('click', () => {
  const side = pendingReadySide;
  hideReadyGate();
  if (side === 'back') beginBackCapture();
  else startCamera();
});

// The upload fallback stays reachable straight from the ready-gate — it
// doesn't touch the camera at all, so there's no reason to make someone
// tap "Start Scanning" first just to upload a photo instead.
readyUploadBtn.addEventListener('click', () => {
  (pendingReadySide === 'back' ? uploadBack : uploadFront)?.click();
});

// Mobile only: replaces the camera/quality panel with a static "confirm
// you're ready" card so the camera never opens — and auto-capture never
// starts trying — until the user explicitly taps in.
function showReadyGate(side) {
  pendingReadySide     = side;
  readyTitle.textContent = side === 'back' ? 'Flip your document over' : 'Get your document ready';
  readyHint.textContent  = side === 'back'
    ? "Have the back facing the camera, flat and well lit. Tap when you're set."
    : "Have it flat, well lit, and free of glare. Tap below when you're set.";
  readyGate.hidden     = false;
  frameBox.hidden      = true;
  qualityPanel.hidden  = true;
}

function hideReadyGate() {
  readyGate.hidden     = true;
  frameBox.hidden      = false;
  qualityPanel.hidden  = false;
}

if (uploadFront) {
  uploadFront.addEventListener('change', e => handleUpload(e.target.files?.[0], 'front', uploadFront));
}

if (uploadBack) {
  uploadBack.addEventListener('change', e => handleUpload(e.target.files?.[0], 'back', uploadBack));
}

window.addEventListener('pagehide', stopCamera);

// Restore if user came back from liveness
if (stored.idFrame) {
  renderPreview(stored.idFrame, stored.idMeta || {});
  if (stored.idFrameBack) {
    renderBackPreview(stored.idFrameBack, stored.idMetaBack || {});
    captureStep = 'back';
    updateStepUI();
    continueBtn.disabled = false;
    retakeBtn.disabled   = false;
    captured             = true;
  } else if (needsBack(selectedDocType)) {
    // Page reloaded (or revisited) with only the front saved: resume at the
    // back side instead of leaving a dead camera frame with nothing to scan.
    retakeBtn.disabled = false;
    captured           = true;
    enterBackCapture();
  } else {
    continueBtn.disabled = false;
    retakeBtn.disabled   = false;
    captured             = true;
  }
} else if (isMobile) {
  showReadyGate('front');
} else {
  startCamera();
}

// ── Camera ────────────────────────────────────────────────────────────────────
// iOS Safari can render a second getUserMedia stream on a reused <video>
// pillarboxed (uncropped, black bars) instead of honouring object-fit:cover,
// so the back side looked different from the front. A brand-new element per
// start gives every side the same first-use rendering path as the front.
function freshVideoElement() {
  const old = video;
  old.pause();
  old.srcObject = null;
  const nv = document.createElement('video');
  nv.id = 'vid-id';
  nv.autoplay    = true;
  nv.muted       = true;
  nv.playsInline = true;
  nv.setAttribute('playsinline', '');
  nv.setAttribute('muted', '');
  old.replaceWith(nv);
  video = nv;
}

async function startCamera() {
  stopCamera();
  hideError();
  freshVideoElement();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    idPage?.classList.add('cam-live');
    startViewfinder();
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas, { passive: true });
    toast.textContent = 'Align your document within the guide.';
    startAnalyser();
  } catch (err) {
    console.error(err);
    toast.textContent = 'Camera unavailable — you can upload your document instead.';
    instr.textContent = 'Upload images below or enable camera access to continue scanning.';
    if (uploadHint) uploadHint.textContent = 'Camera blocked? Upload your document images instead.';
    hideError();
  }
}

// Paint the live video onto #view-id with an explicit cover-crop, matching
// what the overlay canvas assumes, so front and back look identical.
function startViewfinder() {
  stopViewfinder();
  const ctx = viewCanvas.getContext('2d');
  const paint = () => {
    if (video.readyState >= 2 && video.videoWidth) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const tw  = Math.round(viewCanvas.clientWidth  * dpr);
      const th  = Math.round(viewCanvas.clientHeight * dpr);
      if (tw && th && (viewCanvas.width !== tw || viewCanvas.height !== th)) {
        viewCanvas.width = tw; viewCanvas.height = th;
      }
      const s  = Math.max(viewCanvas.width / video.videoWidth, viewCanvas.height / video.videoHeight);
      const dw = video.videoWidth * s, dh = video.videoHeight * s;
      ctx.drawImage(video, (viewCanvas.width - dw) / 2, (viewCanvas.height - dh) / 2, dw, dh);
    }
    viewRaf = requestAnimationFrame(paint);
  };
  paint();
}
function stopViewfinder() {
  if (viewRaf) cancelAnimationFrame(viewRaf);
  viewRaf = null;
}

function stopCamera() {
  stopViewfinder();
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  idPage?.classList.remove('cam-live');
  stopAnalyser();
  cancelCountdown();
}

// Front side is done. We do NOT auto-start the back analyser: the document
// is still sitting in the guide front-up, so if it fired immediately the
// same steady frame could pass quality checks again and get saved as
// "back" — effectively capturing the front twice. Instead we wait here
// until the user confirms (taps the button) that they've actually flipped
// the document over. On mobile that means dropping back to the same
// ready-gate the front side used — camera fully off — rather than leaving
// the stream running behind the button, matching the single-view flow.
function enterBackCapture() {
  if (isMobile) {
    stopCamera();
    showReadyGate('back');
    return;
  }
  awaitingBackStart   = true;
  takeBtn.textContent = 'Ready — Scan Back';
  takeBtn.hidden      = false;
  toast.textContent   = 'Flip your document over, then tap "Ready — Scan Back".';
  instr.textContent   = 'Flip your document over, then tap "Ready — Scan Back" when it\'s in place.';
}

function beginBackCapture() {
  awaitingBackStart   = false;
  takeBtn.textContent = 'Capture Now';
  captureStep         = 'back';
  captured            = false;
  takeBtn.hidden      = false;
  updateStepUI();
  if (stream) {
    toast.textContent = 'Align the back side within the guide.';
    startAnalyser();
  } else {
    startCamera();
  }
}

function resizeCanvas() {
  overlay.width  = video.videoWidth  || overlay.clientWidth;
  overlay.height = video.videoHeight || overlay.clientHeight;
}

function startAnalyser() {
  stopAnalyser();
  analyser = setInterval(() => {
    if (!video || video.readyState < 2 || captured) return;
    const q = measureQuality(selectedDocType);
    drawDocGuide(q, selectedDocType);
    updateUI(q);
    handleAutoCapture(q);
  }, 140);
}

function stopAnalyser() {
  clearInterval(analyser);
  analyser  = null;
  readyStreak = 0;
  ctx?.clearRect(0, 0, overlay.width, overlay.height);
}

// Snaps the instant quality holds steady for READY_HOLD_TICKS in a row —
// no 3-2-1 countdown, just a brief hold to avoid firing on a single lucky
// frame.
function handleAutoCapture(q) {
  if (captured) { readyStreak = 0; return; }
  if (q.ready) {
    readyStreak += 1;
    if (readyStreak >= READY_HOLD_TICKS) captureFrame();
  } else {
    readyStreak = 0;
  }
}

// ── Quality measurement ───────────────────────────────────────────────────────
function measureQuality(docType = 'national_id') {
  const RATIO = DOC_RATIO[docType] || 1.585;
  const cw    = overlay.width  || 640;
  const ch    = overlay.height || 360;
  const scale = 0.28;

  const off   = document.createElement('canvas');
  off.width   = Math.max(1, Math.round(cw * scale));
  off.height  = Math.max(1, Math.round(ch * scale));
  const octx  = off.getContext('2d');
  octx.drawImage(video, 0, 0, off.width, off.height);

  const rect  = getGuideRect(off.width, off.height, RATIO);
  const gx    = rect.x, gy = rect.y;
  const iw    = Math.max(1, Math.floor(rect.width));
  const ih    = Math.max(1, Math.floor(rect.height));
  const data  = octx.getImageData(Math.floor(gx), Math.floor(gy), iw, ih).data;

  let sum = 0, glare = 0;
  const gray = new Float32Array(iw * ih);
  for (let i = 0; i < iw * ih; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    sum += l; gray[i] = l;
    if (r > 244 && g > 244 && b > 244) glare++;
  }

  let lap = 0, cnt = 0;
  for (let y = 1; y < ih - 1; y++) {
    for (let x = 1; x < iw - 1; x++) {
      const c  = gray[y * iw + x];
      const nb = gray[(y - 1) * iw + x] + gray[(y + 1) * iw + x] +
                 gray[y * iw + x - 1]   + gray[y * iw + x + 1];
      lap += Math.abs(nb - 4 * c); cnt++;
    }
  }

  const avg        = sum / (iw * ih);
  const sharpness  = cnt ? lap / cnt : 0;
  const glareRatio = glare / (iw * ih);
  const dark       = avg < 50;
  const bright     = avg > 215;
  const hasGlare   = glareRatio > 0.04;
  const blurry     = sharpness < 2.7;
  const cutoff      = detectCutoff(octx, gx, gy, iw, ih, off.width, off.height);
  const cutoffState = classifyCutoff(cutoff);
  const aligned     = detectEdgeAlignment(octx, gx, gy, iw, ih) && !cutoff.any;

  const checks    = { focus: !blurry, light: !dark && !bright, glare: !hasGlare, align: aligned };
  const passCount = Object.values(checks).filter(Boolean).length;

  return { ready: passCount === 4, passCount, checks, dark, bright, hasGlare, blurry, aligned, cutoff, cutoffState,
           metrics: { brightness: +avg.toFixed(1), glareRatio: +glareRatio.toFixed(4), sharpness: +sharpness.toFixed(3) } };
}

function detectEdgeAlignment(octx, gx, gy, iw, ih) {
  if (iw < 20 || ih < 20) return false;
  const p = 5;
  const samples = [];
  for (let x = p; x < iw - p; x += 4) {
    samples.push(Math.abs(sampleLum(octx, gx + x, gy + p)       - sampleLum(octx, gx + x, gy - p)));
    samples.push(Math.abs(sampleLum(octx, gx + x, gy + ih - p)  - sampleLum(octx, gx + x, gy + ih + p)));
  }
  for (let y = p; y < ih - p; y += 4) {
    samples.push(Math.abs(sampleLum(octx, gx + p, gy + y)       - sampleLum(octx, gx - p, gy + y)));
    samples.push(Math.abs(sampleLum(octx, gx + iw - p, gy + y)  - sampleLum(octx, gx + iw + p, gy + y)));
  }
  if (!samples.length) return false;
  return samples.reduce((a, b) => a + b, 0) / samples.length > 12;
}

function sampleLum(octx, x, y) {
  try {
    const px = octx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
    return 0.299 * px[0] + 0.587 * px[1] + 0.114 * px[2];
  } catch { return 0; }
}

// Mean + variance of luminance over a pixel rect, clamped to the frame bounds.
function sampleBandStats(octx, x, y, w, h, frameW, frameH) {
  const bx = Math.max(0, Math.round(x));
  const by = Math.max(0, Math.round(y));
  const bw = Math.min(frameW - bx, Math.round(w));
  const bh = Math.min(frameH - by, Math.round(h));
  if (bw < 1 || bh < 1) return null;
  const data = octx.getImageData(bx, by, bw, bh).data;
  const n = bw * bh;
  let sum = 0, sumSq = 0;
  for (let i = 0; i < n; i++) {
    const l = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    sum += l; sumSq += l * l;
  }
  const mean = sum / n;
  return { variance: sumSq / n - mean * mean, mean };
}

// Checks the thin band just outside each guide edge for document content.
// If the document extends past the guide there, that side will be cropped
// off when captureFrame() saves the guide rect.
function detectCutoff(octx, gx, gy, iw, ih, frameW, frameH) {
  const marginL = gx;
  const marginR = frameW - (gx + iw);
  const marginT = gy;
  const marginB = frameH - (gy + ih);

  const left   = marginL > CUTOFF_MIN_BAND_PX
    ? sampleBandStats(octx, gx - marginL * CUTOFF_BAND_FRAC, gy, marginL * CUTOFF_BAND_FRAC, ih, frameW, frameH)
    : null;
  const right  = marginR > CUTOFF_MIN_BAND_PX
    ? sampleBandStats(octx, gx + iw, gy, marginR * CUTOFF_BAND_FRAC, ih, frameW, frameH)
    : null;
  const top    = marginT > CUTOFF_MIN_BAND_PX
    ? sampleBandStats(octx, gx, gy - marginT * CUTOFF_BAND_FRAC, iw, marginT * CUTOFF_BAND_FRAC, frameW, frameH)
    : null;
  const bottom = marginB > CUTOFF_MIN_BAND_PX
    ? sampleBandStats(octx, gx, gy + ih, iw, marginB * CUTOFF_BAND_FRAC, frameW, frameH)
    : null;

  const cutLeft   = !!left   && left.variance   > CUTOFF_VARIANCE_THRESH;
  const cutRight  = !!right  && right.variance  > CUTOFF_VARIANCE_THRESH;
  const cutTop    = !!top    && top.variance    > CUTOFF_VARIANCE_THRESH;
  const cutBottom = !!bottom && bottom.variance > CUTOFF_VARIANCE_THRESH;
  const count     = [cutLeft, cutRight, cutTop, cutBottom].filter(Boolean).length;

  return {
    cutLeft, cutRight, cutTop, cutBottom, count,
    any: count > 0,
    opposite: (cutLeft && cutRight) || (cutTop && cutBottom),
  };
}

// 'too_close' → overflowing on opposite/3+ sides, document is bigger than the guide.
// 'off_center' → overflowing on just one or two adjacent sides, document has drifted.
// null → nothing overflowing (may still be too small — that's the separate `aligned` check).
function classifyCutoff(cutoff) {
  if (!cutoff.any) return null;
  if (cutoff.count >= 3 || cutoff.opposite) return 'too_close';
  return 'off_center';
}

function cutoffSideLabel(cutoff) {
  const sides = [];
  if (cutoff.cutTop)    sides.push('top');
  if (cutoff.cutBottom) sides.push('bottom');
  if (cutoff.cutLeft)   sides.push('left');
  if (cutoff.cutRight)  sides.push('right');
  return sides.join('/');
}

// ── Canvas drawing ────────────────────────────────────────────────────────────
function drawDocGuide(quality, docType = 'national_id') {
  const RATIO  = DOC_RATIO[docType] || 1.585;
  const cw     = overlay.width;
  const ch     = overlay.height;
  const { x, y, width, height } = getGuideRect(cw, ch, RATIO);

  ctx.clearRect(0, 0, cw, ch);
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, cw, ch);
  ctx.globalCompositeOperation = 'destination-out';
  roundedRect(ctx, x, y, width, height, 22);
  ctx.fill();
  ctx.restore();

  const color = quality.cutoffState === 'too_close' ? 'rgba(255,76,76,0.95)'
    : quality.ready          ? 'rgba(92,250,142,0.95)'
    : quality.passCount >= 2 ? 'rgba(255,189,89,0.95)'
    : 'rgba(59,130,246,0.8)';

  ctx.strokeStyle = color;
  ctx.lineWidth   = 4;
  roundedRect(ctx, x, y, width, height, 22);
  ctx.stroke();

  const corner = 28;
  ctx.lineWidth = 5;
  [[x, y, 1, 1], [x + width, y, -1, 1], [x, y + height, 1, -1], [x + width, y + height, -1, -1]]
    .forEach(([px, py, dx, dy]) => {
      ctx.beginPath();
      ctx.moveTo(px + dx * corner, py);
      ctx.lineTo(px, py);
      ctx.lineTo(px, py + dy * corner);
      ctx.stroke();
    });

  if (quality.passCount > 0) {
    ctx.beginPath();
    ctx.moveTo(x + 30, y - 6);
    ctx.lineTo(x + 30 + (width - 60) * (quality.passCount / 4), y - 6);
    ctx.strokeStyle = '#5cfa8e';
    ctx.lineWidth   = 4;
    ctx.lineCap     = 'round';
    ctx.stroke();
  }
}

function roundedRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

// ── UI updates ────────────────────────────────────────────────────────────────
function updateUI(q) {
  togglePill(pillFocus, q.checks.focus, !q.checks.focus);
  togglePill(pillLight, q.checks.light, !q.checks.light);
  togglePill(pillGlare, q.checks.glare, !q.checks.glare);
  togglePill(pillAlign, q.checks.align, !q.checks.align);
  progress.style.width = `${(q.passCount / 4) * 100}%`;

  const alignMsg =
    q.cutoffState === 'too_close'  ? 'Move the document back a little' :
    q.cutoffState === 'off_center' ? `Center your document (slipping off the ${cutoffSideLabel(q.cutoff)})` :
    q.aligned                      ? 'Document edges detected' :
                                      'Move closer to fill the guide';

  qualityChecks.innerHTML = '';
  [
    { ok: q.checks.focus, msg: q.blurry   ? 'Hold steady — focus locking'  : 'Sharp focus' },
    { ok: q.checks.light, msg: q.dark     ? 'Move to brighter light'        : q.bright ? 'Too bright — find shade' : 'Good exposure' },
    { ok: q.checks.glare, msg: q.hasGlare ? 'Tilt card to reduce glare'    : 'No glare' },
    { ok: q.checks.align, msg: alignMsg },
  ].forEach(({ ok, msg }) => {
    const div = document.createElement('div');
    div.className   = `qcheck ${ok ? 'qcheck-ok' : 'qcheck-warn'}`;
    div.textContent = msg;
    qualityChecks.appendChild(div);
  });

  toast.textContent =
    q.dark                         ? 'Move to brighter lighting.' :
    q.bright                       ? 'Too bright — find some shade.' :
    q.hasGlare                     ? 'Tilt the card to remove glare.' :
    q.blurry                       ? 'Hold steady so focus locks.' :
    q.cutoffState === 'too_close'  ? 'Document is too close — move it back a little.' :
    q.cutoffState === 'off_center' ? "Your document is slipping out of frame — center it." :
    !q.aligned                     ? 'Move the document closer to fill the guide.' :
    q.ready                        ? 'Perfect — holding for capture…' :
                                      'Align your document within the guide.';

  instr.textContent = q.ready ? 'All checks passed. Keep it steady.' : toast.textContent;
}

function togglePill(el, ok, warn) {
  el.classList.toggle('ok',   !!ok);
  el.classList.toggle('warn', !!warn && !ok);
}

// ── Countdown + capture ───────────────────────────────────────────────────────
function beginCountdown() {
  countdownActive = true;
  let value = 3;
  countdownEl.textContent = value;
  countdownEl.classList.add('show');
  countdownTimer = setInterval(() => {
    value -= 1;
    if (value <= 0) { cancelCountdown(); captureFrame(); }
    else countdownEl.textContent = value;
  }, 850);
}

function cancelCountdown() {
  clearInterval(countdownTimer);
  countdownTimer  = null;
  countdownActive = false;
  countdownEl.classList.remove('show');
}

function captureFrame() {
  if (captured) return;
  const RATIO = DOC_RATIO[selectedDocType] || 1.585;
  const rect  = getGuideRect(video.videoWidth, video.videoHeight, RATIO);
  const canvas = document.createElement('canvas');
  canvas.width  = Math.round(rect.width);
  canvas.height = Math.round(rect.height);
  // Save only what's inside the guide square, never the full camera frame.
  canvas.getContext('2d').drawImage(
    video,
    rect.x, rect.y, rect.width, rect.height,
    0, 0, canvas.width, canvas.height
  );
  const dataUrl = canvas.toDataURL('image/jpeg', 0.92);

  const q     = measureQuality(selectedDocType);
  const notes = [
    q.blurry   ? 'Refocus recommended.'      : 'Edges look crisp.',
    q.dark     ? 'Lighting too low.'         : q.bright ? 'Lighting too bright.' : 'Exposure balanced.',
    q.hasGlare ? 'Glare on surface.'         : 'No glare detected.',
    q.aligned  ? 'Document edges confirmed.' : 'Edge detection marginal.',
  ];
  const meta = {
    ...q.metrics, verdict: q.ready ? 'ready' : 'ok', notes,
    side: captureStep, country: selectedCountry, docType: selectedDocType,
    capturedAt: new Date().toISOString(),
  };

  captured       = true;
  takeBtn.hidden = true;

  if (captureStep === 'front') {
    stopAnalyser();
    cancelCountdown();
    saveIDFrame({ dataUrl, meta });
    renderPreview(dataUrl, meta);
    if (needsBack(selectedDocType)) {
      enterBackCapture();
    } else {
      stopCamera();
      continueBtn.disabled = false;
      retakeBtn.disabled   = false;
    }
  } else {
    stopCamera();
    saveIDFrameBack({ dataUrl, meta });
    renderBackPreview(dataUrl, meta);
    continueBtn.disabled = false;
    retakeBtn.disabled   = false;
    updateStepUI();
  }
}

// ── Upload crop editor ────────────────────────────────────────────────────────
// Uploads are never saved as-is: the user must pan/zoom/straighten the photo
// behind a fixed guide frame first, so only the cropped document region is
// stored — same principle as the camera capture above.
//
// The image's on-screen transform is `translate(offX, offY) rotate(angle)`
// with transform-origin at the image's own center (see app.css) — CSS
// composes that as: rotate the image about its own center, then shift the
// whole result by (offX, offY). Net effect: the image's own center always
// sits at frame-space point C = (offX + dispW/2, offY + dispH/2), completely
// independent of angle, which is what makes the rest of this tractable —
// panning is a plain translate regardless of rotation, and "keep this point
// anchored" math only has to reason about one rotation, not a moving pivot.
let cropState = null; // { natW, natH, frameW, frameH, angle, scale, offX, offY }
let cropResolve = null;

function rotVec(x, y, deg) {
  const r = deg * Math.PI / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return { x: x * c - y * s, y: x * s + y * c };
}

function cropCenter(s) {
  return { x: s.offX + s.natW * s.scale / 2, y: s.offY + s.natH * s.scale / 2 };
}

function setCropCenter(s, cx, cy) {
  s.offX = cx - s.natW * s.scale / 2;
  s.offY = cy - s.natH * s.scale / 2;
}

// Minimum scale for the (unrotated) image to still fully cover the frame
// once rotated by `angleDeg` — i.e. the frame's own corners, expressed in
// the image's local unrotated coordinates, must fit inside it. That's the
// standard "bounding box of a rotated rectangle" size, computed in the
// image's frame instead of the screen's.
function minScaleForAngle(s, angleDeg) {
  const r = Math.abs(angleDeg) * Math.PI / 180;
  const c = Math.abs(Math.cos(r)), sn = Math.abs(Math.sin(r));
  const wPrime = s.frameW * c + s.frameH * sn;
  const hPrime = s.frameW * sn + s.frameH * c;
  return Math.max(wPrime / s.natW, hPrime / s.natH);
}

function openCropEditor(dataUrl, ratio) {
  return new Promise(resolve => {
    cropResolve = resolve;
    cropImg.src = dataUrl;
    cropLayer.classList.remove('hidden');
    cropStage.style.aspectRatio = `${ratio} / 1`;

    cropImg.onload = () => {
      const frameW = cropStage.clientWidth;
      const frameH = cropStage.clientHeight;
      const natW   = cropImg.naturalWidth;
      const natH   = cropImg.naturalHeight;

      cropState = { natW, natH, frameW, frameH, angle: 0, scale: 0 };
      cropState.scale = minScaleForAngle(cropState, 0);
      setCropCenter(cropState, frameW / 2, frameH / 2);

      cropZoom.value = 0;
      cropRotate.value = 0;
      cropRotateVal.textContent = '0°';
      applyCropTransform();
    };
  });
}

function applyCropTransform() {
  const s = cropState;
  cropImg.style.width     = (s.natW * s.scale) + 'px';
  cropImg.style.height    = (s.natH * s.scale) + 'px';
  cropImg.style.transform = `translate(${s.offX}px, ${s.offY}px) rotate(${s.angle}deg)`;
}

// Clamps so the frame stays fully covered at the current angle/scale.
// Reasoned in the image's own (unrotated) local coordinates, where the
// constraint is a plain axis-aligned box — see the module comment above for
// why that's valid. Converts the frame-space center back and forth around
// that local-space clamp.
function clampCropState(s) {
  const dispW = s.natW * s.scale, dispH = s.natH * s.scale;
  const C = cropCenter(s);
  const D = rotVec(C.x, C.y, -s.angle);

  const corners = [
    { x: 0, y: 0 }, { x: s.frameW, y: 0 }, { x: 0, y: s.frameH }, { x: s.frameW, y: s.frameH },
  ].map(p => rotVec(p.x, p.y, -s.angle));
  const wMax = Math.max(...corners.map(p => p.x)), wMin = Math.min(...corners.map(p => p.x));
  const hMax = Math.max(...corners.map(p => p.y)), hMin = Math.min(...corners.map(p => p.y));

  D.x = Math.min(wMin + dispW / 2, Math.max(wMax - dispW / 2, D.x));
  D.y = Math.min(hMin + dispH / 2, Math.max(hMax - dispH / 2, D.y));

  const Cnew = rotVec(D.x, D.y, s.angle);
  setCropCenter(s, Cnew.x, Cnew.y);
}

function closeCropEditor(result) {
  cropLayer.classList.add('hidden');
  cropState = null;
  const resolve = cropResolve;
  cropResolve = null;
  if (resolve) resolve(result);
}

// Shared by the zoom and rotate handlers: whatever natural-image point is
// currently sitting under the frame's visual center stays there through the
// change, same "zoom toward what you're looking at" feel as before, now
// rotation-aware too.
function anchoredPointUnderFrameCenter(s) {
  const C = cropCenter(s);
  const frameCenter = { x: s.frameW / 2, y: s.frameH / 2 };
  const local = rotVec(frameCenter.x - C.x, frameCenter.y - C.y, -s.angle);
  return { x: local.x / s.scale, y: local.y / s.scale };
}

function recenterOnAnchor(s, natPt) {
  const frameCenter = { x: s.frameW / 2, y: s.frameH / 2 };
  const local = { x: natPt.x * s.scale, y: natPt.y * s.scale };
  const rel = rotVec(local.x, local.y, s.angle);
  setCropCenter(s, frameCenter.x - rel.x, frameCenter.y - rel.y);
}

cropZoom.addEventListener('input', () => {
  if (!cropState) return;
  const s = cropState;
  const t = cropZoom.value / 100;
  const minS = minScaleForAngle(s, s.angle);
  const maxS = minS * 3;

  const natPt = anchoredPointUnderFrameCenter(s);
  s.scale = minS + t * (maxS - minS);
  recenterOnAnchor(s, natPt);

  clampCropState(s);
  applyCropTransform();
});

cropRotate.addEventListener('input', () => {
  if (!cropState) return;
  const s = cropState;
  const newAngle = Number(cropRotate.value);

  const natPt = anchoredPointUnderFrameCenter(s);
  const minS  = minScaleForAngle(s, newAngle);
  // Rotating can require more coverage than the current zoom level gives —
  // auto zoom in just enough to keep the frame covered, same as pinch-zoom
  // apps do when you rotate a photo.
  if (s.scale < minS) s.scale = minS;
  s.angle = newAngle;
  recenterOnAnchor(s, natPt);

  // Reflect any auto zoom-in back onto the zoom slider so it doesn't silently
  // drift out of sync with what's actually on screen.
  const maxS = minS * 3;
  cropZoom.value = Math.round(((s.scale - minS) / (maxS - minS)) * 100);
  cropRotateVal.textContent = `${newAngle.toFixed(0)}°`;

  clampCropState(s);
  applyCropTransform();
});

let cropDragging = false, cropDragStartX = 0, cropDragStartY = 0, cropStartOffX = 0, cropStartOffY = 0;

cropStage.addEventListener('pointerdown', e => {
  if (!cropState) return;
  cropDragging = true;
  cropStage.setPointerCapture(e.pointerId);
  cropDragStartX = e.clientX; cropDragStartY = e.clientY;
  cropStartOffX  = cropState.offX; cropStartOffY = cropState.offY;
});
cropStage.addEventListener('pointermove', e => {
  if (!cropDragging || !cropState) return;
  // A screen-space drag translates the whole rotated image by the same
  // delta regardless of angle — rotation only affects the clamp below, not
  // this part. See the module comment above.
  cropState.offX = cropStartOffX + (e.clientX - cropDragStartX);
  cropState.offY = cropStartOffY + (e.clientY - cropDragStartY);
  clampCropState(cropState);
  applyCropTransform();
});
['pointerup', 'pointercancel', 'pointerleave'].forEach(ev =>
  cropStage.addEventListener(ev, () => { cropDragging = false; })
);
cropStage.addEventListener('wheel', e => {
  if (!cropState) return;
  e.preventDefault();
  cropZoom.value = Math.min(100, Math.max(0, Number(cropZoom.value) - Math.sign(e.deltaY) * 4));
  cropZoom.dispatchEvent(new Event('input'));
}, { passive: false });

cropCancel.addEventListener('click', () => closeCropEditor(null));

cropConfirm.addEventListener('click', () => {
  const s = cropState;
  if (!s) return;

  // Renders the frame rectangle exactly as shown on screen: scale frame-space
  // units to canvas pixels, move to the image's center, rotate, draw the
  // full (scaled) image centered on that point. Mirrors the CSS transform
  // pixel-for-pixel instead of extracting an axis-aligned sub-rectangle,
  // which only would have worked for angle 0.
  const canvas = document.createElement('canvas');
  canvas.width  = 900;
  canvas.height = Math.round(900 * (s.frameH / s.frameW));
  const k = canvas.width / s.frameW;
  const C = cropCenter(s);

  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.scale(k, k);
  ctx.translate(C.x, C.y);
  ctx.rotate(s.angle * Math.PI / 180);
  ctx.drawImage(cropImg, -s.natW * s.scale / 2, -s.natH * s.scale / 2, s.natW * s.scale, s.natH * s.scale);
  ctx.restore();

  closeCropEditor(canvas.toDataURL('image/jpeg', 0.92));
});

// ── Upload fallback ─────────────────────────────────────────────────────────
async function handleUpload(file, side, inputEl) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    toast.textContent = 'Please choose an image file (JPG or PNG).';
    if (inputEl) inputEl.value = '';
    return;
  }

  const hasFront = !!getState().idFrame;
  if (side === 'back' && !hasFront) {
    toast.textContent = 'Upload the front side first.';
    if (inputEl) inputEl.value = '';
    return;
  }

  try {
    const rawDataUrl = await readFileAsDataURL(file);
    const RATIO = DOC_RATIO[selectedDocType] || 1.585;
    const dataUrl = await openCropEditor(rawDataUrl, RATIO);
    if (!dataUrl) { // user cancelled the crop
      if (inputEl) inputEl.value = '';
      return;
    }
    const meta = {
      side,
      docType: selectedDocType,
      country: selectedCountry,
      source: 'upload',
      filename: file.name,
      size: file.size,
      mime: file.type,
      capturedAt: new Date().toISOString(),
      notes: ['Uploaded from device.'],
    };

    captured       = true;
    takeBtn.hidden = true;
    readyGate.hidden = true; // dismiss the ready-gate if the upload came from there
    stopCamera();

    if (side === 'front') {
      saveIDFrame({ dataUrl, meta });
      renderPreview(dataUrl, meta);
      if (needsBack(selectedDocType)) {
        continueBtn.disabled = true;
        enterBackCapture();
      } else {
        continueBtn.disabled = false;
      }
      retakeBtn.disabled = false;
    } else {
      saveIDFrameBack({ dataUrl, meta });
      renderBackPreview(dataUrl, meta);
      continueBtn.disabled = false;
      retakeBtn.disabled   = false;
      captureStep          = 'back';
    }

    updateStepUI();
    if (uploadHint) uploadHint.textContent = `Loaded ${file.name} (${side === 'front' ? 'front' : 'back'}).`;
  } catch (err) {
    console.error(err);
    toast.textContent = 'Could not load that image. Try another file.';
  } finally {
    if (inputEl) inputEl.value = '';
  }
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('Invalid file data.'));
    };
    reader.onerror = () => reject(reader.error || new Error('Failed to read file.'));
    reader.readAsDataURL(file);
  });
}

// ── Previews ──────────────────────────────────────────────────────────────────
function renderPreview(dataUrl, meta = {}) {
  previewImg.src        = dataUrl;
  previewRow.hidden     = false;
  qualityList.innerHTML = '';
  (meta.notes || []).forEach(text => {
    const li = document.createElement('li');
    li.textContent = text;
    qualityList.appendChild(li);
  });
  toast.textContent = needsBack(selectedDocType)
    ? 'Front saved — add the back side next (scan or upload).'
    : 'Capture stored — continue or retake.';
}

function renderBackPreview(dataUrl) {
  previewImgBack.src     = dataUrl;
  backPreviewWrap.hidden = false;
  previewRow.hidden      = false;
  toast.textContent      = 'Both sides captured — continue or retake.';
}

// ── Step indicator ────────────────────────────────────────────────────────────
function updateStepUI() {
  idPage?.classList.toggle('on-back', captureStep === 'back');
  stepFront.classList.toggle('active', captureStep === 'front');
  stepFront.classList.toggle('done',   captureStep === 'back');
  stepBack.classList.toggle('active',  captureStep === 'back');
  captureHeading.textContent = captureStep === 'back'
    ? 'Back of your document'
    : needsBack(selectedDocType)
      ? 'Front of your document'
      : 'Place your document in the guide';
}

// ── Errors ────────────────────────────────────────────────────────────────────
function showError(msg) { errorText.textContent = msg; errorLayer.classList.remove('hidden'); }
function hideError()    { errorLayer.classList.add('hidden'); }


// ── Tap a preview thumbnail to inspect it full size ──────────────────────
// Click outside the enlarged image (or press Esc) to return to normal.
const lightbox    = document.getElementById('img-lightbox');
const lightboxImg = document.getElementById('img-lightbox-img');
function closeLightbox() { lightbox.hidden = true; lightboxImg.removeAttribute('src'); }
[previewImg, previewImgBack].forEach((img) => {
  img.addEventListener('click', () => {
    if (!img.src) return;
    lightboxImg.src = img.src;
    lightbox.hidden = false;
  });
});
lightbox.addEventListener('click', (e) => { if (e.target !== lightboxImg) closeLightbox(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !lightbox.hidden) closeLightbox(); });
