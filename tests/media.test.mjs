import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { MediaVerifier } from '../src/media.mjs';

class Decoder extends EventEmitter {
  constructor() { super(); this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.pid = 1234; this.killCount = 0; this.closed = false; }
  finish(code = 0, signal = null) { if (!this.closed) { this.closed = true; this.emit('close', code, signal); } }
  kill() { this.killCount++; queueMicrotask(() => this.finish(null, 'SIGTERM')); return true; }
}

const defaultMetadata = () => ({ format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '3.000000' }, streams: [
  { index: 0, codec_type: 'video', codec_name: 'h264', width: 640, height: 360, avg_frame_rate: '30000/1001', duration: '3.000000' },
  { index: 1, codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2, duration: '3.000000' },
] });

async function fixture(t, options = {}) {
  const rootDir = await fs.mkdtemp(join(tmpdir(), 'studio-media-test-'));
  const config = { ffprobe: join(rootDir, 'ffprobe.exe'), ffmpeg: join(rootDir, 'ffmpeg.exe') };
  await Promise.all(Object.values(config).map(path => fs.writeFile(path, 'fixture-only')));
  const path = join(rootDir, 'sample.mp4');
  await fs.writeFile(path, Buffer.alloc(2048, 1));
  const calls = [], children = [];
  const metadata = options.metadata || defaultMetadata();
  const execFileFn = async (executable, args, processOptions) => {
    calls.push({ executable, args, options: processOptions });
    if (executable === config.ffprobe) {
      if (options.onProbe) await options.onProbe(path);
      if (options.probeError) throw options.probeError;
      return { stdout: JSON.stringify(metadata), stderr: '' };
    }
    if (options.onDecode) await options.onDecode(path);
    if (options.decodeError) throw options.decodeError;
    return { stdout: '', stderr: '' };
  };
  const spawnFn = (executable, args, processOptions) => {
    calls.push({ executable, args, options: processOptions, spawned: true });
    if (options.spawnError) throw options.spawnError;
    const child = new Decoder(); children.push(child);
    if (options.spawnErrorEvent) { child.pid = undefined; queueMicrotask(() => child.emit('error', new Error('Spawn could not start the decoder'))); }
    return child;
  };
  const verifier = new MediaVerifier({ rootDir, config, sessionId: 'unit-test-session', execFileFn, spawnFn });
  t.after(async () => {
    await verifier.close();
    assert.equal(dirname(resolve(rootDir)), resolve(tmpdir()));
    assert(basename(rootDir).startsWith('studio-media-test-'));
    await fs.rm(rootDir, { recursive: true, force: true });
  });
  return { rootDir, config, path, calls, children, metadata, verifier };
}

const quick = (path, extra = {}) => ({ path, stable_for_ms: 0, timeout_ms: 100, ...extra });
async function terminal(verifier, id, timeout = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const status = await verifier.jobStatus({ job_id: id });
    if (['completed', 'failed', 'cancelled'].includes(status.status)) return status;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Decoder job did not reach terminal state.');
}

test('metadata inspection reports real fields, rational FPS and all audio streams', async t => {
  const { verifier, path, calls } = await fixture(t);
  const result = await verifier.mediaInfo({ path });
  assert.equal(result.bytes, 2048);
  assert.equal(result.duration_seconds, 3);
  assert.equal(result.video.width, 640);
  assert.equal(result.video.height, 360);
  assert.equal(result.video.fps, 30000 / 1001);
  assert.equal(result.audio_present, true);
  assert.equal(result.streams[1].sample_rate, 48000);
  assert.equal(result.verification_depth, 'container_and_stream_metadata');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].args.includes('file,pipe'), true);
});

test('audio-only files can be inspected but cannot pass video export verification', async t => {
  const metadata = { format: {}, streams: [{ index: 0, codec_type: 'audio', codec_name: 'pcm_s16le', duration: '1.25', sample_rate: '44100', channels: 1 }] };
  const { verifier, rootDir, path } = await fixture(t, { metadata });
  const audio = join(rootDir, 'recording.WAV');
  await fs.rename(path, audio);
  const result = await verifier.mediaInfo({ path: audio });
  assert.equal(result.duration_seconds, 1.25);
  assert.equal(result.video, null);
  assert.equal(result.audio_present, true);
  await assert.rejects(verifier.verify(quick(audio)), { code: 'NO_VIDEO_STREAM' });
});

