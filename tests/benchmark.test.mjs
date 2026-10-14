import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { imageDimensions, measurePayload, observationEvidence, percentile, summarize, parseArguments, profiles, runBenchmark, writeReport } from '../scripts/benchmark.mjs';

function png(width, height, extra = 0) {
  const bytes = Buffer.alloc(24 + extra);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12, 'ascii'); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return bytes;
}
function jpeg(width, height) {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc2, 0, 8, 8, 0, 0, 0, 0, 3, 0xff, 0xd9]);
  bytes.writeUInt16BE(height, 13); bytes.writeUInt16BE(width, 15); return bytes;
}

async function fixture(t) {
  const rootDir = await fs.mkdtemp(join(tmpdir(), 'studio-benchmark-test-'));
  t.after(async () => {
    assert.equal(dirname(resolve(rootDir)), resolve(tmpdir()));
    assert(basename(rootDir).startsWith('studio-benchmark-test-'));
    await fs.rm(rootDir, { recursive: true, force: true });
  });
  return rootDir;
}

function fakeSdk({ errorTool, missingTool, responseError = false } = {}) {
  const calls = [];
  class MockTransport { constructor(options) { calls.push({ operation: 'transport', options }); } }
  class MockClient {
    async connect() { calls.push({ operation: 'initialize' }); }
    getServerVersion() { return { name: 'insta360-studio', version: '0.4.0' }; }
    async listTools() {
      calls.push({ operation: 'listTools' });
      return { tools: ['studio_status', 'studio_capabilities', 'studio_observe'].filter(name => name !== missingTool)
        .map(name => ({ name, inputSchema: { type: 'object', additionalProperties: false } })) };
    }
    async callTool(request) {
      calls.push({ operation: 'callTool', ...request });
      assert(['studio_status', 'studio_capabilities', 'studio_observe'].includes(request.name), 'No editing input tools may be benchmarked.');
      if (request.name === errorTool) {
        if (responseError) return { isError: true, structuredContent: { error: { code: 'TOOL_FAILURE' } }, content: [{ type: 'text', text: 'Failed' }] };
        throw Object.assign(new Error('Request failed'), { code: 'REQUEST_TIMEOUT' });
      }
      if (request.name === 'studio_observe') {
        const full = request.arguments.image_format === 'png';
        const bytes = full ? png(2030, 1250) : jpeg(1600, 985);
        return { content: [{ type: 'text', text: JSON.stringify({ observation_token: 'fixture-snapshot-token', fresh: true }) },
          { type: 'image', mimeType: full ? 'image/png' : 'image/jpeg', data: bytes.toString('base64') }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, detail: request.arguments.detail || null }) }] };
    }
    async close() { calls.push({ operation: 'close' }); }
  }
  let tick = 0;
  return { calls, ClientType: MockClient, TransportType: MockTransport, now: () => { tick += 10; return tick; } };
}

test('PNG/JPEG image headers report actual pixels and malformed/unsupported images stay unknown', () => {
  assert.deepEqual(imageDimensions(png(1600, 900), 'image/png'), { width: 1600, height: 900, pixels: 1440000 });
  assert.deepEqual(imageDimensions(jpeg(2030, 1250), 'image/jpeg'), { width: 2030, height: 1250, pixels: 2537500 });
  assert.equal(imageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0]), 'image/jpeg'), null);
  assert.equal(imageDimensions(Buffer.alloc(24), 'image/png'), null);
  assert.equal(imageDimensions(png(1600, 900), 'image/webp'), null);
});

test('payload metrics distinguish UTF-8 bytes, JSON characters, structured duplication and image bytes', () => {
  const bytes = jpeg(1600, 900);
  const response = { content: [{ type: 'text', text: 'é🙂' }, { type: 'image', mimeType: 'image/jpeg', data: bytes.toString('base64') }],
    structuredContent: { answer: 'é🙂' } };
  const result = measurePayload(response);
  assert.equal(result.json_characters, JSON.stringify(response).length);
  assert.equal(result.json_utf8_bytes, Buffer.byteLength(JSON.stringify(response), 'utf8'));
  assert.equal(result.text_content_characters, 3);
  assert.equal(result.text_content_utf8_bytes, 6);
  assert.equal(result.structured_json_characters, JSON.stringify(response.structuredContent).length);
  assert.equal(result.image_encoded_bytes, bytes.length);
  assert.equal(result.known_image_pixels, 1440000);
  assert.equal(result.images[0].mime_type, 'image/jpeg');
  assert.equal(result.estimated_text_tokens_chars_div_4, Math.ceil(result.non_image_json_characters / 4));
  assert.equal(result.token_estimate_is_heuristic, true);
  assert.equal(JSON.stringify(result).includes(bytes.toString('base64')), false);
});

