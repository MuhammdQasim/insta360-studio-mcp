import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerStudioTools } from '../src/tools.mjs';

// These tests use protocol-connected mock controllers. They send no desktop input.
async function fixture(t, execute) {
  const server = new McpServer({ name: 'insta360-protocol-test', version: '1.0.0' });
  registerStudioTools(server, { execute });
  const client = new Client({ name: 'insta360-test-client', version: '1.0.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

const call = (client, name, args = {}) => client.callTool({ name, arguments: args });

test('MCP publishes all 21 Studio tools with strict object schemas', async t => {
  const client = await fixture(t, async () => ({ ok: true }));
  const { tools } = await client.listTools();
  assert.equal(tools.length, 21);
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'studio_click', 'studio_drag', 'studio_import_media', 'studio_launch',
    'studio_list_windows', 'studio_observe', 'studio_press_key', 'studio_scroll',
    'studio_select_window', 'studio_set_value', 'studio_status', 'studio_type_text',
    'studio_verify_export', 'studio_wait',
    'studio_hover', 'studio_capabilities', 'studio_wait_ready', 'studio_media_info',
    'studio_export_checkpoint', 'studio_verification_status', 'studio_cancel_verification',
  ].sort());
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  }
});
test('new gestures and job tools reject unbounded or mixed arguments', async t => {
  let calls = 0;
  const client = await fixture(t, async () => { calls++; return { ok: true }; });
  for (const [name, args] of [
    ['studio_press_key', { observation_token: 'fresh', key: 'RIGHT', repeat: 31 }],
    ['studio_click', { observation_token: 'fresh', x: 1, y: 1, modifiers: ['Win'] }],
    ['studio_drag', { observation_token: 'fresh', from_x: 1, from_y: 2, to_x: 3, to_y: 4, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }],
    ['studio_drag', { observation_token: 'fresh', points: [{ x: 1, y: 2 }], duration_ms: 6000 }],
    ['studio_verification_status', { job_id: '../escape' }],
    ['studio_media_info', { path: '\\\\server\\share\\media.mp4' }],
  ]) assert.equal((await call(client, name, args)).isError, true, name);
  assert.equal(calls, 0);
  assert.equal((await call(client, 'studio_import_media', { observation_token: 'fresh', paths: ['C:\\media\\music.wav'] })).isError, undefined);
  assert.equal(calls, 1);
});
test('scroll modifiers are distinct bounded Studio modifiers and default to no held keys', async t => {
  const calls = [];
  const client = await fixture(t, async (action, args) => { calls.push({ action, args }); return { ok: true }; });
  for (const modifiers of [['Win'], ['Ctrl', 'Ctrl'], ['Ctrl', 'Shift', 'Alt', 'Ctrl'], 'Ctrl', ['Ctrl+Shift'], ['Control']]) {
    const result = await call(client, 'studio_scroll', { observation_token: 'fresh', delta: 120, modifiers });
    assert.equal(result.isError, true);
  }
  assert.equal(calls.length, 0);
  assert.equal((await call(client, 'studio_scroll', { observation_token: 'fresh', delta: 120 })).isError, undefined);
  assert.deepEqual(calls[0].args.modifiers, []);
  assert.equal((await call(client, 'studio_scroll', { observation_token: 'fresh', x: 10, y: 20, delta: -120,
    axis: 'horizontal', modifiers: ['Ctrl', 'Shift', 'Alt'] })).isError, undefined);
  assert.equal(calls[1].action, 'scroll');
  assert.deepEqual(calls[1].args.modifiers, ['Ctrl', 'Shift', 'Alt']);
  assert.equal(calls[1].args.delta, -120);
});
test('capture schemas bound image options and leave omitted preferences available for persistence', async t => {
  const calls = [];
  const client = await fixture(t, async (action, args) => { calls.push({ action, args }); return { ok: true }; });
  for (const options of [{ image_max_width: 1 }, { image_max_width: 639 }, { image_max_width: 4097 },
    { image_format: 'gif' }, { jpeg_quality: 49 }, { jpeg_quality: 101 }, { output_detail: 'none' }]) {
    assert.equal((await call(client, 'studio_observe', options)).isError, true);
    assert.equal((await call(client, 'studio_wait_ready', options)).isError, true);
  }
  assert.equal(calls.length, 0);
  await call(client, 'studio_observe');
  assert.equal(calls[0].args.include_text, undefined);
  assert.equal(calls[0].args.image_format, undefined);
  assert.equal(calls[0].args.output_detail, undefined);
  await call(client, 'studio_wait_ready', { image_max_width: 0, image_format: 'png', jpeg_quality: 100, output_detail: 'full', include_text: true });
  assert.equal(calls[1].args.image_max_width, 0); assert.equal(calls[1].args.output_detail, 'full');
  await call(client, 'studio_capabilities', { detail: 'full' });
  assert.equal(calls[2].args.detail, 'full');
  assert.equal((await call(client, 'studio_capabilities', { detail: 'unknown' })).isError, true);
});