test('cover pictures cannot establish a video export', async t => {
  const metadata = { format: { duration: '3' }, streams: [{ index: 0, codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } }] };
  const { verifier, path } = await fixture(t, { metadata });
  await assert.rejects(verifier.verify(quick(path)), { code: 'NO_VIDEO_STREAM' });
});

test('local-path guard rejects URLs, UNC/device paths, ADS, controls and executables before subprocess use', async t => {
  const { verifier, calls } = await fixture(t);
  for (const path of ['https://example.com/file.mp4', 'file:///C:/file.mp4', '\\\\server\\share\\file.mp4', '\\\\?\\C:\\file.mp4',
    '\\file.mp4', 'C:file.mp4', 'relative.mp4', 'C:\\file.exe', 'C:\\file.mp4:stream.mp4', 'C:\\fi\nle.mp4',
    'C:\\NUL.mp4', 'C:\\invalid \\file.mp4', 'C:\\"file.mp4']) {
    await assert.rejects(verifier.mediaInfo({ path }), { code: 'INVALID_MEDIA_PATH' }, path);
    await assert.rejects(verifier.checkpoint({ path }), { code: 'INVALID_MEDIA_PATH' }, path);
  }
  assert.equal(calls.length, 0);
});

test('Insta360 LRV/INSV and MP3 paths are supported; absent files and directories are rejected', async t => {
  const { verifier, rootDir, path } = await fixture(t);
  for (const extension of ['LRV', 'INSV', 'MP3']) {
    const media = join(rootDir, `source.${extension}`); await fs.copyFile(path, media);
    assert.equal((await verifier.mediaInfo({ path: media })).ok, true);
  }
  await assert.rejects(verifier.mediaInfo({ path: join(rootDir, 'absent.mp4') }), { code: 'MEDIA_NOT_FOUND' });
  const directory = join(rootDir, 'directory.mp4'); await fs.mkdir(directory);
  await assert.rejects(verifier.mediaInfo({ path: directory }), { code: 'MEDIA_NOT_FOUND' });
});

test('quick verification decodes video and optional audio without creating output or claiming full decode', async t => {
  const { verifier, path, calls } = await fixture(t);
  const before = await fs.readFile(path);
  const result = await verifier.verify(quick(path, { expected_duration_seconds: 3, expected_width: 640,
    expected_height: 360, expected_fps: 29.97, expected_video_codec: 'H264', expected_audio: true }));
  assert.equal(result.ok, true);
  assert.equal(result.decode_exit_code, 0);
  assert.match(result.verification_depth, /first_second_video_and_audio/);
  assert.match(result.provenance, /No pre-export checkpoint/);
  const decode = calls.find(call => call.executable.endsWith('ffmpeg.exe'));
  assert.deepEqual(decode.args.slice(-7), ['-map', '0:0', '-map', '0:a?', '-f', 'null', '-']);
  assert.equal(decode.args[decode.args.indexOf('-t') + 1], '1');
  assert.equal(decode.args.includes('-nostdin'), true);
  assert.equal(decode.args.includes('-xerror'), true);
  assert.equal(decode.args[decode.args.indexOf('-abort_on') + 1], 'empty_output+empty_output_stream');
  assert.equal(decode.options.shell, false);
  assert.deepEqual(await fs.readFile(path), before);
});

test('export expectations are checked against actual metadata before decoding', async t => {
  const { verifier, path, calls } = await fixture(t);
  const expectations = [
    [{ expected_duration_seconds: 5 }, 'DURATION_MISMATCH'], [{ expected_width: 1920 }, 'WIDTH_MISMATCH'],
    [{ expected_height: 1080 }, 'HEIGHT_MISMATCH'], [{ expected_fps: 60 }, 'FPS_MISMATCH'],
    [{ expected_video_codec: 'hevc' }, 'VIDEO_CODEC_MISMATCH'], [{ expected_audio: false }, 'AUDIO_MISMATCH'],
  ];
  for (const [extra, code] of expectations) await assert.rejects(verifier.verify(quick(path, extra)), { code });
  assert.equal(calls.some(call => call.executable.endsWith('ffmpeg.exe')), false);
  assert.equal((await verifier.verify(quick(path, { expected_duration_seconds: 3.1, duration_tolerance_seconds: 0.15 }))).ok, true);
});

