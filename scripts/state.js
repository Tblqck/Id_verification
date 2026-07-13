const STORAGE_KEY = 'kyc-flow-v2';

function readState() {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.warn('Unable to read session storage', err);
    return {};
  }
}

function writeState(next) {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (err) {
    console.warn('Unable to persist session storage', err);
  }
  return next;
}

export function getState() {
  return readState();
}

export function clearSession() {
  window.sessionStorage.removeItem(STORAGE_KEY);
}

export function saveSelection({ country, docType }) {
  const current = readState();
  return writeState({ ...current, country, docType });
}

// Generate Link's single-use session token — read from the entry URL
// (?token=...) and carried through the same sessionStorage blob as
// country/docType, since that's the only thing that survives this flow's
// hard page-to-page navigations.
export function saveToken(token) {
  const current = readState();
  return writeState({ ...current, token });
}

export function getToken() {
  return readState().token || null;
}

export function saveIDFrame({ dataUrl, meta }) {
  const current = readState();
  const next = {
    ...current,
    idFrame: dataUrl,
    idMeta: meta,
    idFrameBack: null,
    idMetaBack: null,
    faceFrame: null,
    faceMeta: null,
    updatedAt: new Date().toISOString(),
  };
  return writeState(next);
}

export function saveIDFrameBack({ dataUrl, meta }) {
  const current = readState();
  return writeState({
    ...current,
    idFrameBack: dataUrl,
    idMetaBack: meta,
    updatedAt: new Date().toISOString(),
  });
}

export function saveFaceFrame({ dataUrl, meta }) {
  const current = readState();
  const next = {
    ...current,
    faceFrame: dataUrl,
    faceMeta: meta,
    updatedAt: new Date().toISOString(),
  };
  return writeState(next);
}

export function dropIDFrame() {
  const current = readState();
  delete current.idFrame;
  delete current.idMeta;
  delete current.idFrameBack;
  delete current.idMetaBack;
  delete current.faceFrame;
  delete current.faceMeta;
  writeState(current);
}

export function dropIDFrameBack() {
  const current = readState();
  delete current.idFrameBack;
  delete current.idMetaBack;
  writeState(current);
}

export function dropFaceFrame() {
  const current = readState();
  delete current.faceFrame;
  delete current.faceMeta;
  writeState(current);
}

export function ensureIDFrame() {
  const state = readState();
  if (!state.idFrame) {
    window.location.href = 'index.html';
    throw new Error('ID frame missing; redirecting to step 1');
  }
  return state;
}

export function ensureFaceFrame() {
  const state = ensureIDFrame();
  if (!state.faceFrame) {
    window.location.href = 'liveness.html';
    throw new Error('Face frame missing; redirecting to step 2');
  }
  return state;
}

function deviceMeta() {
  return {
    userAgent: window.navigator.userAgent,
    platform: window.navigator.platform,
    language: window.navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

export function buildPayload() {
  const state = ensureFaceFrame();
  return {
    mode:            'id+liveness',
    country:         state.country     || null,
    doc_type:        state.docType     || null,
    id_frame:        state.idFrame,
    id_frame_back:   state.idFrameBack || null,
    face_frame:      state.faceFrame,
    id_quality:      state.idMeta      || null,
    id_quality_back: state.idMetaBack  || null,
    liveness:        state.faceMeta    || null,
    device:          deviceMeta(),
    timestamp:       new Date().toISOString(),
  };
}

export async function submitPayload() {
  const payload = buildPayload();
  window.dispatchEvent(new CustomEvent('kyc:captured', { detail: payload }));

  if (window.KYC_ENDPOINT) {
    await fetch(window.KYC_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  return payload;
}
