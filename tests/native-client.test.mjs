import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { NativeClient } from '../src/native-client.mjs';

// Protocol/process fixtures only. These tests never launch Python or send desktop input.
function fakeChild() {
  const child = new EventEmitter();
  child.killed = false;
  child.killCount = 0;
  child.requests = [];
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new EventEmitter();
  child.stdin.destroyed = false;
  child.stdin.write = (line, callback) => {
    child.requests.push(JSON.parse(line));
    queueMicrotask(() => callback?.());
    return true;
  };
  child.kill = () => { child.killed = true; child.killCount++; return true; };
  child.respond = (id, result = {}) => child.stdout.write(`${JSON.stringify({ id, ok: true, result })}\n`);
  return child;
}

function fixture(t, suppliedChildren = []) {
  const children = [];
  const spawns = [];
  const client = new NativeClient('C:/studio-lifecycle-tests', {
    spawnFn: (...args) => {
      spawns.push(args);
      const child = suppliedChildren[children.length] || fakeChild();
      children.push(child);
      return child;
    },
  });
  t.after(async () => {
    await client.close();
    for (const child of children) { child.stdout.destroy(); child.stderr.destroy(); }
  });
  return { client, children, spawns };
}

test('native requests keep pinned spawn arguments and a live adapter generation', async t => {
  const { client, children, spawns } = fixture(t);
  assert.equal(client.generation, 0);
  assert.equal(client.isGenerationLive(0), false);
  const first = client.request('status');
  assert.equal(client.generation, 1);
  assert.equal(client.isGenerationLive(1), true);
  assert.equal(spawns[0][0], join('C:/studio-lifecycle-tests', '.venv', 'Scripts', 'python.exe'));
  assert.deepEqual(spawns[0][1], ['-u', join('C:/studio-lifecycle-tests', 'native', 'studio_bridge.py')]);
  assert.equal(spawns[0][2].windowsHide, true);
  assert.deepEqual(spawns[0][2].stdio, ['pipe', 'pipe', 'pipe']);
  children[0].respond(children[0].requests[0].id, { ready: true });
  assert.deepEqual(await first, { ready: true });
  const second = client.request('observe', { window_id: '12' });
  assert.equal(spawns.length, 1);
  assert.deepEqual(children[0].requests[1].params, { window_id: '12' });
  children[0].respond(children[0].requests[1].id, { snapshot_id: 'fresh' });
  assert.deepEqual(await second, { snapshot_id: 'fresh' });
  assert.equal(client.pending.size, 0);
});

test('failed spawn error without exit clears the child and recovers on the next read', async t => {
  const { client, children } = fixture(t);
  const failed = client.request('status');
  const failure = assert.rejects(failed, { code: 'NATIVE_SPAWN_ERROR', native_code: 'ENOENT' });
  children[0].emit('error', Object.assign(new Error('Interpreter is absent'), { code: 'ENOENT' }));
  await failure;
  assert.equal(client.child, null);
  assert.equal(client.isGenerationLive(1), false);
  const recovered = client.request('status');
  assert.equal(client.generation, 2);
  assert.equal(client.isGenerationLive(2), true);
  children[0].emit('close'); // A late old-process close cannot reject the new request.
  assert.equal(client.pending.size, 1);
  children[1].respond(children[1].requests[0].id, { recovered: true });
  assert.deepEqual(await recovered, { recovered: true });
  assert.equal(children[0].requests.length, 1, 'The failed request was never replayed');
  assert.equal(children[1].requests.length, 1);
});

test('synchronous spawn failure is typed and does not poison the next request', async t => {
  const child = fakeChild();
  let attempts = 0;
  const client = new NativeClient('C:/studio-lifecycle-tests', {
    spawnFn: () => {
      if (++attempts === 1) throw Object.assign(new Error('Cannot create process'), { code: 'EACCES' });
      return child;
    },
  });
  t.after(() => client.close());
  await assert.rejects(client.request('status'), { code: 'NATIVE_SPAWN_ERROR', native_code: 'EACCES' });
  assert.equal(client.child, null);
  const recovered = client.request('status');
  assert.equal(client.generation, 2);
  child.respond(child.requests[0].id, { ok: true });
  assert.deepEqual(await recovered, { ok: true });
});

for (const [name, line] of [
  ['malformed JSON', 'adapter diagnostic on stdout'],
  ['non-object response', '[]'],
  ['invalid response envelope', '{"id":1,"ok":"yes"}'],
  ['unexpected response ID', '{"id":999,"ok":true,"result":{}}'],
]) {
  test(`native ${name} retires only its adapter and returns a protocol error`, async t => {
    const { client, children } = fixture(t);
    const operation = client.request('observe');
    const rejection = assert.rejects(operation, { code: 'NATIVE_PROTOCOL_ERROR' });
    children[0].stdout.write(`${line}\n`);
    await rejection;
    assert.equal(client.child, null);
    assert.equal(children[0].killCount, 1);
    const next = client.request('status');
    children[0].emit('exit', 1, null);
    children[1].respond(children[1].requests[0].id, { recovered: true });
    assert.deepEqual(await next, { recovered: true });
    assert.equal(children[1].killCount, 0);
  });
}