test('unavailable expectation values produce an explicit error instead of passing', async t => {
  const metadata = defaultMetadata(); delete metadata.format.duration;
  for (const stream of metadata.streams) delete stream.duration;
  const { verifier, path } = await fixture(t, { metadata });
  await assert.rejects(verifier.verify(quick(path, { expected_duration_seconds: 3 })), { code: 'EXPECTATION_UNVERIFIABLE' });
});

test('plain 2:1 video remains projection-unknown and cannot pass a spherical expectation', async t => {
  const metadata = defaultMetadata();
  Object.assign(metadata.streams[0], { width: 3840, height: 1920 });
  const { verifier, path, calls } = await fixture(t, { metadata });
  const result = await verifier.mediaInfo({ path });
  assert.deepEqual(result.video.spherical_mapping, { status: 'unknown', projection: null });
  await assert.rejects(verifier.verify(quick(path, { expected_width: 3840, expected_height: 1920,
    expected_projection: 'equirectangular' })), { code: 'EXPECTATION_UNVERIFIABLE' });
  assert.equal(calls.some(call => call.executable.endsWith('ffmpeg.exe')), false);
  assert.equal((await verifier.verify(quick(path, { expected_width: 3840, expected_height: 1920 }))).ok, true,
    'Ordinary file verification remains available without claiming spherical projection');
});

test('parsed equirectangular spherical side data retains signed orientation and passes its expectation', async t => {
  const metadata = defaultMetadata();
  metadata.streams[0].side_data_list = [{ side_data_type: 'Spherical Mapping', projection: 'equirectangular',
    yaw: -45, pitch: '-12.5', roll: -3, unrelated: 'private arbitrary value'.repeat(1000) }];
  const { verifier, path } = await fixture(t, { metadata });
  const result = await verifier.verify(quick(path, { expected_projection: 'equirectangular' }));
  assert.deepEqual(result.video.spherical_mapping, { status: 'reported', projection: 'equirectangular',
    source: 'ffprobe_stream_side_data', yaw: -45, pitch: -12.5, roll: -3 });
  assert.deepEqual(result.streams[0].spherical_mapping, result.video.spherical_mapping);
  assert.equal(JSON.stringify(result).includes('private arbitrary value'), false);
  assert.equal(result.ok, true);
});

test('cubemap and partial or flat declarations do not pass a full equirectangular expectation', async t => {
  for (const projection of ['cubemap', 'tiled equirectangular', 'half equirectangular', 'rectilinear']) {
    const metadata = defaultMetadata();
    metadata.streams[0].side_data_list = [{ side_data_type: 'Spherical Mapping', projection }];
    const { verifier, path, calls } = await fixture(t, { metadata });
    assert.equal((await verifier.mediaInfo({ path })).video.spherical_mapping.projection, projection);
    await assert.rejects(verifier.verify(quick(path, { expected_projection: 'equirectangular' })),
      { code: 'PROJECTION_MISMATCH' }, projection);
    assert.equal(calls.some(call => call.executable.endsWith('ffmpeg.exe')), false, projection);
  }
});

test('free-form tags, unrelated side data and unrecognized spherical declarations cannot qualify', async t => {
  for (const side_data_list of [undefined, 'Spherical Mapping',
    [{ side_data_type: 'Display Matrix', projection: 'equirectangular' }],
    [{ side_data_type: 'Spherical Mapping', projection: 'unknown', yaw: Infinity, pitch: '', roll: false }],
    [{ side_data_type: 'Spherical Mapping', projection: 'equirectangular'.repeat(100) }]]) {
    const metadata = defaultMetadata();
    metadata.format.tags = { projection: 'equirectangular', spherical: 'true' };
    Object.assign(metadata.streams[0], { tags: { projection: 'equirectangular' }, side_data_list });
    const { verifier, path, calls } = await fixture(t, { metadata });
    const result = await verifier.mediaInfo({ path });
    assert.equal(result.video.spherical_mapping.status, 'unknown');
    assert.equal(result.video.spherical_mapping.projection, null);
    if (result.video.spherical_mapping.source) {
      for (const field of ['yaw', 'pitch', 'roll']) assert.equal(result.video.spherical_mapping[field], null);
    }
    await assert.rejects(verifier.verify(quick(path, { expected_projection: 'equirectangular' })),
      { code: 'EXPECTATION_UNVERIFIABLE' });
    assert.equal(calls.some(call => call.executable.endsWith('ffmpeg.exe')), false);
  }
});

