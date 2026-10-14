import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { StudioController } from '../src/studio.mjs';

async function fixture(t) {
  const rootDir = await fs.mkdtemp(join(tmpdir(), 'studio-mcp-test-'));
  t.after(async () => {
    assert.equal(dirname(resolve(rootDir)), resolve(tmpdir()));
    assert(basename(rootDir).startsWith('studio-mcp-test-'));
    await fs.rm(rootDir, { recursive: true, force: true });
  });
  const calls = [];
  let now = 1000;
  const window = { id: 12, app: 'Studio.exe', is_dialog: false, owner_id: 0 };
  const state = { window, snapshot_id: 'shot', accessibility: { tree: '[0] Window', focused_is_editable: false },
    screenshots: [{ id: 'shot', width: 100, height: 80, url: 'data:image/png;base64,aGVsbG8=' }] };
  const nativeClient = { async request(method, args) {
    calls.push({ method, args });
    if (method === 'list_windows') return [window];
    if (method === 'observe') return state;
    return { delivered: true };
  }, async close() {} };
  return { controller: new StudioController({ rootDir, nativeClient, clock: () => now }), calls, state, advance: ms => { now += ms; } };
}
test('rejects foreign windows without delivering input', async t => {
  const { controller, calls } = await fixture(t);
  await assert.rejects(controller.execute('select_window', { window_id: '999' }), { code: 'FOREIGN_WINDOW' });
  assert.equal(calls.some(call => call.method === 'click'), false);
});
test('tokens are single-use; click arguments reach native adapter correctly', async t => {
  const { controller, calls } = await fixture(t);
  const observation = await controller.execute('observe');
  const token = observation.structuredContent.observation_token;
  await controller.execute('click', { observation_token: token, element_id: '0', count: 2, button: 'left' });
  const delivered = calls.find(call => call.method === 'click').args;
  assert.equal(delivered.element_index, 0);
  assert.equal(delivered.click_count, 2);
  assert.equal(delivered.screenshot_id, 'shot');
  await assert.rejects(controller.execute('press_key', { observation_token: token, key: 'ESC' }), { code: 'STALE_OBSERVATION' });
});
test('expired/outside coordinates are rejected before input', async t => {
  const { controller, calls, advance } = await fixture(t);
  let token = (await controller.execute('observe')).structuredContent.observation_token;
  advance(120001);
  await assert.rejects(controller.execute('click', { observation_token: token, x: 1, y: 1 }), { code: 'EXPIRED_OBSERVATION' });
  token = (await controller.execute('observe')).structuredContent.observation_token;
  await assert.rejects(controller.execute('click', { observation_token: token, x: 100, y: 1 }), { code: 'OUTSIDE_WINDOW' });
  assert.equal(calls.some(call => call.method === 'click'), false);
});
test('typing needs verified editable focus; scroll maps direction', async t => {
  const { controller, calls } = await fixture(t);
  let token = (await controller.execute('observe')).structuredContent.observation_token;
  await assert.rejects(controller.execute('type_text', { observation_token: token, text: 'test' }), { code: 'EDIT_FOCUS_REQUIRED' });
  token = (await controller.execute('observe')).structuredContent.observation_token;
  await controller.execute('scroll', { observation_token: token, delta: 120, axis: 'horizontal' });
  const scroll = calls.find(call => call.method === 'scroll').args;
  assert.equal(scroll.scrollX, 120); assert.equal(scroll.scrollY, 0);
  assert.equal(scroll.x, 50); assert.equal(scroll.y, 40);
});
test('import needs a verified dialog and observe uses a cross-process lock', async t => {
  const { controller, calls } = await fixture(t);
  const token = (await controller.execute('observe')).structuredContent.observation_token;
  await assert.rejects(controller.execute('import_media', { observation_token: token, paths: ['C:\\test.mp4'] }), { code: 'OPEN_DIALOG_REQUIRED' });
  assert.equal(calls.some(call => call.method === 'import_media'), false);
  assert.equal(calls.filter(call => call.method === 'acquire_input_lock').length, calls.filter(call => call.method === 'release_input_lock').length);
});
test('screenshot typing requires immediately preceding click and loses that evidence on observe', async t => {
  const { controller, calls } = await fixture(t);
  let token = (await controller.execute('observe')).structuredContent.observation_token;
  await assert.rejects(controller.execute('type_text', { observation_token: token, text: 'text', focus_mode: 'screenshot' }), { code: 'VISUAL_FOCUS_REQUIRED' });
  token = (await controller.execute('observe')).structuredContent.observation_token;
  token = (await controller.execute('click', { observation_token: token, x: 10, y: 10 })).structuredContent.observation_token;
  await controller.execute('type_text', { observation_token: token, text: 'text', focus_mode: 'screenshot', replace: true });
  const typed = calls.find(call => call.method === 'type_text');
  assert.equal(typed.args.allow_visual_focus, true); assert.equal(typed.args.replace, true);
  token = (await controller.execute('observe')).structuredContent.observation_token;
  token = (await controller.execute('click', { observation_token: token, x: 10, y: 10 })).structuredContent.observation_token;
  token = (await controller.execute('observe')).structuredContent.observation_token;
  await assert.rejects(controller.execute('type_text', { observation_token: token, text: 'text', focus_mode: 'screenshot' }), { code: 'VISUAL_FOCUS_REQUIRED' });
});
test('new modal cannot receive input using a previous main-window observation', async t => {
  const { controller, calls } = await fixture(t);
  const token = (await controller.execute('observe')).structuredContent.observation_token;
  controller.windows = async () => [
    { id: 12, enabled: false, is_dialog: false, owner_id: 0 },
    { id: 13, enabled: true, is_dialog: true, owner_id: 12 },
  ];
  await assert.rejects(controller.execute('press_key', { observation_token: token, key: 'ENTER' }), { code: 'WINDOW_CHANGED' });
  assert.equal(calls.some(call => call.method === 'press_key'), false);
});
test('a dialog belonging to another Studio main window cannot steal selection', async t => {
  const { controller, calls } = await fixture(t);
  const token = (await controller.execute('observe')).structuredContent.observation_token;
  controller.windows = async () => [
    { id: 12, enabled: true, is_dialog: false, owner_id: 0 },
    { id: 14, enabled: false, is_dialog: false, owner_id: 0 },
    { id: 15, enabled: true, is_dialog: true, owner_id: 14 },
  ];
  await controller.execute('press_key', { observation_token: token, key: 'RIGHT' });
  assert.equal(calls.find(call => call.method === 'press_key').args.window_id, '12');
  assert.equal(controller.selected, '12');
});
test('initial nested modal selection follows only its verified ownership chain', async t => {
  const { controller, calls } = await fixture(t);
  controller.windows = async () => [
    { id: 12, enabled: false, is_dialog: false, owner_id: 0 },
    { id: 13, enabled: false, is_dialog: true, owner_id: 12 },
    { id: 14, enabled: true, is_dialog: true, owner_id: 13 },
  ];
  await controller.execute('observe');
  assert.equal(calls.find(call => call.method === 'observe').args.window_id, '14');
});
test('adapter generation changes invalidate tokens before input', async t => {
  const { controller, calls } = await fixture(t);
  controller.native.generation = 1;
  controller.native.isGenerationLive = generation => generation === controller.native.generation;
  const token = (await controller.execute('observe')).structuredContent.observation_token;
  controller.native.generation = 2;
  await assert.rejects(controller.execute('press_key', { observation_token: token, key: 'ENTER' }), { code: 'OBSERVATION_LOST' });
  assert.equal(calls.some(call => call.method === 'press_key'), false);
});
test('cleanup failures preserve original input failure and correlated audit records', async t => {
  const { controller } = await fixture(t);
  const token = (await controller.execute('observe')).structuredContent.observation_token;
  const original = controller.native.request;
  controller.native.request = async (method, args) => {
    if (method === 'press_key') throw Object.assign(new Error('Original input timeout'), { code: 'NATIVE_TIMEOUT' });
    if (method === 'release_input_lock') throw new Error('Cleanup unavailable');
    return original(method, args);
  };
  await assert.rejects(controller.execute('press_key', { observation_token: token, key: 'RIGHT' }), error => error.code === 'NATIVE_TIMEOUT' && error.cleanup_error === 'Cleanup unavailable');
  const records = (await fs.readFile(join(controller.rootDir, 'logs', 'actions.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(new Set(records.map(record => record.action_id)).size, 1);
  assert(records.every(record => record.session_id === controller.sessionId));
});
test('an adapter restart during lock acquisition rejects observed typing before delivery', async t => {
  const { controller, calls, state } = await fixture(t);
  controller.native.generation = 1;
  controller.native.isGenerationLive = generation => generation === controller.native.generation;
  state.accessibility.focused_is_editable = true;
  const token = (await controller.execute('observe')).structuredContent.observation_token;
  const original = controller.native.request;
  controller.native.request = async (method, args) => {
    if (method === 'acquire_input_lock') controller.native.generation++;
    return original(method, args);
  };
  await assert.rejects(controller.execute('type_text', { observation_token: token, text: 'Do not deliver' }), error =>
    error.code === 'OBSERVATION_LOST' && error.delivery_state === 'not_delivered');
  assert.equal(calls.some(call => call.method === 'type_text'), false);
  assert.equal(controller.observation, null);
  assert.equal(calls.filter(call => call.method === 'acquire_input_lock').length,
    calls.filter(call => call.method === 'release_input_lock').length, 'The new adapter lock is released after rejecting the old observation');
});
test('an adapter restart during an audit write is rejected immediately before delivery', async t => {
  const { controller, calls, state } = await fixture(t);
  controller.native.generation = 1;
  controller.native.isGenerationLive = generation => generation === controller.native.generation;
  state.accessibility.focused_is_editable = true;
  const token = (await controller.execute('observe')).structuredContent.observation_token;
  const originalLog = controller.log.bind(controller);
  controller.log = async (...args) => {
    await originalLog(...args);
    if (args[2] === 'prepared') controller.native.generation++;
  };
  await assert.rejects(controller.execute('type_text', { observation_token: token, text: 'Do not deliver' }), error =>
    error.code === 'OBSERVATION_LOST' && error.delivery_state === 'not_delivered');
  assert.equal(calls.some(call => call.method === 'type_text'), false);
  assert.equal(controller.observation, null);
  // A replacement adapter must never receive release for an older adapter's mutex.
  assert.equal(calls.filter(call => call.method === 'release_input_lock').length, 1);
});
test('cleanup failure after delivered input preserves correlation and invalidates the result token', async t => {
  const { controller, calls } = await fixture(t);
  const token = (await controller.execute('observe')).structuredContent.observation_token;
  const original = controller.native.request;
  controller.native.request = async (method, args) => {
    if (method === 'release_input_lock') throw Object.assign(new Error('Cannot release input mutex'), { code: 'mutex_failed' });
    return original(method, args);
  };
  let failure;
  await assert.rejects(controller.execute('click', { observation_token: token, x: 10, y: 10 }), error => {
    failure = error;
    return error.code === 'mutex_failed' && error.delivery_state === 'delivered'
      && typeof error.action_id === 'string' && error.cleanup_error === 'Cannot release input mutex';
  });
  assert.equal(calls.filter(call => call.method === 'click').length, 1);
  assert.equal(controller.observation, null);
  assert.equal(controller.visualFocus, null);
  const records = (await fs.readFile(join(controller.rootDir, 'logs', 'actions.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert(records.some(record => record.outcome === 'result_observed'));
  assert.equal(records.at(-1).outcome, 'cleanup_failed');
  assert.equal(records.at(-1).delivery_state, 'delivered');
  assert(records.every(record => record.action_id === failure.action_id));
});
test('launch failure remains primary when releasing its input lock also fails', async t => {
  const { controller } = await fixture(t);
  const original = controller.native.request;
  controller.native.request = async (method, args) => {
    if (method === 'launch') throw Object.assign(new Error('Studio executable is missing'), { code: 'not_installed' });
    if (method === 'release_input_lock') throw new Error('Cannot release launch mutex');
    return original(method, args);
  };
  await assert.rejects(controller.execute('launch'), error => error.code === 'not_installed'
    && error.message === 'Studio executable is missing' && error.cleanup_error === 'Cannot release launch mutex');
});
test('observation lock acquisition failure invalidates the previous token and click anchor', async t => {
  const { controller } = await fixture(t);
  const token = (await controller.execute('observe')).structuredContent.observation_token;
  controller.visualFocus = { windowId: controller.selected, token };
  const original = controller.native.request;
  controller.native.request = async (method, args) => {
    if (method === 'acquire_input_lock') throw Object.assign(new Error('Input is busy'), { code: 'input_busy' });
    return original(method, args);
  };
  await assert.rejects(controller.execute('observe'), { code: 'input_busy' });
  assert.equal(controller.observation, null);
  assert.equal(controller.visualFocus, null);
  await assert.rejects(controller.execute('press_key', { observation_token: token, key: 'RIGHT' }), { code: 'STALE_OBSERVATION' });
});
test('successful capture followed by observation cleanup failure cannot retain a usable token', async t => {
  const { controller, calls } = await fixture(t);
  const original = controller.native.request;
  controller.native.request = async (method, args) => {
    if (method === 'release_input_lock') throw Object.assign(new Error('Observation mutex release failed'), { code: 'mutex_failed' });
    return original(method, args);
  };
  await assert.rejects(controller.execute('observe'), error => error.code === 'mutex_failed'
    && error.cleanup_error === 'Observation mutex release failed');
  assert(calls.some(call => call.method === 'observe'), 'The capture happened before cleanup failed');
  assert.equal(controller.observation, null);
  assert.equal(controller.visualFocus, null);
});
test('observation errors remain primary when releasing the observation lock also fails', async t => {
  const { controller } = await fixture(t);
  controller.visualFocus = { windowId: '12', token: 'old' };
  const original = controller.native.request;
  controller.native.request = async (method, args) => {
    if (method === 'observe') throw Object.assign(new Error('Cannot capture Studio'), { code: 'capture_failed' });
    if (method === 'release_input_lock') throw new Error('Observation cleanup failed');
    return original(method, args);
  };
  await assert.rejects(controller.execute('observe'), error => error.code === 'capture_failed'
    && error.cleanup_error === 'Observation cleanup failed');
  assert.equal(controller.observation, null);
  assert.equal(controller.visualFocus, null);
});
test('modified scrolling preserves the observed point and signed wheel direction', async t => {
  const { controller, calls } = await fixture(t);
  const token = (await controller.execute('observe')).structuredContent.observation_token;
  await controller.execute('scroll', { observation_token: token, x: 20, y: 30, delta: -120, axis: 'horizontal', modifiers: ['Ctrl', 'Shift'] });
  const scroll = calls.find(call => call.method === 'scroll').args;
  assert.deepEqual(scroll.modifiers, ['Ctrl', 'Shift']);
  assert.equal(scroll.x, 20); assert.equal(scroll.y, 30);
  assert.equal(scroll.scrollX, -120); assert.equal(scroll.scrollY, 0);
});
test('compact default uses scaled JPEG and skips Qt UIA while keeping token and image evidence', async t => {
  const { controller, calls, state } = await fixture(t);
  state.window = { ...state.window, title: 'Studio', class_name: 'QtWindow', executable: 'private-path', pid: 99 };
  state.accessibility = null;
  state.screenshots[0] = { ...state.screenshots[0], width: 640, height: 360, physical_width: 1280, physical_height: 720,
    scale_x: 2, scale_y: 2, image_format: 'jpeg', byte_length: 50, url: 'data:image/jpeg;base64,aGVsbG8=' };
  const result = await controller.execute('observe');
  const native = calls.find(call => call.method === 'observe').args;
  assert.equal(native.include_text, false);
  assert.equal(native.image_max_width, 1600); assert.equal(native.image_format, 'jpeg'); assert.equal(native.jpeg_quality, 85);
  assert.equal(result.structuredContent.expires_after_ms, 120000);
  assert(result.structuredContent.observation_token);
  assert.deepEqual(result.structuredContent.window, { id: 12, title: 'Studio', is_dialog: false });
  assert.equal('accessibility' in result.structuredContent, false);
  assert.equal('warning' in result.structuredContent, false);
  assert.equal(result.structuredContent.screenshots[0].scale_x, 2);
  assert.equal(result.content[1].mimeType, 'image/jpeg');
  const token = result.structuredContent.observation_token;
  await controller.execute('click', { observation_token: token, x: 639, y: 359 });
  const clicked = calls.find(call => call.method === 'click').args;
  assert.equal(clicked.x, 639); assert.equal(clicked.y, 359, 'Coordinates reach native in image pixels without double scaling');
  const nextToken = controller.observation.token;
  await assert.rejects(controller.execute('hover', { observation_token: nextToken, x: 640, y: 100 }), { code: 'OUTSIDE_WINDOW' });
});
test('native dialogs enable UIA automatically and explicit full output retains legacy metadata', async t => {
  const { controller, calls, state } = await fixture(t);
  state.window.class_name = '#32770';
  state.window.title = 'Open'; state.window.executable = 'verified-path';
  state.accessibility.available = true;
  state.accessibility.focused_control = { control_type: 'Edit', value_available: true, value: 'clip.mp4' };
  const compact = await controller.execute('observe');
  assert.equal(calls.find(call => call.method === 'observe').args.include_text, true);
  assert.equal(compact.structuredContent.accessibility.tree, '[0] Window');
  assert.equal(compact.structuredContent.accessibility.focused_control.value, 'clip.mp4');
  const full = await controller.execute('observe', { output_detail: 'full', include_text: true, image_max_width: 0, image_format: 'png' });
  assert.equal(full.structuredContent.window.executable, 'verified-path');
  assert(full.structuredContent.warning);
  assert.deepEqual(full.structuredContent.accessibility, { ...state.accessibility, bounds_coordinate_space: 'physical desktop pixels' });
  assert.equal(calls.filter(call => call.method === 'observe').at(-1).args.image_max_width, 0);
});
test('UIA bounds are explicitly physical desktop pixels while screenshot coordinates stay image relative', async t => {
  const { controller, state } = await fixture(t);
  state.accessibility.available = true;
  state.accessibility.tree = '[0] Edit "Title" bounds=(-150,400,2050,600)';
  state.screenshots[0] = { ...state.screenshots[0], width: 1600, height: 1000, physical_width: 3200,
    physical_height: 2000, scale_x: 2, scale_y: 2, originX: -200, originY: 100 };
  for (const output_detail of ['compact', 'full']) {
    const result = await controller.execute('observe', { include_text: true, output_detail });
    assert.equal(result.structuredContent.coordinate_space, 'returned image pixels relative to window');
    assert.equal(result.structuredContent.accessibility.bounds_coordinate_space, 'physical desktop pixels');
    assert.equal(result.structuredContent.accessibility.tree, state.accessibility.tree);
    assert.equal(JSON.parse(result.content[0].text).accessibility.bounds_coordinate_space, 'physical desktop pixels');
  }
  assert.equal(state.accessibility.bounds_coordinate_space, undefined, 'Controller labels its result without mutating native state');
});
test('include_text auto resets explicit choices and follows Qt then native dialog across later actions', async t => {
  const { controller, calls, state } = await fixture(t);
  state.window.class_name = 'QtWindow';
  await controller.execute('observe', { include_text: true });
  assert.equal(calls.filter(call => call.method === 'observe').at(-1).args.include_text, true);
  let result = await controller.execute('observe', { include_text: 'auto' });
  assert.equal(result.structuredContent.capture.include_text, false);
  assert.equal(controller.observePreferences.include_text, undefined);
  await controller.execute('observe');
  assert.equal(calls.filter(call => call.method === 'observe').at(-1).args.include_text, false);
  state.window.class_name = '#32770'; state.window.is_dialog = true;
  result = await controller.execute('observe');
  assert.equal(result.structuredContent.capture.include_text, true);
  result = await controller.execute('press_key', { observation_token: result.structuredContent.observation_token, key: 'RIGHT' });
  assert.equal(result.structuredContent.capture.include_text, true, 'Action result retains auto rather than forcing the previous Qt value');
  await controller.execute('observe', { include_text: false });
  assert.equal(calls.filter(call => call.method === 'observe').at(-1).args.include_text, false);
  await controller.execute('wait_ready', { kind: 'dialog', timeout_ms: 100, include_text: 'auto' });
  assert.equal(calls.filter(call => call.method === 'observe').at(-1).args.include_text, true);
});
test('capture preferences survive action results and wait-ready without resetting explicit UIA/detail', async t => {
  const { controller, calls, state } = await fixture(t);
  state.accessibility.available = true;
  let result = await controller.execute('observe', { include_text: true, max_elements: 50, image_max_width: 2048,
    image_format: 'png', jpeg_quality: 95, output_detail: 'full' });
  result = await controller.execute('press_key', { observation_token: result.structuredContent.observation_token, key: 'RIGHT' });
  assert.equal(result.structuredContent.action.delivery_state, 'delivered');
  assert.equal(result.structuredContent.action.result_requires_visual_verification, true);
  assert(result.structuredContent.warning);
  await controller.execute('wait_ready', { kind: 'main', timeout_ms: 100 });
  for (const call of calls.filter(call => call.method === 'observe')) {
    assert.equal(call.args.image_max_width, 2048); assert.equal(call.args.image_format, 'png');
    assert.equal(call.args.jpeg_quality, 95); assert.equal(call.args.include_text, true); assert.equal(call.args.max_elements, 50);
  }
});
test('compact action keeps delivery evidence but omits verbose native path/window details', async t => {
  const { controller } = await fixture(t);
  const original = controller.native.request;
  controller.native.request = async (method, args) => method === 'press_key'
    ? { pressed: true, repeat: 3, window_id: 12, paths: ['private-source-path'], note: 'long native explanation' }
    : original(method, args);
  const token = (await controller.execute('observe')).structuredContent.observation_token;
  const result = await controller.execute('press_key', { observation_token: token, key: 'RIGHT', repeat: 3 });
  assert.deepEqual(result.structuredContent.action.delivery, { pressed: true, repeat: 3 });
  assert.equal(result.structuredContent.action.delivery_state, 'delivered');
  assert.equal(result.structuredContent.action.result_requires_visual_verification, true);
  assert(result.structuredContent.action.action_id);
  assert.equal('elapsed_ms' in result.structuredContent.action, false);
});
test('capabilities summary is concise while full or family requests retain sources and restrictions', async t => {
  const { controller } = await fixture(t);
  await fs.writeFile(join(controller.rootDir, 'capabilities.json'), JSON.stringify({ families: [
    { id: 'trim', name: 'Trim', support: 'available_through_observed_UI', source_urls: ['https://example.test/trim'],
      requires: ['Eligible footage'], documentation_notes: ['Observed controls required'] },
  ], limitations: ['Original source limitation'] }));
  await fs.writeFile(join(controller.rootDir, 'validation-v3.json'), JSON.stringify({ families: { trim: { status: 'passed', note: 'Specific clip only' } } }));
  const summary = await controller.execute('capabilities');
  assert.deepEqual(summary.families, [{ id: 'trim', name: 'Trim', support: 'available_through_observed_UI', live_status: 'passed' }]);
  assert(summary.restrictions.length); assert.equal('limitations' in summary, false);
  const full = await controller.execute('capabilities', { detail: 'full' });
  assert.deepEqual(full.families[0].source_urls, ['https://example.test/trim']);
  assert.equal(full.families[0].live_validation.note, 'Specific clip only');
  assert.deepEqual(full.limitations, ['Original source limitation']);
  const family = await controller.execute('capabilities', { family: 'trim' });
  assert.deepEqual(family.families, full.families);
});

test('capability evidence follows the newest valid record and names its actual source', async t => {
  const { controller } = await fixture(t);
  await fs.writeFile(join(controller.rootDir, 'capabilities.json'), JSON.stringify({ families: [
    { id: 'deep_track', name: 'Deep Track', support: 'available_through_observed_UI' },
  ], limitations: [] }));
  const oldRecord = { families: { deep_track: { status: 'not_live_tested' } } };
  await fs.writeFile(join(controller.rootDir, 'validation-v3.json'), JSON.stringify(oldRecord));
  await fs.writeFile(join(controller.rootDir, 'validation-v4.json'), JSON.stringify({
    families: { deep_track: { status: 'partially_live_tested', verified: ['Specific tracked test clip'] } },
  }));
  const latest = await controller.execute('capabilities', { family: 'deep_track' });
  assert.equal(latest.families[0].live_validation.status, 'partially_live_tested');
  assert.equal(latest.workflow_evidence_file, join(controller.rootDir, 'VALIDATION-V4.md'));
  await fs.writeFile(join(controller.rootDir, 'validation-v4.json'), 'malformed record');
  const fallback = await controller.execute('capabilities', { family: 'deep_track' });
  assert.equal(fallback.families[0].live_validation.status, 'not_live_tested');
  assert.equal(fallback.workflow_evidence_file, join(controller.rootDir, 'VALIDATION-V3.md'));
  await fs.unlink(join(controller.rootDir, 'validation-v3.json'));
  const unknown = await controller.execute('capabilities', { family: 'deep_track' });
  assert.equal(unknown.families[0].live_validation.status, 'not_live_tested');
  assert.equal(unknown.workflow_evidence_file, null);
});
