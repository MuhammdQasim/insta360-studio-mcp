import importlib.util
from pathlib import Path
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('studio_bridge', Path(__file__).parents[1] / 'native' / 'studio_bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

class NativeGuardTests(unittest.TestCase):
    def test_rejects_system_and_switching_keys(self):
        for key in ('Win+r', 'Meta', 'Alt+Tab', 'Alt+F4', 'CTRL+ALT+DELETE', 'Win', 'CTRL++O', '{ENTER}', 'CTRL+O+P'):
            with self.subTest(key=key), self.assertRaises(bridge.BridgeError):
                bridge.parse_key_chord(key)

    def test_safe_chord_and_literal_strings(self):
        self.assertEqual(bridge.parse_key_chord('CTRL+O'), ([0x11], ord('O')))
        self.assertEqual(bridge.parse_key_chord('Control_L+Shift_L+period'), ([0x11, 0x10], 0xBE))
        self.assertEqual(bridge._text('{ENTER} ^a %x'), '{ENTER} ^a %x')

    def test_rejects_other_executable(self):
        with self.assertRaises(bridge.BridgeError):
            bridge.StudioBridge(r'C:\Windows\System32\cmd.exe')

    def test_input_layout_and_release_flags(self):
        self.assertEqual(bridge.ctypes.sizeof(bridge.INPUT), 40)
        self.assertEqual(bridge.StudioBridge._key(0x11, True).ki.dwFlags & 2, 2)
        self.assertEqual(bridge.StudioBridge._key(0, True, 65).ki.dwFlags & 6, 6)

    def test_modifier_parser_is_bounded_and_rejects_alias_duplicates(self):
        self.assertEqual(bridge.parse_modifiers(['Control_L', 'Shift', 'Alt']), [0x11, 0x10, 0x12])
        self.assertEqual(bridge.parse_modifiers(), [])
        for modifiers in (['Win'], ['CTRL', 'control'], ['Alt', 'alt_l'], ['Ctrl', 'Shift', 'Alt', 'Ctrl'],
                          'CTRL', [True], ['{CTRL}'], ['CTRL+ESC']):
            with self.subTest(modifiers=modifiers), self.assertRaises(bridge.BridgeError):
                bridge.parse_modifiers(modifiers)

    def test_drag_options_preserve_default_and_support_bounded_path(self):
        options = bridge.parse_drag_options({'from_x': 1, 'from_y': 2, 'to_x': 3, 'to_y': 4})
        self.assertEqual(options, (240, 'left', (2, 4), [], [(1, 2), (3, 4)]))
        options = bridge.parse_drag_options({'points': [{'x': 1, 'y': 2}, {'x': 3, 'y': 4}],
                                             'duration_ms': 5000, 'button': 'right', 'modifiers': ['Shift']})
        self.assertEqual(options, (5000, 'right', (8, 16), [16], [(1, 2), (3, 4)]))

    def test_drag_options_reject_malformed_unbounded_or_ambiguous_input(self):
        base = {'from_x': 1, 'from_y': 2, 'to_x': 3, 'to_y': 4}
        bad_options = [{**base, 'duration_ms': value} for value in (99, 5001, True, float('nan'))]
        bad_options.extend([{**base, 'button': value} for value in ('left+right', {}, 'LEFT')])
        bad_options.extend([{**base, 'points': [{'x': 1, 'y': 2}, {'x': 3, 'y': 4}]},
                            {'points': []}, {'points': [{'x': 1, 'y': 2}]},
                            {'points': [{'x': 1, 'y': 2}] * 65},
                            {'points': [{'x': 1, 'y': 2, 'screen': 0}, {'x': 3, 'y': 4}]},
                            {**base, 'to_x': -1}, {**base, 'from_y': 32768}, {**base, 'to_y': 1.25}])
        for options in bad_options:
            with self.subTest(options=options), self.assertRaises(bridge.BridgeError):
                bridge.parse_drag_options(options)

    def test_drag_interpolation_preserves_corners_and_is_bounded(self):
        corners = [(0, 0), (50, 100), (100, 0), (100, 100)]
        points = bridge.interpolate_drag_path(corners, 5000)
        self.assertEqual(points[0], corners[0])
        self.assertEqual(points[-1], corners[-1])
        for corner in corners:
            self.assertIn(corner, points)
        self.assertLessEqual(len(points), 500)
        maximum_path = [(index, index % 2 * 100) for index in range(64)]
        self.assertLessEqual(len(bridge.interpolate_drag_path(maximum_path, 5000)), 500)
        self.assertEqual(bridge.interpolate_drag_path([(5, 5), (5, 5)], 240), [(5, 5), (5, 5)])

    @staticmethod
    def mocked_adapter():
        # Never initialize WinDLL or send native input in this test suite.
        adapter = object.__new__(bridge.StudioBridge)
        adapter.executable = bridge.STUDIO_EXE
        adapter.snapshots = {1: {'id': 'snapshot', 'rect': (10, 20, 110, 120), 'time': 50, 'elements': [], 'input_tick': 123}}
        adapter.visual_focus = {1: {'focus_hwnd': 1}}
        adapter._hwnd = Mock(return_value=1)
        adapter._activate = Mock()
        adapter._snapshot = Mock(return_value=adapter.snapshots[1])
        adapter._rect = Mock(return_value=adapter.snapshots[1]['rect'])
        adapter._point = Mock(side_effect=lambda hwnd, snapshot, x, y: (10 + x, 20 + y))
        adapter._assert_point = Mock()
        adapter._assert_foreground = Mock()
        adapter._focus_hwnd = Mock(return_value=1)
        adapter._input = Mock()
        adapter._move_cursor = Mock()
        adapter._release_inputs = Mock()
        adapter._last_input_tick = Mock(return_value=123)
        adapter.win = SimpleNamespace(SetCursorPos=Mock(return_value=True))
        return adapter

    def test_hover_checks_current_snapshot_and_point_then_clears_click_anchor(self):
        adapter = self.mocked_adapter()
        result = adapter.hover({'window_id': 1, 'screenshot_id': 'snapshot', 'x': 4, 'y': 5})
        self.assertTrue(result['hovered'])
        self.assertEqual(adapter._snapshot.call_count, 2)
        adapter._point.assert_called_once()
        adapter._move_cursor.assert_called_once_with(1, (14, 25))
        self.assertNotIn(1, adapter.snapshots)
        self.assertNotIn(1, adapter.visual_focus)

    def test_click_modifiers_are_rejected_before_touching_window(self):
        for modifiers in (['Win'], ['Ctrl', 'Control'], 'Ctrl', ['Ctrl+Shift']):
            adapter = self.mocked_adapter()
            with self.subTest(modifiers=modifiers), self.assertRaises(bridge.BridgeError):
                adapter.click({'x': 4, 'y': 5, 'modifiers': modifiers})
            adapter._hwnd.assert_not_called()
            adapter._input.assert_not_called()

    def test_click_holds_modifiers_across_double_click_then_releases(self):
        adapter = self.mocked_adapter()
        with patch.object(bridge.time, 'sleep') as pause:
            result = adapter.click({'x': 4, 'y': 5, 'click_count': 2, 'modifiers': ['Ctrl', 'Shift']})
        self.assertTrue(result['clicked'])
        self.assertEqual(adapter._input.call_count, 4)
        down = adapter._input.call_args_list[0].args[1]
        up = adapter._input.call_args_list[-1].args[1]
        self.assertEqual([item.ki.wVk for item in down], [0x11, 0x10])
        self.assertTrue(all(not item.ki.dwFlags & 2 for item in down))
        self.assertEqual([item.ki.wVk for item in up], [0x10, 0x11])
        self.assertTrue(all(item.ki.dwFlags & 2 for item in up))
        for call in adapter._input.call_args_list:
            self.assertEqual(call.args[2], (14, 25))
        adapter._release_inputs.assert_not_called()
        pause.assert_called_once_with(0.06)
        self.assertNotIn(1, adapter.snapshots)

    def test_click_releases_only_held_modifiers_when_scope_changes(self):
        adapter = self.mocked_adapter()
        adapter._input.side_effect = [None, bridge.BridgeError('scope_denied', 'changed window')]
        with self.assertRaises(bridge.BridgeError):
            adapter.click({'x': 4, 'y': 5, 'modifiers': ['Ctrl', 'Alt']})
        releases = adapter._release_inputs.call_args.args[0]
        self.assertEqual([item.ki.wVk for item in releases], [0x12, 0x11])
        self.assertTrue(all(item.type == 1 and item.ki.dwFlags & 2 for item in releases))
        self.assertNotIn(1, adapter.snapshots)
        self.assertNotIn(1, adapter.visual_focus)

    def test_cursor_movement_rejects_windows_failure_without_followup_input(self):
        adapter = self.mocked_adapter()
        adapter.win.SetCursorPos.return_value = False
        with self.assertRaises(bridge.BridgeError) as caught:
            bridge.StudioBridge._move_cursor(adapter, 1, (10, 20))
        self.assertEqual(caught.exception.code, 'input_failed')
        adapter._assert_point.assert_called_once_with(1, (10, 20))
        adapter._input.assert_not_called()

    def test_key_repeat_checks_scope_and_focus_for_each_packet(self):
        adapter = self.mocked_adapter()
        result = adapter.press_key({'key': 'CTRL+Shift+Left', 'screenshot_id': 'snapshot', 'repeat': 3, 'interval_ms': 0})
        self.assertEqual(result['repeat'], 3)
        self.assertEqual(adapter._snapshot.call_count, 4)
        self.assertEqual(adapter._focus_hwnd.call_count, 3)
        self.assertEqual(adapter._assert_foreground.call_count, 3)
        self.assertEqual(adapter._input.call_count, 3)
        packets = adapter._input.call_args.args[1]
        self.assertEqual([packet.ki.wVk for packet in packets], [17, 16, 37, 37, 16, 17])
        self.assertEqual([bool(packet.ki.dwFlags & 2) for packet in packets], [False, False, False, True, True, True])
        self.assertNotIn(1, adapter.snapshots)

    def test_key_repeat_stops_when_window_or_keyboard_focus_changes(self):
        for guard in ('_snapshot', '_focus_hwnd'):
            adapter = self.mocked_adapter()
            snapshots = [adapter.snapshots[1], adapter.snapshots[1]] if guard == '_snapshot' else [1]
            getattr(adapter, guard).side_effect = snapshots + [bridge.BridgeError('focus_changed', 'test change')]
            with self.subTest(guard=guard), self.assertRaises(bridge.BridgeError):
                adapter.press_key({'key': 'Enter', 'screenshot_id': 'snapshot', 'repeat': 3, 'interval_ms': 0})
            self.assertEqual(adapter._input.call_count, 1)
            self.assertNotIn(1, adapter.snapshots)
            self.assertNotIn(1, adapter.visual_focus)

    def test_repeat_bounds_are_checked_before_touching_the_window(self):
        for options in ({'repeat': 0}, {'repeat': 31}, {'repeat': True}, {'interval_ms': -1}, {'interval_ms': 251}):
            adapter = self.mocked_adapter()
            with self.subTest(options=options), self.assertRaises(bridge.BridgeError):
                adapter.press_key({'key': 'Right', **options})
            adapter._hwnd.assert_not_called()
            adapter._input.assert_not_called()

    def test_drag_releases_held_button_and_modifiers_when_layout_changes(self):
        adapter = self.mocked_adapter()
        adapter._snapshot.side_effect = [adapter.snapshots[1], adapter.snapshots[1], bridge.BridgeError('layout_changed', 'moved')]
        with patch.object(bridge.time, 'sleep'), self.assertRaises(bridge.BridgeError):
            adapter.drag({'from_x': 1, 'from_y': 2, 'to_x': 20, 'to_y': 30,
                          'button': 'middle', 'modifiers': ['Ctrl', 'Alt'], 'screenshot_id': 'snapshot'})
        self.assertEqual(adapter._input.call_count, 1)
        releases = adapter._release_inputs.call_args.args[0]
        self.assertEqual(releases[0].mi.dwFlags, 0x0040)
        self.assertEqual([packet.ki.wVk for packet in releases[1:]], [0x12, 0x11])
        self.assertTrue(all(packet.ki.dwFlags & 2 for packet in releases[1:]))
        self.assertNotIn(1, adapter.snapshots)

    def test_drag_has_no_press_when_a_path_crosses_a_blocked_window(self):
        adapter = self.mocked_adapter()
        adapter._assert_point.side_effect = bridge.BridgeError('point_blocked', 'obscured')
        with self.assertRaises(bridge.BridgeError):
            adapter.drag({'points': [{'x': 1, 'y': 2}, {'x': 20, 'y': 30}], 'screenshot_id': 'snapshot'})
        adapter._input.assert_not_called()
        adapter._release_inputs.assert_not_called()

    def test_partial_input_cleanup_contains_only_matching_releases(self):
        adapter = self.mocked_adapter()
        adapter.win.SendInput = Mock(return_value=1)
        presses = [bridge.StudioBridge._key(0x11), bridge.StudioBridge._mouse(0x0008)]
        with self.assertRaises(bridge.BridgeError) as caught:
            bridge.StudioBridge._input(adapter, 1, presses)
        self.assertEqual(caught.exception.code, 'input_failed')
        releases = adapter._release_inputs.call_args.args[0]
        self.assertEqual(releases[0].ki.wVk, 0x11)
        self.assertTrue(releases[0].ki.dwFlags & 2)
        self.assertEqual(releases[1].mi.dwFlags, 0x0010)

    def test_snapshot_rejects_expiry_id_mismatch_and_geometry_change(self):
        for token, timestamp, rectangle, code in (
                ('old', 51, (10, 20, 110, 120), 'stale_state'),
                ('snapshot', 171, (10, 20, 110, 120), 'stale_state'),
                ('snapshot', 51, (11, 20, 110, 120), 'layout_changed')):
            adapter = self.mocked_adapter()
            adapter._rect = Mock(return_value=rectangle)
            with self.subTest(code=code), patch.object(bridge.time, 'monotonic', return_value=timestamp), self.assertRaises(bridge.BridgeError) as caught:
                bridge.StudioBridge._snapshot(adapter, 1, {'screenshot_id': token})
            self.assertEqual(caught.exception.code, code)

    def test_point_coordinates_stay_inside_screenshot_even_for_negative_origins(self):
        adapter = self.mocked_adapter()
        snapshot = {'rect': (-100, -50, 0, 50)}
        self.assertEqual(bridge.StudioBridge._point(adapter, 1, snapshot, 99, 99), (-1, 49))
        for x, y in ((100, 50), (-1, 0), (True, 0), (0, 100)):
            with self.subTest(point=(x, y)), self.assertRaises(bridge.BridgeError):
                bridge.StudioBridge._point(adapter, 1, snapshot, x, y)

    def test_disabled_modal_parent_rejected_before_activation_or_input(self):
        adapter = self.mocked_adapter()
        adapter._scope = Mock(return_value=12)
        adapter.win.IsWindowEnabled = Mock(return_value=False)
        adapter.win.BringWindowToTop = Mock()
        with self.assertRaises(bridge.BridgeError) as caught:
            bridge.StudioBridge._activate(adapter, 1)
        self.assertEqual(caught.exception.code, 'modal_blocked')
        adapter.win.BringWindowToTop.assert_not_called()
        with self.assertRaises(bridge.BridgeError) as caught:
            bridge.StudioBridge._assert_foreground(adapter, 1)
        self.assertEqual(caught.exception.code, 'modal_blocked')

    def test_focused_value_readback_preserves_unicode_and_bounds_size(self):
        control = SimpleNamespace(element_info=SimpleNamespace(is_password=False),
                                  iface_value=SimpleNamespace(CurrentValue='شروع 360° 🎬', CurrentIsReadOnly=False))
        state = bridge.StudioBridge._value_state(control)
        self.assertEqual(state['value'], 'شروع 360° 🎬')
        self.assertTrue(state['value_available'])
        self.assertFalse(state['read_only'])
        self.assertFalse(state['value_truncated'])
        control.iface_value.CurrentValue = 'x' * (bridge.MAX_TEXT_LENGTH + 1)
        state = bridge.StudioBridge._value_state(control)
        self.assertEqual(len(state['value']), bridge.MAX_TEXT_LENGTH)
        self.assertTrue(state['value_truncated'])
        control.element_info.is_password = True
        self.assertEqual(bridge.StudioBridge._value_state(control), {'value_available': False, 'value_redacted': True})
        self.assertEqual(bridge.StudioBridge._value_state(None), {'value_available': False})

    def test_observe_without_screenshot_keeps_snapshot_and_controls_click_anchor(self):
        for preserve in (False, True):
            adapter = self.mocked_adapter()
            adapter._rect = Mock(return_value=(10, 20, 110, 120))
            adapter._accessibility = Mock(return_value=({'available': False}, []))
            adapter._focused_control = Mock(return_value=None)
            adapter._window_data = Mock(return_value={'id': 1})
            with self.subTest(preserve=preserve), patch.object(bridge.time, 'sleep'), patch.dict('sys.modules', {'PIL': None, 'PIL.ImageGrab': None}):
                result = adapter.observe({'include_screenshot': False, 'preserve_visual_focus': preserve})
            self.assertEqual(result['screenshots'], [])
            self.assertEqual(adapter.snapshots[1]['id'], result['snapshot_id'])
            self.assertEqual(adapter.snapshots[1]['input_tick'], 123)
            self.assertEqual(1 in adapter.visual_focus, preserve)

    def test_manual_input_after_observation_rejected_before_activation_for_every_input_method(self):
        cases = [('click', {'x': 1, 'y': 2}), ('hover', {'x': 1, 'y': 2}),
                 ('press_key', {'key': 'Right'}), ('type_text', {'text': 'literal'}),
                 ('set_value', {'element_index': 0, 'value': 'literal'}),
                 ('import_media', {'paths': ['C:\\test.mp4']}),
                 ('drag', {'from_x': 1, 'from_y': 2, 'to_x': 3, 'to_y': 4}),
                 ('scroll', {'x': 1, 'y': 2, 'scrollY': 120})]
        for action, params in cases:
            adapter = self.mocked_adapter()
            adapter._last_input_tick.return_value = 124
            with self.subTest(action=action), self.assertRaises(bridge.BridgeError) as caught:
                getattr(adapter, action)({'screenshot_id': 'snapshot', **params})
            self.assertEqual(caught.exception.code, 'manual_input_detected')
            adapter._activate.assert_not_called()
            adapter._input.assert_not_called()
            adapter._move_cursor.assert_not_called()
            self.assertNotIn(1, adapter.snapshots)
            self.assertNotIn(1, adapter.visual_focus)

    def test_input_tick_read_failure_and_missing_snapshot_evidence_fail_closed(self):
        for missing in (False, True):
            adapter = self.mocked_adapter()
            if missing:
                del adapter.snapshots[1]['input_tick']
            else:
                adapter._last_input_tick.side_effect = bridge.BridgeError('input_state_unknown', 'read failed')
            with self.subTest(missing=missing), self.assertRaises(bridge.BridgeError) as caught:
                adapter.press_key({'screenshot_id': 'snapshot', 'key': 'Enter'})
            self.assertEqual(caught.exception.code, 'input_state_unknown')
            adapter._activate.assert_not_called()
            adapter._input.assert_not_called()
            self.assertNotIn(1, adapter.snapshots)

    def test_own_key_packets_update_input_tick_without_triggering_manual_guard_mid_action(self):
        adapter = self.mocked_adapter()
        adapter._input.side_effect = lambda *args: setattr(adapter._last_input_tick, 'return_value', 124)
        result = adapter.press_key({'screenshot_id': 'snapshot', 'key': 'Right', 'repeat': 3, 'interval_ms': 0})
        self.assertEqual(result['repeat'], 3)
        adapter._last_input_tick.assert_called_once()
        self.assertEqual(adapter._input.call_count, 3)

    def test_input_tick_reader_uses_win32_structure_and_accepts_dword_wrap(self):
        adapter = self.mocked_adapter()
        def read_tick(pointer):
            info = bridge.ctypes.cast(pointer, bridge.ctypes.POINTER(bridge.LASTINPUTINFO)).contents
            self.assertEqual(info.cbSize, bridge.ctypes.sizeof(bridge.LASTINPUTINFO))
            info.dwTime = 0xFFFFFFFF
            return True
        adapter.win.GetLastInputInfo = Mock(side_effect=read_tick)
        self.assertEqual(bridge.StudioBridge._last_input_tick(adapter), 0xFFFFFFFF)
        adapter.win.GetLastInputInfo = Mock(return_value=False)
        with self.assertRaises(bridge.BridgeError) as caught:
            bridge.StudioBridge._last_input_tick(adapter)
        self.assertEqual(caught.exception.code, 'input_state_unknown')

    def test_legacy_direct_key_without_snapshot_remains_compatible(self):
        adapter = self.mocked_adapter()
        self.assertTrue(adapter.press_key({'key': 'Enter'})['pressed'])
        adapter._last_input_tick.assert_not_called()

    def test_observation_rejects_input_during_pixels_or_uia_and_clears_state(self):
        for phase in ('screenshot', 'uia'):
            adapter = self.mocked_adapter()
            adapter._focused_control = Mock(return_value=None)
            adapter._window_data = Mock(return_value={'id': 1})
            image = SimpleNamespace(width=100, height=100,
                                    save=lambda output, **kwargs: output.write(b'fake PNG pixels'))
            image.convert = lambda mode: image
            def capture(*args, **kwargs):
                adapter._last_input_tick.return_value = 124
                return image
            def accessibility(*args, **kwargs):
                if phase == 'uia':
                    adapter._last_input_tick.return_value = 124
                return {'available': False}, []
            adapter._accessibility = Mock(side_effect=accessibility)
            fake_pil = ModuleType('PIL')
            fake_pil.Image = SimpleNamespace(Resampling=SimpleNamespace(LANCZOS=1))
            fake_pil.ImageGrab = SimpleNamespace(grab=Mock(side_effect=capture))
            with self.subTest(phase=phase), patch.dict('sys.modules', {'PIL': fake_pil}), self.assertRaises(bridge.BridgeError) as caught:
                adapter.observe({'include_screenshot': phase == 'screenshot', 'settle_ms': 0, 'preserve_visual_focus': True})
            self.assertEqual(caught.exception.code, 'manual_input_detected')
            self.assertNotIn(1, adapter.snapshots)
            self.assertNotIn(1, adapter.visual_focus)
            adapter._accessibility.assert_called_once()
            adapter._input.assert_not_called()

    def test_scroll_modifiers_guard_both_axes_and_release_in_reverse_order(self):
        adapter = self.mocked_adapter()
        result = adapter.scroll({'screenshot_id': 'snapshot', 'x': 4, 'y': 5,
                                 'scrollX': 240, 'scrollY': 120, 'modifiers': ['Ctrl', 'Shift']})
        self.assertTrue(result['scrolled'])
        self.assertEqual(adapter._input.call_count, 4)
        self.assertEqual(adapter._focus_hwnd.call_count, 4)
        packets = [call.args[1] for call in adapter._input.call_args_list]
        self.assertEqual([item.ki.wVk for item in packets[0]], [0x11, 0x10])
        self.assertEqual(packets[1][0].mi.dwFlags, 0x0800)
        self.assertEqual(packets[1][0].mi.mouseData, (-120) & 0xFFFFFFFF)
        self.assertEqual(packets[2][0].mi.dwFlags, 0x1000)
        self.assertEqual(packets[2][0].mi.mouseData, 240)
        self.assertEqual([item.ki.wVk for item in packets[3]], [0x10, 0x11])
        self.assertTrue(all(item.ki.dwFlags & 2 for item in packets[3]))
        self.assertTrue(all(call.args[2] == (14, 25) for call in adapter._input.call_args_list))
        adapter._release_inputs.assert_not_called()
        self.assertNotIn(1, adapter.snapshots)

    def test_scroll_modifier_cleanup_on_scope_or_focus_failure(self):
        for guard in ('scope', 'focus'):
            adapter = self.mocked_adapter()
            if guard == 'scope':
                adapter._input.side_effect = [None, bridge.BridgeError('scope_denied', 'changed')]
            else:
                adapter._focus_hwnd.side_effect = [1, bridge.BridgeError('focus_changed', 'changed')]
            with self.subTest(guard=guard), self.assertRaises(bridge.BridgeError):
                adapter.scroll({'screenshot_id': 'snapshot', 'x': 4, 'y': 5, 'scrollY': 120, 'modifiers': ['Alt', 'Ctrl']})
            releases = adapter._release_inputs.call_args.args[0]
            self.assertEqual([item.ki.wVk for item in releases], [0x11, 0x12])
            self.assertTrue(all(item.type == 1 and item.ki.dwFlags & 2 for item in releases))
            self.assertNotIn(1, adapter.snapshots)
            self.assertNotIn(1, adapter.visual_focus)

    def test_scroll_rejects_bad_modifiers_without_activating_window(self):
        for modifiers in (['Win'], ['Ctrl', 'Control'], 'Alt'):
            adapter = self.mocked_adapter()
            with self.subTest(modifiers=modifiers), self.assertRaises(bridge.BridgeError):
                adapter.scroll({'x': 4, 'y': 5, 'scrollY': 120, 'modifiers': modifiers})
            adapter._hwnd.assert_not_called()
            adapter._input.assert_not_called()

    @staticmethod
    def fake_psutil(processes):
        module = ModuleType('psutil')
        module.Error = type('FakeProcessError', (Exception,), {})
        module.NoSuchProcess = type('FakeNoSuchProcess', (module.Error,), {})
        module.ZombieProcess = type('FakeZombieProcess', (module.NoSuchProcess,), {})
        module.AccessDenied = type('FakeAccessDenied', (module.Error,), {})
        module.process_iter = Mock(return_value=iter(processes))
        module.process_iter.cache_clear = Mock()
        return module

    def test_process_scan_verifies_only_exact_studio_executable_and_refreshes_pid_cache(self):
        actual = SimpleNamespace(pid=11, info={'name': 'Insta360 Studio.exe'},
                                 exe=Mock(return_value=bridge.STUDIO_EXE), is_running=Mock(return_value=True))
        impostor = SimpleNamespace(pid=12, info={'name': 'Insta360 Studio.exe'},
                                   exe=Mock(return_value=r'C:\\Elsewhere\\Insta360 Studio.exe'), is_running=Mock(return_value=True))
        other = SimpleNamespace(pid=13, info={'name': 'cmd.exe'}, exe=Mock())
        module = self.fake_psutil([actual, impostor, other])
        adapter = self.mocked_adapter()
        with patch.dict('sys.modules', {'psutil': module}):
            self.assertEqual(adapter._running_studio_processes(), [11])
        module.process_iter.cache_clear.assert_called_once()
        module.process_iter.assert_called_once_with(['pid', 'name'])
        other.exe.assert_not_called()

    def test_process_scan_fails_closed_for_unknown_studio_candidate_and_skips_exited_pid(self):
        adapter = self.mocked_adapter()
        module = self.fake_psutil([])
        unknown = SimpleNamespace(pid=11, info={'name': 'Insta360 Studio.exe'},
                                  exe=Mock(side_effect=module.AccessDenied()))
        module.process_iter.return_value = iter([unknown])
        with patch.dict('sys.modules', {'psutil': module}), self.assertRaises(bridge.BridgeError) as caught:
            adapter._running_studio_processes()
        self.assertEqual(caught.exception.code, 'process_state_unknown')
        unknown.exe.side_effect = module.NoSuchProcess()
        module.process_iter.return_value = iter([unknown])
        with patch.dict('sys.modules', {'psutil': module}):
            self.assertEqual(adapter._running_studio_processes(), [])

    def test_cold_launch_returns_running_pid_without_spawning_duplicate_or_claiming_window_ready(self):
        adapter = self.mocked_adapter()
        adapter.list_windows = Mock(return_value=[])
        adapter._running_studio_processes = Mock(return_value=[99])
        with patch.object(bridge.Path, 'is_file', return_value=True), patch.object(bridge.subprocess, 'Popen') as spawn:
            result = adapter.launch({})
        self.assertTrue(result['already_running'])
        self.assertEqual(result['process_ids'], [99])
        self.assertEqual(result['readiness'], 'waiting_for_visible_window')
        self.assertFalse(result['window_detected'])
        spawn.assert_not_called()

    def test_cold_launch_spawns_only_when_verified_scan_has_no_studio_process(self):
        adapter = self.mocked_adapter()
        adapter.list_windows = Mock(return_value=[])
        adapter._running_studio_processes = Mock(return_value=[])
        with patch.object(bridge.Path, 'is_file', return_value=True), patch.object(bridge.subprocess, 'Popen', return_value=SimpleNamespace(pid=99)) as spawn:
            result = adapter.launch({})
        self.assertTrue(result['started'])
        self.assertEqual(result['readiness'], 'waiting_for_visible_window')
        self.assertFalse(result['window_detected'])
        self.assertEqual(spawn.call_args.args[0], [bridge.STUDIO_EXE])
        self.assertFalse(spawn.call_args.kwargs['shell'])

    def test_cold_launch_does_not_spawn_when_process_verification_is_uncertain(self):
        adapter = self.mocked_adapter()
        adapter.list_windows = Mock(return_value=[])
        adapter._running_studio_processes = Mock(side_effect=bridge.BridgeError('process_state_unknown', 'unverified'))
        with patch.object(bridge.Path, 'is_file', return_value=True), patch.object(bridge.subprocess, 'Popen') as spawn, self.assertRaises(bridge.BridgeError):
            adapter.launch({})
        spawn.assert_not_called()

    def test_image_options_defaults_original_png_and_bounds(self):
        self.assertEqual(bridge.parse_image_options({}), (1600, 'jpeg', 85))
        self.assertEqual(bridge.parse_image_options({'image_max_width': 0, 'image_format': 'png', 'jpeg_quality': 100}), (0, 'png', 100))
        for params in ({'image_max_width': 639}, {'image_max_width': 4097}, {'image_max_width': True},
                       {'image_max_width': -1}, {'image_format': 'gif'}, {'image_format': 'JPEG'},
                       {'jpeg_quality': 49}, {'jpeg_quality': 101}):
            with self.subTest(params=params), self.assertRaises(bridge.BridgeError):
                bridge.parse_image_options(params)

    def test_resize_dimensions_preserve_aspect_ratio_and_never_upscale(self):
        self.assertEqual(bridge.scaled_image_size(2520, 1631, 1600), (1600, 1036))
        self.assertEqual(bridge.scaled_image_size(2520, 1631, 0), (2520, 1631))
        self.assertEqual(bridge.scaled_image_size(800, 600, 1600), (800, 600))
        self.assertEqual(bridge.scaled_image_size(3840, 2160, 640), (640, 360))

    def test_resized_image_points_map_to_physical_pixels_with_negative_monitor_origin(self):
        adapter = self.mocked_adapter()
        snapshot = {'rect': (-100, -50, 2420, 1581), 'coordinate_size': (1600, 1036)}
        for image_point, expected in (((0, 0), (-100, -50)), ((800, 518), (1160, 765)),
                                      ((1599, 1035), (2418, 1579))):
            actual = bridge.StudioBridge._point(adapter, 1, snapshot, *image_point)
            self.assertEqual(actual, expected)
            adapter._assert_point.assert_called_with(1, expected)
        for x, y in ((1600, 0), (0, 1036), (2000, 1500), (-1, 0)):
            with self.subTest(point=(x, y)), self.assertRaises(bridge.BridgeError):
                bridge.StudioBridge._point(adapter, 1, snapshot, x, y)

    def test_resized_image_point_guard_hit_tests_mapped_physical_position(self):
        adapter = self.mocked_adapter()
        adapter._assert_point = lambda hwnd, point: bridge.StudioBridge._assert_point(adapter, hwnd, point)
        adapter.win.WindowFromPoint = Mock(return_value=2)
        adapter._scope = Mock(side_effect=bridge.BridgeError('scope_denied', 'foreign covering window'))
        with self.assertRaises(bridge.BridgeError) as caught:
            bridge.StudioBridge._point(adapter, 1, {'rect': (100, 200, 2100, 1200), 'coordinate_size': (1000, 500)}, 50, 60)
        self.assertEqual(caught.exception.code, 'scope_denied')
        hit_point = adapter.win.WindowFromPoint.call_args.args[0]
        self.assertEqual((hit_point.x, hit_point.y), (200, 320))

    def test_image_encoding_returns_actual_size_scale_and_original_png_option(self):
        from PIL import Image
        import base64
        import io
        cases = [({}, (1600, 1000), 'JPEG'),
                 ({'image_max_width': 640, 'image_format': 'jpeg', 'jpeg_quality': 50}, (640, 400), 'JPEG'),
                 ({'image_max_width': 0, 'image_format': 'png'}, (2560, 1600), 'PNG')]
        for options, expected_size, expected_format in cases:
            adapter = self.mocked_adapter()
            adapter._rect.return_value = (10, 20, 2570, 1620)
            adapter._accessibility = Mock(return_value=({'available': False}, []))
            adapter._focused_control = Mock(return_value=None)
            adapter._window_data = Mock(return_value={'id': 1})
            source = Image.new('RGBA', (2560, 1600), (30, 150, 220, 255))
            with self.subTest(options=options), patch('PIL.ImageGrab.grab', return_value=source):
                result = adapter.observe({'settle_ms': 0, **options})
            screenshot = result['screenshots'][0]
            self.assertEqual((screenshot['width'], screenshot['height']), expected_size)
            self.assertEqual((screenshot['physical_width'], screenshot['physical_height']), (2560, 1600))
            self.assertEqual(screenshot['scale_x'], 2560 / expected_size[0])
            self.assertEqual(screenshot['scale_y'], 1600 / expected_size[1])
            self.assertEqual(adapter.snapshots[1]['coordinate_size'], expected_size)
            self.assertEqual(result['coordinate_space'], 'screenshot_image_pixels')
            encoded = base64.b64decode(screenshot['url'].split(',', 1)[1])
            self.assertEqual(screenshot['byte_length'], len(encoded))
            with Image.open(io.BytesIO(encoded)) as decoded:
                self.assertEqual(decoded.size, expected_size)
                self.assertEqual(decoded.format, expected_format)

    def test_no_text_observation_skips_uia_collection_and_keeps_geometry_input_guards(self):
        adapter = self.mocked_adapter()
        adapter._accessibility = Mock()
        adapter._focused_control = Mock()
        adapter._window_data = Mock(return_value={'id': 1})
        result = adapter.observe({'settle_ms': 0, 'include_screenshot': False, 'include_text': False})
        self.assertIsNone(result['accessibility'])
        adapter._accessibility.assert_not_called()
        adapter._focused_control.assert_not_called()
        self.assertEqual(adapter._last_input_tick.call_count, 2)
        self.assertEqual(adapter.snapshots[1]['coordinate_size'], (100, 100))

    def test_accessible_element_center_remains_physical_when_screenshot_resized(self):
        adapter = self.mocked_adapter()
        adapter._scope = Mock(return_value=11)
        rectangle = SimpleNamespace(left=240, top=100, right=280, bottom=140)
        element = SimpleNamespace(element_info=SimpleNamespace(process_id=11), rectangle=Mock(return_value=rectangle))
        adapter.snapshots[1].update({'rect': (0, 0, 400, 400), 'coordinate_size': (100, 100), 'elements': [element]})
        adapter._rect.return_value = (0, 0, 400, 400)
        self.assertTrue(adapter.click({'screenshot_id': 'snapshot', 'element_index': 0})['clicked'])
        adapter._point.assert_not_called()
        adapter._move_cursor.assert_called_once_with(1, (260, 120))

    def test_drag_image_waypoints_are_scaled_before_physical_interpolation(self):
        adapter = self.mocked_adapter()
        adapter.snapshots[1].update({'rect': (0, 0, 200, 200), 'coordinate_size': (100, 100)})
        adapter._rect.return_value = (0, 0, 200, 200)
        adapter._point = lambda *args: bridge.StudioBridge._point(adapter, *args)
        with patch.object(bridge.time, 'sleep'):
            adapter.drag({'screenshot_id': 'snapshot', 'points': [{'x': 10, 'y': 20}, {'x': 50, 'y': 70}]})
        self.assertEqual(adapter._input.call_args_list[0].args[2], (20, 40))
        self.assertEqual(adapter._input.call_args_list[-1].args[2], (100, 140))
        self.assertEqual(adapter._move_cursor.call_args_list[0].args, (1, (20, 40)))
        self.assertEqual(adapter._move_cursor.call_args_list[-1].args, (1, (100, 140)))

    def test_observation_settles_then_rechecks_foreground_before_capture_bounds(self):
        adapter = self.mocked_adapter()
        events = []
        adapter._activate.side_effect = lambda *args, **kwargs: events.append('activate')
        adapter._assert_foreground.side_effect = lambda *args: events.append('guard')
        adapter._rect = Mock(side_effect=lambda *args: (events.append('bounds'), (10, 20, 110, 120))[1])
        adapter._accessibility = Mock(return_value=({'available': False}, []))
        adapter._focused_control = Mock(return_value=None)
        adapter._window_data = Mock(return_value={'id': 1})
        with patch.object(bridge.time, 'sleep', side_effect=lambda *args: events.append('settle')) as pause:
            adapter.observe({'include_screenshot': False, 'settle_ms': 400})
        pause.assert_called_once_with(0.4)
        self.assertEqual(events[:4], ['activate', 'settle', 'guard', 'bounds'])

    def test_observation_settle_bounds_are_checked_before_touching_window(self):
        for duration in (-1, 2001, True, float('nan')):
            adapter = self.mocked_adapter()
            with self.subTest(duration=duration), self.assertRaises(bridge.BridgeError):
                adapter.observe({'settle_ms': duration})
            adapter._hwnd.assert_not_called()

    def test_focused_uia_control_requires_verified_window_ancestry(self):
        for handle, root, valid in ((0, 1, False), (2, 2, False), (2, 1, True)):
            adapter = self.mocked_adapter()
            adapter._load_uia = Mock(return_value=object())
            adapter._scope = Mock(return_value=11)
            adapter.win.GetAncestor = Mock(return_value=root)
            focused = SimpleNamespace(element_info=SimpleNamespace(process_id=11, handle=handle))
            focused.parent = Mock(return_value=focused)
            fake_modules = {name: ModuleType(name) for name in
                            ('pywinauto', 'pywinauto.uia_defines', 'pywinauto.uia_element_info',
                             'pywinauto.controls', 'pywinauto.controls.uiawrapper')}
            fake_modules['pywinauto.uia_defines'].IUIA = lambda: SimpleNamespace(iuia=SimpleNamespace(GetFocusedElement=lambda: None))
            fake_modules['pywinauto.uia_element_info'].UIAElementInfo = lambda item: item
            fake_modules['pywinauto.controls.uiawrapper'].UIAWrapper = lambda item: focused
            with self.subTest(handle=handle, root=root), patch.dict('sys.modules', fake_modules):
                result = bridge.StudioBridge._focused_control(adapter, 1)
            self.assertIs(result, focused if valid else None)
            if not handle:
                self.assertEqual(focused.parent.call_count, 32)

    def test_set_value_reports_mismatched_readback_instead_of_success(self):
        for retained, succeeds in (('開始 🎬', True), ('changed', False)):
            adapter = self.mocked_adapter()
            adapter._scope = Mock(return_value=11)
            control = SimpleNamespace(element_info=SimpleNamespace(process_id=11, control_type='Edit'),
                                      is_enabled=Mock(return_value=True),
                                      iface_value=SimpleNamespace(SetValue=Mock(), CurrentValue=retained))
            adapter.snapshots[1]['elements'] = [control]
            if succeeds:
                result = adapter.set_value({'element_index': 0, 'value': '開始 🎬', 'screenshot_id': 'snapshot'})
                self.assertTrue(result['value_set'])
            else:
                with self.assertRaises(bridge.BridgeError) as caught:
                    adapter.set_value({'element_index': 0, 'value': '開始 🎬', 'screenshot_id': 'snapshot'})
                self.assertEqual(caught.exception.code, 'value_readback_failed')
            control.iface_value.SetValue.assert_called_once_with('開始 🎬')

if __name__ == '__main__':
    unittest.main()
