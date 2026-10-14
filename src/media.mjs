import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join, win32 } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MEDIA_EXTENSION = /\.(insv|insp|lrv|mp4|mov|m4v|avi|mkv|webm|mpeg|mpg|mts|m2ts|ts|mp3|wav|m4a|aac|ogg|flac|wma|aif|aiff|jpg|jpeg|png|heic|heif|dng)$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STDERR_LIMIT = 65536;
const SPHERICAL_PROJECTIONS = new Set(['equirectangular', 'cubemap', 'tiled equirectangular',
  'half equirectangular', 'rectilinear', 'fisheye', 'parametric immersive']);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function errorDetails(error, fallback = 'INVALID_MEDIA') {
  return { code: typeof error?.code === 'string' ? error.code : fallback, message: String(error?.message || error).slice(0, 4096) };
}
function pathKey(path) { return win32.normalize(path).toLowerCase(); }
function localPath(path, media = true) {
  if (typeof path !== 'string' || path.length > 32767 || !/^[a-z]:[\\/]/i.test(path)
    || /[\x00-\x1f\x7f"<>|?*]/.test(path) || path.slice(2).includes(':')) {
    fail('INVALID_MEDIA_PATH', 'Use an absolute local Windows media path; URLs, device paths, network shares, control characters and alternate data streams are rejected.');
  }
  const normalized = win32.normalize(path);
  for (const component of normalized.slice(3).split(/[\\/]/)) {
    if (/[. ]$/.test(component) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(component)) {
      fail('INVALID_MEDIA_PATH', 'Windows device names and path components ending in dots or spaces are rejected.');
    }
  }
  if (media && !MEDIA_EXTENSION.test(normalized)) fail('INVALID_MEDIA_PATH', 'Unsupported media extension. Use an Insta360, video, audio or image file.');
  return normalized;
}
function integer(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail('INVALID_ARGUMENT', `${name} must be an integer from ${minimum} to ${maximum}.`);
}
function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : null;
}
function frameRate(value) {
  if (typeof value === 'string' && value.includes('/')) {
    const [numerator, denominator] = value.split('/').map(Number);
    return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0 ? numerator / denominator : null;
  }
  return finiteNumber(value);
}
function signedNumber(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === ''
    || (typeof value === 'string' && (value.length > 64 || !value.trim()))) return null;
  const number = Number(value); return Number.isFinite(number) ? number : null;
}
function sphericalMapping(stream) {
  // Only FFprobe's parsed spherical side data qualifies. Dimensions and free-form tags do not.
  const entries = Array.isArray(stream.side_data_list)
    ? stream.side_data_list.filter(entry => entry?.side_data_type === 'Spherical Mapping') : [];
  if (!entries.length) return { status: 'unknown', projection: null };
  const source = 'ffprobe_stream_side_data';
  // Multiple declarations are ambiguous; do not pick whichever would satisfy an expectation.
  if (entries.length !== 1) return { status: 'ambiguous', projection: null, source };
  const entry = entries[0];
  const projection = typeof entry.projection === 'string' && entry.projection.length <= 64
    ? entry.projection.trim().toLowerCase() : null;
  return { status: SPHERICAL_PROJECTIONS.has(projection) ? 'reported' : 'unknown',
    projection: SPHERICAL_PROJECTIONS.has(projection) ? projection : null, source,
    yaw: signedNumber(entry.yaw), pitch: signedNumber(entry.pitch), roll: signedNumber(entry.roll) };
}
function fileSignature(info, canonicalPath) {
  return { canonical_path: canonicalPath, bytes: info.size, mtime_ms: info.mtimeMs, ctime_ms: info.ctimeMs,
    birthtime_ms: info.birthtimeMs, device: String(info.dev), inode: String(info.ino) };
}
function sameFile(left, right) {
  return Boolean(left && right && pathKey(left.canonical_path) === pathKey(right.canonical_path)
    && ['bytes', 'mtime_ms', 'ctime_ms', 'device', 'inode'].every(key => left[key] === right[key]));
}

