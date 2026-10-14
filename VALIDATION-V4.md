# Insta360 Studio MCP v0.4.0 validation

Checked on 2026-10-14 with installed Insta360 Studio 6.0.2.0. The source server and native adapter report 0.4.0 and expose 21 tools. This record adds short spherical and Deep Track exports and a bounded capture comparison. It preserves prior workflow evidence without treating generic UI access or unit tests as proof of every Studio task.

## Automated checks and client versions

Syntax checks passed. There are 127 passing JavaScript tests and 50 passing native tests, for 177 passing automated checks. These cover tool contracts, projection expectations, playable-stream mapping and existing transport, input, capture and verifier safeguards. They do not establish all 27 complete Studio workflows.

The active Codex MCP session still reports **0.3.0**. It performed the observed spherical and Deep Track Studio UI workflows using opt-in returned images at 960 pixels wide; the default remains 1600. A fresh SDK stdio session running source **0.4.0** initialized, listed all 21 tools, performed spherical metadata and full verification, verified the Deep Track output, rejected the flat projection fixture and measured the captures below. The unchanged UI contracts were exercised by the older active client, so this does not claim a reloaded v0.4.0 Codex UI session.

A fresh official Claude Code 2.1.285 run used Claude Opus 5.5 with high effort and an isolated MCP configuration. It issued exactly one `studio_status({})` call and received server/native **0.4.0**, Studio **6.0.2.0** and a successful result. It used no GUI, capture or input tools. Its 5.724-second client/model duration is not a capture benchmark or MCP-only token measurement. Prior v0.3.0 client evidence remains in [VALIDATION-V3.md](VALIDATION-V3.md).

Restart or reload the Codex and Claude MCP sessions, then check `studio_status` for server/native version 0.4.0 before relying on `expected_projection`. An updated source file alone does not refresh an already-running client process.

## Short spherical export

The isolated camera-media copy was exported from the Media page to the new portable output filename `MCP-v4-spherical.mp4`. A pre-export checkpoint recorded the intended output as absent. After export, Task Center visibly showed a successful record for that filename, **97.79 MB** and **00:00:04**. The observed UI, checkpoint and inspected output are separate evidence; file change alone would not establish Studio authorship.

| Check | Observed result |
| --- | --- |
| Output size | 102,536,824 bytes |
| Video | HEVC, 4320 x 2160, 30000/1001 FPS |
| Video/container duration | 3.937267 seconds |
| Declared spherical mapping | Unambiguous `equirectangular` FFprobe stream side data |
| Declared yaw/pitch/roll | 0 / 0 / 0 |
| Audio | AAC stereo, 48 kHz, 3.925333 seconds |
| Full video/audio verification | `completed`, `ok: true`, FFmpeg exit code 0 |
| Decode evidence | 118 frames; 2,653 ms elapsed |

The full job was polled to completion, with final unchanged-file checks. Root visually inspected panorama frames at **0.5 and 3 seconds**: both show the expected stitched 2:1 environment with sky, ground and people, and typical equirectangular distortion. This is a two-frame check. It does not establish seam quality, complete spherical coverage, every intended edit or VR headset playback.

The optional `expected_projection: "equirectangular"` check relies on parsed `Spherical Mapping` stream side data. It rejects missing, unknown or ambiguous declarations as `EXPECTATION_UNVERIFIABLE` and known alternative projections as `PROJECTION_MISMATCH`. Dimensions and free-form tags do not qualify. Quick decode maps the same playable video stream whose metadata was checked; full decode maps all playable video streams and available audio, excluding attached cover pictures. Unknown or unsafe playable stream indices are rejected before decoding.

A real **1280 x 640**, one-second H.264 fixture had `spherical_mapping.status: "unknown"`. Its 2:1 dimensions did not satisfy `expected_projection: "equirectangular"`; the v0.4.0 MCP returned `EXPECTATION_UNVERIFIABLE`.

## Fresh capture comparison

The comparison used one unchanged Studio Home screen. It measured capture requests, not editing, export rendering or end-to-end model work. Neither client issued editing input during this benchmark.

| Capture API/profile | Returned image | Encoded image bytes | Measured samples | Median request time |
| --- | --- | --- | --- | --- |
| Official Computer Use `get_window_state` | 1160 x 714 | 66,125 | 5 retained | 148.1555 ms |
| MCP JPEG width 960 | 960 x 591 | 57,137 | 5 after warmup | 342.331 ms |
| MCP JPEG width 1280 | 1280 x 788 | 87,856 | 5 after warmup | 348.377 ms |
| MCP JPEG width 1600 | 1600 x 985 | 121,672 | 5 after warmup | 351.503 ms |

All 15 measured MCP captures succeeded. One warmup per profile was excluded: 394.097, 349.3806 and 357.3202 ms, respectively. SDK initialization was measured separately at 186.9199 ms. The MCP requested a 250 ms settle, JPEG quality 85, compact detail and `include_text: "auto"`; the resolved Qt setting was false, so UIA was skipped. Each capture was fresh; no image cache was used.

The Computer Use result retains all five measured samples, including its **1009.4475 ms** first sample. The other samples were 132.2648, 152.8441, 148.1555 and 118.059 ms. A separate initial capture took 546.9901 ms and was not one of those five samples.

