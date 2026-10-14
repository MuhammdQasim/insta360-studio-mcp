# Validation on this computer

Validated on 14 October 2026, Asia/Karachi. This records observed local results, not a guarantee about every Studio feature.

## Installation and connection

- Installed application: Insta360 Studio 6.0.2.0, verified from the executable version and Windows installation record.
- Executable: `C:\Program Files\Insta360 Studio\Insta360 Studio.exe`.
- MCP identity: `insta360-studio` version `0.1.0`, local stdio transport, 14 tools.
- A real MCP SDK client completed initialization, listed tools, read native status and captured a running Studio window with an inline PNG. Final connection evidence is in ignored `artifacts/smoke-final.json`.
- Registered globally through `codex mcp add insta360-studio`; `codex mcp get insta360-studio --json` confirmed the executable/server paths, enabled state, 20-second startup timeout and 90-second tool timeout.
- Previous Codex configuration was backed up to `<local Codex configuration backup>`. Existing settings remained semantically equal; the Codex CLI omitted explicit default `enabled=true` and empty `args=[]` values for two existing entries.
- The current chat's original tool catalog does not establish that the newly registered tools have loaded into the desktop client. Restart Codex to load them; the external MCP connection itself has already been tested live.

## Automated checks

- 13 JavaScript controller/SDK protocol tests passed: strict schemas, unknown argument rejection, 14-tool registration, click target validation, serialization, inline images/errors, foreign-window rejection, token expiry/single use, coordinate bounds, scroll mapping, dialog requirements, editable focus, click-anchored screenshot typing and rejection when a new modal appears after an observation.
- 4 Python native guard tests passed: forbidden desktop/switching shortcuts, literal text/key parsing, foreign executable refusal, Win32 input structure/key-up flags.
- JavaScript syntax, Python compilation and PowerShell setup-script parsing passed.
- A real two-process kernel-mutex check proved exclusion while the first adapter owned the lock and automatic recovery after the owning process was terminated. This check sent no application input.
- Node dependency audit reported zero vulnerabilities at installation. Python dependencies are pinned in `requirements.txt`; Node dependencies are locked in `package-lock.json`.

## Live Studio workflow

All editing input below was sent through the new MCP server and its own Windows adapter. Earlier inspection used the Computer Use plugin to establish the installed app/menu behavior.

1. Created a disposable synthetic test source: `artifacts/MCP-Test-Source.mp4`, 640x360, 30 fps, three seconds. No user source footage was edited.
2. Sent Studio's observed `CTRL+O` shortcut. Selected and observed the verified Studio-owned `Open Files` dialog when needed.
3. `studio_import_media` identified the dialog's filename edit through UI Automation, entered the existing absolute path, verified value/focus and submitted Open. The returned Studio screen showed the imported test clip. After correcting a post-input dialog timing issue, the import returned success and a fresh screenshot/token. `artifacts/import-confirmed.png` records the resulting screen.
4. Double-clicked the test clip using screenshot-relative coordinates; Studio opened its media preview. Keyboard input and fresh result capture worked.
5. Sent `CTRL+E`, opened the export dialog, clicked Modify, set an accessible Folder field, and clicked Select Folder. The export folder was isolated under `artifacts/exports`.
6. Clicked Export and produced `artifacts/exports/MCP-Test-Source.mp4`. Before the click, the target file was confirmed absent.
7. `studio_verify_export` confirmed the stable file and playable media: 396,183 bytes, H.264 640x360 video, AAC audio, duration about 3.033333 seconds. FFprobe metadata plus first-second video decode passed.
8. A separate full-file FFmpeg decode of the three-second export exited successfully with no decode errors.
9. Tested the custom Qt filename field: clicked its visible edit area, visually confirmed a caret, and used `studio_type_text` with screenshot focus mode and `replace=true`. The screenshot showed the exact new value `MCP-Typing-Test.mp4`. `artifacts/qt-typing-confirmed.png` records this. The dialog was closed without exporting a second file.
10. An expired observation token was rejected during live testing before any input was delivered; re-observation restored normal operation.

The sample clip and its derived export remain in the ignored local artifacts folder. Studio's export-folder preference now points to that test export folder because the folder selection was tested. Choose the intended project output folder for subsequent real editing.

## Coverage limits

Studio's custom Qt editing screen exposed only its top-level window to UI Automation. Screenshot-based inputs are necessary for most of these controls. File/folder dialogs exposed usable accessible elements.

Real `.insv` stitching/stabilization, keyframe creation, 360 reframing, trimming, drag/scroll behavior on specific editing panes, project timelines and long/batch exports have not been validated on real footage in this implementation run. Generic tools exist for the required mouse/keyboard operations; semantic workflow success must be established through the actual resulting Studio screen and output.

Normal screenshots capture visible desktop pixels after foregrounding Studio. Keep the desktop unlocked, avoid other manual input during an operation, and re-observe after unexpected changes. Coordinate guards reject moved/resized windows and points covered by another window; they cannot infer which editing control the operator intended.

`studio_verify_export` checks a stable file, container metadata and first-second video decode. It does not fully decode long exports or, by itself, prove that Studio created a pre-existing file. Use the export's observed creation, expected duration/settings and appropriate full-file/visual/audio checks for real delivery.
