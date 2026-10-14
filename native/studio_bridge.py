"""Studio-only Windows UI adapter. JSON lines on stdin/stdout; no UI work on import.

This is an ordinary Win32/UIA implementation. It does not depend on or emulate
Codex Computer Use helpers, transports, approval metadata, or private protocols.
"""
from __future__ import annotations

import argparse
import base64
import ctypes
from ctypes import wintypes
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import time
import uuid


STUDIO_EXE = r"C:\Program Files\Insta360 Studio\Insta360 Studio.exe"
MAX_REQUEST_BYTES = 1_048_576
MAX_TEXT_LENGTH = 16_384
SNAPSHOT_TTL = 120.0
ADAPTER_VERSION = "0.3.0"
MOUSE_BUTTONS = {"left": (0x0002, 0x0004), "right": (0x0008, 0x0010),
                 "middle": (0x0020, 0x0040)}


class BridgeError(Exception):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


def _integer(value, label, minimum=None, maximum=None):
    if isinstance(value, str) and value.isdecimal():
        value = int(value)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise BridgeError("invalid_argument", f"{label} must be a finite integer")
    if int(value) != value:
        raise BridgeError("invalid_argument", f"{label} must be an integer")
    value = int(value)
    if minimum is not None and value < minimum or maximum is not None and value > maximum:
        raise BridgeError("invalid_argument", f"{label} is outside the allowed range")
    return value


def _text(value, label="text", limit=MAX_TEXT_LENGTH):
    if not isinstance(value, str) or len(value) > limit or "\x00" in value:
        raise BridgeError("invalid_argument", f"{label} must be text of at most {limit} characters without NUL")
    return value


def _canonical(path):
    return os.path.normcase(os.path.realpath(os.path.abspath(path)))


ULONG_PTR = ctypes.c_size_t


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG),
                ("mouseData", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("dwExtraInfo", ULONG_PTR)]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD),
                ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD),
                ("dwExtraInfo", ULONG_PTR)]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [("uMsg", wintypes.DWORD), ("wParamL", wintypes.WORD), ("wParamH", wintypes.WORD)]


class INPUT_UNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", INPUT_UNION)]


class POINT(ctypes.Structure):
    _fields_ = [("x", wintypes.LONG), ("y", wintypes.LONG)]

class GUITHREADINFO(ctypes.Structure):
    _fields_ = [('cbSize', wintypes.DWORD), ('flags', wintypes.DWORD),
                ('hwndActive', wintypes.HWND), ('hwndFocus', wintypes.HWND),
                ('hwndCapture', wintypes.HWND), ('hwndMenuOwner', wintypes.HWND),
                ('hwndMoveSize', wintypes.HWND), ('hwndCaret', wintypes.HWND),
                ('rcCaret', wintypes.RECT)]


class LASTINPUTINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]


MODIFIERS = {"ctrl": 0x11, "control": 0x11, "control_l": 0x11,
             "shift": 0x10, "shift_l": 0x10, "alt": 0x12, "alt_l": 0x12}
KEYS = {"enter": 0x0D, "return": 0x0D, "tab": 0x09, "esc": 0x1B,
        "escape": 0x1B, "space": 0x20, "backspace": 0x08,
        "delete": 0x2E, "del": 0x2E, "insert": 0x2D,
        "left": 0x25, "up": 0x26, "right": 0x27, "down": 0x28,
        "home": 0x24, "end": 0x23, "pageup": 0x21, "prior": 0x21,
        "pagedown": 0x22, "next": 0x22, "period": 0xBE,
        "comma": 0xBC, "minus": 0xBD, "equal": 0xBB,
        "slash": 0xBF, "semicolon": 0xBA, "apostrophe": 0xDE,
        "bracketleft": 0xDB, "bracketright": 0xDD, "backslash": 0xDC}
KEYS.update({f"f{i}": 0x6F + i for i in range(1, 13)})
EXTENDED_KEYS = {0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E}
FORBIDDEN_KEYS = {"win", "windows", "super", "super_l", "super_r", "meta", "cmd", "command", "lwin", "rwin"}


def parse_key_chord(value):
    """Strict key parser: no pywinauto key-string interpretation or shell keys."""
    value = _text(value, "key", 100)
    parts = [part.strip().lower() for part in value.split("+")]
    if not parts or any(not part for part in parts) or len(parts) > 4:
        raise BridgeError("invalid_argument", "Use one key and optional Ctrl/Shift/Alt modifiers")
    if any(part in FORBIDDEN_KEYS for part in parts):
        raise BridgeError("forbidden_key", "Windows and Meta keys are not available")
    mods = []
    for part in parts[:-1]:
        if part not in MODIFIERS or MODIFIERS[part] in mods:
            raise BridgeError("invalid_argument", "Use one key and optional Ctrl/Shift/Alt modifiers")
        mods.append(MODIFIERS[part])
    main = parts[-1]
    if main in MODIFIERS:
        raise BridgeError("invalid_argument", "A non-modifier key is required")
    if len(main) == 1 and main.isascii() and main.isalnum():
        vk = ord(main.upper())
    elif main in KEYS:
        vk = KEYS[main]
    else:
        raise BridgeError("invalid_argument", f"Unsupported key: {main}")
    if 0x12 in mods and vk in (0x09, 0x1B, 0x20, 0x73):
        raise BridgeError("forbidden_key", "Desktop switching and window-close chords are not available")
    if 0x11 in mods and 0x12 in mods and vk == 0x2E:
        raise BridgeError("forbidden_key", "Secure desktop chords are not available")
    return mods, vk


def parse_modifiers(value=None):
    """Accept only bounded, distinct Ctrl/Shift/Alt modifiers for held input."""
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 3:
        raise BridgeError("invalid_argument", "modifiers must contain at most three Ctrl/Shift/Alt names")
    modifiers = []
    for item in value:
        name = _text(item, "modifier", 20).strip().lower()
        if name in FORBIDDEN_KEYS:
            raise BridgeError("forbidden_key", "Windows and Meta modifiers are not available")
        if name not in MODIFIERS or MODIFIERS[name] in modifiers:
            raise BridgeError("invalid_argument", "Use distinct Ctrl/Shift/Alt modifiers")
        modifiers.append(MODIFIERS[name])
    return modifiers


def parse_mouse_button(value):
    value = _text(value, "button", 10)
    if value not in MOUSE_BUTTONS:
        raise BridgeError("invalid_argument", "button must be left, right, or middle")
    return value, MOUSE_BUTTONS[value]


def parse_image_options(params):
    max_width = _integer(params.get("image_max_width", 1600), "image_max_width", 0, 4096)
    if max_width and max_width < 640:
        raise BridgeError("invalid_argument", "image_max_width must be 0 for original pixels or 640 to 4096")
    image_format = _text(params.get("image_format", "jpeg"), "image_format", 4)
    if image_format not in ("jpeg", "png"):
        raise BridgeError("invalid_argument", "image_format must be jpeg or png")
    quality = _integer(params.get("jpeg_quality", 85), "jpeg_quality", 50, 100)
    return max_width, image_format, quality


