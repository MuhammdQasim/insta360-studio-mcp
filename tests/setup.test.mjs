import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const setupPath = fileURLToPath(new URL('../setup.ps1', import.meta.url));

async function fixture(t) {
  if (process.platform !== 'win32') { t.skip('Setup is Windows-only.'); return null; }
  const rootDir = await fs.mkdtemp(join(tmpdir(), 'studio-setup-test-'));
  t.after(async () => {
    assert.equal(dirname(resolve(rootDir)), resolve(tmpdir()));
    assert(basename(rootDir).startsWith('studio-setup-test-'));
    await fs.rm(rootDir, { recursive: true, force: true });
  });
  const run = async body => {
    const scriptPath = join(rootDir, 'check.ps1');
    await fs.writeFile(scriptPath, "$ErrorActionPreference = 'Stop'\n. $env:TASK_SETUP_SCRIPT\n" + body + '\n');
    const result = await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024, env: { ...process.env, TASK_SETUP_SCRIPT: setupPath, TASK_SETUP_FIXTURE: rootDir } });
    return result.stdout.trim();
  };
  return { rootDir, run };
}

test('PowerShell setup parses and dot-sourcing performs no installation', async t => {
  const f = await fixture(t); if (!f) return;
  assert.equal(await f.run(`
    $taskTokens = $null; $taskErrors = $null
    $null = [Management.Automation.Language.Parser]::ParseFile($env:TASK_SETUP_SCRIPT, [ref]$taskTokens, [ref]$taskErrors)
    if ($taskErrors.Count) { throw 'Setup parse failed' }
    'loaded'
  `), 'loaded');
  assert.deepEqual(await fs.readdir(f.rootDir), ['check.ps1']);
});

test('Python version checks reject old, 32-bit and malformed results before installation', async t => {
  const f = await fixture(t); if (!f) return;
  const result = await f.run(`
    function fixture-python { $global:LASTEXITCODE = 0; $script:taskFakePython }
    $taskRejected = 0
    foreach ($taskPayload in @('{"major":3,"minor":9,"bits":64}', '{"major":3,"minor":12,"bits":32}', '{"major":3,"minor":"invalid","bits":64}', 'not-json')) {
      $script:taskFakePython = $taskPayload
      try { $null = Test-StudioPython -Executable fixture-python } catch { $taskRejected++ }
    }
    $script:taskFakePython = '{"major":3,"minor":12,"bits":64}'
    $taskGood = Test-StudioPython -Executable fixture-python
    @{ rejected = $taskRejected; bits = $taskGood.bits } | ConvertTo-Json -Compress
  `);
  assert.deepEqual(JSON.parse(result), { rejected: 4, bits: 64 });
});

test('Node version checks require Node 20 or newer without invoking npm', async t => {
  const f = await fixture(t); if (!f) return;
  const result = await f.run(`
    function fixture-node { $global:LASTEXITCODE = 0; $script:taskFakeNode }
    $taskRejected = 0
    foreach ($taskVersion in @('18.20.0', 'invalid')) {
      $script:taskFakeNode = $taskVersion
      try { $null = Test-StudioNode -Executable fixture-node } catch { $taskRejected++ }
    }
    $script:taskFakeNode = '20.19.0'
    @{ rejected = $taskRejected; accepted = (Test-StudioNode -Executable fixture-node) } | ConvertTo-Json -Compress
  `);
  assert.deepEqual(JSON.parse(result), { rejected: 2, accepted: '20.19.0' });
});

test('explicit Python takes priority over installed and bundled candidates', async t => {
  const f = await fixture(t); if (!f) return;
  const result = await f.run(`
    function Get-Command { param($Name, $CommandType, [switch]$All, $ErrorAction); [pscustomobject]@{ Source = 'explicit-python' } }
    function Test-StudioPython { param($Executable); if ($Executable -ne 'explicit-python') { throw 'Unexpected candidate' }; @{ bits = 64 } }
    Get-StudioPython -ExplicitPython custom-python
  `);
  assert.equal(result, 'explicit-python');
});

test('ordinary installed Python is preferred before the bundled fallback', async t => {
  const f = await fixture(t); if (!f) return;
  assert.equal(await f.run(`
    function Get-Command { param($Name, $CommandType, [switch]$All, $ErrorAction); if ($Name -eq 'python.exe') { [pscustomobject]@{ Source = 'installed-python' } } }
    function Test-StudioPython { param($Executable); if ($Executable -ne 'installed-python') { throw 'Unexpected candidate' }; @{ bits = 64 } }
    Get-StudioPython
  `), 'installed-python');
});

