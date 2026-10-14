import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { scanRelease, scanText, sdkHandshake, checkRelease, validateManifest, parseArguments } from '../scripts/release-check.mjs';

async function fixture(t) {
  const rootDir = await fs.mkdtemp(join(tmpdir(), 'studio-release-test-'));
  t.after(async () => {
    assert.equal(dirname(resolve(rootDir)), resolve(tmpdir()));
    assert(basename(rootDir).startsWith('studio-release-test-'));
    await fs.rm(rootDir, { recursive: true, force: true });
  });
  const manifest = { schema_version: 1, package_name: 'insta360-studio-mcp', required_files: [
    'release-manifest.json', 'package.json', 'package-lock.json', 'native/studio_bridge.py', 'src/server.mjs', 'README.md',
  ], optional_files: ['LICENSE'] };
  const text = {
    'release-manifest.json': JSON.stringify(manifest),
    'package.json': JSON.stringify({ name: manifest.package_name, version: '0.3.0' }),
    'package-lock.json': JSON.stringify({ name: manifest.package_name, version: '0.3.0', packages: { '': { version: '0.3.0' } } }),
    'native/studio_bridge.py': 'ADAPTER_VERSION = "0.3.0"\n',
    'src/server.mjs': "const identity = { name: 'insta360-studio', version: '0.3.0' };\n",
    'README.md': '# Public package\nUse a local Windows installation.\n',
  };
  for (const [name, value] of Object.entries(text)) { await fs.mkdir(dirname(join(rootDir, name)), { recursive: true }); await fs.writeFile(join(rootDir, name), value); }
  return { rootDir, manifest, files: manifest.required_files };
}

test('explicit public manifest accepts a clean package and optional license remains optional', async t => {
  const { rootDir } = await fixture(t);
  const report = await scanRelease({ rootDir });
  assert.equal(report.ok, true);
  assert.equal(report.version, '0.3.0');
  assert.equal(report.license_present, false);
  await fs.writeFile(join(rootDir, 'LICENSE'), 'Example owner-selected license\n');
  assert.equal((await scanRelease({ rootDir })).license_present, true);
});

test('missing files and unexpected source, credentials, media and compiled caches fail publication', async t => {
  const { rootDir, files } = await fixture(t);
  await fs.unlink(join(rootDir, 'README.md'));
  for (const name of ['unexpected.mjs', 'config.local.json', 'secrets.env', 'sample.mp4', 'screenshots/capture.png', 'native/__pycache__/bridge.pyc']) {
    const report = await scanRelease({ rootDir, files: [...files, name] });
    assert.equal(report.ok, false);
    assert(report.findings.some(finding => finding.rule === 'FILE_NOT_ALLOWED' && finding.file === name));
  }
  const report = await scanRelease({ rootDir, files: files.filter(name => name !== 'README.md') });
  assert(report.findings.some(finding => finding.rule === 'MISSING_REQUIRED_FILE'));
});

test('private user and footage paths are rejected without echoing their contents', () => {
  const slash = String.fromCharCode(92);
  const privateHome = ['C:', 'Users', 'PrivatePerson', 'Documents', 'file.mp4'].join(slash);
  const privateDrive = ['G:', 'Private Footage', 'clip.insv'].join(slash);
  const report = scanText('README.md', `${privateHome}\n${privateDrive}\n`);
  assert.equal(report.length, 2);
  assert.equal(report[0].line, 1);
  assert.equal(report[1].line, 2);
  assert.equal(JSON.stringify(report).includes('PrivatePerson'), false);
  assert.equal(JSON.stringify(report).includes('Private Footage'), false);
});

test('secrets and large embedded screenshots are rejected; ordinary dependency URLs and examples pass', () => {
  const secret = ['gh', 'p_'].join('') + 'a'.repeat(36);
  const privateKey = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
  const credentialUrl = ['https://', 'name', ':', 'password', '@', 'example.com/'].join('');
  const image = ['data:', 'image/png;', 'base64,'].join('') + 'a'.repeat(300);
  for (const value of [secret, privateKey, credentialUrl, image, 'api_key = "' + 'a'.repeat(32) + '"']) {
    assert(scanText('README.md', value).length > 0);
    assert.equal(JSON.stringify(scanText('README.md', value)).includes(value), false);
  }
  assert.deepEqual(scanText('README.md', 'https://registry.npmjs.org/zod/-/zod-4.6.7.tgz\npassword = "CHANGE_ME"\nC:/Tools/ffmpeg/bin/ffmpeg.exe\nC:/Program Files/Insta360 Studio/Insta360 Studio.exe'), []);
});

test('manifest rejects traversal, absolute paths, duplicates and private/binary payload names', () => {
  const base = { schema_version: 1, package_name: 'insta360-studio-mcp', required_files: [], optional_files: [] };
  for (const name of ['../secret.json', '/secret.json', 'C:/secret.json', 'src\\server.mjs', '.env', 'config.local.json',
    'artifacts/result.json', 'logs/actions.jsonl', 'runtime/jobs/data.json', 'native/__pycache__/bridge.pyc', 'photo.png']) {
    assert.throws(() => validateManifest({ ...base, required_files: [name] }));
  }
  assert.throws(() => validateManifest({ ...base, required_files: ['README.md'], optional_files: ['README.md'] }));
});

test('binary and invalid UTF-8 cannot hide inside an allowed text filename', async t => {
  const { rootDir, files } = await fixture(t);
  for (const bytes of [Buffer.from([0, 1, 2]), Buffer.from([0xc0, 0xaf])]) {
    await fs.writeFile(join(rootDir, 'README.md'), bytes);
    const report = await scanRelease({ rootDir, files });
    assert(report.findings.some(finding => finding.rule === 'UNSAFE_FILE' && finding.file === 'README.md'));
  }
});