test('cover-picture spherical metadata cannot establish projection of the playable video', async t => {
  const metadata = defaultMetadata();
  metadata.streams[0].index = 1; metadata.streams[1].index = 2;
  metadata.streams.unshift({ index: 0, codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 },
    side_data_list: [{ side_data_type: 'Spherical Mapping', projection: 'equirectangular' }] });
  const { verifier, path, calls } = await fixture(t, { metadata });
  const result = await verifier.mediaInfo({ path });
  assert.equal(result.video.index, 1);
  assert.equal(result.streams[0].spherical_mapping.projection, 'equirectangular');
  assert.equal(result.video.spherical_mapping.status, 'unknown');
  await assert.rejects(verifier.verify(quick(path, { expected_projection: 'equirectangular' })),
    { code: 'EXPECTATION_UNVERIFIABLE' });
  assert.equal(calls.some(call => call.executable.endsWith('ffmpeg.exe')), false);
});

test('multiple spherical declarations remain ambiguous with bounded evidence and reject before decoding', async t => {
  const metadata = defaultMetadata();
  metadata.streams[0].side_data_list = Array.from({ length: 1000 }, (_, index) => ({ side_data_type: 'Spherical Mapping',
    projection: index % 2 ? 'cubemap' : 'equirectangular', yaw: index }));
  const { verifier, path, calls } = await fixture(t, { metadata });
  const result = await verifier.mediaInfo({ path });
  assert.deepEqual(result.video.spherical_mapping, { status: 'ambiguous', projection: null, source: 'ffprobe_stream_side_data' });
  assert(JSON.stringify(result.video.spherical_mapping).length < 100);
  await assert.rejects(verifier.verify(quick(path, { expected_projection: 'equirectangular', mode: 'full' })),
    { code: 'EXPECTATION_UNVERIFIABLE' });
  assert.equal(calls.some(call => call.executable.endsWith('ffmpeg.exe')), false);
});

test('full-decode job preserves declared spherical evidence through successful completion and persistence', async t => {
  const metadata = defaultMetadata();
  metadata.streams[0].side_data_list = [{ side_data_type: 'Spherical Mapping', projection: 'equirectangular', yaw: -90,
    pitch: 5, roll: 0 }];
  const { verifier, path, children, rootDir } = await fixture(t, { metadata });
  const job = await verifier.verify(quick(path, { mode: 'full', expected_projection: 'equirectangular' }));
  assert.equal(job.status, 'running');
  assert.equal(job.video.spherical_mapping.projection, 'equirectangular');
  assert.equal(job.video.spherical_mapping.yaw, -90);
  children[0].finish(0);
  const finished = await terminal(verifier, job.job_id);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.ok, true);
  assert.deepEqual(finished.video.spherical_mapping, job.video.spherical_mapping);
  await verifier.close();
  const saved = JSON.parse(await fs.readFile(join(rootDir, 'runtime', 'jobs', `${job.job_id}.json`), 'utf8'));
  assert.deepEqual(saved.video.spherical_mapping, job.video.spherical_mapping);
  assert.equal(saved.verification_depth, 'full_video_and_audio_decode');
});

test('quick decode maps the checked playable video and full mode maps every playable video while excluding covers', async t => {
  const metadata = defaultMetadata();
  metadata.streams[0].index = 1; metadata.streams[1].index = 2;
  metadata.streams[0].side_data_list = [{ side_data_type: 'Spherical Mapping', projection: 'equirectangular' }];
  metadata.streams.unshift({ index: 0, codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } });
  metadata.streams.push({ index: 3, codec_type: 'video', codec_name: 'h264', width: 320, height: 180,
    avg_frame_rate: '30/1', duration: '3' });
  const { verifier, path, calls, children } = await fixture(t, { metadata });
  assert.equal((await verifier.verify(quick(path, { expected_projection: 'equirectangular' }))).ok, true);
  const quickDecode = calls.find(call => call.executable.endsWith('ffmpeg.exe'));
  assert.deepEqual(quickDecode.args.filter((_, index, args) => args[index - 1] === '-map'), ['0:1', '0:a?']);
  const job = await verifier.verify(quick(path, { mode: 'full', expected_projection: 'equirectangular' }));
  const fullDecode = calls.find(call => call.spawned);
  assert.deepEqual(fullDecode.args.filter((_, index, args) => args[index - 1] === '-map'), ['0:1', '0:3', '0:a?']);
  children[0].finish(0);
  assert.equal((await terminal(verifier, job.job_id)).ok, true);
});

