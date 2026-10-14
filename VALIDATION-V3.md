# Version 0.3 validation

Validated locally on 14 October 2026 with Insta360 Studio **6.0.2.0**, Windows 11, Node 24.18.1, Python 3.12.14 and FFmpeg 9.0. The stdio server publishes **21 tools**. This record extends the [version 0.2 evidence](VALIDATION-V2.md); earlier records remain historical. Machine paths, window/action/job identifiers, raw screenshots and test media are excluded from this public record.

## Automated and client checks

**166 automated checks pass: 116 JavaScript and 50 native Python checks.** Syntax checks also pass. The checks cover strict real SDK stdio contracts, controller preferences and compact responses, native image-coordinate scaling, input and observation guards, adapter failures, export verification, setup, release checking and benchmark measurements. Mocked tests establish implementation behavior; the live workflows below provide separate Studio evidence.

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run test:native
```

The active Codex MCP connection called the version 0.3 server directly and used it for the Project workflow below. Claude Code connected through a user-scope stdio configuration, and an actual Claude Opus 5.5 run at high effort invoked `studio_status`, returning version 0.3.0 and the installed Studio version. A saved configuration alone is not this connection evidence. Claude session input, output and cache usage are not reported as MCP-only token consumption.

A separate fresh SDK session requested `include_text: "auto"` on the Studio Qt window. It returned a successful fresh 1600×1036 JPEG, physical dimensions 2520×1631, the returned-image coordinate contract and resolved `capture.include_text: false`, with no accessibility payload. This establishes the automatic Qt skip behavior through the actual stdio server, alongside its unit coverage.

## Efficient capture and response behavior

A second actual Claude Code run invoked `studio_observe` once with `include_text: "auto"`, received the 1600 x 1036 JPEG and correctly read the visible title as "MCP validation". No input tools or other tools were used in that run. This verifies image delivery and interpretation in Claude as well as the earlier status connection.

Default observation now returns a fresh JPEG at quality 85, resized down to a maximum width of 1600 pixels without upscaling. It reports image dimensions, physical dimensions, scale factors and format. Coordinates use the returned image's pixels and map once to physical window coordinates before ownership, foreground, geometry and point-hit checks. UI Automation element actions retain their separate native route.

Compact responses preserve the observation token, action ID, input delivery state and requirement to inspect the resulting frame. Capture preferences carry into after-action observations and readiness polling. Native Windows dialogs automatically receive accessibility inspection; Studio Qt windows skip it by default. An explicit `include_text: true` enables it. The skipped path omits both the tree and focused-control query. Expanded metadata and original PNG pixels remain available:

```json
{"include_text":true,"output_detail":"full","image_max_width":0,"image_format":"png"}
```

`studio_capabilities` defaults to a summary; a family request or `detail: "full"` supplies source and eligibility detail. Every capture remains fresh. No screenshot cache or automatic input replay was introduced.

## Local benchmark

Two completed runs each measured five sequential samples for all six profiles, with **30 successful requests and zero failures per run**. One captured the Project with footage visible; the other captured a black preview. The benchmark issued no editing input. The full comparison profile used original pixels, PNG, explicit accessibility inspection and expanded metadata; it is a diagnostic comparison, not the default operating profile.

Those two capture runs preceded the version 0.3 family evidence file, so their capabilities responses used the documented version 0.2 evidence fallback. The historical measurements below retain that state. A later metadata-only run with the current version 0.3 evidence measured five samples for each of four profiles: **20 successful requests and zero failures**, with no GUI captures or editing input.

The footage-visible run measured:

| Profile | P50 latency | Non-image protocol JSON characters | Encoded image bytes | Image pixels |
| --- | ---: | ---: | ---: | ---: |
| List tools | 2.004 ms | 17,703 | 0 | 0 |
| Status | 26.570 ms | 4,156 | 0 | 0 |
| Capabilities summary | 26.248 ms | 10,702 | 0 | 0 |
| Capabilities full | 25.197 ms | 51,240 | 0 | 0 |
| Default observation | 374.061 ms | 1,115 | 177,988 | 1,657,600 |
| Full PNG observation | 424.196 ms | 2,764 | 1,125,615 | 4,110,120 |

For this footage-visible sample, default observation used **84.2% fewer encoded image bytes**, **59.7% fewer pixels** and **59.7% fewer non-image JSON characters** than the full profile. Its P50 latency was **11.8% lower**. The black-preview run measured 379.988 ms default observation and 374.908 ms full observation; the default was slightly slower in that case, although its encoded image was smaller (121,819 versus 319,861 bytes). Content and desktop state affect the result.

The latest metadata-only run, using the current version 0.3 family evidence, measured:

| Profile | P50 latency | Non-image protocol JSON characters |
| --- | ---: | ---: |
| List tools | 1.818 ms | 17,703 |
| Status | 30.175 ms | 4,156 |
| Capabilities summary | 31.221 ms | 10,714 |
| Capabilities full | 31.048 ms | 52,392 |

The current capabilities summary used **79.6% fewer non-image JSON characters** than full detail. The earlier fallback run measured 79.1%; current family evidence adds detail without increasing the number of tools.

An earlier exploratory run retained two rejected default observations: `scope_denied` and `manual_input_detected`. That run had three successful default samples out of five and is not reported as a performance success. These guards stayed active; the tests do not establish what caused the desktop state to change. The later completed runs do not erase those failures.

Measurements include the JSON-RPC result wrapper, including duplicated text/structured fields, and distinguish encoded image bytes from non-image JSON. Five samples per profile provide local comparisons, not a prediction for other hardware or end-to-end model interaction. Initial status includes native startup. The benchmark's characters-divided-by-four text estimate is a heuristic. **Actual Codex/Claude billed tokens, image tokenization, prompts and cached context were not measured.** Compression alone does not establish an exact token saving.

Reproduce metadata requests without GUI capture, or opt into fresh observations on an idle desktop:

```powershell
npm.cmd run benchmark -- --samples 5
npm.cmd run benchmark -- --samples 5 --observe --output artifacts/benchmark-local.json
```

Private reports remain in the ignored artifacts folder. Portable benchmark summaries are also recorded in [validation-v3.json](validation-v3.json).

## Live Project workflow with compact defaults

Reopened the isolated **MCP v2 validation** project. Its timeline already contained the disposable flat reframe export and a separately added generated WAV, as recorded in version 0.2. Through the actual Codex MCP tools, opened Text > Basic, added a title, inspected the selected text field, then used guarded screenshot typing with explicit replacement to set **MCP validation**. The after-action frame showed the edited title.

Set the exact new export filename and destination through Studio's export dialog. Its owned Windows folder picker received automatic accessibility inspection; `studio_set_value` set the destination field, the returned value was checked, and the observed Select Folder control accepted it. A pre-export checkpoint established that the intended output did not exist. All input remained scoped to verified Studio-owned windows and used fresh observation tokens and the returned-image coordinate contract.

The short Project export passed explicit 1920×1080, 30 fps, H.264 and audio expectations. Asynchronous full verification was polled to successful completion:

| Output evidence | Result |
| --- | --- |
| File size | 13,715,884 bytes |
| Video duration | 3.966667 seconds |
| Video | H.264, 1920×1080, 30 fps |
| Audio | AAC, stereo, 48 kHz; 3.946833 seconds |
| Checkpoint | File absent before export, present afterward at the intended destination |
| Full video and audio decoding | Completed; FFmpeg exit 0, 119 video frames |
| Local decoder elapsed time | 621 ms |
| Extracted frame at one second | Inspected; shows the title MCP validation over the footage |

The timeline and AAC/full decode provide evidence of track placement and decodable Project audio. Audible mixing, relative levels, fades and denoising were not assessed. The inspected frame proves the title in this output; it does not validate every text style, font, animation or transition. Changed file identity and successful decoding alone do not prove the correctness of every intended edit.

Version 0.2's copied-source INSV import, trim, two reframe keyframes, flat Media export, quick/full decoding, wrong-setting and unchanged-output rejection, and owned cancellation remain separate historical live evidence. They were not all repeated in version 0.3. Source preservation was checked again: the original INSV and isolated copy still share SHA-256 `2425C7B352CC1396568E35BA5964FB77EDF1BC0E0CB9180D7BE1CE9D4CAEAC77`, matching the recorded pre-edit baseline.

## Coverage and remaining work

The 21 tools have passing protocol and implementation checks, and the recorded workflows exercise real Studio input and export. This does **not** establish all 27 documented task families as complete workflows. [validation-v3.json](validation-v3.json) records **11 partially live tested families, 12 without complete live tests and 4 documented unsupported families**.

Remaining workflows include complex timeline edits, speed effects, transitions, draft management, Deep Track, Movement, Auto Frame, alternate stitching/stabilization settings, color/noise adjustments, watermark/Stats, spherical export, long/batch export, camera/cloud imports, MP3/LRV actual imports and preferences. Direct recording, multiple added audio tracks, gyroscope export and one-click AI editing remain documented Studio restrictions. Source qualifications and eligibility limits remain in [CAPABILITIES.md](CAPABILITIES.md) and `capabilities.json`.

No Facebook posts, group joins or administrator messages were made. The MCP exposes no external posting or arbitrary shell/process tools.

## Public package verification

A fresh clone of the initial public code commit matched all 38 allowlisted files after line-ending normalization. Locked Node installation, syntax checks, the SDK handshake and 50 native checks passed. Its JavaScript suite reported 115 passes, one optional real-FFmpeg check skipped, and zero failures; the local configured suite above passed all 116. No private configuration, media or credentials were included.

The first hosted Windows run exposed Node 20 treating `tests/*.test.mjs` as a literal filename. The package test command now names all seven JavaScript test files explicitly. The changed command passed all 116 local JavaScript checks. Hosted CI status is available in [GitHub Actions](https://github.com/MuhammdQasim/insta360-studio-mcp/actions/workflows/ci.yml); hosted checks use no Studio UI.