/** Read-only media inspection and export evidence. Subprocess executables come only from local config. */
export class MediaVerifier {
  constructor({ rootDir, config = {}, sessionId = randomUUID(), execFileFn = execFileAsync, spawnFn = spawn }) {
    if (!rootDir) throw new TypeError('MediaVerifier requires rootDir.');
    this.rootDir = rootDir;
    this.config = Object.freeze({ ffprobe: config.ffprobe, ffmpeg: config.ffmpeg });
    this.sessionId = sessionId;
    this.execFileFn = execFileFn;
    this.spawnFn = spawnFn;
    this.jobs = new Map();
    this.pendingFull = 0;
    this.closed = false;
  }

  async _tool(name) {
    const path = this.config[name];
    try {
      localPath(path, false);
      const canonical = localPath(await fs.realpath(path), false);
      if (win32.basename(path).toLowerCase() !== `${name}.exe` || win32.basename(canonical).toLowerCase() !== `${name}.exe`
        || !(await fs.stat(canonical)).isFile()) throw new Error('Missing pinned executable.');
    } catch { fail('MEDIA_TOOLS_UNAVAILABLE', `A pinned absolute ${name}.exe path is required in config.local.json. Run setup.ps1.`); }
    return path;
  }

  async _file(path, optional = false) {
    const normalized = localPath(path);
    let canonicalPath;
    try { canonicalPath = localPath(await fs.realpath(normalized)); }
    catch (error) {
      if (optional && error.code === 'ENOENT') return null;
      if (error.code === 'INVALID_MEDIA_PATH') throw error;
      fail('MEDIA_NOT_FOUND', `Media file cannot be read: ${normalized}`);
    }
    const info = await fs.stat(canonicalPath).catch(() => null);
    if (!info?.isFile()) fail('MEDIA_NOT_FOUND', `Media path is not an existing regular file: ${normalized}`);
    return fileSignature(info, canonicalPath);
  }

