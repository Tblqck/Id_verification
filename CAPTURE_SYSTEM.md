# Liveness Capture System (Current Behaviour)

This document explains how the browser-based liveness module in `production/web/` now operates after the latest round of changes. It covers the runtime layout, the view hierarchy, and the exact capture pipeline so the behaviour can be compared against desired product requirements.

## 1. Runtime Structure

| Layer | Location | Responsibility |
| --- | --- | --- |
| Static server | `production/web/server.py` | Serves the PWA bundle on port `5000`, handles `POST /save` to stash captures for local development. |
| Entry HTML | `production/web/pipeline.html` | Single-page UI for the liveness-only flow (video element, overlays, status panel). |
| Core script | `production/web/scripts/pipeline.js` | Boots the MediaPipe face landmarker, orchestrates the camera loop, runs lighting heuristics, and emits the final `liveness:captured` payload. |
| Styling | `production/web/styles/app.css` | Defines the portrait capture frame, overlay aesthetics, pills, preview row, etc. |
| Model bundle | `production/web/liveness/` | Offline MediaPipe Face Landmarker assets (`vision_bundle.mjs`, WASM runtimes, `face_landmarker.task`) used by `pipeline.js` to compute yaw/pitch/landmarks without hitting CDNs. |

### DOM Highlights

```
div.capture-frame (portrait)
 ├─ video#vid              ← mirrored front-facing camera
 ├─ canvas#overlay         ← face outline + status drawing
 ├─ div#toast              ← inline copy for guidance
 └─ div#countdown          ← hold timer for the steady shot

div.challenge-panel        ← live prompt list + progress bar
div.preview-row            ← shows the captured still(s)
button#restart-btn         ← restarts the entire flow
```

## 2. Capture Pipeline (Current Logic)

1. **Load & Bootstrap**
   - `loadModel()` fetches the 2.8 MB MediaPipe Face Landmarker bundle from `/liveness/`.
   - After the model loads, `startCamera()` grabs the front camera and mirrors the feed.

2. **Alignment Stage**
   - User centers their face. The system checks three gates each frame:
     1. Face inside the oval (coarse positioning).
     2. Lighting score (average brightness 55–215, low asymmetry) — blocking condition.
     3. Evenness pill stays informational—only brightness issues block capture.
   - When the face stays centered for the 1 s countdown (`ALIGN_HOLD_MS`), the module snaps the first JPEG via `storeCapture(CAPTURE_TYPES.ALIGN_REFERENCE, …)`. This image seeds the **capture pack** (`captureFrames[0]`) and remains the `face_frame` default in the payload. The preview section appears immediately and shows this reference as the first thumbnail.

3. **Challenge Stage + Capture Pack**
   - Prompt order: `Turn head left` → `Turn head right`.
   - A challenge is marked done after the required yaw stays beyond ±16° for three consecutive frames.
   - **Task-side captures**
     - The same frame that finalizes a challenge also calls `captureTaskFrame()`.
     - This stores a sideways still (`type: "task_turn_left"`, etc.) so reviewers get proof that each motion was actually performed—not just the centered stills.
   - **Centered capture queue**
     - Each time a challenge completes, `scheduleCenterCapture(type, meta)` pushes a request onto `pendingCaptures`.
     - The main loop calls `attemptPendingCapture()` every frame. When the user is re-centered (`|yaw| ≤ CENTER_CAPTURE_YAW`, currently 6°) and lighting is passable, the pending request resolves.
     - Sequence for the current two-challenge flow now yields **five** frames:
       1. `align_reference` – captured during the initial hold.
       2. `task_turn_left` – grabbed the instant the left prompt meets yaw tolerance.
       3. `between_challenges` – captured while the user re-centers between the left and right prompts.
       4. `task_turn_right` – grabbed the instant the right prompt meets yaw tolerance.
       5. `post_challenges` – captured once both prompts are green and the user steadies for the completion countdown.
   - Each resolved capture appends to `captureFrames`, refreshes the preview gallery (thumbnails + log), and surfaces a toast (e.g., “Task – Turn Left saved” or “Centered frame saved – continue with the next prompt”).