test('observe and wait-ready accept boolean or auto UIA preferences and reject other reset values', async t => {
  const calls = [];
  const client = await fixture(t, async (action, args) => { calls.push({ action, args }); return { ok: true }; });
  for (const name of ['studio_observe', 'studio_wait_ready']) {
    for (const include_text of [true, false, 'auto']) {
      assert.equal((await call(client, name, { include_text })).isError, undefined);
      assert.equal(calls.at(-1).args.include_text, include_text);
    }
    for (const include_text of ['true', 'false', 'default', null, 0, {}]) {
      assert.equal((await call(client, name, { include_text })).isError, true);
    }
  }
  assert.equal(calls.length, 6, 'Invalid UIA preferences never reach the backend');
});

test('unknown arguments and invalid schema values never reach the backend', async t => {
  let calls = 0;
  const client = await fixture(t, async () => { calls++; return { ok: true }; });
  for (const [name, args] of [
    ['studio_status', { unknown: true }],
    ['studio_click', { observation_token: 'fresh', x: -1, y: 4 }],
    ['studio_click', { observation_token: 'fresh', x: 1, y: 4, count: 3 }],
    ['studio_type_text', { text: 'missing token' }],
    ['studio_wait', { milliseconds: 10001 }],
  ]) {
    const result = await call(client, name, args);
    assert.equal(result.isError, true, name);
  }
  assert.equal(calls, 0);
});

test('mixed, partial and absent click targets are rejected before input', async t => {
  let calls = 0;
  const client = await fixture(t, async () => { calls++; return { ok: true }; });
  for (const target of [
    {}, { x: 10 }, { y: 10 }, { element_id: '1', x: 10 },
    { element_id: '1', x: 10, y: 20 },
  ]) {
    const result = await call(client, 'studio_click', { observation_token: 'fresh', ...target });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'INVALID_ARGUMENT');
  }
  assert.equal(calls, 0);
  assert.equal((await call(client, 'studio_click', { observation_token: 'fresh', element_id: '1' })).isError, undefined);
  assert.equal((await call(client, 'studio_click', { observation_token: 'fresh', x: 10, y: 20 })).isError, undefined);
  assert.equal(calls, 2);
});

test('unsafe imports and invalid export intervals are rejected without backend execution', async t => {
  let calls = 0;
  const client = await fixture(t, async () => { calls++; return { ok: true }; });
  for (const paths of [['C:\\media\\run.exe'], ['relative.mp4'], ['C:\\media\\bad\nname.mp4']]) {
    const result = await call(client, 'studio_import_media', { observation_token: 'fresh', paths });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'INVALID_ARGUMENT');
  }
  const result = await call(client, 'studio_verify_export', {
    path: 'C:\\exports\\clip.mp4', stable_for_ms: 2000, timeout_ms: 1000,
  });
  assert.equal(result.isError, true);
  assert.equal(calls, 0);
});

test('concurrent MCP tool requests serialize backend calls', async t => {
  let active = 0;
  let maxActive = 0;
  const seen = [];
  const client = await fixture(t, async (action) => {
    active++;
    maxActive = Math.max(maxActive, active);
    seen.push(action);
    await delay(15);
    active--;
    return { ok: true, action };
  });
  const results = await Promise.all([
    call(client, 'studio_status'),
    call(client, 'studio_list_windows'),
    call(client, 'studio_wait', { milliseconds: 0 }),
  ]);
  assert.equal(maxActive, 1);
  assert.deepEqual(seen, ['status', 'list_windows', 'wait']);
  assert(results.every(result => !result.isError));
});

test('inline observation images and coded errors survive the MCP protocol', async t => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8WQAAAAASUVORK5CYII=';
  const client = await fixture(t, async action => {
    if (action === 'observe') return {
      content: [
        { type: 'text', text: JSON.stringify({ observation_token: 'fresh-token' }) },
        { type: 'image', data: png, mimeType: 'image/png' },
      ],
    };
    if (action === 'click') throw Object.assign(new Error('Observation is stale'), { code: 'STALE_OBSERVATION' });
    return { ok: true };
  });
  const observation = await call(client, 'studio_observe');
  assert.equal(JSON.parse(observation.content[0].text).observation_token, 'fresh-token');
  assert.deepEqual(observation.content[1], { type: 'image', data: png, mimeType: 'image/png' });
  const failure = await call(client, 'studio_click', { observation_token: 'old-token', x: 10, y: 20 });
  assert.equal(failure.isError, true);
  assert.equal(failure.structuredContent.error.code, 'STALE_OBSERVATION');
  assert.equal(failure.structuredContent.error.message, 'Observation is stale');
  assert.match(failure.structuredContent.next_step, /Do not retry/);
  assert.equal((await call(client, 'studio_status')).structuredContent.ok, true, 'The request queue remains usable after an error');
});