test('missing, unsafe and duplicate playable stream indices fail before starting any decoder', async t => {
  for (const index of [undefined, -1, '0:v:0', Number.MAX_SAFE_INTEGER + 1]) {
    const metadata = defaultMetadata(); metadata.streams[0].index = index;
    const { verifier, path, calls } = await fixture(t, { metadata });
    assert.equal((await verifier.mediaInfo({ path })).video.index, null);
    await assert.rejects(verifier.verify(quick(path)), { code: 'VIDEO_STREAM_INDEX_UNVERIFIABLE' });
    assert.equal(calls.some(call => call.executable.endsWith('ffmpeg.exe')), false);
  }
  const metadata = defaultMetadata(); metadata.streams.push({ ...metadata.streams[0] });
  const { verifier, path, calls } = await fixture(t, { metadata });
  await assert.rejects(verifier.verify(quick(path, { mode: 'full' })), { code: 'VIDEO_STREAM_INDEX_UNVERIFIABLE' });
  assert.equal(calls.some(call => call.executable.endsWith('ffmpeg.exe')), false);
});

test('invalid bounds and unknown modes are rejected before any subprocess', async t => {
  const { verifier, path, calls } = await fixture(t);
  for (const extra of [{ mode: 'all' }, { min_bytes: 0 }, { stable_for_ms: -1 }, { timeout_ms: 0 },
    { stable_for_ms: 1000, timeout_ms: 500 }, { decode_timeout_ms: 0 }, { duration_tolerance_seconds: -0.1 },
    { expected_projection: 'flat' }, { expected_projection: true }, { expected_projection: 'EQUIRECTANGULAR' }]) {
    await assert.rejects(verifier.verify(quick(path, extra)), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal(calls.length, 0);
});

test('checkpoint persists an existing baseline and rejects an unchanged export', async t => {
  const { verifier, rootDir, path, calls } = await fixture(t);
  const checkpoint = await verifier.checkpoint({ path });
  assert.equal(checkpoint.existed, true);
  const saved = JSON.parse(await fs.readFile(join(rootDir, 'runtime', 'checkpoints', `${checkpoint.checkpoint_id}.json`), 'utf8'));
  assert.equal(saved.baseline.bytes, 2048);
  await assert.rejects(verifier.verify(quick(path, { checkpoint_id: checkpoint.checkpoint_id })), { code: 'EXPORT_UNCHANGED' });
  assert.equal(calls.length, 0);
  await fs.appendFile(path, 'new export bytes');
  const result = await verifier.verify(quick(path, { checkpoint_id: checkpoint.checkpoint_id }));
  assert.equal(result.checkpoint.changed_since_checkpoint, true);
  assert.match(result.provenance, /Studio authorship is not established/);
});

test('checkpoint supports a not-yet-created output and binds to its exact local path', async t => {
  const { verifier, rootDir, path } = await fixture(t);
  const output = join(rootDir, 'new-output.mp4');
  const checkpoint = await verifier.checkpoint({ path: output });
  assert.equal(checkpoint.existed, false);
  await fs.copyFile(path, output);
  const result = await verifier.verify(quick(output, { checkpoint_id: checkpoint.checkpoint_id }));
  assert.equal(result.checkpoint.existed_before, false);
  await assert.rejects(verifier.verify(quick(path, { checkpoint_id: checkpoint.checkpoint_id })), { code: 'CHECKPOINT_PATH_MISMATCH' });
  await assert.rejects(verifier.checkpoint({ path: join(rootDir, 'missing-folder', 'new.mp4') }), { code: 'OUTPUT_DIRECTORY_NOT_FOUND' });
});

test('record IDs cannot traverse paths and missing records return explicit errors', async t => {
  const { verifier, path } = await fixture(t);
  for (const id of ['../other', '..\\other', 'C:\\foo', 'unknown']) {
    await assert.rejects(verifier.jobStatus({ job_id: id }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(verifier.cancelJob({ job_id: id }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(verifier.verify(quick(path, { checkpoint_id: id })), { code: 'INVALID_ARGUMENT' });
  }
  const absent = '12345678-1234-1234-1234-123456789abc';
  await assert.rejects(verifier.jobStatus({ job_id: absent }), { code: 'JOB_NOT_FOUND' });
  await assert.rejects(verifier.verify(quick(path, { checkpoint_id: absent })), { code: 'CHECKPOINT_NOT_FOUND' });
});

test('missing or unpinned media tool paths cannot be substituted with an arbitrary command', async t => {
  const { rootDir, path } = await fixture(t);
  for (const config of [{}, { ffprobe: 'ffprobe' }, { ffprobe: 'cmd.exe' }, { ffprobe: join(rootDir, 'ffmpeg.exe') },
    { ffprobe: join(rootDir, 'missing', 'ffprobe.exe') }]) {
    const verifier = new MediaVerifier({ rootDir, config, execFileFn: async () => assert.fail('Invalid executable was invoked.') });
    await assert.rejects(verifier.mediaInfo({ path }), { code: 'MEDIA_TOOLS_UNAVAILABLE' });
  }
});

test('probe and quick decode failures retain EXPORT_CHANGED when the file changed concurrently', async t => {
  const first = await fixture(t, { onProbe: path => fs.appendFile(path, 'changed'), probeError: new Error('Probe failed') });
  await assert.rejects(first.verifier.verify(quick(first.path)), { code: 'EXPORT_CHANGED' });
  const second = await fixture(t, { onDecode: path => fs.appendFile(path, 'changed'), decodeError: new Error('Decode failed') });
  await assert.rejects(second.verifier.verify(quick(second.path)), { code: 'EXPORT_CHANGED' });
  const third = await fixture(t, { onDecode: path => fs.appendFile(path, 'changed') });
  await assert.rejects(third.verifier.verify(quick(third.path)), { code: 'EXPORT_CHANGED' });
});

test('probe/decode errors and bounded timeouts remain explicit', async t => {
  const first = await fixture(t, { probeError: new Error('Invalid container') });
  await assert.rejects(first.verifier.mediaInfo({ path: first.path }), { code: 'INVALID_MEDIA' });
  const second = await fixture(t, { decodeError: Object.assign(new Error('Decode timeout'), { killed: true }) });
  await assert.rejects(second.verifier.verify(quick(second.path)), { code: 'QUICK_DECODE_TIMEOUT' });
  const third = await fixture(t);
  await assert.rejects(third.verifier.verify(quick(third.path, { min_bytes: 9999, timeout_ms: 10 })), { code: 'EXPORT_NOT_STABLE' });
});

test('full decode returns an immediate job and completes only after zero exit and restat', async t => {
  const { verifier, path, children, calls, rootDir } = await fixture(t);
  const result = await verifier.verify(quick(path, { mode: 'full' }));
  assert.equal(result.status, 'running');
  assert.equal(result.verification_depth, 'full_video_and_audio_decode_pending');
  assert.equal(result.can_cancel, true);
  const decode = calls.find(call => call.spawned);
  assert.equal(decode.args.includes('-t'), false);
  assert.equal(decode.args[decode.args.indexOf('-progress') + 1], 'pipe:1');
  assert.equal(decode.args[decode.args.indexOf('-map') + 1], '0:0');
  assert.equal(decode.args[decode.args.indexOf('-abort_on') + 1], 'empty_output+empty_output_stream');
  assert.deepEqual(decode.options.stdio, ['ignore', 'pipe', 'pipe']);
  children[0].stdout.write('frame=90\nout_time_us=3000000\nspeed=2.0x\nprogress=end\n');
  assert.equal((await verifier.jobStatus({ job_id: result.job_id })).status, 'running');
  children[0].finish(0);
  const finished = await terminal(verifier, result.job_id);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.ok, true);
  assert.equal(finished.decode_exit_code, 0);
  assert.equal(finished.verification_depth, 'full_video_and_audio_decode');
  assert.equal(finished.progress.percent, 100);
  assert.equal(finished.can_cancel, false);
  await new Promise(resolve => setTimeout(resolve, 20));
  const saved = JSON.parse(await fs.readFile(join(rootDir, 'runtime', 'jobs', `${result.job_id}.json`), 'utf8'));
  assert.equal(saved.status, 'completed');
});

test('full decode catches corruption after the first second and bounds decoder stderr', async t => {
  const { verifier, path, children } = await fixture(t);
  const job = await verifier.verify(quick(path, { mode: 'full' }));
  children[0].stderr.write('x'.repeat(100000) + '\nCorruption near end of media');
  children[0].finish(1);
  const result = await terminal(verifier, job.job_id);
  assert.equal(result.status, 'failed');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_MEDIA');
  assert.match(result.error.message, /Corruption near end/);
  assert.equal(result.stderr_truncated, true);
  assert.equal(result.stderr.length, 65536);
});

test('full decode retains EXPORT_CHANGED even when decode failed', async t => {
  const { verifier, path, children } = await fixture(t);
  const job = await verifier.verify(quick(path, { mode: 'full' }));
  await fs.appendFile(path, 'different export');
  children[0].finish(1);
  const result = await terminal(verifier, job.job_id);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'EXPORT_CHANGED');
});

test('full jobs enforce the two-job cap and owned cancellation terminates only tracked children', async t => {
  const { verifier, path, children, rootDir, config } = await fixture(t);
  const first = await verifier.verify(quick(path, { mode: 'full' }));
  const second = await verifier.verify(quick(path, { mode: 'full' }));
  await assert.rejects(verifier.verify(quick(path, { mode: 'full' })), { code: 'JOB_LIMIT_REACHED' });
  const other = new MediaVerifier({ rootDir, config, sessionId: 'other-session' });
  await assert.rejects(other.cancelJob({ job_id: first.job_id }), { code: 'JOB_NOT_OWNED' });
  assert.equal(children[0].killCount, 0);
  assert.equal((await other.jobStatus({ job_id: first.job_id })).can_cancel, false);
  await verifier.cancelJob({ job_id: first.job_id });
  const result = await terminal(verifier, first.job_id);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.error.code, 'DECODE_CANCELLED');
  assert.equal(children[0].killCount, 1);
  assert.equal(children[1].killCount, 0);
  children[1].finish(0); await terminal(verifier, second.job_id);
  await other.close();
});

test('concurrent full preparations also obey the job cap', async t => {
  const { verifier, path } = await fixture(t);
  const attempts = await Promise.allSettled([0, 1, 2].map(() => verifier.verify(quick(path, { mode: 'full' }))));
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 2);
  assert.equal(attempts.find(result => result.status === 'rejected').reason.code, 'JOB_LIMIT_REACHED');
});

test('decode timeout kills the owned child and cannot report completion', async t => {
  const { verifier, path, children } = await fixture(t);
  const job = await verifier.verify(quick(path, { mode: 'full', decode_timeout_ms: 10 }));
  const result = await terminal(verifier, job.job_id);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'DECODE_TIMEOUT');
  assert.equal(children[0].killCount, 1);
});

test('spawn failure is recorded as a failed job and progress cannot fake completion', async t => {
  const { verifier, path } = await fixture(t, { spawnError: new Error('Process unavailable') });
  const result = await verifier.verify(quick(path, { mode: 'full' }));
  assert.equal(result.status, 'failed');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'DECODE_PROCESS_FAILED');
});

