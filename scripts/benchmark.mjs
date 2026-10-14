#!/usr/bin/env node
// Fresh SDK requests only. Observation is opt-in; this script never sends editing input.
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ownRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN_LIMITATION = 'Text estimates use non-image JSON characters divided by four, rounded up. This is a heuristic, not tokenizer output or actual Codex/Claude billed tokens. Image tokens, prompts, cached context and model billing are not measured.';
const allowedTools = new Set(['studio_status', 'studio_capabilities', 'studio_observe']);

export function percentile(values, fraction) {
  if (!Array.isArray(values) || !values.length || values.some(value => !Number.isFinite(value) || value < 0)
    || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) throw new TypeError('Use nonempty finite nonnegative samples and a percentile fraction from zero to one.');
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position), upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function summarize(values) {
  const round = value => Math.round(value * 1000) / 1000;
  return { count: values.length, min: round(percentile(values, 0)), p50: round(percentile(values, 0.5)),
    p95: round(percentile(values, 0.95)), max: round(percentile(values, 1)) };
}

export function imageDimensions(bytes, mimeType) {
  if (mimeType === 'image/png' && bytes.length >= 24
    && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height, pixels: width * height } : null;
  }
  if (mimeType !== 'image/jpeg' || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if (frameMarkers.has(marker)) {
      if (length < 8) return null;
      const height = bytes.readUInt16BE(offset + 3), width = bytes.readUInt16BE(offset + 5);
      return width > 0 && height > 0 ? { width, height, pixels: width * height } : null;
    }
    offset += length;
  }
  return null;
}

export function measurePayload(result) {
  const json = JSON.stringify(result);
  if (json === undefined) throw new TypeError('Response must be JSON serializable.');
  const images = [];
  let contentCharacters = 0, contentBytes = 0;
  const stripped = { ...result };
  if (Array.isArray(result?.content)) {
    stripped.content = result.content.map(block => {
      if (block.type === 'text' && typeof block.text === 'string') { contentCharacters += block.text.length; contentBytes += Buffer.byteLength(block.text, 'utf8'); }
      if (block.type !== 'image') return block;
      const data = typeof block.data === 'string' ? block.data : '';
      const validBase64 = data.length > 0 && data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(data);
      const bytes = validBase64 ? Buffer.from(data, 'base64') : null;
      const dimensions = bytes ? imageDimensions(bytes, block.mimeType) : null;
      images.push({ mime_type: block.mimeType || null, base64_characters: data.length, encoded_bytes: bytes?.length ?? null,
        width: dimensions?.width ?? null, height: dimensions?.height ?? null, pixels: dimensions?.pixels ?? null,
        dimension_source: dimensions ? 'image_file_header' : 'unavailable' });
      const { data: _omitted, ...metadata } = block;
      return metadata;
    });
  }
  const nonImageJson = JSON.stringify(stripped);
  const structuredJson = result?.structuredContent === undefined ? '' : JSON.stringify(result.structuredContent);
  return { json_characters: json.length, json_utf8_bytes: Buffer.byteLength(json, 'utf8'),
    text_content_characters: contentCharacters, text_content_utf8_bytes: contentBytes, structured_json_characters: structuredJson.length,
    non_image_json_characters: nonImageJson.length, non_image_json_utf8_bytes: Buffer.byteLength(nonImageJson, 'utf8'),
    estimated_text_tokens_chars_div_4: Math.ceil(nonImageJson.length / 4), token_estimate_is_heuristic: true,
    image_count: images.length, image_encoded_bytes: images.reduce((sum, value) => sum + (value.encoded_bytes || 0), 0),
    images_with_unknown_encoding: images.filter(value => value.encoded_bytes === null).length,
    known_image_pixels: images.reduce((sum, value) => sum + (value.pixels || 0), 0),
    images_with_unknown_dimensions: images.filter(value => value.pixels === null).length, images };
}

export function observationEvidence(response) {
  let data = response?.structuredContent;
  if (!data) {
    const block = response?.content?.find(value => value.type === 'text');
    try { data = JSON.parse(block?.text || '{}'); } catch { data = {}; }
  }
  const accessibility = data.accessibility;
  const resolvedText = typeof data.capture?.include_text === 'boolean' ? data.capture.include_text : null;
  return { accessibility_field_present: Object.hasOwn(data, 'accessibility'),
    accessibility_reported_available: typeof accessibility?.available === 'boolean' ? accessibility.available : null,
    accessibility_element_count: Number.isFinite(accessibility?.element_count) ? accessibility.element_count : null,
    accessibility_tree_characters: typeof accessibility?.tree === 'string' ? accessibility.tree.length : null,
    resolved_include_text: resolvedText, uia_skipped_by_resolved_setting: resolvedText === null ? null : !resolvedText,
    uia_execution_evidence: resolvedText === null ? 'Execution/skip is not explicitly reported; accessibility absence alone is insufficient.'
      : 'Resolved capture setting reported by the server.',
    screenshots: (data.screenshots || []).map(value => ({ width: value.width ?? null, height: value.height ?? null,
      physical_width: value.physical_width ?? null, physical_height: value.physical_height ?? null,
      image_format: value.image_format ?? null, reported_encoded_bytes: value.byte_length ?? null })) };
}