def scaled_image_size(width, height, max_width):
    """Resize down only, preserving the aspect ratio to the nearest image pixel."""
    width = _integer(width, "physical_width", 1)
    height = _integer(height, "physical_height", 1)
    target_width = min(width, max_width) if max_width else width
    return target_width, max(1, round(height * target_width / width))


def parse_drag_options(params):
    """Validate drag timing and path without touching the desktop."""
    duration = _integer(params.get("duration_ms", 240), "duration_ms", 100, 5000)
    button, flags = parse_mouse_button(params.get("mouse_button", params.get("button", "left")))
    modifiers = parse_modifiers(params.get("modifiers"))
    endpoints = ("from_x", "from_y", "to_x", "to_y")
    if "points" in params:
        if any(key in params for key in endpoints):
            raise BridgeError("invalid_argument", "Use points or from/to coordinates, not both")
        path = params["points"]
        if not isinstance(path, list) or not 2 <= len(path) <= 64:
            raise BridgeError("invalid_argument", "points must contain 2 to 64 x/y objects")
        waypoints = []
        for point in path:
            if not isinstance(point, dict) or set(point) != {"x", "y"}:
                raise BridgeError("invalid_argument", "Each drag point must contain only x and y")
            waypoints.append((_integer(point["x"], "x", 0, 32767), _integer(point["y"], "y", 0, 32767)))
    else:
        waypoints = [(_integer(params.get("from_x"), "from_x", 0, 32767),
                      _integer(params.get("from_y"), "from_y", 0, 32767)),
                     (_integer(params.get("to_x"), "to_x", 0, 32767),
                      _integer(params.get("to_y"), "to_y", 0, 32767))]
    return duration, button, flags, modifiers, waypoints


def interpolate_drag_path(waypoints, duration_ms):
    """Keep every requested corner, with a bounded set of intermediate positions."""
    distances = [math.hypot(end[0] - start[0], end[1] - start[1])
                 for start, end in zip(waypoints, waypoints[1:])]
    total = sum(distances)
    steps = max(20, round(duration_ms / 12))
    positions = [waypoints[0]]
    for start, end, distance in zip(waypoints, waypoints[1:], distances):
        segment_steps = max(1, round(steps * distance / total)) if total else 1
        positions.extend((round(start[0] + (end[0] - start[0]) * step / segment_steps),
                          round(start[1] + (end[1] - start[1]) * step / segment_steps))
                         for step in range(1, segment_steps + 1))
    return positions


def executable_file_version(path):
    """Read the Windows version resource, without invoking a shell or executable."""
    if os.name != "nt" or not Path(path).is_file():
        return None
    try:
        version = ctypes.WinDLL("version", use_last_error=True)
        version.GetFileVersionInfoSizeW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(wintypes.DWORD)]
        version.GetFileVersionInfoSizeW.restype = wintypes.DWORD
        version.GetFileVersionInfoW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p]
        version.VerQueryValueW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.UINT)]
        unused = wintypes.DWORD()
        size = version.GetFileVersionInfoSizeW(str(path), ctypes.byref(unused))
        if not size or size > 4 * 1024 * 1024:
            return None
        data = ctypes.create_string_buffer(size)
        if not version.GetFileVersionInfoW(str(path), 0, size, data):
            return None
        pointer, length = ctypes.c_void_p(), wintypes.UINT()
        if not version.VerQueryValueW(data, "\\", ctypes.byref(pointer), ctypes.byref(length)) or length.value < 52:
            return None
        fixed = ctypes.cast(pointer, ctypes.POINTER(wintypes.DWORD))
        if fixed[0] != 0xFEEF04BD:
            return None
        return ".".join(str(value) for value in (fixed[2] >> 16, fixed[2] & 0xFFFF,
                                                  fixed[3] >> 16, fixed[3] & 0xFFFF))
    except (AttributeError, OSError, ValueError):
        return None


