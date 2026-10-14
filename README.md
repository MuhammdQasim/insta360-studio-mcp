# Insta360 Studio MCP

An unofficial, local [Model Context Protocol](https://modelcontextprotocol.io) server that lets an MCP client such as Codex or Claude Code observe and operate the **Insta360 Studio** desktop app on Windows.

**Version:** 0.3.0
**Platform:** Windows only
**License:** MIT

> This project is not affiliated with, endorsed by, or supported by Insta360.

---

## Contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Setup](#setup)
- [Client configuration](#client-configuration)
- [Tools](#tools)
- [Observation contract](#observation-contract)
- [Safety model](#safety-model)
- [Operating guidance](#operating-guidance)
- [Testing](#testing)
- [Benchmark](#benchmark)
- [Validation status](#validation-status)
- [Limitations](#limitations)
- [Repository contents](#repository-contents)
- [License](#license)

---

## How it works

- A **Node.js stdio MCP server** (`src/server.mjs`) talks to the MCP client.
- A **Python adapter** runs in the project's own `.venv` and uses Win32, `pywinauto`, and Pillow. It captures windows and delivers input.
- The server targets one pinned executable:

  ```
  C:\Program Files\Insta360 Studio\Insta360 Studio.exe
  ```

- It acts only on windows and dialogs owned by that executable path.

The server runs locally. It does not include a network service.

## Requirements

| Component | Requirement |
|---|---|
| OS | Windows |
| Insta360 Studio | Installed at the pinned path above. Tested with **6.0.2.0**. |
| Node.js | 20 or later |
| Python | 3.10 or later, **64-bit** |
| FFmpeg / FFprobe | Optional. Needed only for media inspection and decode verification. |

## Setup

The examples below use `C:\Projects\insta360-studio-mcp` for the source and `C:\Tools` for external binaries. Replace these with your own paths.

### 1. Get the source

Place the source in a local folder, for example `C:\Projects\insta360-studio-mcp`.

### 2. Run the setup script

From PowerShell in the project folder:

```powershell
.\setup.ps1
```

The setup script does the following:

- Installs the locked Node dependencies.
- Installs the pinned Python dependencies into the project's own `.venv`.
- Selects Python in this order:
  1. An explicitly specified Python.
  2. An installed Python.
  3. An optional bundled fallback.

  Use `.\setup.ps1 -PythonExe 'C:\Tools\Python\python.exe'` to select an interpreter.
- Preserves an existing valid `config.local.json`, including custom FFmpeg paths.

To validate the environment without installing or writing anything:

```powershell
.\setup.ps1 -CheckOnly
```

### 3. Configure FFmpeg (optional)

You only need this step for media inspection and export decode verification.

1. Copy `config.example.json` to `config.local.json`.
2. Set **absolute** paths to `ffmpeg.exe` and `ffprobe.exe` in the fields shown in the example file. For example:

   ```
   C:\Tools\ffmpeg\bin\ffmpeg.exe
   C:\Tools\ffmpeg\bin\ffprobe.exe
   ```

## Client configuration

Both clients launch the server over stdio. The paths below are examples only.

### Codex

```powershell
codex mcp add insta360-studio -- 'C:\Program Files\nodejs\node.exe' 'C:\Projects\insta360-studio-mcp\src\server.mjs'
```

### Claude Code

```powershell
claude mcp add --transport stdio --scope user insta360-studio -- 'C:\Program Files\nodejs\node.exe' 'C:\Projects\insta360-studio-mcp\src\server.mjs'
```

After you install or upgrade the server, **restart the client**. Otherwise the client may keep showing an older tool schema.

## Tools

The server registers **21 tools**. They are grouped below by family. Your client's tool listing is the authoritative source for exact names and schemas. The exact schemas are defined in `src/tools.mjs`.

| Family | Tools |
|---|---|
| Session and windows | `studio_status`, `studio_launch`, `studio_list_windows`, `studio_select_window`, `studio_wait_ready` |
| Observation | `studio_observe`, `studio_wait` |
| Input | `studio_click`, `studio_press_key`, `studio_type_text`, `studio_set_value`, `studio_drag`, `studio_scroll`, `studio_hover` |
| Media | `studio_import_media`, `studio_media_info` |
| Export verification | `studio_verify_export`, `studio_export_checkpoint`, `studio_verification_status`, `studio_cancel_verification` |
| Discovery | `studio_capabilities` |

## Observation contract

The server is built around one rule: **look, act once, look again.**

### Fresh captures

- Every observation is a fresh capture.
- There is no screenshot cache, no macro system, and no blind retry.

### Default output

- The image is JPEG at quality 85 with a maximum width of 1600 px.
- Images are only ever downscaled, never upscaled.
- The text summary is compact.

### `include_text`

- **Default (`'auto'`):** text is included for native Win32 dialogs (class `#32770`) and omitted for Studio's Qt windows.
- **Explicit `true` / `false`:** the setting persists for later calls.
- **`include_text: 'auto'`:** resets to the default behaviour.

### Full-detail opt-in

Pass all of the following to get the full original image and full text:

```json
{ "output_detail": "full", "image_max_width": 0, "image_format": "png", "include_text": true }
```

### Coordinates

- `x` / `y` arguments use **pixels of the returned image**. The server maps them internally to physical screen coordinates, behind a guard.
- UI Automation tree bounds use **physical desktop coordinates**. To target an element from the tree, pass its `element_id` instead of raw coordinates.

### Tokens and after-state

- Each observation issues a **single-use token** that is valid for **120 seconds**. Actions require a current token.
- Every action returns a fresh after-state.
- Inspect the returned image at each step before you choose the next action.

### Input delivery is not the same as an edit

An "input delivered" flag means the input reached the window. It does **not** prove that Studio applied the edit. Confirm the result from the after-state.

### Typing into a field identified from a screenshot

1. Click the visible field.
2. Inspect the after-state to confirm focus or a caret.
3. Call `studio_type_text` with `focus_mode: 'screenshot'`.

Calling `studio_observe` between steps 1 and 3 invalidates the focus anchor. If that happens, click the field again.

## Safety model

### Scope

- Actions are limited to windows and dialogs owned by the pinned Studio executable path.

### Guards before each input

The server checks:

- Foreground window
- Window geometry
- Hit-test target
- Manual-input interference

### Concurrency

- A mutex prevents concurrent instances from sending input at the same time.
- Requests are serialized.

### Logging and data handling

- Literal typed text and set values are **hashed** in logs.
- Screenshots are not persisted during normal operation.

### Media import

- Import checks that the file is a local file with an accepted extension.
- Import does **not** check whether Studio supports that file for a given camera or mode.

## Operating guidance

- Keep the desktop unlocked while the server is capturing or sending input.
- Run Studio as an ordinary, non-administrator process.
- Do not use the mouse or keyboard yourself during capture or input. The manual-input guard will reject the action.

## Testing

Run these from the project folder:

```powershell
npm.cmd run check          # static checks
npm.cmd run test           # JavaScript tests
npm.cmd run test:native    # native adapter tests
```

### Smoke test

The `--require-window` smoke test requires a running Studio window:

```powershell
npm.cmd run smoke -- --require-window
```

### Continuous integration

The [Windows CI workflow](https://github.com/MuhammdQasim/insta360-studio-mcp/actions/workflows/ci.yml) runs syntax checks, unit tests and a GUI-free MCP handshake. GitHub Actions shows its latest result. The optional real FFmpeg test requires configured local binaries and may be skipped in a clean environment.

## Benchmark

### Running the benchmark

By default, the benchmark does not touch the GUI:

```powershell
npm.cmd run benchmark
```

To run explicit capture samples, use the command below. This **activates Studio** and takes screenshots.

```powershell
npm.cmd run benchmark -- --samples 5 --observe --output artifacts\benchmark.json
```

### Recorded local result

Conditions: 5 fresh requests per profile, same footage, same window.

| Metric | Default profile | Full profile (original PNG + UIA, full detail) |
|---|---|---|
| Median latency | 374.06 ms | 424.20 ms |
| Encoded image bytes | 177,988 | 1,125,615 |
| Image pixels | 1,657,600 | 4,110,120 |
| Non-image protocol JSON chars | 1,115 | 2,764 |


With current v3 workflow evidence loaded, capability summaries use 10,714 protocol JSON characters versus 52,392 for full capability details.

### How to read these numbers

- The sizes are **MCP protocol payload sizes**. They are **not billed tokens**.
- A characters-divided-by-4 estimate leaves out image billing, caching, and prompt content. It does not measure cost.
- These are 5 local samples on one machine. They are not a guarantee for other machines, displays, or projects.
- Earlier runs in which guards rejected captures because of desktop interference are kept in private evidence. They are not included above.

## Validation status

### Canonical records

- [VALIDATION-V3.md](VALIDATION-V3.md)
- [validation-v3.json](validation-v3.json)

Older V1 and V2 records are kept for history only.

### Verified locally

- **Automated checks:** 166 checks pass (116 JavaScript and 50 native).
- **Codex:** edits were performed through actual Codex tool calls.
- **Claude Code:** actual tool-call status was verified with the official CLI.

### Live run 1

1. Imported an isolated copy of an INSV file.
2. Applied a trim.
3. Set a yaw keyframe.
4. Ran a flat export.

### Live run 2

1. Reopened an isolated project containing video and a WAV file, then added and edited a basic title through the MCP.
2. Exported at 1080p30 with H.264 video and AAC audio.
3. Decoded all 119 frames of the output.
4. Inspected a decoded frame.

## Limitations

### Test coverage

- The live runs above **do not** cover all 27 task families.
- Spherical export, batch export, deep tracking, and other workflows are **untested**.
- Features that are officially unsupported are listed in the [capabilities document](CAPABILITIES.md).

### Platform and version

- **Windows only**, with one pinned install path.
- Tested against Studio **6.0.2.0** only. Other versions may change the UI and break automation.

### Behaviour by design

- There is no macro playback, no blind retry, and no observation cache. Each step needs a fresh observation.
- Input delivery does not confirm an edit. Verify each change from the after-state.

### Other

- Media import does not check camera or mode eligibility.
- Benchmark figures are local measurements, not token or billing figures.
- CI runs without an installed Studio app and does not replace the live workflow tests.

## Repository contents

The repository contains **source code only**.

Do not commit any of the following:

- Media files
- `config.local.json`
- Logs
- `.venv`
- `artifacts/`

## License

MIT. Copyright (c) 2026 Muhammd Qasim.

Insta360 Studio MCP is an independent, unofficial project. It is not affiliated with or endorsed by Insta360.