function validatedPath(value, name) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f]/.test(value) || /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith('\\\\')) {
    throw new TypeError(`${name} must be a local filesystem path without control characters.`);
  }
  return value;
}

export function parseArguments(args) {
  const options = { rootDir: ownRoot, samples: 3, observe: false, timeout_ms: 45000, output: null };
  let outputRequested = false, outputName;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--observe') options.observe = true;
    else if (flag === '--help') options.help = true;
    else if (flag === '--output') {
      outputRequested = true;
      if (args[index + 1] && !args[index + 1].startsWith('--')) outputName = args[++index];
    } else if (['--root', '--samples', '--timeout-ms'].includes(flag)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new TypeError(`${flag} requires a value.`);
      if (flag === '--root') options.rootDir = resolve(validatedPath(value, 'root'));
      else if (flag === '--samples') {
        if (!['3', '5'].includes(value)) throw new TypeError('--samples must be 3 or 5.');
        options.samples = Number(value);
      } else {
        if (!/^\d+$/.test(value) || Number(value) < 5000 || Number(value) > 60000) throw new TypeError('--timeout-ms must be from 5000 to 60000.');
        options.timeout_ms = Number(value);
      }
    } else throw new TypeError(`Unknown benchmark option: ${flag}`);
  }
  if (outputRequested) {
    options.output = outputName ? resolve(options.rootDir, validatedPath(outputName, 'output')) : join(options.rootDir, 'artifacts', 'benchmark-v4.json');
    const relation = relative(join(options.rootDir, 'artifacts'), options.output);
    if (!relation || relation.startsWith(`..${sep}`) || isAbsolute(relation) || !/\.json$/i.test(options.output)) throw new TypeError('--output must be a .json file inside the selected root artifacts directory.');
  }
  return options;
}

export function profiles(observe = false) {
  const result = [
    { name: 'list_tools', operation: 'listTools' },
    { name: 'status', operation: 'callTool', tool: 'studio_status', arguments: {} },
    { name: 'capabilities_summary', operation: 'callTool', tool: 'studio_capabilities', arguments: { detail: 'summary' } },
    { name: 'capabilities_full', operation: 'callTool', tool: 'studio_capabilities', arguments: { detail: 'full' } },
  ];
  if (observe) result.push(
    { name: 'observe_fast', operation: 'callTool', tool: 'studio_observe', arguments: {},
      requested_profile: 'Fresh-server defaults: JPEG, width<=1600, q85, compact, auto UIA.' },
    { name: 'observe_full', operation: 'callTool', tool: 'studio_observe', arguments: {
      image_max_width: 0, image_format: 'png', include_text: true, output_detail: 'full' },
      requested_profile: 'Original image pixels, PNG, explicit UIA and full output.' },
  );
  return result;
}

function summarizeProfile(name, samples, definition) {
  const successes = samples.filter(sample => sample.ok && sample.payload);
  const metricNames = ['json_characters', 'json_utf8_bytes', 'non_image_json_characters', 'non_image_json_utf8_bytes',
    'estimated_text_tokens_chars_div_4', 'image_encoded_bytes', 'known_image_pixels'];
  return { name, operation: definition.operation, ...(definition.tool ? { tool: definition.tool } : {}),
    ...(definition.requested_profile ? { requested_profile: definition.requested_profile } : {}),
    sample_count: samples.length, successful_samples: successes.length, failed_samples: samples.length - successes.length,
    latency_ms: summarize(samples.map(sample => sample.elapsed_ms)), successful_latency_ms: successes.length ? summarize(successes.map(sample => sample.elapsed_ms)) : null,
    payload: Object.fromEntries(metricNames.map(metric => [metric, successes.length ? summarize(successes.map(sample => sample.payload[metric])) : null])),
    samples };
}