class StudioBridge:
    def __init__(self, executable=STUDIO_EXE):
        if _canonical(executable) != _canonical(STUDIO_EXE):
            raise BridgeError("invalid_target", "Only the configured Insta360 Studio executable is allowed")
        self.executable = STUDIO_EXE
        self.snapshots = {}
        self.uia = None
        self.uia_error = None
        self.win = None
        self.input_mutex = None
        self.input_mutex_owned = False
        self.visual_focus = {}
        if os.name == "nt":
            self.win = ctypes.WinDLL("user32", use_last_error=True)
            self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            self.dwm = ctypes.WinDLL("dwmapi", use_last_error=True)
            self._configure_win32()
            try:
                self.win.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
            except (AttributeError, OSError):
                try:
                    self.win.SetProcessDPIAware()
                except (AttributeError, OSError):
                    pass

    def _configure_win32(self):
        w = self.win
        w.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        w.GetWindowThreadProcessId.restype = wintypes.DWORD
        w.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]
        w.GetAncestor.restype = wintypes.HWND
        w.GetForegroundWindow.restype = wintypes.HWND
        w.GetGUIThreadInfo.argtypes = [wintypes.DWORD, ctypes.POINTER(GUITHREADINFO)]
        w.GetLastInputInfo.argtypes = [ctypes.POINTER(LASTINPUTINFO)]
        w.GetLastInputInfo.restype = wintypes.BOOL
        w.WindowFromPoint.argtypes = [POINT]
        w.WindowFromPoint.restype = wintypes.HWND
        w.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        w.GetWindowTextLengthW.argtypes = [wintypes.HWND]
        w.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        w.GetWindow.argtypes = [wintypes.HWND, wintypes.UINT]
        w.GetWindow.restype = wintypes.HWND
        w.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
        for name in ("IsWindow", "IsWindowVisible", "IsWindowEnabled", "IsIconic", "BringWindowToTop", "SetForegroundWindow"):
            getattr(w, name).argtypes = [wintypes.HWND]
        w.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
        w.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]
        w.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
        w.SendInput.restype = wintypes.UINT
        w.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
        self.kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        self.kernel.OpenProcess.restype = wintypes.HANDLE
        self.kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
        self.kernel.CreateMutexW.restype = wintypes.HANDLE
        self.kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        self.kernel.WaitForSingleObject.restype = wintypes.DWORD
        self.kernel.ReleaseMutex.argtypes = [wintypes.HANDLE]
        self.kernel.GetCurrentThreadId.restype = wintypes.DWORD
        self.dwm.DwmGetWindowAttribute.argtypes = [wintypes.HWND, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]

    def _windows_only(self):
        if self.win is None:
            raise BridgeError("unsupported_platform", "This adapter requires Windows")

    def _process_path(self, hwnd):
        pid = wintypes.DWORD()
        self.win.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if not pid.value:
            raise BridgeError("invalid_window", "The target window no longer exists")
        handle = self.kernel.OpenProcess(0x1000, False, pid.value)
        if not handle:
            raise BridgeError("scope_denied", "Cannot verify the target process executable")
        try:
            path = ctypes.create_unicode_buffer(32768)
            size = wintypes.DWORD(len(path))
            if not self.kernel.QueryFullProcessImageNameW(handle, 0, path, ctypes.byref(size)):
                raise BridgeError("scope_denied", "Cannot verify the target process executable")
            return pid.value, path.value
        finally:
            self.kernel.CloseHandle(handle)

    def _scope(self, hwnd, visible=True):
        self._windows_only()
        hwnd = _integer(hwnd, "window_id", 1)
        if not self.win.IsWindow(hwnd):
            raise BridgeError("invalid_window", "The target window no longer exists")
        pid, path = self._process_path(hwnd)
        if _canonical(path) != _canonical(self.executable):
            raise BridgeError("scope_denied", "The window does not belong to the configured Insta360 Studio executable")
        root = self.win.GetAncestor(hwnd, 3)  # GA_ROOTOWNER
        if root:
            _, root_path = self._process_path(root)
            if _canonical(root_path) != _canonical(self.executable):
                raise BridgeError("scope_denied", "The window owner is outside Insta360 Studio")
        if visible and not self.win.IsWindowVisible(hwnd):
            raise BridgeError("invalid_window", "The target window is not visible")
        return pid

    def _hwnd(self, params):
        window = params.get("window") or {}
        hwnd = params.get("window_id", window.get("id") if isinstance(window, dict) else None)
        self._scope(hwnd)
        return int(hwnd)

    def _title(self, hwnd):
        length = self.win.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(min(length + 1, 4096))
        self.win.GetWindowTextW(hwnd, buf, len(buf))
        return buf.value

    def _rect(self, hwnd):
        rect = wintypes.RECT()
        # Extended frame bounds match the visible frame and exclude invisible resize borders.
        result = self.dwm.DwmGetWindowAttribute(hwnd, 9, ctypes.byref(rect), ctypes.sizeof(rect))
        if result != 0 and not self.win.GetWindowRect(hwnd, ctypes.byref(rect)):
            raise BridgeError("capture_failed", "Cannot read the target window bounds")
        if rect.right <= rect.left or rect.bottom <= rect.top:
            raise BridgeError("capture_failed", "The target window has no capture area")
        return (rect.left, rect.top, rect.right, rect.bottom)

    def _window_data(self, hwnd):
        pid = self._scope(hwnd)
        class_name = ctypes.create_unicode_buffer(256)
        self.win.GetClassNameW(hwnd, class_name, len(class_name))
        return {"id": hwnd, "app": self.executable, "title": self._title(hwnd),
                "pid": pid, "minimized": bool(self.win.IsIconic(hwnd)),
                "enabled": bool(self.win.IsWindowEnabled(hwnd)),
                "bounds": list(self._rect(hwnd)), "class_name": class_name.value,
                "is_dialog": class_name.value == "#32770",
                "owner_id": int(self.win.GetWindow(hwnd, 4) or 0)}

    def list_windows(self, params):
        self._windows_only()
        windows = []
        callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

        def visit(hwnd, _):
            if self.win.IsWindowVisible(hwnd):
                try:
                    windows.append(self._window_data(int(hwnd)))
                except (BridgeError, OSError):
                    pass
            return True

        callback = callback_type(visit)
        self.win.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
        self.win.EnumWindows(callback, 0)
        return windows

    def status(self, params):
        self._windows_only()
        windows = self.list_windows({})
        try:
            processes = self._running_studio_processes()
            process_detection = {"verified": True, "count": len(processes)}
        except BridgeError as exc:
            processes = []
            process_detection = {"verified": False, "reason": exc.code}
        return {"backend": "studio-win32-uia", "adapter_version": ADAPTER_VERSION,
                "executable": self.executable, "installed_file_version": executable_file_version(self.executable),
                "executable_exists": Path(self.executable).is_file(),
                "platform": platform.platform(), "python_version": platform.python_version(),
                "dependencies": {"pillow": importlib.util.find_spec("PIL") is not None,
                                 "pywinauto": importlib.util.find_spec("pywinauto") is not None,
                                 "psutil": importlib.util.find_spec("psutil") is not None},
                "process_detection": process_detection, "process_ids": processes,
                "window_count": len(windows), "windows": windows,
                "foreground_is_studio": self._foreground_is_studio(),
                "capabilities": {"target_scope": "pinned_studio_executable_only", "hover": True,
                                 "press_key_repeat_max": 30, "press_key_interval_ms_max": 250,
                                 "drag_buttons": list(MOUSE_BUTTONS), "drag_modifiers": ["Ctrl", "Shift", "Alt"],
                                 "drag_path_points_max": 64, "drag_duration_ms_range": [100, 5000],
                                 "scroll_modifiers": ["Ctrl", "Shift", "Alt"],
                                 "focused_value_readback": "UI Automation ValuePattern when exposed",
                                 "input_since_observation_guard": "Win32 last-input tick checked before each new action",
                                 "input_during_observation_guard": True,
                                 "cold_launch_process_guard": True,
                                 "screenshot_coordinate_space": "returned_image_pixels",
                                 "screenshot_default": {"image_max_width": 1600, "image_format": "jpeg", "jpeg_quality": 85}}}

    def _foreground_is_studio(self):
        try:
            self._scope(int(self.win.GetForegroundWindow() or 0))
            return True
        except BridgeError:
            return False

    def _running_studio_processes(self):
        """Return only exact verified Studio PIDs; do not expose other processes."""
        self._windows_only()
        try:
            import psutil
        except ImportError:
            raise BridgeError("missing_dependency", "psutil is required to verify whether Studio is already starting")
        verified = []
        unknown_candidate = False
        try:
            # Avoid reusing psutil Process objects after Windows has recycled a PID.
            clear_cache = getattr(psutil.process_iter, "cache_clear", None)
            if clear_cache is not None:
                clear_cache()
            for process in psutil.process_iter(["pid", "name"]):
                candidate = False
                try:
                    name = process.info.get("name") or ""
                    if str(name).casefold() != Path(self.executable).name.casefold():
                        continue
                    candidate = True
                    executable = process.exe()
                    if not executable:
                        unknown_candidate = True
                    elif _canonical(executable) == _canonical(self.executable) and process.is_running():
                        verified.append(_integer(process.pid, "Studio process id", 1))
                except (psutil.NoSuchProcess, psutil.ZombieProcess):
                    continue
                except psutil.AccessDenied:
                    if candidate:
                        unknown_candidate = True
        except (psutil.Error, OSError):
            raise BridgeError("process_state_unknown", "Cannot verify whether Insta360 Studio is already running")
        if unknown_candidate and not verified:
            raise BridgeError("process_state_unknown", "A possible Studio process could not be verified; wait and inspect Studio before launching")
        return sorted(set(verified))

    def launch(self, params):
        self._windows_only()
        if not Path(self.executable).is_file():
            raise BridgeError("not_installed", "The configured Insta360 Studio executable is missing")
        existing = self.list_windows({})
        if existing:
            return {"already_running": True, "window_detected": True,
                    "readiness": "observe_visible_window", "windows": existing}
        processes = self._running_studio_processes()
        if processes:
            return {"already_running": True, "process_ids": processes, "window_detected": False,
                    "readiness": "waiting_for_visible_window", "windows": []}
        proc = subprocess.Popen([self.executable], shell=False, cwd=str(Path(self.executable).parent),
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL)
        windows = self.list_windows({})
        return {"started": True, "pid": proc.pid, "window_detected": bool(windows),
                "readiness": "observe_visible_window" if windows else "waiting_for_visible_window", "windows": windows}

    def _activate(self, hwnd, restore=False):
        self._scope(hwnd)
        if not self.win.IsWindowEnabled(hwnd):
            raise BridgeError("modal_blocked", "The selected Studio window is disabled by a modal dialog; select and observe that dialog")
        if self.win.IsIconic(hwnd):
            if not restore:
                raise BridgeError("minimized", "The target window is minimized; activate it first")
            self.win.ShowWindow(hwnd, 9)  # SW_RESTORE
        self.win.BringWindowToTop(hwnd)
        self.win.SetForegroundWindow(hwnd)
        if int(self.win.GetForegroundWindow() or 0) != hwnd:
            foreground = self.win.GetForegroundWindow()
            current_tid = self.kernel.GetCurrentThreadId()
            foreground_tid = self.win.GetWindowThreadProcessId(foreground, None) if foreground else 0
            attached = bool(foreground_tid and foreground_tid != current_tid and
                            self.win.AttachThreadInput(current_tid, foreground_tid, True))
            try:
                self.win.BringWindowToTop(hwnd)
                self.win.SetForegroundWindow(hwnd)
            finally:
                if attached:
                    self.win.AttachThreadInput(current_tid, foreground_tid, False)
        self._assert_foreground(hwnd)

    def _assert_foreground(self, hwnd):
        self._scope(hwnd)
        if not self.win.IsWindowEnabled(hwnd):
            raise BridgeError("modal_blocked", "The selected Studio window is disabled by a modal dialog; select and observe that dialog")
        if self.win.IsIconic(hwnd):
            raise BridgeError("minimized", "The target window is minimized")
        foreground = int(self.win.GetForegroundWindow() or 0)
        self._scope(foreground)
        if foreground != hwnd and int(self.win.GetAncestor(foreground, 2) or 0) != hwnd:
            raise BridgeError("focus_changed", "The selected Studio window is not in the foreground; refresh window selection")

    def activate(self, params):
        hwnd = self._hwnd(params)
        self._activate(hwnd, restore=True)
        return {"activated": True, "window": self._window_data(hwnd)}

    def _load_uia(self):
        if self.uia is None and self.uia_error is None:
            try:
                from pywinauto import Desktop
                self.uia = Desktop(backend="uia")
            except Exception as exc:
                self.uia_error = type(exc).__name__
        return self.uia

    def _focused_control(self, hwnd):
        if self._load_uia() is None:
            return None
        try:
            from pywinauto.uia_defines import IUIA
            from pywinauto.uia_element_info import UIAElementInfo
            from pywinauto.controls.uiawrapper import UIAWrapper
            focused = UIAWrapper(UIAElementInfo(IUIA().iuia.GetFocusedElement()))
            if focused.element_info.process_id != self._scope(hwnd):
                return None
            # A focused control from a different Studio window is not the selected target.
            ancestor = focused
            verified_root = False
            for _ in range(32):
                handle = int(ancestor.element_info.handle or 0)
                if handle:
                    root = int(self.win.GetAncestor(handle, 2) or handle)
                    if root != hwnd:
                        return None
                    verified_root = True
                    break
                ancestor = ancestor.parent()
                if ancestor is None:
                    return None
            return focused if verified_root else None
        except Exception:
            return None

    def _editable_control(self, item):
        try:
            if item is None or item.element_info.control_type not in ("Edit", "Document", "ComboBox"):
                return False
            if not item.is_enabled():
                return False
            return not bool(item.iface_value.CurrentIsReadOnly)
        except Exception:
            return False

    @staticmethod
    def _value_state(item):
        """Return bounded, explicit ValuePattern evidence for the focused control."""
        if item is None:
            return {"value_available": False}
        try:
            if bool(getattr(item.element_info, "is_password", False)):
                return {"value_available": False, "value_redacted": True}
            pattern = item.iface_value
            value = str(pattern.CurrentValue or "")
            return {"value_available": True, "value": value[:MAX_TEXT_LENGTH],
                    "value_truncated": len(value) > MAX_TEXT_LENGTH,
                    "read_only": bool(pattern.CurrentIsReadOnly)}
        except Exception:
            return {"value_available": False}

    def _accessibility(self, hwnd, max_elements=200):
        desktop = self._load_uia()
        if desktop is None:
            return {"tree": "UI Automation unavailable; use the current screenshot.",
                    "available": False}, []
        try:
            root = desktop.window(handle=hwnd).wrapper_object()
            deadline = time.monotonic() + 2.0
            queue = [(root, 0)]
            elements, lines, focused = [], [], None
            while queue and len(elements) < max_elements and time.monotonic() < deadline:
                item, depth = queue.pop(0)
                try:
                    info = item.element_info
                    if info.process_id != self._scope(hwnd):
                        continue
                    index = len(elements)
                    elements.append(item)
                    name = str(info.name or "").replace("\n", " ")[:300]
                    kind = str(info.control_type or "Control")
                    rectangle = info.rectangle
                    auto_id = str(info.automation_id or "")
                    line = f"{'  ' * depth}[{index}] {kind} {json.dumps(name, ensure_ascii=False)} automation_id={json.dumps(auto_id)} bounds=({rectangle.left},{rectangle.top},{rectangle.right},{rectangle.bottom})"
                    if not item.is_enabled():
                        line += " disabled"
                    lines.append(line)
                    try:
                        if item.has_keyboard_focus():
                            focused = line
                    except Exception:
                        pass
                    if depth < 6:
                        queue.extend((child, depth + 1) for child in item.children())
                except Exception:
                    continue
            state = {"tree": "\n".join(lines) or "No UI Automation elements; use the current screenshot.",
                     "available": bool(lines), "element_count": len(elements),
                     "truncated": bool(queue)}
            if focused:
                state["focused_element"] = focused
            return state, elements
        except Exception as exc:
            return {"tree": "UI Automation did not expose this window; use the current screenshot.",
                    "available": False, "reason": type(exc).__name__}, []

    def observe(self, params):
        settle_ms = _integer(params.get("settle_ms", 250), "settle_ms", 0, 2000)
        max_width, image_format, quality = parse_image_options(params)
        max_elements = _integer(params.get("max_elements", 200), "max_elements", 1, 1000)
        hwnd = self._hwnd(params)
        self.snapshots.pop(hwnd, None)
        if params.get("preserve_visual_focus", False) is not True:
            self.visual_focus.pop(hwnd, None)
        # PIL captures visible screen pixels, so bring this exact target forward first.
        self._activate(hwnd, restore=True)
        if settle_ms:
            time.sleep(settle_ms / 1000)
        self._assert_foreground(hwnd)
        input_tick = self._last_input_tick()
        rect = self._rect(hwnd)
        physical_width, physical_height = rect[2] - rect[0], rect[3] - rect[1]
        coordinate_size = (physical_width, physical_height)
        self._assert_foreground(hwnd)
        image, buffer = None, None
        if params.get("include_screenshot", True):
            try:
                from PIL import Image, ImageGrab
                image = ImageGrab.grab(bbox=rect, all_screens=True)
                if (image.width, image.height) != (physical_width, physical_height):
                    raise BridgeError("capture_failed", "Captured Studio pixels do not match its verified physical bounds")
                coordinate_size = scaled_image_size(image.width, image.height, max_width)
                if coordinate_size != (image.width, image.height):
                    image = image.resize(coordinate_size, resample=Image.Resampling.LANCZOS)
                if image_format == "jpeg":
                    image = image.convert("RGB")
                buffer = io.BytesIO()
                if image_format == "jpeg":
                    image.save(buffer, format="JPEG", quality=quality)
                else:
                    image.save(buffer, format="PNG")
            except ImportError:
                raise BridgeError("missing_dependency", "Pillow is required for window screenshots")
            except BridgeError:
                raise
            except Exception as exc:
                raise BridgeError("capture_failed", f"Window capture failed: {type(exc).__name__}")
        self._assert_foreground(hwnd)
        if self._rect(hwnd) != rect:
            raise BridgeError("layout_changed", "The target moved during capture; observe again")
        accessibility, elements = None, []
        if params.get("include_text", True):
            accessibility, elements = self._accessibility(hwnd, max_elements)
            self._assert_foreground(hwnd)
            focused = self._focused_control(hwnd)
            accessibility["focused_is_editable"] = self._editable_control(focused)
            if focused is not None:
                info = focused.element_info
                accessibility["focused_control"] = {"control_type": info.control_type,
                                                     "name": str(info.name or "")[:300],
                                                     "automation_id": str(info.automation_id or "")}
                accessibility["focused_control"].update(self._value_state(focused))
        if self._rect(hwnd) != rect:
            raise BridgeError("layout_changed", "The target moved during observation; observe again")
        screenshot_id = str(uuid.uuid4())
        screenshots = []
        if image is not None:
            encoded = buffer.getvalue()
            screenshots.append({"id": screenshot_id, "url": f"data:image/{image_format};base64," + base64.b64encode(encoded).decode("ascii"),
                                "width": image.width, "height": image.height,
                                "physical_width": physical_width, "physical_height": physical_height,
                                "scale_x": physical_width / image.width, "scale_y": physical_height / image.height,
                                "image_format": image_format, "byte_length": len(encoded),
                                "originX": rect[0], "originY": rect[1], "zIndex": 0})
        window = self._window_data(hwnd)
        self._assert_foreground(hwnd)
        try:
            if self._last_input_tick() != input_tick:
                raise BridgeError("manual_input_detected", "Desktop input changed during Studio capture/UI inspection; observe again before sending input")
        except BridgeError:
            self.visual_focus.pop(hwnd, None)
            raise
        self.snapshots[hwnd] = {"id": screenshot_id, "rect": rect,
                                "time": time.monotonic(), "elements": elements, "input_tick": input_tick,
                                "coordinate_size": coordinate_size}
        if len(self.snapshots) > 24:
            oldest = min(self.snapshots, key=lambda key: self.snapshots[key]["time"])
            del self.snapshots[oldest]
        return {"window": window, "accessibility": accessibility,
                "snapshot_id": screenshot_id,
                "screenshots": screenshots, "coordinate_space": "screenshot_image_pixels"}

    def _snapshot(self, hwnd, params):
        snapshot = self.snapshots.get(hwnd)
        screenshot_id = params.get("screenshot_id", params.get("screenshotId"))
        if not snapshot or not screenshot_id or screenshot_id != snapshot["id"]:
            raise BridgeError("stale_state", "Observe the selected window and supply its current screenshot_id")
        if time.monotonic() - snapshot["time"] > SNAPSHOT_TTL:
            raise BridgeError("stale_state", "The screenshot expired; observe the selected window again")
        if self._rect(hwnd) != snapshot["rect"]:
            self.snapshots.pop(hwnd, None)
            raise BridgeError("layout_changed", "The window moved or resized; observe again")
        return snapshot

    def _last_input_tick(self):
        info = LASTINPUTINFO()
        info.cbSize = ctypes.sizeof(info)
        if not self.win.GetLastInputInfo(ctypes.byref(info)):
            raise BridgeError("input_state_unknown", "Cannot verify desktop input activity; observe again before controlling Studio")
        return int(info.dwTime)

    def _initial_snapshot(self, hwnd, params):
        """Reject new desktop input since observation before activation changes it.

        Check only at action entry. Our cursor/input events legitimately update
        this tick during the action; post-action observation records a new tick.
        """
        if "screenshot_id" not in params and "screenshotId" not in params:
            return None  # Compatibility for legacy direct adapter key callers.
        try:
            snapshot = self._snapshot(hwnd, params)
            if "input_tick" not in snapshot:
                raise BridgeError("input_state_unknown", "Observation lacks desktop input evidence; observe Studio again")
            if snapshot["input_tick"] != self._last_input_tick():
                raise BridgeError("manual_input_detected", "Desktop input occurred after this Studio observation; observe again before sending input")
            return snapshot
        except BridgeError:
            self.snapshots.pop(hwnd, None)
            self.visual_focus.pop(hwnd, None)
            raise

    def _point(self, hwnd, snapshot, x, y):
        left, top, right, bottom = snapshot["rect"]
        physical_width, physical_height = right - left, bottom - top
        coordinate_width, coordinate_height = snapshot.get("coordinate_size", (physical_width, physical_height))
        coordinate_width = _integer(coordinate_width, "coordinate_width", 1)
        coordinate_height = _integer(coordinate_height, "coordinate_height", 1)
        x = _integer(x, "x", 0, coordinate_width - 1)
        y = _integer(y, "y", 0, coordinate_height - 1)
        # Integer division is exact floor scaling, including on negative-origin monitors.
        point = (left + x * physical_width // coordinate_width,
                 top + y * physical_height // coordinate_height)
        self._assert_point(hwnd, point)
        return point

    def _assert_point(self, hwnd, point):
        self._assert_foreground(hwnd)
        hit = int(self.win.WindowFromPoint(POINT(*point)) or 0)
        self._scope(hit)
        hit_root = int(self.win.GetAncestor(hit, 2) or hit)
        if hit_root != hwnd:
            raise BridgeError("point_blocked", "The point is outside the selected Studio window or covered by another window")

    def _move_cursor(self, hwnd, point):
        self._assert_point(hwnd, point)
        if not self.win.SetCursorPos(*point):
            raise BridgeError("input_failed", "Windows rejected the Studio cursor movement")
        self._assert_point(hwnd, point)

    def _input(self, hwnd, items, point=None):
        self._assert_foreground(hwnd)
        if point is not None:
            self._assert_point(hwnd, point)
        array = (INPUT * len(items))(*items)
        sent = self.win.SendInput(len(array), array, ctypes.sizeof(INPUT))
        if sent != len(array):
            # Cleanup is key/button release only, never another press or cursor move.
            if sent:
                releases = []
                for item in items:
                    if item.type == 1 and not item.ki.dwFlags & 0x0002:
                        releases.append(self._key(item.ki.wVk, True, item.ki.wScan if item.ki.dwFlags & 0x0004 else None))
                    elif item.type == 0:
                        for down, up in ((0x0002, 0x0004), (0x0008, 0x0010), (0x0020, 0x0040)):
                            if item.mi.dwFlags & down:
                                releases.append(self._mouse(up))
                self._release_inputs(releases)
            raise BridgeError("input_failed", "Windows rejected input; verify Studio is not running elevated")

    def _focus_hwnd(self, hwnd):
        info = GUITHREADINFO()
        info.cbSize = ctypes.sizeof(info)
        tid = self.win.GetWindowThreadProcessId(hwnd, None)
        if not self.win.GetGUIThreadInfo(tid, ctypes.byref(info)):
            raise BridgeError('focus_unknown', 'Cannot verify Studio keyboard focus')
        focus = int(info.hwndFocus or 0)
        self._scope(focus)
        if int(self.win.GetAncestor(focus, 2) or focus) != hwnd:
            raise BridgeError('focus_changed', 'Keyboard focus is outside the selected Studio window')
        return focus

    def _release_inputs(self, items):
        if items:
            array = (INPUT * len(items))(*items)
            self.win.SendInput(len(array), array, ctypes.sizeof(INPUT))

    @staticmethod
    def _mouse(flags, data=0):
        return INPUT(type=0, mi=MOUSEINPUT(0, 0, data & 0xFFFFFFFF, flags, 0, 0))

    @staticmethod
    def _key(vk, up=False, unicode_unit=None):
        flags = 0x0002 if up else 0
        if unicode_unit is not None:
            flags |= 0x0004
            return INPUT(type=1, ki=KEYBDINPUT(0, unicode_unit, flags, 0, 0))
        if vk in EXTENDED_KEYS:
            flags |= 0x0001
        return INPUT(type=1, ki=KEYBDINPUT(vk, 0, flags, 0, 0))

    def click(self, params):
        button, flags = parse_mouse_button(params.get("mouse_button", params.get("button", "left")))
        count = _integer(params.get("click_count", 1), "click_count", 1, 2)
        modifiers = parse_modifiers(params.get("modifiers"))
        hwnd = self._hwnd(params)
        self._initial_snapshot(hwnd, params)
        self._activate(hwnd)
        snapshot = self._snapshot(hwnd, params)
        if params.get("element_index") is not None:
            index = _integer(params["element_index"], "element_index", 0)
            if index >= len(snapshot["elements"]):
                raise BridgeError("invalid_element", "The indexed element is not in the current observation")
            item = snapshot["elements"][index]
            if item.element_info.process_id != self._scope(hwnd):
                raise BridgeError("scope_denied", "The indexed element is outside Studio")
            rect = item.rectangle()
            point = (int((rect.left + rect.right) / 2), int((rect.top + rect.bottom) / 2))
            left, top, right, bottom = snapshot["rect"]
            if not (left <= point[0] < right and top <= point[1] < bottom):
                raise BridgeError("point_blocked", "The indexed element is outside the visible selected window")
            self._assert_point(hwnd, point)
        else:
            point = self._point(hwnd, snapshot, params.get("x"), params.get("y"))
        self._move_cursor(hwnd, point)
        modifier_releases = [self._key(modifier, True) for modifier in reversed(modifiers)]
        held_modifiers = False
        try:
            if modifiers:
                self._input(hwnd, [self._key(modifier) for modifier in modifiers], point)
                held_modifiers = True
            for index in range(count):
                self._input(hwnd, [self._mouse(flags[0]), self._mouse(flags[1])], point)
                if index + 1 < count:
                    time.sleep(0.06)
            if held_modifiers:
                self._input(hwnd, modifier_releases, point)
                held_modifiers = False
        finally:
            if held_modifiers:
                self._release_inputs(modifier_releases)
            self.snapshots.pop(hwnd, None)
            self.visual_focus.pop(hwnd, None)
        try:
            self.visual_focus[hwnd] = {'focus_hwnd': self._focus_hwnd(hwnd), 'rect': self._rect(hwnd), 'time': time.monotonic()}
        except BridgeError:
            # A successful click may open an owned dialog; it provides no text-focus anchor.
            self.visual_focus.pop(hwnd, None)
        return {"clicked": True, "window_id": hwnd}

    def hover(self, params):
        hwnd = self._hwnd(params)
        self._initial_snapshot(hwnd, params)
        self._activate(hwnd)
        snapshot = self._snapshot(hwnd, params)
        point = self._point(hwnd, snapshot, params.get("x"), params.get("y"))
        try:
            self._move_cursor(hwnd, point)
        finally:
            self.snapshots.pop(hwnd, None)
            self.visual_focus.pop(hwnd, None)
        return {"hovered": True, "window_id": hwnd}

    def press_key(self, params):
        mods, vk = parse_key_chord(params.get("key"))
        repeat = _integer(params.get("repeat", 1), "repeat", 1, 30)
        interval = _integer(params.get("interval_ms", 50), "interval_ms", 0, 250)
        hwnd = self._hwnd(params)
        self._initial_snapshot(hwnd, params)
        self._activate(hwnd)
        items = [self._key(mod) for mod in mods] + [self._key(vk), self._key(vk, True)]
        items.extend(self._key(mod, True) for mod in reversed(mods))
        try:
            for index in range(repeat):
                if "screenshot_id" in params or "screenshotId" in params:
                    self._snapshot(hwnd, params)
                self._assert_foreground(hwnd)
                self._focus_hwnd(hwnd)
                self._input(hwnd, items)
                if index + 1 < repeat and interval:
                    time.sleep(interval / 1000)
        finally:
            self.snapshots.pop(hwnd, None)
            self.visual_focus.pop(hwnd, None)
        return {"pressed": True, "repeat": repeat, "window_id": hwnd}

    def type_text(self, params):
        hwnd = self._hwnd(params)
        text = _text(params.get("text"))
        self._initial_snapshot(hwnd, params)
        self._activate(hwnd)
        focused = self._focused_control(hwnd)
        visual = params.get('allow_visual_focus', False) is True
        anchor = self.visual_focus.pop(hwnd, None)
        if visual:
            self._snapshot(hwnd, params)
            if not anchor or time.monotonic() - anchor['time'] > SNAPSHOT_TTL or anchor['rect'] != self._rect(hwnd) or anchor['focus_hwnd'] != self._focus_hwnd(hwnd):
                raise BridgeError('focus_changed', 'Screenshot typing requires a recent click and unchanged Studio keyboard focus')
        elif not self._editable_control(focused):
            raise BridgeError("focus_not_editable", "UI Automation must confirm an editable focused control before typing text")
        runtime_id = focused.element_info.runtime_id if not visual else None
        if params.get('replace', False) is True:
            self._input(hwnd, [self._key(0x11), self._key(ord('A')), self._key(ord('A'), True), self._key(0x11, True)])
        raw = text.encode("utf-16-le", errors="strict")
        units = [int.from_bytes(raw[index:index + 2], "little") for index in range(0, len(raw), 2)]
        for offset in range(0, len(units), 32):
            current_focus = self._focused_control(hwnd)
            if visual and anchor['focus_hwnd'] != self._focus_hwnd(hwnd):
                raise BridgeError('focus_changed', 'Studio keyboard focus changed while typing')
            if not visual and (not self._editable_control(current_focus) or current_focus.element_info.runtime_id != runtime_id):
                raise BridgeError('focus_changed', 'Editable focus changed while typing; observe before continuing')
            items = []
            for unit in units[offset:offset + 32]:
                items.extend((self._key(0, unicode_unit=unit), self._key(0, True, unicode_unit=unit)))
            self._input(hwnd, items)
        self.snapshots.pop(hwnd, None)
        return {"typed": True, "character_count": len(text), "window_id": hwnd}

    def import_media(self, params):
        """Fill a verified Studio-owned file-open dialog and confirm it with Enter."""
        hwnd = self._hwnd(params)
        self._initial_snapshot(hwnd, params)
        self._activate(hwnd)
        window = self._window_data(hwnd)
        if window["class_name"] != "#32770" or not re.search(r"\b(open|import)\b", window["title"], re.I):
            raise BridgeError("not_import_dialog", "Select a verified Studio file-open dialog before importing")
        paths = params.get("paths")
        if not isinstance(paths, list) or not paths or len(paths) > 32:
            raise BridgeError("invalid_argument", "paths must contain 1 to 32 absolute existing media paths")
        accepted = {".insv", ".insp", ".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm", ".jpg", ".jpeg", ".png", ".heic", ".heif", ".dng", ".mp3", ".wav", ".lrv"}
        verified = []
        for value in paths:
            value = _text(value, "media path", 4096)
            path = Path(value)
            if not path.is_absolute() or not path.is_file() or path.suffix.lower() not in accepted or path.resolve().suffix.lower() not in accepted or any(c in value for c in ('"', '\r', '\n')) or value.startswith('\\\\'):
                raise BridgeError("invalid_media_path", "Each import path must be an existing absolute supported media file")
            verified.append(str(path.resolve()))
        desktop = self._load_uia()
        if desktop is None:
            raise BridgeError("uia_unavailable", "Import requires UI Automation identification of the file-name control")
        try:
            root = desktop.window(handle=hwnd).wrapper_object()
            descendants = root.descendants()
            matching = [item for item in descendants
                        if str(item.element_info.automation_id) == "1148"]
            file_edit = None
            for item in matching:
                if item.element_info.control_type == "Edit":
                    file_edit = item
                    break
                if item.element_info.control_type == "ComboBox":
                    edits = [child for child in item.descendants()
                             if child.element_info.control_type == "Edit"]
                    if len(edits) == 1:
                        file_edit = edits[0]
                        break
            open_buttons = [item for item in descendants
                            if item.element_info.control_type in ("Button", "SplitButton")
                            and str(item.element_info.automation_id) == '1'
                            and re.sub(r"[&\s]", "", str(item.element_info.name or "")).lower() in ("open", "import")]
        except Exception as exc:
            raise BridgeError("uia_failed", f"Cannot inspect the file-open dialog: {type(exc).__name__}")
        if file_edit is None or not open_buttons or not self._editable_control(file_edit):
            raise BridgeError("unverified_import_dialog", "The dialog must expose its File name Edit control (1148) and an Open button")
        if file_edit.element_info.process_id != self._scope(hwnd):
            raise BridgeError("scope_denied", "The file-name control is outside Studio")
        filename = " ".join('"' + value + '"' for value in verified)
        self._assert_foreground(hwnd)
        try:
            file_edit.iface_value.SetValue(filename)
            if str(file_edit.iface_value.CurrentValue) != filename:
                raise BridgeError("import_readback_failed", "The filename control did not retain the requested paths")
            self._assert_foreground(hwnd)
            file_edit.set_focus()
        except BridgeError:
            raise
        except Exception as exc:
            raise BridgeError("uia_failed", f"The filename control rejected the paths: {type(exc).__name__}")
        focus = self._focused_control(hwnd)
        if focus is None or focus.element_info.runtime_id != file_edit.element_info.runtime_id:
            raise BridgeError("focus_changed", "The filename control did not receive keyboard focus")
        if str(file_edit.iface_value.CurrentValue) != filename:
            raise BridgeError("import_readback_failed", "The filename paths changed before confirmation")
        self._input(hwnd, [self._key(0x0D), self._key(0x0D, True)])
        self.snapshots.pop(hwnd, None)
        return {"submitted": True, "media_count": len(verified), "paths": verified,
                "note": "Studio must be observed to verify import completion"}

    def set_value(self, params):
        hwnd = self._hwnd(params)
        value = _text(params.get("value"), "value")
        self._initial_snapshot(hwnd, params)
        self._activate(hwnd)
        snapshot = self._snapshot(hwnd, params)
        index = _integer(params.get("element_index"), "element_index", 0)
        if index >= len(snapshot["elements"]):
            raise BridgeError("invalid_element", "The indexed element is not in the current observation")
        item = snapshot["elements"][index]
        if item.element_info.process_id != self._scope(hwnd):
            raise BridgeError("scope_denied", "The indexed element is outside Studio")
        if item.element_info.control_type != "Edit" or not item.is_enabled():
            raise BridgeError("unsupported_element", "set_value requires an enabled UI Automation Edit control")
        self._assert_foreground(hwnd)
        try:
            item.iface_value.SetValue(value)
            if str(item.iface_value.CurrentValue) != value:
                raise BridgeError("value_readback_failed", "The editable control did not retain the requested value")
        except BridgeError:
            raise
        except Exception as exc:
            raise BridgeError("uia_failed", f"The editable control rejected SetValue: {type(exc).__name__}")
        self.snapshots.pop(hwnd, None)
        return {"value_set": True, "window_id": hwnd}

    def drag(self, params):
        duration, button, flags, modifiers, waypoints = parse_drag_options(params)
        hwnd = self._hwnd(params)
        self._initial_snapshot(hwnd, params)
        self._activate(hwnd)
        snapshot = self._snapshot(hwnd, params)
        absolute = [self._point(hwnd, snapshot, x, y) for x, y in waypoints]
        points = interpolate_drag_path(absolute, duration)
        start, end = points[0], points[-1]
        # Verify every point before pressing, then recheck throughout the drag.
        for point in points:
            self._assert_point(hwnd, point)
        self._move_cursor(hwnd, start)
        presses = [self._key(modifier) for modifier in modifiers] + [self._mouse(flags[0])]
        releases = [self._mouse(flags[1])] + [self._key(modifier, True) for modifier in reversed(modifiers)]
        released = False
        attempted_press = False
        try:
            attempted_press = True
            self._input(hwnd, presses, start)
            started = time.monotonic()
            for index, point in enumerate(points[1:], 1):
                delay = started + duration / 1000 * index / (len(points) - 1) - time.monotonic()
                if delay > 0:
                    time.sleep(delay)
                self._snapshot(hwnd, params)
                self._move_cursor(hwnd, point)
            self._input(hwnd, releases, end)
            released = True
        finally:
            # Releasing our held inputs is cleanup only, even if Studio lost focus.
            if attempted_press and not released:
                self._release_inputs(releases)
            self.snapshots.pop(hwnd, None)
            self.visual_focus.pop(hwnd, None)
        return {"dragged": True, "window_id": hwnd, "duration_ms": duration, "button": button,
                "path_points": len(waypoints)}

    def scroll(self, params):
        modifiers = parse_modifiers(params.get("modifiers"))
        horizontal = _integer(params.get("scrollX", params.get("scroll_x", 0)), "scrollX", -2400, 2400)
        vertical = _integer(params.get("scrollY", params.get("scroll_y", 0)), "scrollY", -2400, 2400)
        hwnd = self._hwnd(params)
        self._initial_snapshot(hwnd, params)
        self._activate(hwnd)
        snapshot = self._snapshot(hwnd, params)
        point = self._point(hwnd, snapshot, params.get("x"), params.get("y"))
        self._move_cursor(hwnd, point)
        items = []
        if vertical:
            items.append(self._mouse(0x0800, -vertical))
        if horizontal:
            items.append(self._mouse(0x1000, horizontal))
        held_modifiers = False
        releases = [self._key(modifier, True) for modifier in reversed(modifiers)]
        try:
            if items and modifiers:
                self._focus_hwnd(hwnd)
                self._input(hwnd, [self._key(modifier) for modifier in modifiers], point)
                held_modifiers = True
            for item in items:
                self._focus_hwnd(hwnd)
                self._input(hwnd, [item], point)
            if held_modifiers:
                self._focus_hwnd(hwnd)
                self._input(hwnd, releases, point)
                held_modifiers = False
        finally:
            if held_modifiers:
                self._release_inputs(releases)
            self.snapshots.pop(hwnd, None)
            self.visual_focus.pop(hwnd, None)
        return {"scrolled": True, "window_id": hwnd}

    def acquire_input_lock(self, params):
        self._windows_only()
        if self.input_mutex_owned:
            raise BridgeError('input_busy', 'This adapter already owns the input lock')
        if self.input_mutex is None:
            self.input_mutex = self.kernel.CreateMutexW(None, False, 'Local\\Insta360StudioMCPInput')
            if not self.input_mutex:
                raise BridgeError('mutex_failed', 'Cannot create the Studio input mutex')
        result = self.kernel.WaitForSingleObject(self.input_mutex, 0)
        if result not in (0, 0x80):
            raise BridgeError('input_busy', 'Another Studio MCP process is controlling the app')
        self.input_mutex_owned = True
        return {'locked': True}

    def release_input_lock(self, params):
        if self.input_mutex_owned:
            if not self.kernel.ReleaseMutex(self.input_mutex):
                raise BridgeError('mutex_failed', 'Cannot release the Studio input mutex')
            self.input_mutex_owned = False
        return {'released': True}

    def dispatch(self, method, params):
        methods = {"status": self.status, "list_windows": self.list_windows, "launch": self.launch,
                   'acquire_input_lock': self.acquire_input_lock, 'release_input_lock': self.release_input_lock,
                   "observe": self.observe, "click": self.click, "hover": self.hover, "press_key": self.press_key,
                   "type_text": self.type_text, "set_value": self.set_value, "drag": self.drag,
                   "scroll": self.scroll, "activate": self.activate, "import_media": self.import_media}
        if method not in methods:
            raise BridgeError("unknown_method", "Unsupported Studio bridge method")
        if not isinstance(params, dict):
            raise BridgeError("invalid_argument", "params must be a JSON object")
        return methods[method](params)


def serve(executable=STUDIO_EXE):
    """Keep protocol output separate from optional dependency diagnostic prints."""
    protocol = sys.stdout
    sys.stdout = sys.stderr
    bridge = StudioBridge(executable)
    for line in sys.stdin:
        request_id = None
        try:
            if len(line.encode("utf-8")) > MAX_REQUEST_BYTES:
                raise BridgeError("request_too_large", "The request exceeds the JSON-line size limit")
            request = json.loads(line)
            if not isinstance(request, dict):
                raise BridgeError("invalid_request", "A JSON object is required")
            request_id = request.get("id")
            result = bridge.dispatch(request.get("method"), request.get("params", {}))
            response = {"id": request_id, "ok": True, "result": result}
        except BridgeError as exc:
            response = {"id": request_id, "ok": False, "error": {"code": exc.code, "message": str(exc)}}
        except json.JSONDecodeError:
            response = {"id": request_id, "ok": False, "error": {"code": "invalid_json", "message": "Invalid JSON request"}}
        except Exception as exc:
            response = {"id": request_id, "ok": False, "error": {"code": "native_error", "message": f"Native adapter failed: {type(exc).__name__}"}}
        protocol.write(json.dumps(response, ensure_ascii=True, separators=(",", ":")) + "\n")
        protocol.flush()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Insta360 Studio-only JSON-lines UI bridge")
    parser.add_argument("--exe", default=STUDIO_EXE)
    args = parser.parse_args()
    serve(args.exe)