test('closing cancels active owned jobs and preserves completed records for future sessions', async t => {
  const { verifier, path, children, rootDir, config } = await fixture(t);
  const completed = await verifier.verify(quick(path, { mode: 'full' }));
  children[0].finish(0); await terminal(verifier, completed.job_id);
  const pending = await verifier.verify(quick(path, { mode: 'full' }));
  await verifier.close();
  assert.equal(children[0].killCount, 0);
  assert.equal(children[1].killCount, 1);
  assert.equal((await verifier.jobStatus({ job_id: pending.job_id })).status, 'cancelled');
  await assert.rejects(verifier.verify(quick(path)), { code: 'SERVER_CLOSED' });
  const another = new MediaVerifier({ rootDir, config, sessionId: 'fresh-session' });
  const result = await another.jobStatus({ job_id: completed.job_id });
  assert.equal(result.status, 'completed');
  assert.equal(result.live_tracking, false);
  assert.equal(result.can_cancel, false);
  await another.close();
});

test('close waits for an already-settled decoder final record write', async t => {
  const { verifier, path, children, rootDir } = await fixture(t);
  const job = await verifier.verify(quick(path, { mode: 'full' }));
  const write = verifier._write.bind(verifier);
  let writeStarted, releaseWrite;
  const started = new Promise(resolve => { writeStarted = resolve; });
  const released = new Promise(resolve => { releaseWrite = resolve; });
  verifier._write = async (directory, id, record) => {
    if (directory === 'jobs' && record.status === 'completed') { writeStarted(); await released; }
    await write(directory, id, record);
  };
  children[0].finish(0);
  await started;
  let closed = false;
  const closing = verifier.close().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(closed, false);
  releaseWrite(); await closing;
  const saved = JSON.parse(await fs.readFile(join(rootDir, 'runtime', 'jobs', `${job.job_id}.json`), 'utf8'));
  assert.equal(saved.status, 'completed');
});

