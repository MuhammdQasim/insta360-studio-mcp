#!/usr/bin/env node
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TOOL_DEFINITIONS } from '../src/tools.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flags = new Set(process.argv.slice(2));
const allowed = new Set(['--launch', '--require-window', '--no-observe']);
for (const flag of flags) if (!allowed.has(flag)) throw new Error(`Unknown option: ${flag}`);
if (flags.has('--launch') && flags.has('--no-observe')) throw new Error('--no-observe performs no GUI operations and cannot be combined with --launch.');

const client = new Client({ name: 'insta360-studio-smoke', version: '0.4.0' });
const transport = new StdioClientTransport({
  command: process.execPath, args: [resolve(root, 'src/server.mjs')], cwd: root, stderr: 'pipe',
});
let stderr = '';
transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });

function dataOf(result) {
  if (result.structuredContent) return result.structuredContent;
  for (const item of result.content || []) {
    if (item.type === 'text') { try { return JSON.parse(item.text); } catch {} }
  }
  return null;
}

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 45000 });
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(dataOf(result) || result.content)}`);
  return result;
}

try {
  await client.connect(transport, { timeout: 45000 });
  const info = client.getServerVersion();
  assert.equal(info.name, 'insta360-studio');
  const tools = await client.listTools();
  const names = tools.tools.map(tool => tool.name);
  assert.deepEqual([...names].sort(), TOOL_DEFINITIONS.map(tool => tool.name).sort(), 'Published tools must match all current contracts');
  const status = dataOf(await call('studio_status'));
  const capabilities = dataOf(await call('studio_capabilities'));
  assert.equal(capabilities.installed_version, status.installed_file_version);
  assert(capabilities.families.length > 0, 'Capability inventory must be available');
  let readyObservation;
  if (flags.has('--launch')) {
    await call('studio_launch');
    // A successful Popen is not evidence that Studio's cold-start window is ready.
    readyObservation = await call('studio_wait_ready', { kind: 'main', timeout_ms: 10000,
      include_screenshot: true, include_text: true, max_elements: 200 });
  }
  const windows = dataOf(await call('studio_list_windows'));

  // A closed app is a legitimate read-only smoke result. --require-window checks live observation.
  const listed = Array.isArray(windows) ? windows : (windows?.windows || windows?.data?.windows || []);
  let observation = { skipped: true, reason: 'Studio has no running window; use --launch to test observation.' };
  if (flags.has('--no-observe')) {
    observation = { skipped: true, reason: '--no-observe checks the MCP connection and window inventory without foregrounding or capturing Studio.' };
    if (flags.has('--require-window')) assert(listed.length > 0, 'A running Studio window is required.');
  } else if (listed.length || flags.has('--require-window') || flags.has('--launch')) {
    const result = readyObservation || await call('studio_observe', { include_screenshot: true, include_text: true, max_elements: 200 });
    const data = dataOf(result);
    assert(data?.observation_token, 'Observation must return an observation_token');
    observation = {
      ...data,
      image_count: result.content.filter(item => item.type === 'image').length,
    };
    assert(observation.image_count >= 1, 'Observation must return an inline screenshot');
  }
  console.log(JSON.stringify({ ok: true, server: info, tool_count: names.length, status,
    capabilities: { installed_version: capabilities.installed_version, task_family_count: capabilities.families.length,
      validation_updated_at: capabilities.validation_updated_at, coverage: capabilities.families.map(family => ({ id: family.id, support: family.support, live_validation: family.live_validation?.status ?? family.live_status })) },
    windows, observation }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message, stderr }, null, 2));
  process.exitCode = 1;
} finally {
  await client.close();
}
