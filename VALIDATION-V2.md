# Version 0.2 validation

Validated locally on 14 October 2026 against installed **Insta360 Studio 6.0.2.0**, Windows 11, Node 24.18.1, isolated Python 3.12.14 and FFmpeg 9.0. The actual stdio server handshake publishes **21 tools**. The original [version 0.1 evidence](VALIDATION.md) remains historical; this file records the expanded coverage.

## Checks and implementation

**98 automated checks pass:** 65 JavaScript checks and 33 Python native checks. JavaScript coverage includes real SDK stdio contracts, controller ownership/generation/token handling, native-process failure recovery and media-verification fixtures. One JavaScript regression also runs the installed FFmpeg against disposable synthetic media to reject empty mapped output. The remaining mocked tests establish implementation behavior, not successful Studio editing.

Commands completed:

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run test:native
npm.cmd run smoke -- --require-window
```

Independent real stdio media integration also passed metadata, quick decode, full decode/completion polling, wrong-width rejection, unchanged-checkpoint rejection, rejection of cancellation from another session and confirmed cancellation of this session's decoder. Reproduce using the existing disposable test files:

```powershell
npm.cmd run verify:integration -- 'C:\Projects\validation-media\export.mp4' 'C:\Projects\validation-media\source.insv'
```

Artifacts: `artifacts/smoke-v2-final.json`, `artifacts/media-integration-v2.json`, native/controller/protocol/media test source, and local `logs/actions.jsonl`. Runtime records are under `runtime/checkpoints/` and `runtime/jobs/`.

The upgrade adds hover; Ctrl/Shift/Alt mouse modifiers; bounded repeated keys; timed endpoint/polyline dragging with left/right/middle buttons; MP3/WAV/LRV import validation; readiness polling; metadata inspection; capability reporting; pre-export checkpoints; setting expectations; full asynchronous video/audio decoding; progress and owned cancellation. It repairs failed adapter recovery, nested dialog ownership, generation changes during awaited operations, original-error preservation and action correlation after cleanup failure.

Desktop input after an observation now invalidates the next native action before activation/input. A snapshot stores Windows' last-input tick and compares it initially for all eight input methods. It catches another client as well as physical input; it cannot distinguish their origin or catch every event during an action already running. Foreground, focus, ownership, geometry and point guards continue during actions. Keep the keyboard/mouse idle while the MCP operates.

## Actual 360 workflow

The source was copied before importing:

- Original: `<private original INSV>`.
- Test copy: `C:\Projects\validation-media\source.insv`.
- Size: 276,468,082 bytes; duration 10.777433 seconds; two HEVC 3840×3840 streams at 30000/1001 fps plus AAC audio.
- Original and copy SHA-256, before and after editing: `2425C7B352CC1396568E35BA5964FB77EDF1BC0E0CB9180D7BE1CE9D4CAEAC77`.

All editing input went through MCP tools. The copied INSV loaded into Local Media, produced a stitched flat preview and opened by double-click. `studio_hover` revealed the **Trim end (O)** tooltip. Seeking to `00:00:03:27` and pressing O visibly shortened the retained range. Two reframe keyframes were added at `00:00:00:00` and `00:00:03:21`; a three-point 900 ms drag changed yaw to +8.2°, and a 650 ms reverse drag changed the later keyframe to −3.5°. UI screenshots showed the keyframe markers, connecting interval and angle values.

The export dialog showed Video/16:9, 1920×1080, Match Source 29.97 fps, H.265 and Rec.709 10-bit. Qt filename entry and a verified Studio-owned Windows folder dialog set the destination. A checkpoint established that the intended output did not exist before the export action.

Output: **`C:\Projects\validation-media\export.mp4`**.

| Output evidence | Result |
| --- | --- |
| Size | 13,985,412 bytes |
| Duration | 3.937267 seconds, consistent with the trim |
| Video | HEVC, 1920×1080, 30000/1001 fps |
| Audio | AAC, stereo, 48 kHz; 3.925333 seconds |
| Pre-export checkpoint | Newly present file, exact path matched |
| Full video and audio decode | Completed; exit code 0, 118 frames, no decoder stderr |
| Quick verification | Passed; first second video/audio only |
| Incorrect expected width 720 | Rejected with WIDTH_MISMATCH |
| Existing-file baseline reused unchanged | Rejected with EXPORT_UNCHANGED |

Full decode job `27032850-4c5e-443e-a5d5-56ea2f232e29` completed through actual MCP polling. Four extracted export frames were inspected in `artifacts/v2-export-contact-sheet.png`; they showed the street footage across the retained interval without a black export. This is not a rigorous stitch-seam, stabilization-quality or audio-listening assessment. The edits and output prove this particular short flat-reframe workflow, not every camera mode, interpolation type or spherical 360 output.

UI evidence includes initial `artifacts/live-1.png` to `live-6.png` and the timestamped `live-2026-10-14T09-27-01-083Z-*.png` / `.jsonl`. Normal server calls do not persist screenshots; the developer client intentionally saved these local test captures.

## Actual Project workflow

Created a separate project **MCP v2 validation** through Studio's New Project dialog with 16:9 and Auto Match. Entered its name through guarded screenshot typing. Imported the disposable flat export and generated three-second `MCP-test-audio.wav` together through Studio's verified Open Files dialog. The Project library displayed both video and WAV tiles. A timed drag of the selected items placed video and original audio on the video track and the imported WAV on the added audio track. The Project preview and both timeline clips were visible.

Screenshots `artifacts/live-2026-10-14T09-55-25-949Z-8.png` to `-12.png` and the matching JSONL establish creation/import/placement. The isolated project remains available for further testing. **Project export, audible mixing/fades, text, transitions and complex timeline edits have not yet passed end-to-end validation.** MP3 and LRV are accepted by the guarded import surface but their actual Studio import was not exercised in this run.

On the final native adapter, RIGHT repeated three times changed the Media preview time from `00:00:03:21` to `00:00:03:24`, proving bounded key repeat and a normal action with the last-input guard active.

## Recovery and operational findings

Expired observation tokens were rejected without sending input, and the workflow recovered by observing the unchanged state. One Modify-folder click encountered a transient target-process verification failure; the result was treated as unknown, then a fresh observation showed the dialog had not opened. A newly observed click subsequently opened the owned folder dialog. There were no blind retries.

Manual typing also entered Studio's active destination/name fields during the test. The fields were re-observed/restored and the final output name/path verified before export. That finding triggered the last-input guard described above. Its rejection behavior is tested natively; deliberate real desktop interference was not injected in this run.

The independently registered MCP connection remains `insta360-studio` in the user's global Codex configuration. Actual SDK stdio clients verified version 0.2.0 and all 21 definitions. A client that already loaded version 0.1 may still show the previous 14 tools until its MCP connection is reloaded or Codex restarts. Registration alone is not the handshake evidence.

## Coverage boundaries

[CAPABILITIES.md](CAPABILITIES.md) and `capabilities.json` cover 27 documented task families with source URLs and restrictions. `studio_capabilities` combines this inventory with `validation-v2.json` so a generic UI route does not appear as an already-proven workflow.

Untested complete workflows include Deep Track, Movement, Auto Frame, speed effects, independent draft management, watermark/Stats, color/filter adjustments, resource/text/transition output, spherical 360 export, long/batch exports, camera/cloud imports and preferences. Default stitching produced the inspected preview/export; alternate stitching and stabilization settings were not tested. Installed-app restrictions still apply: the inventory records direct recording, multiple added audio tracks, gyroscope export and one-click AI editing as documented unsupported families.

The server does not expose arbitrary commands, arbitrary executable/process targets, authentication flows or external posting. All input remains scoped to the pinned Studio installation and its verified owned windows. Full decode confirms decoder success and stable file identity, not the correctness of artistic choices, audible quality or flawless stitching.