test('installed FFmpeg rejects an empty mapped output with the verification abort flags', async t => {
  let config;
  try {
    config = JSON.parse(await fs.readFile(new URL('../config.local.json', import.meta.url), 'utf8'));
    await Promise.all([fs.stat(config.ffmpeg), fs.stat(config.ffprobe)]);
  } catch { t.skip('Pinned local FFmpeg/FFprobe are not configured in this environment.'); return; }
  const { rootDir, path } = await fixture(t);
  const execute = promisify(execFile);
  // Make an isolated valid clip; no user media is read or changed.
  await execute(config.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i',
    'color=c=blue:s=160x90:r=10:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path],
    { windowsHide: true, shell: false, timeout: 10000, maxBuffer: 1024 * 1024 });
  const verifier = new MediaVerifier({ rootDir, config, execFileFn: (executable, args, options) => {
    if (executable === config.ffmpeg) {
      // Force an empty decoded output to test the real binary's exit behavior, not a mocked exit code.
      const emptyArgs = [...args]; emptyArgs.splice(emptyArgs.indexOf('-t'), 0, '-ss', '10');
      return execute(executable, emptyArgs, options);
    }
    return execute(executable, args, options);
  } });
  t.after(() => verifier.close());
  await assert.rejects(verifier.verify(quick(path)), { code: 'INVALID_MEDIA' });
});