test('image base64 size does not get counted as text-token billing and invalid base64 is explicit', () => {
  const measure = bytes => measurePayload({ content: [{ type: 'image', mimeType: 'image/png', data: bytes.toString('base64') }] });
  const small = measure(png(640, 360)), large = measure(png(640, 360, 3000));
  assert(large.json_characters > small.json_characters);
  assert(large.image_encoded_bytes > small.image_encoded_bytes);
  assert.equal(large.estimated_text_tokens_chars_div_4, small.estimated_text_tokens_chars_div_4);
  const invalid = measurePayload({ content: [{ type: 'image', mimeType: 'image/jpeg', data: '%invalid%' }] });
  assert.equal(invalid.images[0].encoded_bytes, null);
  assert.equal(invalid.images_with_unknown_encoding, 1);
  assert.equal(invalid.images_with_unknown_dimensions, 1);
});

test('percentiles use documented interpolation and reject empty/unbounded values', () => {
  const values = [30, 10, 20];
  assert.equal(percentile(values, 0.5), 20);
  assert.equal(percentile(values, 0.95), 29);
  assert.deepEqual(summarize(values), { count: 3, min: 10, p50: 20, p95: 29, max: 30 });
  assert.deepEqual(values, [30, 10, 20]);
  for (const invalid of [[], [-1, 2], [1, Infinity], [NaN]]) assert.throws(() => percentile(invalid, 0.5));
  assert.throws(() => percentile([1], 1.1));
});

test('UIA skip evidence is reported only from a resolved server setting, never inferred from omitted text', () => {
  const absent = observationEvidence({ structuredContent: { screenshots: [] } });
  assert.equal(absent.accessibility_field_present, false);
  assert.equal(absent.uia_skipped_by_resolved_setting, null);
  const resolved = observationEvidence({ content: [{ type: 'text', text: JSON.stringify({ capture: { include_text: false },
    screenshots: [{ width: 1600, height: 985, physical_width: 2030, physical_height: 1250, image_format: 'jpeg', byte_length: 1000 }] }) }] });
  assert.equal(resolved.uia_skipped_by_resolved_setting, true);
  assert.equal(resolved.screenshots[0].physical_width, 2030);
  const full = observationEvidence({ structuredContent: { capture: { include_text: true }, accessibility: { available: false, element_count: 0 } } });
  assert.equal(full.accessibility_reported_available, false);
  assert.equal(full.uia_skipped_by_resolved_setting, false);
});

test('benchmark defaults perform bounded metadata requests with no observation, editing or writes', async () => {
  const sdk = fakeSdk();
  const result = await runBenchmark(sdk);
  assert.equal(result.ok, true);
  assert.equal(result.tool_count, 3);
  assert.equal(result.observation_enabled, false);
  assert.equal(result.profiles.length, 4);
  assert.equal(result.editing_input_calls, 0);
  assert.equal(sdk.calls.filter(call => call.name === 'studio_status').length, 3);
  assert.equal(sdk.calls.filter(call => call.name === 'studio_capabilities').length, 6);
  assert.equal(sdk.calls.some(call => call.name === 'studio_observe'), false);
  assert.equal(sdk.calls.filter(call => call.operation === 'listTools').length, 4);
  assert.equal(sdk.calls.at(-1).operation, 'close');
  assert.equal(result.token_estimate.heuristic, true);
  assert.equal(result.token_estimate.actual_billed_tokens_measured, false);
  assert.match(result.token_estimate.limitation, /not tokenizer output or actual Codex\/Claude billed tokens/);
  assert(result.tool_context.schemas_json_characters > 0);
  assert.equal(result.profiles[0].latency_ms.count, 3);
});