test('Store aliases are skipped and bundled Python is only a last fallback', async t => {
  const f = await fixture(t); if (!f) return;
  const result = await f.run(`
    $script:taskAliasCalls = 0
    function Get-Command { param($Name, $CommandType, [switch]$All, $ErrorAction); if ($Name -eq 'python.exe') { [pscustomobject]@{ Source = 'C:/Example/Microsoft/WindowsApps/python.exe' } } }
    function Test-Path { param($LiteralPath, $PathType); $true }
    function Test-StudioPython { param($Executable); if ($Executable -match 'WindowsApps') { $script:taskAliasCalls++; throw 'Alias must never execute' }; @{ bits = 64 } }
    $taskSelected = Get-StudioPython
    if ($taskSelected -notmatch 'codex-primary-runtime') { throw 'Expected final fallback' }
    if ($script:taskAliasCalls -ne 0) { throw 'Store alias was executed' }
    'fallback'
  `);
  assert.equal(result, 'fallback');
});

test('an explicitly invalid Python fails instead of silently choosing a different interpreter', async t => {
  const f = await fixture(t); if (!f) return;
  assert.equal(await f.run(`
    function Get-Command { param($Name, $CommandType, [switch]$All, $ErrorAction); [pscustomobject]@{ Source = 'explicit-python' } }
    function Test-StudioPython { param($Executable); throw 'Unsupported explicit Python' }
    try { $null = Get-StudioPython -ExplicitPython custom-python; throw 'Must reject' } catch { if ($_.Exception.Message -ne 'Unsupported explicit Python') { throw }; 'rejected' }
  `), 'rejected');
});

test('existing valid manual FFmpeg paths and original config bytes are preserved', async t => {
  const f = await fixture(t); if (!f) return;
  await Promise.all(['ffmpeg.exe', 'ffprobe.exe'].map(name => fs.writeFile(join(f.rootDir, name), 'fixture only')));
  const configPath = join(f.rootDir, 'config.local.json');
  const bytes = JSON.stringify({ ffmpeg: join(f.rootDir, 'ffmpeg.exe'), ffprobe: join(f.rootDir, 'ffprobe.exe') }, null, 4) + '\n';
  await fs.writeFile(configPath, bytes);
  assert.equal(await f.run(`
    function Get-Command { throw 'Existing settings must not rediscover PATH' }
    Initialize-StudioMediaConfig -ConfigPath (Join-Path $env:TASK_SETUP_FIXTURE 'config.local.json')
    'preserved'
  `), 'preserved');
  assert.equal(await fs.readFile(configPath, 'utf8'), bytes);
});

test('invalid existing config fails without overwriting manual settings', async t => {
  const f = await fixture(t); if (!f) return;
  const configPath = join(f.rootDir, 'config.local.json'); const bytes = '{"ffmpeg":"cmd.exe"}\n';
  await fs.writeFile(configPath, bytes);
  assert.equal(await f.run(`
    try { Initialize-StudioMediaConfig -ConfigPath (Join-Path $env:TASK_SETUP_FIXTURE 'config.local.json'); throw 'Must reject' }
    catch { if ($_.Exception.Message -eq 'Must reject') { throw }; 'rejected' }
  `), 'rejected');
  assert.equal(await fs.readFile(configPath, 'utf8'), bytes);
});

test('first-run media config discovers standard commands only when no config exists', async t => {
  const f = await fixture(t); if (!f) return;
  await Promise.all(['ffmpeg.exe', 'ffprobe.exe'].map(name => fs.writeFile(join(f.rootDir, name), 'fixture only')));
  assert.equal(await f.run(`
    function Get-Command { param($Name, $CommandType, $ErrorAction); [pscustomobject]@{ Source = (Join-Path $env:TASK_SETUP_FIXTURE $Name) } }
    Initialize-StudioMediaConfig -ConfigPath (Join-Path $env:TASK_SETUP_FIXTURE 'config.local.json')
    'created'
  `), 'created');
  const config = JSON.parse(await fs.readFile(join(f.rootDir, 'config.local.json'), 'utf8'));
  assert.equal(config.ffmpeg, join(f.rootDir, 'ffmpeg.exe'));
  assert.equal(config.ffprobe, join(f.rootDir, 'ffprobe.exe'));
});

test('check-only validates prerequisites without npm, pip, venv creation or config writes', async t => {
  const f = await fixture(t); if (!f) return;
  const result = await f.run(`
    function Get-Command { param($Name, $CommandType, $ErrorAction); [pscustomobject]@{ Source = 'fixture-node' } }
    function Test-StudioNode { param($Executable); '20.19.0' }
    function Get-StudioPython { param($ExplicitPython); 'fixture-python' }
    function Initialize-StudioMediaConfig { throw 'Must not write' }
    function npm.cmd { throw 'Must not install' }
    Invoke-StudioSetup -TaskRoot $env:TASK_SETUP_FIXTURE -OnlyCheck | ConvertTo-Json -Compress
  `);
  assert.equal(JSON.parse(result).checked, true);
  assert.deepEqual(await fs.readdir(f.rootDir), ['check.ps1']);
});