test('symbolic-link parents cannot escape package source boundaries', async t => {
  const { rootDir, files } = await fixture(t);
  const source = join(rootDir, 'real-native'); await fs.rename(join(rootDir, 'native'), source);
  try { await fs.symlink(source, join(rootDir, 'native'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Symbolic links unavailable to this account.'); return; } throw error; }
  const report = await scanRelease({ rootDir, files });
  assert(report.findings.some(finding => finding.rule === 'UNSAFE_FILE' && finding.file === 'native/studio_bridge.py'));
});

test('version alignment requires package, lockfile, server and native adapter agreement', async t => {
  const { rootDir, files } = await fixture(t);
  await fs.writeFile(join(rootDir, 'native', 'studio_bridge.py'), 'ADAPTER_VERSION = "0.2.0"\n');
  const report = await scanRelease({ rootDir, files });
  assert.equal(report.ok, false);
  assert(report.findings.some(finding => finding.rule === 'VERSION_ALIGNMENT'));
});

test('Git-based payload scan checks the intended repo and rejects a tracked private file even when ignored', async t => {
  const { rootDir, files } = await fixture(t); await fs.mkdir(join(rootDir, '.git'));
  const execFileFn = async (_command, args) => ({ stdout: args[0] === 'rev-parse' ? rootDir
    : args.includes('--cached') ? [...files, 'native/__pycache__/bridge.pyc'].join('\0') + '\0' : '' });
  const report = await scanRelease({ rootDir, execFileFn });
  assert.equal(report.publication_source, 'git_index_and_untracked_public_files');
  assert(report.findings.some(finding => finding.rule === 'FILE_NOT_ALLOWED' && finding.file.endsWith('.pyc')));
  await assert.rejects(scanRelease({ rootDir, execFileFn: async () => ({ stdout: dirname(rootDir) }) }), /Git root/);
});

test('unstaged or untracked release changes cannot conceal different indexed publication bytes', async t => {
  const { rootDir, files } = await fixture(t); await fs.mkdir(join(rootDir, '.git'));
  const execFileFn = async (_command, args) => ({ stdout: args[0] === 'rev-parse' ? rootDir : args[0] === 'diff' ? 'README.md\0'
    : args.includes('--cached') ? files.join('\0') + '\0' : 'LICENSE\0' });
  await fs.writeFile(join(rootDir, 'LICENSE'), 'An owner-selected license\n');
  const report = await scanRelease({ rootDir, execFileFn });
  assert(report.findings.some(finding => finding.rule === 'UNSTAGED_RELEASE_CHANGE'));
  assert(report.findings.some(finding => finding.rule === 'UNTRACKED_RELEASE_FILE'));
});

test('a raw release tree cannot silently include ignored compiled Python or private folders', async t => {
  const { rootDir } = await fixture(t);
  await fs.mkdir(join(rootDir, 'native', '__pycache__'));
  await fs.writeFile(join(rootDir, 'native', '__pycache__', 'bridge.pyc'), Buffer.from([0, 1, 2]));
  await fs.mkdir(join(rootDir, 'artifacts'));
  const report = await scanRelease({ rootDir });
  assert(report.findings.some(finding => finding.rule === 'FILE_NOT_ALLOWED' && finding.file.includes('__pycache__')));
  assert(report.findings.some(finding => finding.rule === 'FILE_NOT_ALLOWED' && finding.file.startsWith('artifacts/')));
});

test('SDK handshake initializes and lists strict tools only, without calling any native or GUI tool', async () => {
  const calls = [];
  class MockTransport { constructor(options) { calls.push(['transport', options]); } }
  class MockClient {
    async connect() { calls.push(['initialize']); }
    getServerVersion() { return { name: 'insta360-studio', version: '0.3.0' }; }
    async listTools() { calls.push(['listTools']); return { tools: [{ name: 'studio_click', inputSchema: { type: 'object', additionalProperties: false } }] }; }
    async callTool() { assert.fail('Release handshake must not call any tool.'); }
    async close() { calls.push(['close']); }
  }
  const report = await sdkHandshake({ version: '0.3.0', expectedToolNames: ['studio_click'], ClientType: MockClient, TransportType: MockTransport });
  assert.equal(report.tool_calls, 0);
  assert.equal(report.native_calls, 0);
  assert.equal(report.gui_actions, 0);
  assert.deepEqual(calls.slice(1).map(call => call[0]), ['initialize', 'listTools', 'close']);
});

test('SDK handshake rejects stale identity/tool schemas and always closes its client', async () => {
  let closed = false;
  class MockTransport { }
  class MockClient {
    async connect() { }
    getServerVersion() { return { name: 'insta360-studio', version: '0.2.0' }; }
    async close() { closed = true; }
  }
  await assert.rejects(sdkHandshake({ version: '0.3.0', expectedToolNames: [], ClientType: MockClient, TransportType: MockTransport }), /identity/);
  assert.equal(closed, true);
});

test('failed static privacy scan prevents SDK launch and CLI flags remain explicit', async () => {
  const report = await checkRelease({ scanFn: async () => ({ ok: false, findings: [{ rule: 'PRIVATE_USER_PATH' }] }),
    handshakeFn: async () => assert.fail('Unsafe package must not be launched.') });
  assert.equal(report.handshake.skipped, true);
  assert.equal(parseArguments(['--no-handshake']).handshake, false);
  assert.throws(() => parseArguments(['--root']), /requires/);
  assert.throws(() => parseArguments(['--publish']), /Unknown/);
});