test('live-child kill errors cannot claim cancellation until a close event confirms exit', async t => {
  const { verifier, path, children } = await fixture(t);
  const job = await verifier.verify(quick(path, { mode: 'full' }));
  children[0].kill = () => {
    children[0].killCount++;
    children[0].emit('error', Object.assign(new Error('Permission denied while terminating'), { code: 'EPERM' }));
    return false;
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await verifier.cancelJob({ job_id: job.job_id });
    assert.equal(result.status, 'termination_failed');
    assert.equal(result.error.code, 'DECODE_TERMINATION_FAILED');
    assert.equal(result.completed_at, undefined);
    assert.equal(result.can_cancel, true);
    assert.equal(children[0].closed, false);
  }
  assert.equal(children[0].killCount, 2);
  children[0].finish(0);
  assert.equal((await terminal(verifier, job.job_id)).status, 'cancelled');
});

test('failed termination bounds shutdown and persists uncertainty while the child remains alive', async t => {
  const { verifier, path, children, rootDir } = await fixture(t);
  const job = await verifier.verify(quick(path, { mode: 'full' }));
  children[0].kill = () => { children[0].killCount++; throw Object.assign(new Error('Cannot terminate owned child'), { code: 'EPERM' }); };
  const started = Date.now();
  await verifier.close();
  assert(Date.now() - started < 4500, 'Shutdown must not wait indefinitely for a failed termination.');
  const result = await verifier.jobStatus({ job_id: job.job_id });
  assert.equal(result.status, 'termination_unconfirmed');
  assert.equal(result.error.code, 'DECODE_TERMINATION_UNCONFIRMED');
  assert.equal(result.completed_at, undefined);
  assert.equal(children[0].closed, false);
  const saved = JSON.parse(await fs.readFile(join(rootDir, 'runtime', 'jobs', `${job.job_id}.json`), 'utf8'));
  assert.equal(saved.status, 'termination_unconfirmed');
  children[0].finish(null, 'SIGTERM');
  await terminal(verifier, job.job_id);
});

test('an asynchronous spawn error without a live child still reaches failed terminal status', async t => {
  const { verifier, path, children } = await fixture(t, { spawnErrorEvent: true });
  const job = await verifier.verify(quick(path, { mode: 'full' }));
  const result = await terminal(verifier, job.job_id);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'DECODE_PROCESS_FAILED');
  assert.equal(result.can_cancel, false);
  assert.equal(children[0].killCount, 0);
});
