// Real stdio, read-only integration checks against existing disposable media.
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { promises as fs } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [exportPath, sourcePath] = process.argv.slice(2);
if (!exportPath || !sourcePath) throw new Error('Provide existing validation export and copied source paths.');
const connect = async () => {
  const client = new Client({ name: 'studio-media-integration', version: '0.4.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'src/server.mjs')], cwd: root }));
  return client;
};
const data = result => result.structuredContent || JSON.parse(result.content.find(block => block.type === 'text').text);
const client = await connect();
let other;
const report = { date: new Date().toISOString(), server: client.getServerVersion(), checks: {} };
try {
  const call = async (name, args) => data(await client.callTool({ name, arguments: args }));
  const meta = await call('studio_media_info', { path: exportPath });
  assert(meta.ok && meta.video && meta.audio_present);
  report.checks.metadata = meta;
  const quick = await call('studio_verify_export', { path: exportPath, stable_for_ms: 250, timeout_ms: 2000,
    expected_width: 1920, expected_height: 1080, expected_duration_seconds: 3.94, expected_fps: 29.97, expected_audio: true });
  assert(quick.ok && quick.decode_exit_code === 0);
  report.checks.quick = quick;
  const wrong = await call('studio_verify_export', { path: exportPath, stable_for_ms: 250, timeout_ms: 2000, expected_width: 720 });
  assert.equal(wrong.error?.code, 'WIDTH_MISMATCH'); report.checks.wrong_width_rejected = wrong;
  const checkpoint = await call('studio_export_checkpoint', { path: exportPath });
  const unchanged = await call('studio_verify_export', { path: exportPath, checkpoint_id: checkpoint.checkpoint_id, stable_for_ms: 250, timeout_ms: 2000 });
  assert.equal(unchanged.error?.code, 'EXPORT_UNCHANGED'); report.checks.unchanged_rejected = unchanged;
  const full = await call('studio_verify_export', { path: exportPath, mode: 'full', stable_for_ms: 250, timeout_ms: 2000 });
  assert(full.job_id);
  const poll = async (id, terminal) => {
    for (let index = 0; index < 100; index++) {
      const state = await call('studio_verification_status', { job_id: id });
      if (terminal.includes(state.status)) return state;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Verification did not reach a confirmed terminal state within ten seconds.');
  };
  const completed = await poll(full.job_id, ['completed', 'failed']);
  assert.equal(completed.status, 'completed'); assert.equal(completed.decode_exit_code, 0);
  report.checks.full = completed;
  const long = await call('studio_verify_export', { path: sourcePath, mode: 'full', stable_for_ms: 250, timeout_ms: 2000 });
  assert(long.job_id);
  other = await connect();
  const foreign = data(await other.callTool({ name: 'studio_cancel_verification', arguments: { job_id: long.job_id } }));
  assert.equal(foreign.ok, false); assert(foreign.error?.code);
  report.checks.foreign_cancellation_rejected = foreign;
  const cancel = await call('studio_cancel_verification', { job_id: long.job_id });
  assert(cancel.ok !== false);
  const cancelled = await poll(long.job_id, ['cancelled', 'completed', 'failed']);
  assert.equal(cancelled.status, 'cancelled'); report.checks.owned_cancellation = cancelled;
  await fs.mkdir(join(root, 'artifacts'), { recursive: true });
  await fs.writeFile(join(root, 'artifacts', 'media-integration-v4.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, checks: Object.keys(report.checks), full_status: completed.status, cancellation_status: cancelled.status }));
} finally { await other?.close(); await client.close(); }