These timing boundaries differ. Computer Use was timed inside its official Sky API call, excluding outer tool transport and model time. MCP timing includes its SDK request, settle, ownership/focus/input checks, image encoding and stdio transport; it also excludes model inference and the outer tool invocation. Computer Use can capture occluded windows; the Studio MCP retains foreground and input-activity requirements. **No overall speed benefit was demonstrated.** Computer Use had the lower measured capture median in this small comparison. One Home screen and five samples per profile cannot establish editing-task performance.

### Conditional visual-token illustration

Anthropic currently documents 28 x 28 visual patches: `ceil(width / 28) * ceil(height / 28)`. On the documented high-resolution tier, the unchanged images above fit the limits and give the following conditional estimates. Other tiers, model choices or client resizing can change the result. [Anthropic Vision documentation](https://platform.claude.com/docs/en/build-with-claude/vision).

| Image | Conditional visual tokens |
| --- | --- |
| MCP 960 x 591 | 770 |
| Computer Use 1160 x 714 | 1,092 |
| MCP default 1600 x 985 | 2,088 |

The 960-wide image is about **29.5%** below the Computer Use image in this conditional patch calculation: 322 fewer visual tokens, or **6,440 fewer across 20 copies of these same Home images**. The default 1600-wide image is higher than Computer Use in this calculation. Small labels must remain readable; request more detail when needed.

These are image-only estimates, **not measured billed Codex or Claude tokens**. They exclude prompts, tool definitions, response text, cache behavior, repeated context and client preprocessing. Encoded JPEG bytes are a transport measure, not a model-token count. No overall token saving across a complete editing task is established here.

## Deep Track workflow and flat export

The first attempt encountered **"Cannot apply Deep Track on keyframes"**. Both existing keyframes were removed on the isolated test copy. An initial seated target later became obscured; its track was removed, the baseline was reframed and a clearly visible operator was selected as the new target. These observations remain part of the result; they do not establish general occlusion recovery.

The selected target completed the tested short workflow. Studio showed a full green tracking timeline and the **Delete Deep Track** control. UI previews at **0, 5 and 10.7 seconds** retained the same person. Task Center showed the new `MCP-v4-deep-track.mp4` export as successful, **35.00 MB** and **00:00:11**. A pre-export checkpoint recorded that output as absent.

| Check | Observed result |
| --- | --- |
| Output size | 36,696,011 bytes |
| Flat video | HEVC, 1920 x 1080, 30000/1001 FPS |
| Measured video/container duration | 10.677333 seconds |
| Audio | AAC stereo, 48 kHz, 10.666667 seconds |
| Full video/audio verification | `completed`, `ok: true`, FFmpeg exit code 0 |
| Decode evidence | 320 frames; 1,446 ms elapsed |

The supplied expected duration was **10.777433 seconds**, with an explicit **0.15-second tolerance**. The selected GUI range produced an output **0.100100 seconds, or three frames, shorter**. It passed that tolerance; it is not an exact full-source duration match.

Root inspected exported frames at **0.25, 3, 5 and 10 seconds**. The same green-shirt/glasses operator remains near frame center despite camera yaw, pitch and height changes. Together with the UI previews and completed decode, this verifies the specific short tracking/export case. It does not establish every frame's target accuracy, other subjects, sustained occlusion recovery, longer footage or Project-page variants. Earlier Cancel and `manual_input_detected` rejections remain historical safeguards, not successful tracking evidence.

## Workflow coverage and remaining checks

[validation-v4.json](validation-v4.json) preserves all 27 source-qualified families. Eleven partial workflows from V3 remain historical evidence. This run adds specific partial evidence for spherical output, Task Center and Deep Track, giving **14 partially live-tested, 9 not live-tested and 4 documented unsupported** families. Export and Deep Track remain partial task families because the evidence covers specific short cases. Other family statuses and restrictions are inherited from [validation-v3.json](validation-v3.json).

Spherical 2:1 Project editing, Reorient, 360 Monitor, VR presets and headset playback remain unverified. Long/batch exports, full stitching-quality assessment and the other untested families also remain open.

## Preservation and release state

The executable/ownership, foreground/focus/geometry, point-hit, single-use-token, native-generation and cross-client input-activity guards remain in place. Captures remain fresh, with no blind input replay. Input delivery and a completed editing operation remain separate evidence.

Root completed the final V4 hash recheck. Original camera media, the isolated V2 copy and the fresh advanced V4 copy all remain byte-identical to the prior recorded baseline. All three have SHA-256 `2425C7B352CC1396568E35BA5964FB77EDF1BC0E0CB9180D7BE1CE9D4CAEAC77`. Removing edit keyframes and changing tracking on the isolated test copy did not change these source-file bytes.

Facebook posts, group joins and administrator messages remain **zero**, held per the user's instruction. This document records local checks. Publication and remote CI are checked separately for the published revision; inspect its [Windows Actions run](https://github.com/MuhammdQasim/insta360-studio-mcp/actions/workflows/ci.yml). CI performs automated checks without Studio and does not replace the live workflows above.

The public evidence uses portable filenames and summaries. Private reports, screenshots, machine paths, window identifiers, session identifiers and observation tokens are excluded.