4. **Payload Emission**
   - When both prompts finish, `finalize()` stops the camera and emits `liveness:captured`.
   - Payload fields of interest:

     ```json
    {
      "face_frame": "data:image/jpeg;base64,...",      // alias for capture_pack[0]
      "face_frames": [
        "data:image/jpeg;base64,...",   // align_reference
        "data:image/jpeg;base64,...",   // task_turn_left
        "data:image/jpeg;base64,...",   // between_challenges
        "data:image/jpeg;base64,...",   // task_turn_right
        "data:image/jpeg;base64,..."    // post_challenges
      ],
      "capture_pack": [
        { "type": "align_reference", "label": "Reference locked", "captured_at": "…", "lighting_score": 0.93 },
        { "type": "task_turn_left", "label": "Task – Turn Left", "captured_at": "…", "lighting_score": 0.90, "challenge": "turn_left" },
        { "type": "between_challenges", "label": "Between Turn Left → Turn Right", "captured_at": "…", "lighting_score": 0.89 },
        { "type": "task_turn_right", "label": "Task – Turn Right", "captured_at": "…", "lighting_score": 0.92, "challenge": "turn_right" },
        { "type": "post_challenges", "label": "Completion hold", "captured_at": "…", "lighting_score": 0.91 }
      ],
      "challenges": [{ "type": "turn_left", "status": "done" }, ...],
      "motion": { "yaw_left": ..., "yaw_right": ... }
    }
    ```

   - `face_frames` now mirrors every capture in `capture_pack`. If—despite the queue—the only valid still is the reference image, the array gracefully collapses to `[face_frame]`.
   - **Local saves (`server.py`)**
     - The dev server still listens for `POST /save`, but now iterates over the entire `face_frames` array.
     - Each entry is decoded and written to `production/web/captures/` as `{timestamp}_{index}_{capture_type}.jpg` (type slugified when present).
     - The accompanying `{timestamp}_meta.json` omits the large data URIs and instead records the capture metadata plus a `saved_frames` list describing the files that were persisted.

## 3. Known Limitations (As of Now)

1. **Re-centering Still Required** – Centered captures still depend on the user pausing near yaw ≈ 0°. If they lunge directly from one prompt to the next without passing through the center cleanly, that queued capture remains unresolved and the pack may skip that slot (the task-side frames still exist).
2. **Lighting Gate** – Only global brightness blocks progress. Uneven side lighting is tolerated (shows as a warning) and may produce lower quality secondary frames when users are partially shadowed.
3. **Static Thresholds** – `CENTER_CAPTURE_YAW` and `ALIGN_HOLD_MS` remain hard-coded; operators must edit the bundle to tune tolerances.
4. **No Failure Toast for Pending Captures** – The UI celebrates successful captures but still lacks an explicit warning when a queued capture times out before submission.

## 4. Next Steps (Suggested)

1. **Preview Both Frames** – Extend the preview row to show two thumbnails so operators can confirm both stills before continuing.
2. **Timeout Feedback** – If no centered frame is captured within *n* seconds after the left-turn, display a toast instructing the user to re-center before the right-turn prompt begins.
3. **Configurable Thresholds** – Expose `SECOND_CAPTURE_YAW` and `ALIGN_HOLD_MS` via `window` globals so ops teams can tune tolerances without editing the bundle.
4. **Audit Trail** – Attach metadata (`secondary_capture_at`) to the emitted payload for easier debugging downstream.

This markdown reflects the exact behaviour in the repository as of the latest commit. Any future adjustments to the capture cadence should update this file to keep ops documentation accurate.
--------------------------------------
 now the variant zipped here carries out full scan retuns up to 5 frames so we can use to match to picture from id 