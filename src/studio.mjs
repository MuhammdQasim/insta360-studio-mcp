import { randomUUID, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { win32, join } from 'node:path';
import { NativeClient } from './native-client.mjs';
import { MediaVerifier } from './media.mjs';

const MEDIA_EXTENSION = /\.(insv|insp|mp4|mov|m4v|avi|mkv|webm|jpg|jpeg|png|heic|heif|dng|mp3|wav|lrv)$/i;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const OBSERVATION_DEFAULTS = { include_screenshot: true, include_text: undefined, max_elements: 200,
  image_max_width: 1600, image_format: 'jpeg', jpeg_quality: 85, output_detail: 'compact' };
const DELIVERY_FIELDS = new Set(['clicked', 'hovered', 'pressed', 'typed', 'value_set', 'dragged', 'scrolled', 'submitted',
  'repeat', 'media_count', 'character_count', 'click_count', 'duration_ms', 'delivered']);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function scrubArgs(args) {
  const result = { ...args };
  delete result.observation_token;
  for (const key of ['text', 'value']) {
    if (typeof result[key] === 'string') {
      result[`${key}_length`] = result[key].length;
      result[`${key}_sha256`] = createHash('sha256').update(result[key]).digest('hex');
      delete result[key];
    }
  }
  return result;
}

export class StudioController {
  constructor({ rootDir, nativeClient, config = {}, clock = Date.now }) {
    this.rootDir = rootDir;
    this.native = nativeClient || new NativeClient(rootDir);
    this.config = config;
    this.clock = clock;
    this.sessionId = randomUUID();
    this.media = new MediaVerifier({ rootDir, config, sessionId: this.sessionId });
    this.selected = null;
    this.observation = null;
    this.visualFocus = null;
    this.observePreferences = { ...OBSERVATION_DEFAULTS };
  }
  async log(action, args, outcome, error, context = {}) {
    await fs.mkdir(join(this.rootDir, 'logs'), { recursive: true });
    const row = { timestamp: new Date().toISOString(), session_id: this.sessionId, action, window_id: this.selected, args: scrubArgs(args), outcome, ...context,
      ...(error ? { error: { code: error.code || 'ERROR', message: error.message } } : {}) };
    await fs.appendFile(join(this.rootDir, 'logs', 'actions.jsonl'), JSON.stringify(row) + '\n', 'utf8');
  }
  async lock() {
    // A kernel mutex provides atomic ownership and is recovered by Windows after a crash.
    await this.native.request('acquire_input_lock');
    const generation = this.native.generation;
    return async () => {
      // Windows abandons the mutex when an adapter exits. Never spawn a replacement to release it.
      if (typeof this.native.isGenerationLive === 'function' && !this.native.isGenerationLive(generation)) return;
      await this.native.request('release_input_lock');
    };
  }
  async windows() {
    const result = await this.native.request('list_windows');
    return Array.isArray(result) ? result : result.windows || [];
  }
  resolveModal(window, windows) {
    const idOf = item => String(item.id ?? item.window_id);
    const byId = new Map(windows.map(item => [idOf(item), item]));
    const descendantOf = item => {
      let owner = String(item.owner_id || 0), depth = 0;
      const visited = new Set();
      while (owner !== '0' && depth++ < 32 && !visited.has(owner)) {
        if (owner === idOf(window)) return depth;
        visited.add(owner); owner = String(byId.get(owner)?.owner_id || 0);
      }
      return 0;
    };
    const candidates = windows.filter(item => item.is_dialog && item.enabled !== false).map(item => ({ item, depth: descendantOf(item) })).filter(entry => entry.depth);
    if (!candidates.length) return window;
    const deepest = Math.max(...candidates.map(entry => entry.depth));
    const leaves = candidates.filter(entry => entry.depth === deepest);
    if (leaves.length !== 1) fail('AMBIGUOUS_MODAL', 'Multiple Studio dialogs belong to the selected window. List and select the intended dialog explicitly.');
    return leaves[0].item;
  }
  async requireWindow() {
    const windows = await this.windows();
    let window;
    if (this.selected !== null) {
      window = windows.find(item => String(item.id ?? item.window_id) === String(this.selected));
      if (!window) {
        this.selected = null; this.observation = null;
        fail('WINDOW_GONE', 'Selected Studio window closed. Select a current Studio window and observe.');
      }
    } else {
      const main = windows.filter(item => !item.is_dialog && !item.owner_id);
      const candidates = main.length ? main : windows;
      if (candidates.length !== 1) fail('SELECT_WINDOW', `Expected one Studio window; found ${candidates.length}. List and select a Studio window.`);
      window = candidates[0];
    }
    window = this.resolveModal(window, windows);
    this.selected = String(window.id ?? window.window_id);
    return window;
  }
  async observe(args = {}, lockHeld = false) {
    this.observation = null; this.visualFocus = null;
    let release, originalError;
    try {
    release = lockHeld ? async () => {} : await this.lock();
    const window = await this.requireWindow();
    const preferences = { ...this.observePreferences };
    for (const key of Object.keys(OBSERVATION_DEFAULTS)) if (args[key] !== undefined) preferences[key] = args[key];
    if (preferences.include_text === 'auto') preferences.include_text = undefined;
    const includeText = preferences.include_text ?? (window.class_name === '#32770');
    const state = await this.native.request('observe', { window_id: this.selected, include_screenshot: preferences.include_screenshot,
      include_text: includeText, max_elements: preferences.max_elements,
      image_max_width: preferences.image_max_width, image_format: preferences.image_format, jpeg_quality: preferences.jpeg_quality,
      settle_ms: args.settle_ms ?? 250, preserve_visual_focus: Boolean(lockHeld && args.preserve_visual_focus) });
    this.observePreferences = preferences;
    const token = randomUUID();
    this.observation = { token, createdAt: this.clock(), windowId: this.selected, generation: this.native.generation, state, preferences };
    const screenshots = state.screenshots || [];
    const full = preferences.output_detail === 'full';
    const observedWindow = state.window || window;
    const data = { ok: true, observation_token: token, expires_after_ms: 120000,
      window: full ? observedWindow : { id: observedWindow.id ?? observedWindow.window_id ?? this.selected,
        title: observedWindow.title || '', is_dialog: Boolean(observedWindow.is_dialog) },
      coordinate_space: 'returned image pixels relative to window',
      capture: { include_text: includeText },
      screenshots: screenshots.map(({ url, originX, originY, zIndex, ...metadata }) => full ? { ...metadata, originX, originY, zIndex } : metadata) };
    if (full) {
      data.accessibility = state.accessibility ? { ...state.accessibility, bounds_coordinate_space: 'physical desktop pixels' } : null;
      data.warning = 'Input delivery does not prove an edit succeeded. Inspect the returned state. Observe again after manual interaction.';
    } else if (state.accessibility && state.accessibility.available !== false) {
      const { tree, focused_is_editable, focused_control, element_count, truncated } = state.accessibility;
      data.accessibility = { available: true, tree, focused_is_editable, focused_control, element_count, truncated,
        bounds_coordinate_space: 'physical desktop pixels' };
    }
    const content = [{ type: 'text', text: JSON.stringify(data) }];
    for (const screenshot of screenshots) {
      const match = /^data:(image\/(?:png|jpeg));base64,(.+)$/s.exec(screenshot.url || '');
      if (match) content.push({ type: 'image', mimeType: match[1], data: match[2] });
    }
    return { content, structuredContent: data };
    } catch (error) { originalError = error; this.observation = null; this.visualFocus = null; throw error; }
    finally {
      if (release) try { await release(); } catch (cleanup) {
        this.observation = null; this.visualFocus = null;
        if (originalError) originalError.cleanup_error = cleanup.message;
        else { cleanup.cleanup_error = cleanup.message; throw cleanup; }
      }
    }
  }
  consume(token) {
    const observation = this.observation;
    if (!observation || token !== observation.token) fail('STALE_OBSERVATION', 'Use the latest unconsumed observation_token from studio_observe or the previous action result.');
    if (this.clock() - observation.createdAt > 120000) {
      this.observation = null;
      fail('EXPIRED_OBSERVATION', 'Observation is more than two minutes old. Observe Studio again.');
    }
    if (observation.windowId !== this.selected) fail('WRONG_WINDOW', 'Observation belongs to a different Studio window.');
    this.assertObservationGeneration(observation);
    this.observation = null;
    return observation;
  }
  assertObservationGeneration(observation) {
    if (observation.generation !== this.native.generation
      || (typeof this.native.isGenerationLive === 'function' && !this.native.isGenerationLive(observation.generation))) {
      this.observation = null;
      fail('OBSERVATION_LOST', 'The native adapter restarted or exited after this observation. Observe again before input.');
    }
  }
  async input(action, args) {
    const actionId = randomUUID(), started = this.clock();
    let observation, release, originalError, attempted = false, delivery;
    try {
      observation = this.consume(args.observation_token);
      release = await this.lock();
      this.assertObservationGeneration(observation);
      const window = await this.requireWindow();
      if (this.selected !== observation.windowId) {
        fail('WINDOW_CHANGED', 'A different Studio window or dialog became active after the observation. Observe it before sending input.');
      }
      const nativeArgs = { ...args, window_id: this.selected };
      delete nativeArgs.observation_token;
      if (args.element_id !== undefined) { nativeArgs.element_index = Number(args.element_id); delete nativeArgs.element_id; }
      if (args.count !== undefined) { nativeArgs.click_count = args.count; delete nativeArgs.count; }
      if (action === 'scroll') {
        // Positive scroll delta moves down/right, matching Studio tool semantics.
        nativeArgs.scrollY = args.axis === 'horizontal' ? 0 : args.delta;
        nativeArgs.scrollX = args.axis === 'horizontal' ? args.delta : 0;
        delete nativeArgs.delta; delete nativeArgs.axis;
      }
      const screenshot = observation.state.screenshots?.[0];
      nativeArgs.screenshot_id = observation.state.snapshot_id || screenshot?.id;
      if (['click', 'hover', 'drag', 'scroll'].includes(action)) {
        if (args.element_id === undefined) {
          if (!screenshot) fail('SCREENSHOT_REQUIRED', 'Observe with include_screenshot=true before coordinate input.');
          nativeArgs.screenshot_id = screenshot.id;
          const points = action === 'drag' ? (args.points ? args.points.map(point => [point.x, point.y]) : [[args.from_x, args.from_y], [args.to_x, args.to_y]]) : [[args.x ?? Math.floor(screenshot.width / 2), args.y ?? Math.floor(screenshot.height / 2)]];
          for (const [x, y] of points) {
            if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= screenshot.width || y >= screenshot.height) {
              fail('OUTSIDE_WINDOW', 'Coordinates are outside the captured Studio window.');
            }
          }
          if (action === 'scroll') { nativeArgs.x = points[0][0]; nativeArgs.y = points[0][1]; }
        } else if (!observation.state.accessibility) fail('UI_TREE_REQUIRED', 'Observe accessibility text before selecting an element.');
      }
      if (action === 'type_text') {
        if (args.focus_mode === 'screenshot') {
          if (!this.visualFocus || this.visualFocus.token !== observation.token || this.visualFocus.windowId !== this.selected) {
            fail('VISUAL_FOCUS_REQUIRED', 'Click the visible Studio text field and inspect its resulting screenshot before using screenshot typing mode.');
          }
          nativeArgs.allow_visual_focus = true;
        } else if (!observation.state.accessibility?.focused_is_editable) {
          fail('EDIT_FOCUS_REQUIRED', 'Focus an accessible editable field, or click a visible Qt text field and use screenshot typing mode after inspecting its focus.');
        }
      }
      if (action === 'import_media') {
        if (!(window.is_dialog || window.class_name === '#32770')) fail('OPEN_DIALOG_REQUIRED', 'Open Studio’s File > Open Files dialog (CTRL+O), select the returned dialog, then observe it before importing.');
        for (const path of args.paths) {
          if (!win32.isAbsolute(path) || /[\r\n\0"]/.test(path) || !MEDIA_EXTENSION.test(path) || path.startsWith('\\\\')) {
            fail('INVALID_MEDIA_PATH', 'Use an absolute local media path without quotes, control characters or network shares.');
          }
          const info = await fs.stat(path).catch(() => null);
          if (!info?.isFile()) fail('MEDIA_NOT_FOUND', `Media file does not exist: ${path}`);
        }
      }
      await this.log(action, args, 'prepared', undefined, { action_id: actionId, before: this.stateSummary(observation), delivery_state: 'not_delivered' });
      // Window lookup, file checks and audit writes also yield to adapter exit events.
      this.assertObservationGeneration(observation);
      attempted = true;
      delivery = await this.native.request(action, nativeArgs);
      this.visualFocus = null;
      await this.log(action, args, 'input_delivered', undefined, { action_id: actionId, delivery_state: 'delivered', elapsed_ms: this.clock() - started });
      // Let Studio's UI thread create/close its dialog before choosing the next window.
      await sleep(300);
      // Native dialogs can close as a result of input. Select the remaining main window explicitly.
      const windows = await this.windows();
      if (!windows.some(item => String(item.id ?? item.window_id) === this.selected)) {
        const previous = observation.state.window;
        const owner = windows.find(item => String(item.id ?? item.window_id) === String(previous?.owner_id));
        this.selected = owner ? String(owner.id ?? owner.window_id) : null;
      }
      const after = await this.observe({ ...observation.preferences, settle_ms: 400, preserve_visual_focus: action === 'click' && this.selected === observation.windowId }, true);
      if (action === 'click' && this.selected === observation.windowId) this.visualFocus = { windowId: this.selected, token: after.structuredContent.observation_token };
      const compactDelivery = delivery && Object.fromEntries(Object.entries(delivery).filter(([key]) => DELIVERY_FIELDS.has(key)));
      after.structuredContent.action = { action_id: actionId, name: action, delivery_state: 'delivered',
        delivery: this.observePreferences.output_detail === 'full' ? delivery : compactDelivery,
        ...(this.observePreferences.output_detail === 'full' ? { elapsed_ms: this.clock() - started } : {}), result_requires_visual_verification: true };
      after.content[0].text = JSON.stringify(after.structuredContent);
      await this.log(action, args, 'result_observed', undefined, { action_id: actionId, delivery_state: 'delivered', after: this.stateSummary(this.observation), elapsed_ms: this.clock() - started, semantic_verified: false });
      return after;
    } catch (error) {
      this.observation = null;
      this.visualFocus = null;
      originalError = error;
      error.action_id = actionId;
      error.delivery_state = delivery ? 'delivered' : attempted ? 'unknown' : 'not_delivered';
      try { await this.log(action, args, 'rejected_or_incomplete', error, { action_id: actionId, delivery_state: error.delivery_state, elapsed_ms: this.clock() - started }); }
      catch (auditError) { error.audit_error = auditError.message; }
      throw error;
    } finally {
      if (release) try { await release(); } catch (cleanup) {
        if (originalError) originalError.cleanup_error = cleanup.message;
        else {
          this.observation = null; this.visualFocus = null;
          cleanup.action_id = actionId;
          cleanup.delivery_state = delivery ? 'delivered' : attempted ? 'unknown' : 'not_delivered';
          cleanup.cleanup_error = cleanup.message;
          try { await this.log(action, args, 'cleanup_failed', cleanup, { action_id: actionId, delivery_state: cleanup.delivery_state, elapsed_ms: this.clock() - started }); }
          catch (auditError) { cleanup.audit_error = auditError.message; }
          throw cleanup;
        }
      }
    }
  }
  stateSummary(observation) {
    if (!observation) return null;
    return { window_id: observation.windowId, snapshot_id: observation.state.snapshot_id || observation.state.screenshots?.[0]?.id,
      native_generation: observation.generation, element_count: observation.state.accessibility?.element_count || 0,
      image_dimensions: observation.state.screenshots?.[0] ? [observation.state.screenshots[0].width, observation.state.screenshots[0].height] : null };
  }
  async verifyExport(args) {
    const data = await this.media.verify(args);
    await this.log('verify_export', args, data.job_id ? 'full_verification_started' : 'quick_verification_passed');
    return data;
  }
  async capabilities(args = {}) {
    const native = await this.native.request('status');
    const inventory = JSON.parse(await fs.readFile(join(this.rootDir, 'capabilities.json'), 'utf8'));
    let validation = {}, evidenceFile = null;
    for (const version of [4, 3, 2]) {
      try {
        const candidate = JSON.parse(await fs.readFile(join(this.rootDir, `validation-v${version}.json`), 'utf8'));
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
        validation = candidate; evidenceFile = `VALIDATION-V${version}.md`; break;
      } catch {}
    }
    const families = inventory.families.filter(item => !args.family || item.id === args.family).map(item => ({ ...item,
      live_validation: validation.families?.[item.id] || { status: 'not_live_tested', note: 'Available UI route is not proof that this complete workflow passed.' } }));
    if (!families.length) fail('UNKNOWN_FAMILY', 'Unknown task family. Request the full studio_capabilities report to list family IDs.');
    const full = args.detail === 'full' || Boolean(args.family);
    return { ok: true, server_version: '0.4.0', installed_version: native.installed_file_version || native.file_version || native.executable_version || null,
      native_adapter_version: native.adapter_version || null, target: native.executable, interaction_capabilities: native.capabilities || {},
      families: full ? families : families.map(item => ({ id: item.id, name: item.name, support: item.support, live_status: item.live_validation.status })),
      ...(full ? { limitations: inventory.limitations } : { restrictions: ['Studio only; preserve source media.',
        'Observed UI access does not prove workflow completion. Request a family or detail=full for evidence and eligibility.',
        'Inspect installed controls and verify intended edits and exports.'] }), validation_updated_at: validation.updated_at || null,
      workflow_evidence_file: evidenceFile ? join(this.rootDir, evidenceFile) : null };
  }
  async waitReady(args) {
    this.observation = null; this.visualFocus = null;
    const deadline = Date.now() + (args.timeout_ms ?? 10000);
    let windows = [];
    while (Date.now() <= deadline) {
      windows = await this.windows();
      const candidates = windows.filter(item => (args.kind === 'dialog' ? item.is_dialog : args.kind === 'main' ? !item.is_dialog && !item.owner_id : true)
        && (!args.title_contains || (item.title || '').toLowerCase().includes(args.title_contains.toLowerCase())));
      if (candidates.length === 1) { this.selected = String(candidates[0].id ?? candidates[0].window_id); return this.observe(args); }
      if (candidates.length > 1) fail('SELECT_WINDOW', 'More than one matching Studio window is ready. List and select it explicitly.');
      await sleep(150);
    }
    fail('WINDOW_NOT_READY', `No matching Studio window appeared within ${args.timeout_ms ?? 10000}ms. Inspect studio_status.`);
  }
  async execute(action, args = {}) {
    if (['click', 'hover', 'press_key', 'type_text', 'set_value', 'drag', 'scroll', 'import_media'].includes(action)) return this.input(action, args);
    switch (action) {
      case 'status': return { ...(await this.native.request('status')), server: 'insta360-studio', selected_window_id: this.selected,
        server_version: '0.4.0', native_generation: this.native.generation, session_id: this.sessionId,
        observation_ready: Boolean(this.observation && this.clock() - this.observation.createdAt <= 120000
          && (typeof this.native.isGenerationLive !== 'function' || this.native.isGenerationLive(this.observation.generation))), logs_path: join(this.rootDir, 'logs', 'actions.jsonl'),
        coverage: { tested_workflows_file: join(this.rootDir, 'VALIDATION-V4.md'), capability_tool: 'studio_capabilities', editing_controls: 'Observed UI controls; use family-specific live validation evidence.' } };
      case 'launch': {
        this.observation = null; this.visualFocus = null;
        const release = await this.lock();
        let originalError;
        try { const result = await this.native.request('launch'); this.selected = null; await this.log(action, args, 'launched_or_already_running'); return { ok: true, ...result, next_step: 'Call studio_list_windows, select a window if needed, then studio_observe.' }; }
        catch (error) { originalError = error; throw error; }
        finally { try { await release(); } catch (cleanup) { if (originalError) originalError.cleanup_error = cleanup.message; else throw cleanup; } }
      }
      case 'list_windows': return { ok: true, windows: (await this.windows()).map(window => ({ ...window, window_id: String(window.id ?? window.window_id) })) };
      case 'select_window': {
        const windows = await this.windows();
        const window = windows.find(window => String(window.id ?? window.window_id) === String(args.window_id));
        if (!window) fail('FOREIGN_WINDOW', 'Requested window does not belong to the verified Insta360 Studio installation.');
        this.selected = String(args.window_id); this.observation = null;
        return { ok: true, selected_window: window, next_step: 'Call studio_observe before input.' };
      }
      case 'observe': return this.observe(args);
      case 'wait': this.observation = null; await sleep(args.milliseconds ?? 1000); return { ok: true, windows: await this.windows(), next_step: 'Call studio_observe to get a fresh screen and token.' };
      case 'verify_export': return this.verifyExport(args);
      case 'capabilities': return this.capabilities(args);
      case 'wait_ready': return this.waitReady(args);
      case 'media_info': return this.media.mediaInfo(args);
      case 'export_checkpoint': return this.media.checkpoint(args);
      case 'verification_status': return this.media.jobStatus(args);
      case 'cancel_verification': return this.media.cancelJob(args);
      default: fail('UNKNOWN_ACTION', 'Unknown Studio action.');
    }
  }
  async close() { this.observation = null; try { await this.media.close(); } finally { await this.native.close(); } }
}

export async function createStudioController({ rootDir, nativeClient, config, clock } = {}) {
  if (!config) {
    try { config = JSON.parse(await fs.readFile(join(rootDir, 'config.local.json'), 'utf8')); }
    catch { config = {}; }
  }
  return new StudioController({ rootDir, nativeClient, config, clock });
}