  async _write(directory, id, value) {
    const parent = join(this.rootDir, 'runtime', directory);
    await fs.mkdir(parent, { recursive: true });
    const destination = join(parent, `${id}.json`);
    const temporary = join(parent, `${id}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
      await fs.rename(temporary, destination);
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }

  async _read(directory, id) {
    if (typeof id !== 'string' || !UUID.test(id)) fail('INVALID_ARGUMENT', 'Record IDs must be UUIDs returned by this server.');
    let record;
    try { record = JSON.parse(await fs.readFile(join(this.rootDir, 'runtime', directory, `${id}.json`), 'utf8')); }
    catch { fail(directory === 'jobs' ? 'JOB_NOT_FOUND' : 'CHECKPOINT_NOT_FOUND', 'The requested saved record does not exist or cannot be read.'); }
    if (record?.[directory === 'jobs' ? 'job_id' : 'checkpoint_id'] !== id) fail('INVALID_RECORD', 'Saved record identity does not match the requested ID.');
    return record;
  }

  async _probe(path, info) {
    const executable = await this._tool('ffprobe');
    let metadata;
    try {
      const result = await this.execFileFn(executable, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_format', '-show_streams', '-of', 'json', '-i', path],
        { windowsHide: true, shell: false, timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
      metadata = JSON.parse(result.stdout);
      if (!Array.isArray(metadata.streams) || metadata.streams.length === 0) throw new Error('No media streams were found.');
    } catch (error) {
      fail(error.killed ? 'MEDIA_PROBE_TIMEOUT' : 'INVALID_MEDIA', `Media could not be probed: ${String(error.message).slice(0, 4096)}`);
    }
    const streams = metadata.streams.map(stream => ({ index: Number.isSafeInteger(stream.index) && stream.index >= 0 ? stream.index : null,
      type: stream.codec_type || 'unknown', codec: stream.codec_name || null,
      ...(stream.codec_type === 'video' ? { width: finiteNumber(stream.width), height: finiteNumber(stream.height),
        fps: frameRate(stream.avg_frame_rate) || frameRate(stream.r_frame_rate), attached_picture: Boolean(stream.disposition?.attached_pic),
        spherical_mapping: sphericalMapping(stream) } : {}),
      ...(stream.codec_type === 'audio' ? { sample_rate: finiteNumber(stream.sample_rate), channels: finiteNumber(stream.channels) } : {}),
      duration_seconds: finiteNumber(stream.duration) }));
    const video = streams.find(stream => stream.type === 'video' && !stream.attached_picture) || null;
    const durations = streams.map(stream => stream.duration_seconds).filter(value => value !== null);
    return { ok: true, path, bytes: info.bytes, modified_at: new Date(info.mtime_ms).toISOString(),
      format: { name: metadata.format?.format_name || null, long_name: metadata.format?.format_long_name || null },
      duration_seconds: finiteNumber(metadata.format?.duration) ?? (durations.length ? Math.max(...durations) : null),
      video, audio_present: streams.some(stream => stream.type === 'audio'), streams,
      limitation: 'Metadata describes the file. Declared projection does not establish stitching quality or complete spherical coverage. Metadata does not establish correct reframing or Studio authorship.' };
  }

  async _unchanged(path, expected) {
    const current = await this._file(path, true);
    if (!sameFile(current, expected)) fail('EXPORT_CHANGED', 'The media file changed or disappeared during verification. Wait for the export to finish and verify again.');
  }

  async mediaInfo({ path }) {
    const info = await this._file(path);
    let result;
    try { result = await this._probe(localPath(path), info); }
    catch (error) { await this._unchanged(path, info); throw error; }
    await this._unchanged(path, info);
    return { ...result, verification_depth: 'container_and_stream_metadata' };
  }

  async checkpoint({ path }) {
    if (this.closed) fail('SERVER_CLOSED', 'The media verifier has closed.');
    path = localPath(path);
    const baseline = await this._file(path, true);
    // An absent output is allowed, but its parent must already be a local directory.
    if (!baseline) {
      let parent;
      try { parent = localPath(await fs.realpath(win32.dirname(path)), false); }
      catch (error) { if (error.code === 'INVALID_MEDIA_PATH') throw error; fail('OUTPUT_DIRECTORY_NOT_FOUND', 'Create the intended local export directory before taking a checkpoint.'); }
      if (!(await fs.stat(parent)).isDirectory()) fail('OUTPUT_DIRECTORY_NOT_FOUND', 'The intended export parent is not a directory.');
    }
    const checkpoint_id = randomUUID();
    const record = { schema_version: 1, checkpoint_id, owner_session_id: this.sessionId, path, created_at: new Date().toISOString(),
      existed: Boolean(baseline), baseline,
      limitation: 'A changed or newly present file can be established against this baseline; this does not prove which application produced it.' };
    await this._write('checkpoints', checkpoint_id, record);
    return { ok: true, ...record };
  }

  async _stable(path, { min_bytes, stable_for_ms, timeout_ms }) {
    const started = Date.now();
    let previous = null, stableSince = started;
    while (true) {
      const info = await this._file(path, true);
      if (info && info.bytes >= min_bytes) {
        if (!sameFile(previous, info)) { previous = info; stableSince = Date.now(); }
        if (Date.now() - stableSince >= stable_for_ms) return { info, stable_for_ms: Date.now() - stableSince };
      } else { previous = null; stableSince = Date.now(); }
      if (Date.now() - started >= timeout_ms) fail('EXPORT_NOT_STABLE', 'Export file is absent, too small or still changing. Wait for Studio to finish and verify again.');
      await sleep(Math.min(100, Math.max(1, timeout_ms - (Date.now() - started))));
    }
  }

  _expectations(metadata, args) {
    if (!metadata.video) fail('NO_VIDEO_STREAM', 'The export must contain a video stream; audio-only files and attached cover pictures are insufficient.');
    const checks = [
      ['expected_duration_seconds', metadata.duration_seconds, args.duration_tolerance_seconds ?? 0.15, 'DURATION_MISMATCH'],
      ['expected_width', metadata.video.width, 0, 'WIDTH_MISMATCH'],
      ['expected_height', metadata.video.height, 0, 'HEIGHT_MISMATCH'],
      ['expected_fps', metadata.video.fps, 0.01, 'FPS_MISMATCH'],
    ];
    for (const [name, actual, tolerance, code] of checks) {
      if (args[name] !== undefined) {
        if (!Number.isFinite(args[name]) || args[name] <= 0) fail('INVALID_ARGUMENT', `${name} must be a positive finite number.`);
        if (actual === null) fail('EXPECTATION_UNVERIFIABLE', `${name} cannot be checked because the file's value is unavailable.`);
        if (Math.abs(actual - args[name]) > tolerance) fail(code, `${name} is ${args[name]}, but the file reports ${actual}.`);
      }
    }
    if (args.expected_video_codec !== undefined) {
      if (typeof args.expected_video_codec !== 'string' || !/^[a-z0-9_]{1,64}$/i.test(args.expected_video_codec)) fail('INVALID_ARGUMENT', 'expected_video_codec must be an FFprobe codec name.');
      if (metadata.video.codec?.toLowerCase() !== args.expected_video_codec.toLowerCase()) fail('VIDEO_CODEC_MISMATCH', `Expected video codec ${args.expected_video_codec}, but found ${metadata.video.codec}.`);
    }
    if (args.expected_audio !== undefined) {
      if (typeof args.expected_audio !== 'boolean') fail('INVALID_ARGUMENT', 'expected_audio must be a boolean.');
      if (args.expected_audio !== metadata.audio_present) fail('AUDIO_MISMATCH', `Expected audio presence ${args.expected_audio}, but the file reports ${metadata.audio_present}.`);
    }
    if (args.expected_projection !== undefined) {
      const mapping = metadata.video.spherical_mapping;
      if (mapping?.status !== 'reported') fail('EXPECTATION_UNVERIFIABLE', 'expected_projection cannot be checked because the playable video has no unambiguous recognized spherical mapping metadata. Dimensions alone do not establish spherical projection.');
      if (mapping.projection !== args.expected_projection) fail('PROJECTION_MISMATCH', `Expected projection ${args.expected_projection}, but the playable video reports ${mapping.projection}.`);
    }
  }

  async verify(args) {
    if (this.closed) fail('SERVER_CLOSED', 'The media verifier has closed.');
    const path = localPath(args.path);
    const settings = { min_bytes: args.min_bytes ?? 1024, stable_for_ms: args.stable_for_ms ?? 1500, timeout_ms: args.timeout_ms ?? 10000,
      mode: args.mode ?? 'quick', decode_timeout_ms: args.decode_timeout_ms ?? 1800000 };
    integer(settings.min_bytes, 'min_bytes', 1, Number.MAX_SAFE_INTEGER);
    integer(settings.stable_for_ms, 'stable_for_ms', 0, 10000);
    integer(settings.timeout_ms, 'timeout_ms', 1, 30000);
    integer(settings.decode_timeout_ms, 'decode_timeout_ms', 1, 7200000);
    if (settings.stable_for_ms > settings.timeout_ms) fail('INVALID_ARGUMENT', 'stable_for_ms cannot exceed timeout_ms.');
    if (!['quick', 'full'].includes(settings.mode)) fail('INVALID_ARGUMENT', 'mode must be quick or full.');
    if (args.expected_projection !== undefined && args.expected_projection !== 'equirectangular') fail('INVALID_ARGUMENT', 'expected_projection must be equirectangular when supplied.');
    if (args.duration_tolerance_seconds !== undefined && (!Number.isFinite(args.duration_tolerance_seconds) || args.duration_tolerance_seconds < 0)) fail('INVALID_ARGUMENT', 'duration_tolerance_seconds must be a nonnegative finite number.');
    if (settings.mode === 'full') {
      const active = [...this.jobs.values()].filter(job => !job.settled).length;
      if (active + this.pendingFull >= 2) fail('JOB_LIMIT_REACHED', 'At most two full-decode jobs can be active in one server.');
      this.pendingFull++;
    }
    try {
      const checkpoint = args.checkpoint_id ? await this._read('checkpoints', args.checkpoint_id) : null;
      if (checkpoint && pathKey(checkpoint.path) !== pathKey(path)) fail('CHECKPOINT_PATH_MISMATCH', 'The checkpoint belongs to a different export path.');
      const stable = await this._stable(path, settings);
      if (checkpoint?.existed && sameFile(checkpoint.baseline, stable.info)) fail('EXPORT_UNCHANGED', 'This file is unchanged from the pre-export checkpoint. It is not evidence of a new export.');
      let metadata;
      try { metadata = await this._probe(path, stable.info); }
      catch (error) { await this._unchanged(path, stable.info); throw error; }
      this._expectations(metadata, args);
      const decodeArgs = this._decodeArgs(path, settings.mode === 'quick', metadata);
      await this._unchanged(path, stable.info);
      const evidence = { ...metadata, stable_for_ms: stable.stable_for_ms,
        checkpoint: checkpoint ? { checkpoint_id: checkpoint.checkpoint_id, created_at: checkpoint.created_at,
          existed_before: checkpoint.existed, changed_since_checkpoint: true } : null,
        provenance: checkpoint ? 'File is new or changed relative to the checkpoint; Studio authorship is not established by this check.'
          : 'No pre-export checkpoint supplied. Verification does not establish that this is a new export.' };
      if (settings.mode === 'full') return await this._startJob(path, stable.info, evidence, settings.decode_timeout_ms, decodeArgs);
      const executable = await this._tool('ffmpeg');
      try {
        await this.execFileFn(executable, decodeArgs, { windowsHide: true, shell: false, timeout: 15000, maxBuffer: 1024 * 1024 });
      } catch (error) {
        // A concurrent write must retain its more useful error instead of becoming INVALID_MEDIA.
        await this._unchanged(path, stable.info);
        fail(error.killed ? 'QUICK_DECODE_TIMEOUT' : 'INVALID_MEDIA', `First-second video/audio decode failed: ${String(error.message).slice(0, 4096)}`);
      }
      await this._unchanged(path, stable.info);
      return { ...evidence, verification_depth: 'stable_file_metadata_and_first_second_video_and_audio_decode',
        decode_exit_code: 0, limitation: 'Only the first second was decoded. Visual quality, correct edits and the remaining media require additional review.' };
    } finally { if (settings.mode === 'full') this.pendingFull--; }
  }

  _decodeArgs(path, quick, metadata) {
    // Decode the video whose metadata was checked, never an earlier attached cover picture.
    // Full mode covers every playable video stream and all available audio streams.
    const videos = quick ? [metadata.video] : metadata.streams.filter(stream => stream.type === 'video' && !stream.attached_picture);
    const indices = videos.map(stream => stream?.index);
    if (!indices.length || indices.some(index => !Number.isSafeInteger(index) || index < 0)
      || new Set(indices).size !== indices.length) fail('VIDEO_STREAM_INDEX_UNVERIFIABLE', 'Playable video stream indices cannot be established unambiguously from FFprobe metadata.');
    return ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-abort_on', 'empty_output+empty_output_stream', '-protocol_whitelist', 'file,pipe',
      ...(!quick ? ['-nostats', '-stats_period', '1', '-progress', 'pipe:1'] : []), '-i', path,
      ...(quick ? ['-t', '1'] : []), ...indices.flatMap(index => ['-map', `0:${index}`]), '-map', '0:a?', '-f', 'null', '-'];
  }

  _persistJob(job) {
    const snapshot = JSON.parse(JSON.stringify(job.record));
    job.writeTail = job.writeTail.then(() => this._write('jobs', job.record.job_id, snapshot));
    // Keep later writes possible after a transient disk error, but expose the latest persistence failure.
    job.writeTail = job.writeTail.catch(error => { job.persistenceError = errorDetails(error, 'JOB_PERSISTENCE_FAILED'); });
    return job.writeTail;
  }

  _publicJob(job) {
    const record = JSON.parse(JSON.stringify(job.record));
    return { ...record, live_tracking: true, can_cancel: Boolean(job.child && !job.settled && !job.finishing && job.record.owner_session_id === this.sessionId),
      ...(job.persistenceError ? { persistence_error: job.persistenceError } : {}) };
  }

  _liveProcessError(job, error) {
    if (job.settled || job.finishing) return;
    // A failed kill is an error event on ChildProcess too; it does not confirm process exit.
    job.record.ok = false;
    job.record.status = job.reason ? 'termination_failed' : 'process_error';
    job.record.error = { code: job.reason ? 'DECODE_TERMINATION_FAILED' : 'DECODE_PROCESS_ERROR',
      message: `${job.reason ? 'Decoder termination was not confirmed' : 'The decoder reported a process error'}: ${String(error?.message || error).slice(0, 4096)}` };
    job.record.updated_at = new Date().toISOString();
    if (job.reason) job.record.termination_signal_sent = false;
    void this._persistJob(job);
  }

  _requestStop(job, reason) {
    if (job.settled || job.finishing || !job.child) return;
    job.reason = reason;
    job.record.status = reason === 'timeout' ? 'timing_out' : 'cancelling';
    job.record.updated_at = new Date().toISOString();
    job.record.termination_requested = true;
    try {
      const sent = job.child.kill();
      job.record.termination_signal_sent = Boolean(sent);
      if (!sent && job.record.status !== 'termination_failed') this._liveProcessError(job, new Error('The owned child did not accept the termination signal.'));
    } catch (error) { this._liveProcessError(job, error); }
    void this._persistJob(job);
  }

  async _startJob(path, baseline, evidence, timeout, decodeArgs) {
    if (this.closed) fail('SERVER_CLOSED', 'The media verifier has closed.');
    const executable = await this._tool('ffmpeg');
    const job_id = randomUUID();
    const started = Date.now();
    const job = { record: { schema_version: 1, ...evidence, job_id, owner_session_id: this.sessionId, status: 'running',
      started_at: new Date(started).toISOString(), updated_at: new Date(started).toISOString(), decode_timeout_ms: timeout,
      verification_depth: 'full_video_and_audio_decode_pending', progress: { decoded_seconds: 0, percent: null }, stderr: '', stderr_truncated: false },
      child: null, baseline, started, settled: false, finishing: false, reason: null, writeTail: Promise.resolve(), lastPersisted: started,
      progressBuffer: '', progressValues: {} };
    await this._write('jobs', job_id, job.record);
    this.jobs.set(job_id, job);
    job.completion = new Promise(resolve => { job.resolveCompletion = resolve; });
    try {
      job.child = this.spawnFn(executable, decodeArgs, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      job.child.once('spawn', () => { job.spawnConfirmed = true; });
      job.child.stdout?.on('data', chunk => this._progress(job, chunk));
      job.child.stderr?.on('data', chunk => {
        const combined = job.record.stderr + String(chunk);
        job.record.stderr_truncated ||= combined.length > STDERR_LIMIT;
        job.record.stderr = combined.slice(-STDERR_LIMIT);
      });
      job.child.on('error', error => {
        if (job.spawnConfirmed || (Number.isInteger(job.child.pid) && job.child.pid > 0)) this._liveProcessError(job, error);
        else void this._finish(job, null, null, error);
      });
      job.child.once('close', (code, signal) => { void this._finish(job, code, signal); });
      job.timer = setTimeout(() => {
        if (job.settled || job.finishing) return;
        this._requestStop(job, 'timeout');
      }, timeout);
      job.timer.unref?.();
    } catch (error) { await this._finish(job, null, null, error); }
    return this._publicJob(job);
  }

  _progress(job, chunk) {
    if (job.settled || job.finishing) return;
    job.progressBuffer += String(chunk);
    if (job.progressBuffer.length > 32768) job.progressBuffer = job.progressBuffer.slice(-32768);
    const lines = job.progressBuffer.split(/\r?\n/);
    job.progressBuffer = lines.pop() || '';
    for (const line of lines) {
      const separator = line.indexOf('=');
      if (separator < 1) continue;
      const key = line.slice(0, separator), value = line.slice(separator + 1);
      if (['frame', 'fps', 'speed', 'out_time_us', 'out_time_ms', 'out_time', 'progress'].includes(key)) job.progressValues[key] = value.slice(0, 128);
      if (key !== 'progress') continue;
      const microseconds = finiteNumber(job.progressValues.out_time_us ?? job.progressValues.out_time_ms);
      const seconds = microseconds === null ? null : microseconds / 1000000;
      const duration = job.record.duration_seconds;
      job.record.progress = { decoded_seconds: seconds, percent: seconds !== null && duration > 0 ? Math.min(100, seconds / duration * 100) : null,
        frame: finiteNumber(job.progressValues.frame), speed: job.progressValues.speed || null };
      if (Date.now() - job.lastPersisted >= 1000) {
        job.lastPersisted = Date.now(); job.record.updated_at = new Date().toISOString();
        void this._persistJob(job);
      }
    }
  }

  async _finish(job, code, signal, spawnError) {
    if (job.settled || job.finishing) return;
    job.finishing = true;
    clearTimeout(job.timer);
    job.record.decode_exit_code = code;
    job.record.decode_signal = signal || null;
    let failure;
    if (job.reason === 'cancelled') failure = { code: 'DECODE_CANCELLED', message: 'Full decode was cancelled by its owning server session.' };
    else if (job.reason === 'timeout') failure = { code: 'DECODE_TIMEOUT', message: 'Full decode exceeded its configured timeout.' };
    else if (spawnError) failure = errorDetails(spawnError, 'DECODE_PROCESS_FAILED');
    else if (code !== 0) failure = { code: 'INVALID_MEDIA', message: `Full video/audio decode failed (exit ${code}${signal ? `, signal ${signal}` : ''}). ${job.record.stderr.slice(-4096)}`.trim() };
    // Restat even on decoder failure, preserving EXPORT_CHANGED as the causal evidence.
    if (job.reason !== 'cancelled' && job.reason !== 'timeout') {
      try { await this._unchanged(job.record.path, job.baseline); }
      catch (error) { failure = errorDetails(error); }
    }
    const finished = Date.now();
    Object.assign(job.record, { ok: !failure, status: failure ? (job.reason === 'cancelled' ? 'cancelled' : 'failed') : 'completed',
      completed_at: new Date(finished).toISOString(), updated_at: new Date(finished).toISOString(), elapsed_ms: finished - job.started,
      verification_depth: failure ? 'full_video_and_audio_decode_incomplete' : 'full_video_and_audio_decode',
      limitation: 'Decoding does not establish visual quality, correct editing choices or Studio authorship.' });
    if (failure) job.record.error = failure;
    else { delete job.record.error; job.record.progress.percent = 100; }
    job.settled = true;
    await this._persistJob(job);
    job.resolveCompletion(this._publicJob(job));
  }

  async jobStatus({ job_id }) {
    if (typeof job_id !== 'string' || !UUID.test(job_id)) fail('INVALID_ARGUMENT', 'job_id must be a UUID returned by this server.');
    const job = this.jobs.get(job_id);
    if (job) return this._publicJob(job);
    const record = await this._read('jobs', job_id);
    return { ...record, live_tracking: false, can_cancel: false,
      ...(['running', 'timing_out', 'cancelling', 'termination_failed', 'termination_unconfirmed', 'process_error'].includes(record.status)
        ? { warning: 'This server does not own the decoder process. The persisted active state may be stale; completed status requires a saved successful result.' } : {}) };
  }

  async cancelJob({ job_id }) {
    if (typeof job_id !== 'string' || !UUID.test(job_id)) fail('INVALID_ARGUMENT', 'job_id must be a UUID returned by this server.');
    const job = this.jobs.get(job_id);
    if (!job || job.record.owner_session_id !== this.sessionId) fail('JOB_NOT_OWNED', 'Only this session can cancel its own tracked decoder child. Persisted PIDs are never used for termination.');
    if (!job.settled && !job.finishing && job.child) {
      this._requestStop(job, 'cancelled');
      await this._persistJob(job);
    }
    return this._publicJob(job);
  }

  async close() {
    this.closed = true;
    const owned = [...this.jobs.values()].filter(job => !job.settled);
    await Promise.all(owned.map(job => this.cancelJob({ job_id: job.record.job_id })));
    if (owned.length) {
      let timer;
      try { await Promise.race([Promise.all(owned.map(job => job.completion)), new Promise(resolve => { timer = setTimeout(resolve, 3000); })]); }
      finally { clearTimeout(timer); }
      for (const job of owned.filter(item => !item.settled && !item.finishing)) {
        clearTimeout(job.timer);
        Object.assign(job.record, { ok: false, status: 'termination_unconfirmed', updated_at: new Date().toISOString(),
          error: { code: 'DECODE_TERMINATION_UNCONFIRMED', message: 'Shutdown waited three seconds without a decoder close event. The owned process may still be running; cancellation is not confirmed.' } });
        await this._persistJob(job);
      }
    }
    // A decoder can have settled just before close while its final atomic record write is still queued.
    await Promise.all([...this.jobs.values()].map(job => job.writeTail));
  }
}
