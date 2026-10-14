param([string]$PythonExe, [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'

function Test-StudioPython {
    param([Parameter(Mandatory)][string]$Executable)
    $taskOutput = & $Executable -c 'import json,struct,sys; print(json.dumps({"major":sys.version_info.major,"minor":sys.version_info.minor,"bits":struct.calcsize("P")*8}))'
    if ($LASTEXITCODE -ne 0) { throw 'Python did not run successfully.' }
    try { $taskInfo = ($taskOutput -join "`n") | ConvertFrom-Json } catch { throw 'Python did not return valid version information.' }
    $taskMajor = 0; $taskMinor = 0; $taskBits = 0
    if (-not [int]::TryParse([string]$taskInfo.major, [ref]$taskMajor) -or -not [int]::TryParse([string]$taskInfo.minor, [ref]$taskMinor) -or
        -not [int]::TryParse([string]$taskInfo.bits, [ref]$taskBits) -or $taskMajor -lt 3 -or ($taskMajor -eq 3 -and $taskMinor -lt 10) -or $taskBits -ne 64) {
        throw 'Use 64-bit Python 3.10 or newer.'
    }
    return $taskInfo
}

function Get-StudioPython {
    param([string]$ExplicitPython)
    if ($ExplicitPython) {
        $taskExplicit = (Get-Command $ExplicitPython -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
        $null = Test-StudioPython -Executable $taskExplicit
        return $taskExplicit
    }
    $taskCandidates = @()
    foreach ($taskName in @('python.exe', 'python3.exe')) {
        $taskCandidates += @(Get-Command $taskName -CommandType Application -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
    }
    $taskLauncher = Get-Command py.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($taskLauncher) {
        try {
            $taskLaunched = & $taskLauncher.Source -3 -c 'import sys; print(sys.executable)'
            if ($LASTEXITCODE -eq 0 -and $taskLaunched) { $taskCandidates += ($taskLaunched -join '').Trim() }
        } catch { }
    }
    # Store aliases are not installed interpreters and may open another application.
    foreach ($taskCandidate in ($taskCandidates | Select-Object -Unique)) {
        if ($taskCandidate -match '[\\/]Microsoft[\\/]WindowsApps[\\/]') { continue }
        try { $null = Test-StudioPython -Executable $taskCandidate; return $taskCandidate } catch { }
    }
    # Optional last fallback; ordinary installations do not need Codex.
    $taskBundledPython = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
    if (Test-Path -LiteralPath $taskBundledPython -PathType Leaf) {
        try { $null = Test-StudioPython -Executable $taskBundledPython; return $taskBundledPython } catch { }
    }
    throw 'No supported Python installation was found. Install 64-bit Python 3.10+ or pass -PythonExe.'
}

function Test-StudioNode {
    param([Parameter(Mandatory)][string]$Executable)
    $taskVersion = & $Executable -p 'process.versions.node'
    if ($LASTEXITCODE -ne 0 -or ($taskVersion -join '') -notmatch '^([0-9]+)\.') { throw 'Node.js did not return valid version information.' }
    if ([int]$Matches[1] -lt 20) { throw 'Use Node.js 20 or newer.' }
    return ($taskVersion -join '').Trim()
}

function Read-StudioMediaConfig {
    param([Parameter(Mandatory)][string]$ConfigPath)
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { return $null }
    try { $taskConfig = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json } catch { throw 'Existing config.local.json is invalid JSON. Repair it; setup will not overwrite it.' }
    if ($null -eq $taskConfig -or $taskConfig -is [array] -or $taskConfig -isnot [pscustomobject]) { throw 'config.local.json must contain a JSON object.' }
    foreach ($taskProperty in $taskConfig.PSObject.Properties) {
        if ($taskProperty.Name -notin @('ffmpeg', 'ffprobe')) { throw 'config.local.json contains an unknown setting.' }
        $taskValue = $taskProperty.Value
        if ($taskValue -isnot [string] -or $taskValue -notmatch '^[A-Za-z]:[\\/]' -or $taskValue -match '[\x00-\x1f\x7f"<>|?*]' -or $taskValue.Substring(2).Contains(':') -or
            [IO.Path]::GetFileName($taskValue) -ine ($taskProperty.Name + '.exe') -or -not (Test-Path -LiteralPath $taskValue -PathType Leaf)) {
            throw "Existing $($taskProperty.Name) path must identify its absolute local .exe file. Repair it; setup will not replace manual settings."
        }
    }
    return $taskConfig
}

function Initialize-StudioMediaConfig {
    param([Parameter(Mandatory)][string]$ConfigPath)
    if (Test-Path -LiteralPath $ConfigPath) { $null = Read-StudioMediaConfig -ConfigPath $ConfigPath; return }
    $taskMediaConfig = @{}
    foreach ($taskProgram in @('ffprobe', 'ffmpeg')) {
        $taskCommand = Get-Command ($taskProgram + '.exe') -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($taskCommand) { $taskMediaConfig[$taskProgram] = $taskCommand.Source }
    }
    [IO.File]::WriteAllText($ConfigPath, ($taskMediaConfig | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    $null = Read-StudioMediaConfig -ConfigPath $ConfigPath
}

function Invoke-StudioSetup {
    param([string]$ExplicitPython, [string]$TaskRoot = $PSScriptRoot, [switch]$OnlyCheck)
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This server requires Windows.' }
    $taskNode = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $taskNodeVersion = Test-StudioNode -Executable $taskNode
    $taskPython = Get-StudioPython -ExplicitPython $ExplicitPython
    $taskConfigPath = Join-Path $TaskRoot 'config.local.json'
    $null = Read-StudioMediaConfig -ConfigPath $taskConfigPath
    $taskVenvPython = Join-Path $TaskRoot '.venv\Scripts\python.exe'
    if (Test-Path -LiteralPath $taskVenvPython -PathType Leaf) { $null = Test-StudioPython -Executable $taskVenvPython }
    if ($OnlyCheck) { return [pscustomobject]@{ checked = $true; node_version = $taskNodeVersion; python = $taskPython; config_preserved = (Test-Path -LiteralPath $taskConfigPath) } }
    Push-Location -LiteralPath $TaskRoot
    try {
        if (-not (Test-Path -LiteralPath $taskVenvPython -PathType Leaf)) {
            & $taskPython -m venv (Join-Path $TaskRoot '.venv')
            if ($LASTEXITCODE -ne 0) { throw 'Python virtual environment creation failed.' }
        }
        $null = Test-StudioPython -Executable $taskVenvPython
        & $taskVenvPython -m pip install -r (Join-Path $TaskRoot 'requirements.txt')
        if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed.' }
        & npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw 'Node dependency installation failed.' }
        Initialize-StudioMediaConfig -ConfigPath $taskConfigPath
        & npm.cmd run check
        if ($LASTEXITCODE -ne 0) { throw 'JavaScript syntax check failed.' }
        & npm.cmd test
        if ($LASTEXITCODE -ne 0) { throw 'MCP/controller tests failed.' }
        & npm.cmd run test:native
        if ($LASTEXITCODE -ne 0) { throw 'Native guard tests failed.' }
        Write-Host 'Dependencies and tests are ready. Use scripts/release-check.mjs for a GUI-free public-package check.'
    } finally { Pop-Location }
}

# Dot-sourcing exposes testable helpers without installation, network access or desktop operations.
if ($MyInvocation.InvocationName -ne '.') { Invoke-StudioSetup -ExplicitPython $PythonExe -OnlyCheck:$CheckOnly }
