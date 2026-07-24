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
const video          = document.getElementById('vid-id');
const overlay        = document.getElementById('overlay-id');
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
const cropCancel     = document.getElementById('crop-cancel');
const cropConfirm    = document.getElementById('crop-confirm');

// ── Capture state ─────────────────────────────────────────────────────────────
let stream             = null;
let analyser           = null;
let countdownTimer     = null;
let countdownActive    = false;
let captured           = false;
let captureStep        = 'front';
let backTransitionTimer = null;
let readyStreak        = 0; // consecutive analyser ticks with all 4 checks passing

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
  previewRow.hidden      = true;
  backPreviewWrap.hidden = true;
  cameraBlock.hidden     = false;
  takeBtn.hidden         = false;
  continueBtn.disabled   = true;
  retakeBtn.disabled     = true;
  captured               = false;
  updateStepUI();
  startCamera();
});

takeBtn.addEventListener('click', () => {
  if (countdownActive || captured) return;
  beginCountdown();
});

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
  }
  continueBtn.disabled = false;
  retakeBtn.disabled   = false;
  captured             = true;
} else {
  startCamera();
}

// ── Camera ────────────────────────────────────────────────────────────────────
async function startCamera() {
  stopCamera();
  hideError();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
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

function stopCamera() {
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  stopAnalyser();
  cancelCountdown();
  clearTimeout(backTransitionTimer);
  backTransitionTimer = null;
}

// Front side is done — move straight to the back side, no extra tap needed.
// If the camera is already running we keep the stream alive and just reset
// the quality check for the new side; otherwise (e.g. front came from an
// upload) we try to start it fresh.
function enterBackCapture() {
  clearTimeout(backTransitionTimer);
  toast.textContent = 'Front saved — flip your document…';
  backTransitionTimer = setTimeout(() => {
    captureStep    = 'back';
    captured       = false;
    takeBtn.hidden = false;
    updateStepUI();
    if (stream) {
      toast.textContent = 'Align the back side within the guide.';
      startAnalyser();
    } else {
      startCamera();
    }
  }, 900);
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
// Uploads are never saved as-is: the user must pan/zoom the photo behind a
// fixed guide frame first, so only the cropped document region is stored —
// same principle as the camera capture above.
let cropState = null; // { natW, natH, frameW, frameH, minScale, maxScale, scale, offX, offY }
let cropResolve = null;

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
      const minScale = Math.max(frameW / natW, frameH / natH);

      cropState = {
        natW, natH, frameW, frameH,
        minScale, maxScale: minScale * 3,
        scale: minScale,
        offX: (frameW - natW * minScale) / 2,
        offY: (frameH - natH * minScale) / 2,
      };
      cropZoom.value = 0;
      applyCropTransform();
    };
  });
}

function applyCropTransform() {
  const s = cropState;
  cropImg.style.width     = (s.natW * s.scale) + 'px';
  cropImg.style.height    = (s.natH * s.scale) + 'px';
  cropImg.style.transform = `translate(${s.offX}px, ${s.offY}px)`;
}

function clampCropOffsets() {
  const s = cropState;
  const dispW = s.natW * s.scale;
  const dispH = s.natH * s.scale;
  s.offX = Math.min(0, Math.max(s.frameW - dispW, s.offX));
  s.offY = Math.min(0, Math.max(s.frameH - dispH, s.offY));
}

function closeCropEditor(result) {
  cropLayer.classList.add('hidden');
  cropState = null;
  const resolve = cropResolve;
  cropResolve = null;
  if (resolve) resolve(result);
}

cropZoom.addEventListener('input', () => {
  if (!cropState) return;
  const s = cropState;
  const t = cropZoom.value / 100;
  const newScale = s.minScale + t * (s.maxScale - s.minScale);

  // Keep the frame's visual center anchored while zooming.
  const cx = s.frameW / 2, cy = s.frameH / 2;
  const imgX = (cx - s.offX) / s.scale;
  const imgY = (cy - s.offY) / s.scale;
  s.scale = newScale;
  s.offX = cx - imgX * s.scale;
  s.offY = cy - imgY * s.scale;

  clampCropOffsets();
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
  cropState.offX = cropStartOffX + (e.clientX - cropDragStartX);
  cropState.offY = cropStartOffY + (e.clientY - cropDragStartY);
  clampCropOffsets();
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

  // Exactly what's visible inside the frame, at full source resolution.
  const srcX = -s.offX / s.scale;
  const srcY = -s.offY / s.scale;
  const srcW = s.frameW / s.scale;
  const srcH = s.frameH / s.scale;

  const canvas = document.createElement('canvas');
  canvas.width  = 900;
  canvas.height = Math.round(900 * (s.frameH / s.frameW));
  canvas.getContext('2d').drawImage(cropImg, srcX, srcY, srcW, srcH, 0, 0, canvas.width, canvas.height);
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
