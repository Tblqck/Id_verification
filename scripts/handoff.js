import {
  ensureFaceFrame,
  buildPayload,
  submitPayload,
  dropIDFrame,
  dropFaceFrame,
  clearSession,
} from './state.js';

const state = ensureFaceFrame();
const payload = buildPayload();

const idImg = document.getElementById('review-id');
const faceImg = document.getElementById('review-face');
const idMetrics = document.getElementById('id-metrics');
const challengeReview = document.getElementById('challenge-review');
const payloadEl = document.getElementById('payload-json');
const submitBtn = document.getElementById('submit-btn');
const restartBtn = document.getElementById('restart-flow');
const retakeIDBtn = document.getElementById('retake-id');
const retakeFaceBtn = document.getElementById('retake-face');
const copyBtn = document.getElementById('copy-payload');

render();

submitBtn.addEventListener('click', async () => {
  submitBtn.disabled = true;
  submitBtn.textContent = 'Sending…';
  try {
    const result = await submitPayload();
    submitBtn.textContent = 'Payload emitted';
    submitBtn.classList.add('success');
    payloadEl.textContent = JSON.stringify(result, null, 2);
  } catch (err) {
    console.error(err);
    submitBtn.disabled = false;
    submitBtn.textContent = 'Emit Payload';
    alert('Failed to dispatch payload. Check console for details.');
  }
});

restartBtn.addEventListener('click', () => {
  clearSession();
  window.location.href = 'index.html';
});

retakeIDBtn.addEventListener('click', () => {
  dropIDFrame();
  window.location.href = 'index.html';
});

retakeFaceBtn.addEventListener('click', () => {
  dropFaceFrame();
  window.location.href = 'liveness.html';
});

copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(payloadEl.textContent);
    copyBtn.textContent = 'Copied ✔';
    setTimeout(() => (copyBtn.textContent = 'Copy JSON'), 1600);
  } catch (err) {
    console.warn('Clipboard unavailable', err);
  }
});

function render() {
  idImg.src = state.idFrame;
  faceImg.src = state.faceFrame;
  idMetrics.innerHTML = '';
  const meta = state.idMeta || {};
  ['brightness', 'sharpness', 'glareRatio'].forEach(key => {
    if (meta[key] === undefined) return;
    const li = document.createElement('li');
    li.textContent = `${key}: ${meta[key]}`;
    idMetrics.appendChild(li);
  });
  (meta.notes || []).forEach(note => {
    const li = document.createElement('li');
    li.textContent = note;
    idMetrics.appendChild(li);
  });

  challengeReview.innerHTML = '';
  (state.faceMeta?.challenges || []).forEach(ch => {
    const li = document.createElement('li');
    li.textContent = `${ch.label}: ${ch.status}`;
    challengeReview.appendChild(li);
  });

  payloadEl.textContent = JSON.stringify(payload, null, 2);
}
