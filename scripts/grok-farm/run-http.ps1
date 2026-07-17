# run-http.ps1 — HTTP farm entry (Windows) — prefers in-tree .venv
param([Parameter(ValueFromRemainingArguments = $true)]$FarmArgs)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

if (-not (Test-Path ".env")) {
  if (Test-Path ".env.example") {
    Copy-Item ".env.example" ".env"
    Write-Host "Created .env from .env.example — set GROK_TEMPMAIL_API_KEY and BOTERDROP_URL"
  } else {
    Write-Host "Missing .env"
    exit 1
  }
}

function Test-PythonHasCurlCffi([string]$exe, [string[]]$prefixArgs) {
  try {
    $all = @()
    if ($prefixArgs) { $all += $prefixArgs }
    $all += @("-c", "import curl_cffi")
    & $exe @all 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
  } catch {
    return $false
  }
}

$pyExe = $null
$pyPrefix = @()

if ((Test-Path ".venv\Scripts\python.exe") -and (Test-PythonHasCurlCffi ".venv\Scripts\python.exe" @())) {
  $pyExe = (Resolve-Path ".venv\Scripts\python.exe").Path
} elseif (Test-PythonHasCurlCffi "py" @("-3")) {
  $pyExe = "py"
  $pyPrefix = @("-3")
} elseif (Test-PythonHasCurlCffi "python" @()) {
  $pyExe = "python"
} else {
  Write-Host "No Python with curl_cffi found."
  Write-Host "  Re-run repo install.ps1, or:"
  Write-Host "  py -3 -m venv .venv; .\.venv\Scripts\pip install -r requirements.txt"
  exit 1
}

& $pyExe @pyPrefix "$Root\http_farm.py" @FarmArgs
exit $LASTEXITCODE
