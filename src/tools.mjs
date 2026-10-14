import { win32 } from 'node:path';
import { z } from 'zod';

const token = z.string().min(1).max(128).describe('Fresh single-use observation token.');
const elementId = z.string().regex(/^\d+$/).max(12).describe('Index from current UI tree.');
const coordinate = z.number().int().min(0).max(32767);
const text = z.string().min(1).max(16000);
const modifiers = z.array(z.enum(['Ctrl', 'Shift', 'Alt'])).max(3).refine(values => new Set(values).size === values.length, 'Duplicate modifiers are not allowed').default([]);
const localPath = z.string().min(1).max(4096).refine(path => win32.isAbsolute(path) && !path.startsWith('\\\\') && !/[\r\n\0"]/.test(path), 'Use an absolute local Windows path.');
const uuid = z.string().uuid();
const readonly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const uiAction = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

function schema(shape) { return z.object(shape).strict(); }
const observationOptions = {
  include_screenshot: z.boolean().optional(), include_text: z.union([z.boolean(), z.literal('auto')]).optional().describe('Auto: native dialogs on, Qt off. Boolean choices persist; auto resets them.'),
  max_elements: z.number().int().min(1).max(1000).optional(), settle_ms: z.number().int().min(0).max(2000).optional(),
  image_max_width: z.number().int().min(0).max(4096).refine(value => value === 0 || value >= 640, 'Use 0 or 640..4096').optional().describe('Default 1600; 0 keeps original pixels.'),
  image_format: z.enum(['jpeg', 'png']).optional().describe('Default jpeg.'), jpeg_quality: z.number().int().min(50).max(100).optional(),
  output_detail: z.enum(['compact', 'full']).optional().describe('Default compact. Capture preferences persist.'),
};

export const TOOL_DEFINITIONS = [
  {
    name: 'studio_status', action: 'status', title: 'Insta360 Studio status',
    description: 'Read installation/backend, Studio windows, selection and token readiness. Does not start Studio.',
    inputSchema: schema({}), annotations: readonly,
  },
  {
    name: 'studio_launch', action: 'launch', title: 'Open Insta360 Studio',
    description: 'Start the pinned Studio installation if closed. Use wait_ready for its window; no project edits.',
    inputSchema: schema({}), annotations: { ...uiAction, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'studio_list_windows', action: 'list_windows', title: 'List Studio windows',
    description: 'List verified Studio windows/dialogs and IDs for selection.',
    inputSchema: schema({}), annotations: readonly,
  },
  {
    name: 'studio_select_window', action: 'select_window', title: 'Select Studio window',
    description: 'Select a verified Studio window/dialog. Invalidates the old token; observe before input.',
    inputSchema: schema({ window_id: z.string().min(1).max(128) }),
    annotations: { ...uiAction, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'studio_observe', action: 'observe', title: 'Observe Studio',
    description: 'Fresh Studio image/token. x/y use returned image pixels; UIA bounds are physical desktop pixels, use element_id for tree targets. Defaults: JPEG1600/q85, compact, native-dialog UIA. Preferences persist; include_text=auto resets UIA. Separate observation clears screenshot-typing focus.',
    inputSchema: schema(observationOptions), annotations: { ...readonly, idempotentHint: false },
  },
  {
    name: 'studio_click', action: 'click', title: 'Click Studio control',
    description: 'Click one current UI element_id OR visible returned-image x/y point. Tree bounds are physical desktop pixels; never pass them as x/y. Consumes token; returns after-state. Never guess or retry blindly.',
    inputSchema: schema({
      observation_token: token,
      element_id: elementId.optional(),
      x: coordinate.optional(), y: coordinate.optional(),
      button: z.enum(['left', 'right', 'middle']).default('left'),
      count: z.number().int().min(1).max(2).default(1),
      modifiers,
    }),
    validate: (args) => {
      const hasElement = args.element_id !== undefined;
      const hasPoint = args.x !== undefined && args.y !== undefined;
      if (hasElement === hasPoint || ((args.x !== undefined || args.y !== undefined) && !hasPoint)) {
        throw new ToolInputError('Specify exactly one element_id or a complete x/y point.');
      }
      if (hasElement && (args.x !== undefined || args.y !== undefined)) {
        throw new ToolInputError('Do not combine element_id with coordinates.');
      }
    }, annotations: uiAction,
  },
  {
    name: 'studio_press_key', action: 'press_key', title: 'Press Studio key',
    description: 'Send a supported Studio key/chord with bounded repeats. Consumes token; returns after-state. System/app-switching keys are rejected.',
    inputSchema: schema({ observation_token: token, key: z.string().min(1).max(80), repeat: z.number().int().min(1).max(30).default(1), interval_ms: z.number().int().min(0).max(250).default(50) }), annotations: uiAction,
  },
  {
    name: 'studio_type_text', action: 'type_text', title: 'Type into Studio',
    description: 'Type literal text in a focused field. Accessibility mode needs editable UIA. Qt screenshot mode requires immediately preceding click, inspected caret/focus and that token. Replace is explicit; inspect typed result.',
    inputSchema: schema({ observation_token: token, text, focus_mode: z.enum(['accessibility', 'screenshot']).default('accessibility'), replace: z.boolean().default(false) }), annotations: uiAction,
  },
  {
    name: 'studio_set_value', action: 'set_value', title: 'Set Studio UI value',
    description: 'Set an editable control from the current UIA tree. Consumes token; readback is checked. Unsupported Qt controls require screenshot typing.',
    inputSchema: schema({ observation_token: token, element_id: elementId, value: z.string().max(16000) }), annotations: uiAction,
  },
  {
    name: 'studio_drag', action: 'drag', title: 'Drag within Studio',
    description: 'Drag visible image endpoints OR a bounded path, with optional button/modifiers/duration. Consumes token; inspect resulting edits.',
    inputSchema: schema({ observation_token: token, from_x: coordinate.optional(), from_y: coordinate.optional(), to_x: coordinate.optional(), to_y: coordinate.optional(),
      points: z.array(schema({ x: coordinate, y: coordinate })).min(2).max(64).optional(),
      duration_ms: z.number().int().min(100).max(5000).default(240), button: z.enum(['left', 'right', 'middle']).default('left'), modifiers }),
    validate: args => {
      const endpoints = [args.from_x, args.from_y, args.to_x, args.to_y];
      if (args.points ? endpoints.some(value => value !== undefined) : endpoints.some(value => value === undefined)) throw new ToolInputError('Provide a points path OR all four from/to coordinates, never both.');
    }, annotations: uiAction,
  },
  {
    name: 'studio_scroll', action: 'scroll', title: 'Scroll within Studio',
    description: 'Wheel at an optional visible image point; modifiers support observed zoom controls. Positive delta moves down/right. Consumes token; returns after-state.',
    inputSchema: schema({
      observation_token: token, delta: z.number().int().min(-1200).max(1200).refine(v => v !== 0, 'delta must be nonzero'),
      axis: z.enum(['vertical', 'horizontal']).default('vertical'), x: coordinate.optional(), y: coordinate.optional(),
      modifiers,
    }),
    validate: (args) => {
      if ((args.x === undefined) !== (args.y === undefined)) throw new ToolInputError('Provide both x and y or neither.');
    }, annotations: uiAction,
  },
  {
    name: 'studio_wait', action: 'wait', title: 'Wait for Studio',
    description: 'Wait up to ten seconds without replaying input. Invalidates token; observe before input.',
    inputSchema: schema({ milliseconds: z.number().int().min(0).max(10000).default(1000) }), annotations: readonly,
  },
  {
    name: 'studio_import_media', action: 'import_media', title: 'Import footage into Studio',
    description: 'Import existing local media through an observed Studio-owned Open dialog. Consumes its token; originals stay intact. Inspect the resulting screen to establish import success.',
    inputSchema: schema({ observation_token: token, paths: z.array(z.string().min(1).max(4096)).min(1).max(32) }),
    validate: (args) => {
      for (const path of args.paths) {
        if (!win32.isAbsolute(path) || /[\r\n\0"]/.test(path)) throw new ToolInputError('Media paths must be absolute Windows paths without quotes or control characters.');
        if (!/\.(insv|insp|mp4|mov|m4v|avi|mkv|webm|jpg|jpeg|png|heic|heif|dng|mp3|wav|lrv)$/i.test(path)) {
          throw new ToolInputError('Unsupported media extension. Use an Insta360, video or image file.');
        }
      }
    }, annotations: { ...uiAction, destructiveHint: false },
  },
  {
    name: 'studio_verify_export', action: 'verify_export', title: 'Verify exported media',
    description: 'Check stable output, optional baseline/settings/projection. Spherical expectations require metadata, not a 2:1 image. Quick decodes one second; full returns job_id; poll status for completion. Validity/change does not prove edits or Studio authorship.',
    inputSchema: schema({
      path: z.string().min(1).max(32767), min_bytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(1024),
      stable_for_ms: z.number().int().min(250).max(10000).default(1500),
      timeout_ms: z.number().int().min(500).max(30000).default(10000),
      mode: z.enum(['quick', 'full']).default('quick'), checkpoint_id: uuid.optional(),
      expected_duration_seconds: z.number().positive().max(86400).optional(), duration_tolerance_seconds: z.number().min(0).max(10).default(0.15),
      expected_width: z.number().int().positive().max(32768).optional(), expected_height: z.number().int().positive().max(32768).optional(),
      expected_fps: z.number().positive().max(1000).optional(), expected_video_codec: z.string().regex(/^[a-zA-Z0-9_]+$/).max(50).optional(),
      expected_projection: z.enum(['equirectangular']).optional(),
      expected_audio: z.boolean().optional(), decode_timeout_ms: z.number().int().min(1000).max(7200000).default(1800000),
    }),
    validate: (args) => {
      if (!win32.isAbsolute(args.path) || /[\r\n\0]/.test(args.path)) throw new ToolInputError('Export path must be an absolute Windows path.');
      if (args.stable_for_ms > args.timeout_ms) throw new ToolInputError('stable_for_ms cannot exceed timeout_ms.');
    }, annotations: readonly,
  },
  {
    name: 'studio_hover', action: 'hover', title: 'Hover over Studio control',
    description: 'Hover a visible image point for tooltips/submenus. Consumes token; returns after-state.',
    inputSchema: schema({ observation_token: token, x: coordinate, y: coordinate }), annotations: { ...uiAction, destructiveHint: false },
  },
  {
    name: 'studio_capabilities', action: 'capabilities', title: 'Studio task coverage',
    description: 'Task coverage summary and restrictions. Request family or detail=full for sources/eligibility/live evidence. UI access alone is not a completed workflow.',
    inputSchema: schema({ family: z.string().regex(/^[a-z_]+$/).max(80).optional(), detail: z.enum(['summary', 'full']).default('summary') }), annotations: readonly,
  },
  {
    name: 'studio_wait_ready', action: 'wait_ready', title: 'Wait for Studio window',
    description: 'Wait for one matching Studio window, then observe with saved capture preferences. Window readiness does not prove media processing/export completion.',
    inputSchema: schema({ timeout_ms: z.number().int().min(100).max(10000).default(10000), kind: z.enum(['any', 'main', 'dialog']).default('main'),
      title_contains: z.string().max(200).optional(), ...observationOptions }), annotations: readonly,
  },
  {
    name: 'studio_media_info', action: 'media_info', title: 'Inspect local media',
    description: 'Read local duration/codecs/dimensions/FPS/streams and declared spherical projection, including MP3/WAV/LRV. Missing projection is unknown; metadata does not prove stitching quality or camera-mode eligibility.',
    inputSchema: schema({ path: localPath }), annotations: readonly,
  },
  {
    name: 'studio_export_checkpoint', action: 'export_checkpoint', title: 'Record pre-export baseline',
    description: 'Record exact output baseline before Export. Pass checkpoint_id to verify_export to reject unchanged old files; no media changes.',
    inputSchema: schema({ path: localPath }), annotations: readonly,
  },
  {
    name: 'studio_verification_status', action: 'verification_status', title: 'Full decode status',
    description: 'Read full-decode progress/result. Only completed+ok establishes successful complete decoding and stable output; inspect failed/cancelled errors.',
    inputSchema: schema({ job_id: uuid }), annotations: readonly,
  },
  {
    name: 'studio_cancel_verification', action: 'cancel_verification', title: 'Cancel full decode',
    description: 'Cancel this session\'s owned FFmpeg verification child only. Does not cancel Studio exports or delete media.',
    inputSchema: schema({ job_id: uuid }), annotations: { ...uiAction, destructiveHint: false, idempotentHint: true },
  },
];

class ToolInputError extends Error {
  constructor(message) { super(message); this.code = 'INVALID_ARGUMENT'; }
}

export function errorResult(error) {
  const details = {
    ok: false,
    error: {
      code: typeof error?.code === 'string' ? error.code : 'STUDIO_TOOL_ERROR',
      message: error?.message || String(error),
      ...(error?.action_id ? { action_id: error.action_id, delivery_state: error.delivery_state } : {}),
      ...(error?.cleanup_error ? { cleanup_error: error.cleanup_error } : {}),
      ...(error?.native_code ? { native_code: error.native_code } : {}),
    },
    next_step: 'Inspect the error and call studio_observe before any further input. Do not retry the input blindly.',
  };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(details) }], structuredContent: details };
}

export function toToolResult(value) {
  if (value && Array.isArray(value.content)) return value;
  const data = value === undefined ? { ok: true } : value;
  const objectData = data && typeof data === 'object' && !Array.isArray(data) ? data : { data };
  return {
    content: [{ type: 'text', text: JSON.stringify(objectData) }],
    structuredContent: objectData,
    ...(objectData.ok === false ? { isError: true } : {}),
  };
}

export function registerStudioTools(server, controller) {
  if (typeof controller?.execute !== 'function') throw new TypeError('Studio controller must expose execute(action,args).');
  // One queue protects focus and observation tokens across concurrent MCP requests.
  let tail = Promise.resolve();
  for (const definition of TOOL_DEFINITIONS) {
    server.registerTool(definition.name, {
      title: definition.title, description: definition.description,
      inputSchema: definition.inputSchema, annotations: definition.annotations,
    }, (input) => {
      const operation = tail.then(async () => {
        try {
          const args = definition.inputSchema.parse(input);
          definition.validate?.(args);
          return toToolResult(await controller.execute(definition.action, args));
        } catch (error) { return errorResult(error); }
      });
      tail = operation.then(() => undefined, () => undefined);
      return operation;
    });
  }
}
