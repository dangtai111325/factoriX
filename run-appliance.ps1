# Build and run the single FactoriX Docker appliance on http://127.0.0.1:8080
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Test-Path .env)) {
  Write-Error "Missing .env next to this script. Copy your appliance env file first."
}

Write-Host "Building factorix image..."
docker build -t factorix .

Write-Host "Replacing container factorix-appliance..."
docker rm -f factorix-appliance 2>$null | Out-Null
docker run -d --name factorix-appliance --env-file .env -p 8080:8080 -v factorix-data:/data factorix

# Docker Desktop sometimes leaves the container in "created"; force start.
Start-Sleep -Seconds 2
docker start factorix-appliance | Out-Null

Write-Host "Waiting for health..."
for ($i = 0; $i -lt 60; $i++) {
  try {
    $live = Invoke-RestMethod -Uri http://127.0.0.1:8080/health/live -TimeoutSec 2
    if ($live.status -eq 'live') {
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