test('opt-in observation benchmarks fresh default/full captures and retains only image metrics', async () => {
  const sdk = fakeSdk();
  const report = await runBenchmark({ ...sdk, observe: true, samples: 5 });
  const observe = sdk.calls.filter(call => call.name === 'studio_observe');
  assert.equal(observe.length, 10);
  assert.deepEqual(observe[0].arguments, {});
  assert.deepEqual(observe[5].arguments, { image_max_width: 0, image_format: 'png', include_text: true, output_detail: 'full' });
  assert.equal(report.profiles.find(profile => profile.name === 'observe_fast').samples[0].payload.images[0].width, 1600);
  assert.equal(report.profiles.find(profile => profile.name === 'observe_full').samples[0].payload.images[0].width, 2030);
  assert.equal(report.profiles.find(profile => profile.name === 'observe_full').sample_count, 5);
  assert.equal(JSON.stringify(report).includes('fixture-snapshot-token'), false);
  assert.equal(JSON.stringify(report).includes('base64,'), false);
  assert.match(report.snapshot_policy, /does not reuse/);
});

test('failed requests are measured as failures instead of fabricating successful payloads', async () => {
  const sdk = fakeSdk({ errorTool: 'studio_status' });
  const report = await runBenchmark(sdk);
  const status = report.profiles.find(profile => profile.name === 'status');
  assert.equal(report.ok, false);
  assert.equal(status.failed_samples, 3);
  assert.equal(status.successful_latency_ms, null);
  assert.equal(status.payload.json_utf8_bytes, null);
  assert.equal(status.samples[0].payload, null);
  assert.equal(status.samples[0].error.code, 'REQUEST_TIMEOUT');
  assert.equal(sdk.calls.at(-1).operation, 'close');
});

test('error tool responses cannot be reported as performance success', async () => {
  const sdk = fakeSdk({ errorTool: 'studio_capabilities', responseError: true });
  const report = await runBenchmark(sdk);
  assert.equal(report.ok, false);
  assert.equal(report.profiles.find(profile => profile.name === 'capabilities_full').samples[0].error.code, 'TOOL_FAILURE');
});

test('bounded samples and missing required tools fail safely and close clients', async () => {
  for (const samples of [0, 1, 2, 4, 6, 100, Infinity, '3']) await assert.rejects(runBenchmark({ ...fakeSdk(), samples }), /3 or 5/);
  const sdk = fakeSdk({ missingTool: 'studio_capabilities' });
  await assert.rejects(runBenchmark(sdk), /Required benchmark tool/);
  assert.equal(sdk.calls.at(-1).operation, 'close');
  assert.equal(sdk.calls.some(call => call.operation === 'callTool'), false);
});

test('CLI observes and writes reports only with explicit bounded flags and artifact paths', () => {
  const defaults = parseArguments([]);
  assert.equal(defaults.observe, false);
  assert.equal(defaults.output, null);
  assert.equal(defaults.samples, 3);
  const output = parseArguments(['--output', '--samples', '5']);
  assert.equal(output.samples, 5);
  assert(output.output.endsWith(join('artifacts', 'benchmark-v4.json')));
  assert.equal(parseArguments(['--observe']).observe, true);
  for (const args of [['--samples', '100'], ['--samples'], ['--timeout-ms', '1'], ['--timeout-ms', 'Infinity'],
    ['--output', 'package.json'], ['--output', 'artifacts/test.png'], ['--root', 'https://example.com'],
    ['--root', '\\\\network\\share'], ['--root', 'bad\npath'], ['--press-key', 'SPACE'], ['--node', 'cmd.exe']]) assert.throws(() => parseArguments(args));
  assert.deepEqual(profiles(false).map(profile => profile.name), ['list_tools', 'status', 'capabilities_summary', 'capabilities_full']);
});

test('explicit report writes stay inside artifacts and never create screenshot/media files', async t => {
  const rootDir = await fixture(t);
  const output = join(rootDir, 'artifacts', 'benchmark-v4.json');
  await writeReport({ ok: true, image_count: 1, images: [{ mime_type: 'image/jpeg', pixels: 1440000 }] }, output, rootDir);
  assert.equal(JSON.parse(await fs.readFile(output, 'utf8')).ok, true);
  assert.deepEqual(await fs.readdir(join(rootDir, 'artifacts')), ['benchmark-v4.json']);
  await assert.rejects(writeReport({}, join(rootDir, 'package.json'), rootDir), /inside artifacts/);
});