export async function runBenchmark({ rootDir = ownRoot, samples = 3, observe = false, timeout_ms = 45000,
  ClientType = Client, TransportType = StdioClientTransport, now = () => performance.now() } = {}) {
  if (![3, 5].includes(samples) || typeof observe !== 'boolean' || !Number.isInteger(timeout_ms) || timeout_ms < 5000 || timeout_ms > 60000) throw new TypeError('Use 3 or 5 samples, a boolean observe flag and timeout_ms 5000..60000.');
  rootDir = resolve(validatedPath(rootDir, 'root'));
  const client = new ClientType({ name: 'insta360-sdk-benchmark', version: '1.0.0' });
  const transport = new TransportType({ command: process.execPath, args: [join(rootDir, 'src', 'server.mjs')], cwd: rootDir, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const started = now();
  try {
    await client.connect(transport, { timeout: timeout_ms });
    const initializeMs = now() - started;
    const server = client.getServerVersion();
    if (server?.name !== 'insta360-studio') throw new Error('Connected server is not Insta360 Studio MCP.');
    const initialTools = await client.listTools({}, { timeout: timeout_ms });
    if (!Array.isArray(initialTools.tools) || initialTools.tools.length === 0) throw new Error('The server did not publish tools.');
    const names = new Set(initialTools.tools.map(tool => tool.name));
    for (const required of ['studio_status', 'studio_capabilities', ...(observe ? ['studio_observe'] : [])]) if (!names.has(required)) throw new Error(`Required benchmark tool is missing: ${required}`);
    const definitionsJson = JSON.stringify(initialTools.tools);
    const schemasJson = JSON.stringify(initialTools.tools.map(({ name, inputSchema }) => ({ name, inputSchema })));
    const results = [];
    for (const definition of profiles(observe)) {
      if (definition.tool && !allowedTools.has(definition.tool)) throw new Error('Benchmark editing/input tools are forbidden.');
      const measurements = [];
      for (let sample = 1; sample <= samples; sample++) {
        const sampleStarted = now();
        try {
          const response = definition.operation === 'listTools' ? await client.listTools({}, { timeout: timeout_ms })
            : await client.callTool({ name: definition.tool, arguments: { ...definition.arguments } }, undefined, { timeout: timeout_ms });
          const errorCode = response.structuredContent?.error?.code;
          measurements.push({ sample, ok: !response.isError, elapsed_ms: now() - sampleStarted, payload: measurePayload(response),
            ...(definition.tool === 'studio_observe' ? { observation_evidence: observationEvidence(response) } : {}),
            ...(response.isError ? { error: { code: errorCode || 'MCP_TOOL_ERROR', kind: 'tool_error_response' } } : {}) });
        } catch (error) {
          measurements.push({ sample, ok: false, elapsed_ms: now() - sampleStarted, payload: null,
            error: { code: typeof error?.code === 'string' ? error.code : 'MCP_REQUEST_FAILED', kind: 'request_failed' } });
        }
      }
      results.push(summarizeProfile(definition.name, measurements, definition));
    }
    return { ok: results.every(result => result.failed_samples === 0), created_at: new Date().toISOString(), server,
      tool_count: initialTools.tools.length, sdk_initialize_ms: initializeMs, samples_per_profile: samples, observation_enabled: observe,
      editing_input_calls: 0, snapshot_policy: 'Every sample makes a fresh SDK request; the benchmark does not reuse screenshots or responses.',
      timing_limitations: 'First status request includes native adapter startup. Samples are sequential and use one new server session. P50/P95 use linear interpolation over a small local sample; they do not predict other computers or client/model latency.',
      token_estimate: { formula: 'ceil(non_image_json_characters / 4)', heuristic: true, actual_billed_tokens_measured: false, limitation: TOKEN_LIMITATION },
      tool_context: { definitions_json_characters: definitionsJson.length, definitions_json_utf8_bytes: Buffer.byteLength(definitionsJson, 'utf8'),
        schemas_json_characters: schemasJson.length, schemas_json_utf8_bytes: Buffer.byteLength(schemasJson, 'utf8'),
        schemas_estimated_tokens_chars_div_4: Math.ceil(schemasJson.length / 4), token_estimate_is_heuristic: true }, profiles: results };
  } finally { await client.close(); }
}

export async function writeReport(report, output, rootDir = ownRoot) {
  const artifacts = resolve(rootDir, 'artifacts');
  output = resolve(validatedPath(output, 'output'));
  const relation = relative(artifacts, output);
  if (!relation || relation.startsWith(`..${sep}`) || isAbsolute(relation) || !/\.json$/i.test(output)) throw new TypeError('Benchmark report must be a .json file inside artifacts.');
  let location = resolve(rootDir);
  const rootInfo = await fs.lstat(location);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Benchmark root must be an ordinary directory.');
  for (const part of relative(location, dirname(output)).split(sep).filter(Boolean)) {
    location = join(location, part);
    await fs.mkdir(location).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await fs.lstat(location);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Benchmark output directories cannot be links.');
  }
  const existing = await fs.lstat(output).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('Benchmark output must be an ordinary JSON file.');
  const temporary = join(dirname(output), `benchmark-${randomUUID()}.tmp`);
  try { await fs.writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' }); await fs.rename(temporary, output); }
  finally { await fs.unlink(temporary).catch(() => {}); }
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) console.log('Usage: node scripts/benchmark.mjs [--samples 3|5] [--observe] [--root <package>] [--timeout-ms 5000..60000] [--output [artifacts/report.json]]\nWithout --observe, no UI capture or input occurs. Only explicit --output writes a report (default artifacts/benchmark-v4.json). Text token estimates are heuristic chars/4, never billed Codex/Claude tokens.');
    else {
      const report = await runBenchmark(options);
      if (options.output) await writeReport(report, options.output, options.rootDir);
      const { profiles: detailed, ...summary } = report;
      console.log(JSON.stringify({ ...summary, profiles: detailed.map(({ samples: _samples, ...profile }) => profile), report_written: Boolean(options.output) }, null, 2));
      process.exitCode = report.ok ? 0 : 1;
    }
  } catch (error) { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }
}
