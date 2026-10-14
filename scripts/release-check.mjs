#!/usr/bin/env node
// Local public-package checks. SDK initialization/listing deliberately invoke no native or UI tools.
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const execute = promisify(execFile);
const ownRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const worktreeOnly = new Set(['.git', 'node_modules', '.venv']);
const forbiddenDirectories = new Set(['artifacts', 'runtime', 'logs', 'node_modules', '.venv', '__pycache__', '.git']);
const forbiddenExtension = /\.(?:pyc|pyo|exe|dll|zip|7z|rar|tar|gz|mp4|mov|mkv|avi|insv|insp|lrv|insprj|insproj|wav|mp3|png|jpe?g|gif|webp|heic|pdf|pem|key|pfx|log|jsonl)$/i;
const allowedExtension = /\.(?:mjs|js|py|ps1|json|md|txt|ya?ml)$/i;
const secretPatterns = [
  ['PRIVATE_KEY', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ['GITHUB_TOKEN', /\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/g],
  ['API_TOKEN', /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}\b/g],
  ['AWS_ACCESS_KEY', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['CREDENTIAL_URL', /https?:\/\/[^\s/@:]+:[^\s/@]+@[^\s/]+/g],
  ['LITERAL_CREDENTIAL', /(?:api[_-]?key|client[_-]?secret|access[_-]?token|password)["']?\s*[:=]\s*["']([A-Za-z0-9_+\/=.:-]{8,})["']/gi],
];
const privatePatterns = [
  ['PRIVATE_USER_PATH', /\b[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+[^\s"'<>]+/gi],
  ['PRIVATE_USER_PATH', /\/(?:Users|home)\/(?!<|YOUR_|your_|example|username)[A-Za-z0-9._-]+\//g],
  ['PRIVATE_DRIVE_PATH', /\b[D-Z]:[\\/]+[^\s"'<>]+/gi],
  ['EMBEDDED_SCREENSHOT', /data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9/+]{256,}={0,2}/gi],
];

function problem(rule, file, detail, line) { return { rule, file, ...(line ? { line } : {}), detail }; }
function lineNumber(text, index) { return text.slice(0, index).split('\n').length; }
function portableName(name) {
  return typeof name === 'string' && name.length > 0 && name.length < 300 && !isAbsolute(name)
    && !name.includes('\\') && !/[\x00-\x1f\x7f:]/.test(name) && !name.split('/').some(part => !part || part === '.' || part === '..');
}
function forbiddenName(name) {
  return name.split('/').some(part => forbiddenDirectories.has(part.toLowerCase())) || forbiddenExtension.test(name)
    || /(?:^|\/)(?:\.env(?:\..*)?|config\.local\.json|id_rsa|id_ed25519|credentials(?:\..*)?)$/i.test(name);
}

export function validateManifest(manifest) {
  if (manifest?.schema_version !== 1 || manifest.package_name !== 'insta360-studio-mcp'
    || !Array.isArray(manifest.required_files) || !Array.isArray(manifest.optional_files)) throw new Error('Release manifest format is invalid.');
  const names = [...manifest.required_files, ...manifest.optional_files];
  if (names.length !== new Set(names).size) throw new Error('Release manifest contains duplicate files.');
  for (const name of names) {
    if (!portableName(name) || forbiddenName(name) || (!allowedExtension.test(name) && !['.gitignore', 'LICENSE'].includes(name))) {
      throw new Error('Release manifest contains an unsafe or unsupported file name.');
    }
  }
  return manifest;
}

export function scanText(file, text) {
  const findings = [];
  for (const [rule, pattern] of [...secretPatterns, ...privatePatterns]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (rule === 'LITERAL_CREDENTIAL' && /^(?:CHANGE_ME|EXAMPLE|PLACEHOLDER|YOUR_|REPLACE_|DUMMY|TEST_|FAKE)/i.test(match[1])) continue;
      // Report locations/rules only, never echo a credential or private path.
      findings.push(problem(rule, file, 'Remove private content or replace it with a portable example before publishing.', lineNumber(text, match.index)));
    }
  }
  return findings;
}

async function publicationFiles(root, execFileFn) {
  if (await fs.lstat(join(root, '.git')).catch(() => null)) {
    const options = { cwd: root, windowsHide: true, shell: false, timeout: 10000, maxBuffer: 4 * 1024 * 1024 };
    const top = await execFileFn('git', ['rev-parse', '--show-toplevel'], options);
    if (resolve(top.stdout.trim()).toLowerCase() !== root.toLowerCase()) throw new Error('Git root must be the intended public package, not its parent workspace.');
    const files = await execFileFn('git', ['ls-files', '--cached', '-z'], options);
    const names = files.stdout.split('\0').filter(Boolean);
    if (!names.length) throw new Error('The public Git index is empty. Stage the explicit release files before checking it.');
    // Also reject unexpected untracked source/media/config files; generated ignored worktree files are not publication payload.
    const others = await execFileFn('git', ['ls-files', '--others', '--exclude-standard', '-z'], options);
    const unstaged = await execFileFn('git', ['diff', '--name-only', '-z'], options);
    return { names: [...new Set([...names, ...others.stdout.split('\0').filter(Boolean)])],
      unstaged: unstaged.stdout.split('\0').filter(Boolean), untracked: others.stdout.split('\0').filter(Boolean), source: 'git_index_and_untracked_public_files' };
  }
  const names = [];
  const walk = async (directory, prefix = '') => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isSymbolicLink()) { names.push(name); continue; }
      if (entry.isDirectory()) {
        if (worktreeOnly.has(entry.name.toLowerCase())) continue;
        if (forbiddenDirectories.has(entry.name.toLowerCase())) { names.push(`${name}/__private_directory__`); continue; }
        await walk(join(directory, entry.name), `${name}/`);
      } else names.push(name);
    }
  };
  await walk(root);
  return { names, source: 'explicit_package_tree' };
}

async function safeFile(root, name) {
  if (!portableName(name)) throw new Error('Unsafe relative file name.');
  const destination = resolve(root, ...name.split('/'));
  const relation = relative(root, destination);
  if (!relation || relation.startsWith(`..${sep}`) || isAbsolute(relation)) throw new Error('File is outside the public package.');
  let location = root;
  for (const part of name.split('/')) {
    location = join(location, part);
    const info = await fs.lstat(location);
    if (info.isSymbolicLink()) throw new Error('Symbolic links are forbidden in public payload files.');
  }
  const info = await fs.stat(destination);
  if (!info.isFile()) throw new Error('Release entry is not a regular file.');
  if (info.size > 2 * 1024 * 1024) throw new Error('Release source file exceeds the two-megabyte limit.');
  const bytes = await fs.readFile(destination);
  if (bytes.includes(0)) throw new Error('Binary content is forbidden in public source files.');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export async function scanRelease({ rootDir = ownRoot, manifest, files, execFileFn = execute } = {}) {
  const root = resolve(rootDir);
  if ((await fs.lstat(root)).isSymbolicLink()) throw new Error('The public package root cannot be a symbolic link.');
  const findings = [], contents = new Map();
  manifest = validateManifest(manifest || JSON.parse(await safeFile(root, 'release-manifest.json')));
  const payload = files ? { names: files, source: 'explicit_file_list' } : await publicationFiles(root, execFileFn);
  const permitted = new Set([...manifest.required_files, ...manifest.optional_files]);
  for (const name of payload.unstaged || []) findings.push(problem('UNSTAGED_RELEASE_CHANGE', name, 'Stage the reviewed file so checked bytes match the public Git index.'));
  for (const name of payload.untracked || []) if (permitted.has(name)) findings.push(problem('UNTRACKED_RELEASE_FILE', name, 'Stage this allowed source file before the publication check.'));
  for (const name of manifest.required_files) if (!payload.names.includes(name)) findings.push(problem('MISSING_REQUIRED_FILE', name, 'Required public release file is absent.'));
  for (const name of payload.names) {
    if (!portableName(name) || forbiddenName(name) || !permitted.has(name)) { findings.push(problem('FILE_NOT_ALLOWED', String(name), 'This file is outside the public release allowlist.')); continue; }
    let text;
    try { text = await safeFile(root, name); }
    catch (error) { findings.push(problem('UNSAFE_FILE', name, error.message)); continue; }
    contents.set(name, text);
    findings.push(...scanText(name, text));
  }
  let version = null;
  try {
    const pkg = JSON.parse(contents.get('package.json'));
    const lock = JSON.parse(contents.get('package-lock.json'));
    version = pkg.version;
    if (pkg.name !== manifest.package_name || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error('Package name/version is invalid.');
    if (lock.version !== version || lock.packages?.['']?.version !== version || lock.name !== pkg.name) throw new Error('Package and lockfile identity/version differ.');
    const nativeVersion = /ADAPTER_VERSION\s*=\s*["']([^"']+)["']/.exec(contents.get('native/studio_bridge.py') || '')?.[1];
    const serverVersion = /name:\s*['"]insta360-studio['"]\s*,\s*version:\s*['"]([^'"]+)['"]/.exec(contents.get('src/server.mjs') || '')?.[1];
    if (nativeVersion !== version || serverVersion !== version) throw new Error('Native/server/package release versions differ.');
    if (contents.has('src/studio.mjs')) {
      const controllerVersions = [...contents.get('src/studio.mjs').matchAll(/server_version:\s*['"]([^'"]+)['"]/g)].map(match => match[1]);
      if (!controllerVersions.length || controllerVersions.some(value => value !== version)) throw new Error('Controller-reported release version differs from the package.');
    }
  } catch (error) { findings.push(problem('VERSION_ALIGNMENT', 'package.json', error.message)); }
  return { ok: findings.length === 0, version, file_count: contents.size, publication_source: payload.source,
    license_present: contents.has('LICENSE'), files: [...contents.keys()].sort(), findings };
}

export async function sdkHandshake({ rootDir = ownRoot, version, expectedToolNames, ClientType = Client, TransportType = StdioClientTransport } = {}) {
  const client = new ClientType({ name: 'insta360-release-check', version });
  const transport = new TransportType({ command: process.execPath, args: [join(resolve(rootDir), 'src', 'server.mjs')], cwd: resolve(rootDir), stderr: 'pipe' });
  // Drain diagnostics, but do not copy machine-specific stderr into a public report.
  transport.stderr?.on('data', () => {});
  try {
    await client.connect(transport, { timeout: 15000 });
    const identity = client.getServerVersion();
    if (identity?.name !== 'insta360-studio' || identity.version !== version) throw new Error('SDK handshake identity/version does not match the package.');
    const { tools } = await client.listTools({}, { timeout: 15000 });
    if (!Array.isArray(tools) || tools.length === 0) throw new Error('SDK handshake returned no tools.');
    const names = tools.map(tool => tool.name).sort();
    if (JSON.stringify(names) !== JSON.stringify([...expectedToolNames].sort()) || new Set(names).size !== names.length) throw new Error('Published SDK tool list differs from current source definitions.');
    for (const tool of tools) if (tool.inputSchema?.type !== 'object' || tool.inputSchema.additionalProperties !== false) throw new Error('Published tool schemas must be strict objects.');
    return { ok: true, server: identity, tool_count: names.length, gui_actions: 0, native_calls: 0, tool_calls: 0 };
  } finally { await client.close(); }
}

export async function checkRelease({ rootDir = ownRoot, handshake = true, scanFn = scanRelease, handshakeFn = sdkHandshake } = {}) {
  const report = await scanFn({ rootDir });
  if (!report.ok || !handshake) return { ...report, handshake: { skipped: true, reason: report.ok ? 'Static-only check requested.' : 'Publication scan failed.' } };
  try {
    const { TOOL_DEFINITIONS } = await import(pathToFileURL(join(resolve(rootDir), 'src', 'tools.mjs')).href);
    return { ...report, handshake: await handshakeFn({ rootDir, version: report.version, expectedToolNames: TOOL_DEFINITIONS.map(tool => tool.name) }) };
  } catch (error) {
    return { ...report, ok: false, findings: [...report.findings, problem('SDK_HANDSHAKE_FAILED', 'src/server.mjs', error.message)] };
  }
}

export function parseArguments(args) {
  const options = { rootDir: ownRoot, handshake: true };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--root') { if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('--root requires a public-package directory.'); options.rootDir = resolve(args[++index]); }
    else if (args[index] === '--no-handshake') options.handshake = false;
    else if (args[index] === '--help') options.help = true;
    else throw new Error(`Unknown release-check option: ${args[index]}`);
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) console.log('Usage: node scripts/release-check.mjs [--root <sanitized-public-package>] [--no-handshake]\nDefault handshake initializes MCP and lists tools only; it never calls native/UI tools. LICENSE is optional until the owner selects a license.');
    else { const report = await checkRelease(options); console.log(JSON.stringify(report, null, 2)); process.exitCode = report.ok ? 0 : 1; }
  } catch (error) { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }
}