test('timeout fails all requests in its generation, kills only that child and never retries input', async t => {
  const { client, children } = fixture(t);
  const input = client.request('click', { x: 10, y: 20 }, 15);
  const second = client.request('status', {}, 1000);
  const inputRejected = assert.rejects(input, { code: 'NATIVE_TIMEOUT' });
  const secondRejected = assert.rejects(second, { code: 'NATIVE_TIMEOUT' });
  await Promise.all([inputRejected, secondRejected]);
  assert.equal(client.child, null);
  assert.equal(client.isGenerationLive(1), false);
  assert.equal(children[0].killCount, 1);
  assert.deepEqual(children[0].requests.map(request => request.method), ['click', 'status']);
  const recovered = client.request('status');
  children[0].emit('exit', null, 'SIGTERM');
  children[0].emit('close');
  children[0].stdout.write('{"id":1,"ok":true,"result":{"late":true}}\n');
  assert.equal(client.isGenerationLive(2), true);
  assert.equal(children[1].killCount, 0);
  assert.deepEqual(children[1].requests.map(request => request.method), ['status']);
  children[1].respond(children[1].requests[0].id, { recovered: true });
  assert.deepEqual(await recovered, { recovered: true });
});

test('stdin callback failure is typed, clears its generation and permits a fresh read', async t => {
  const child = fakeChild();
  child.stdin.write = (_line, callback) => queueMicrotask(() => callback(Object.assign(new Error('Broken pipe'), { code: 'EPIPE' })));
  const { client, children } = fixture(t, [child]);
  await assert.rejects(client.request('click'), { code: 'NATIVE_WRITE_ERROR', native_code: 'EPIPE' });
  assert.equal(client.child, null);
  const next = client.request('status');
  children[1].respond(children[1].requests[0].id, { ready: true });
  assert.deepEqual(await next, { ready: true });
});

test('synchronous stdin failure is typed and retires the adapter', async t => {
  const child = fakeChild();
  child.stdin.write = () => { throw Object.assign(new Error('Destroyed stream'), { code: 'ERR_STREAM_DESTROYED' }); };
  const { client } = fixture(t, [child]);
  await assert.rejects(client.request('status'), { code: 'NATIVE_WRITE_ERROR', native_code: 'ERR_STREAM_DESTROYED' });
  assert.equal(client.child, null);
  assert.equal(child.killCount, 1);
});

test('stdin stream errors are handled without an unhandled EventEmitter error', async t => {
  const { client, children } = fixture(t);
  const operation = client.request('status');
  const rejection = assert.rejects(operation, { code: 'NATIVE_WRITE_ERROR' });
  children[0].stdin.emit('error', Object.assign(new Error('Broken stream'), { code: 'EPIPE' }));
  await rejection;
  assert.equal(client.pending.size, 0);
});

test('stdout stream failures are reported as protocol transport errors', async t => {
  const { client, children } = fixture(t);
  const operation = client.request('observe');
  const rejection = assert.rejects(operation, { code: 'NATIVE_PROTOCOL_ERROR' });
  children[0].stdout.emit('error', new Error('Cannot read protocol'));
  await rejection;
  assert.equal(client.child, null);
});

test('a close event without exit fails pending work and clears the current child', async t => {
  const { client, children } = fixture(t);
  const operation = client.request('observe');
  const rejection = assert.rejects(operation, { code: 'NATIVE_EXITED' });
  children[0].emit('close');
  await rejection;
  assert.equal(client.child, null);
  assert.equal(client.isGenerationLive(1), false);
  const next = client.request('status');
  assert.equal(client.generation, 2);
  children[1].respond(children[1].requests[0].id, {});
  await next;
});

test('coded native operation failures preserve a usable adapter generation', async t => {
  const { client, children } = fixture(t);
  const operation = client.request('click');
  const rejection = assert.rejects(operation, { code: 'stale_snapshot' });
  children[0].stdout.write(`${JSON.stringify({ id: children[0].requests[0].id, ok: false,
    error: { code: 'stale_snapshot', message: 'Observe before input' } })}\n`);
  await rejection;
  assert.equal(client.isGenerationLive(1), true);
  const next = client.request('observe');
  children[0].respond(children[0].requests[1].id, { fresh: true });
  assert.deepEqual(await next, { fresh: true });
});

test('intentional close fails pending work and never starts another adapter', async t => {
  const { client, children, spawns } = fixture(t);
  const operation = client.request('click');
  const rejection = assert.rejects(operation, { code: 'NATIVE_CLOSED' });
  await client.close();
  await rejection;
  assert.equal(client.pending.size, 0);
  assert.equal(client.isGenerationLive(1), false);
  assert.equal(children[0].killCount, 1);
  await assert.rejects(client.request('status'), { code: 'NATIVE_CLOSED' });
  assert.equal(spawns.length, 1);
});
