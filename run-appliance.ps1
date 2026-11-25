# Build and run the single FactoriX Docker appliance on http://127.0.0.1:8080
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Test-Path .env)) {
  Write-Error "Missing .env next to this script. Copy your appliance env file first."
}

Write-Host "Deploying FactoriX stack via Docker Compose..."
docker compose up -d --build

Write-Host "Waiting for health..."
for ($i = 0; $i -lt 60; $i++) {
  try {
    $live = Invoke-RestMethod -Uri http://127.0.0.1:8080/health/live -TimeoutSec 2
    if ($live.status -eq 'live') {
      try {
        $ready = Invoke-RestMethod -Uri http://127.0.0.1:8080/health/ready -TimeoutSec 2
      } catch {
        $ready = $null
      }
      $auth = Invoke-RestMethod -Uri http://127.0.0.1:8080/api/v1/auth/status -TimeoutSec 2
      Write-Host "Ready at http://127.0.0.1:8080"
      Write-Host ($auth | ConvertTo-Json -Compress)
      exit 0
    }
  } catch {
    Start-Sleep -Seconds 2
  }
}

Write-Error "Appliance did not become healthy on port 8080."
