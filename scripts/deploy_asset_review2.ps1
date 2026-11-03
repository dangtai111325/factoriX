# Deploy the tested asset checkpoint into the existing 8080 appliance.
# No volume recreation, credential output, database reset, commit or push.
$ErrorActionPreference = 'Stop'
$fxProjectRoot = Split-Path $PSScriptRoot -Parent
$fxInspectText = docker inspect factorix-appliance
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the existing appliance.' }
$fxAppliance = @($fxInspectText | ConvertFrom-Json)[0]
$fxMounts = @($fxAppliance.Mounts)
if ($fxMounts.Count -ne 1 -or $fxMounts[0].Type -ne 'volume' -or $fxMounts[0].Name -ne 'factorix-data' -or $fxMounts[0].Destination -ne '/data') {
    throw 'Unexpected data mounts; deployment was not started.'
}
if (-not $fxAppliance.State.Running) { throw 'The appliance must be running before its backup is taken.' }
$fxInputs = @('apps/center/src', 'apps/center/migrations', 'apps/edge/src', 'apps/web/dist')
foreach ($fxInput in $fxInputs) {
    if (-not (Test-Path -LiteralPath (Join-Path $fxProjectRoot $fxInput))) { throw "Missing build input: $fxInput" }
}
$fxLocalHtml = Get-Content -Raw -LiteralPath (Join-Path $fxProjectRoot 'apps/web/dist/index.html')
if ($fxLocalHtml -notmatch 'src="([^"]+\.js)"') { throw 'The frontend production bundle is missing.' }
$fxExpectedBundle = $Matches[1]
$fxStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$fxDatabaseBackup = "/data/backups/pre-asset-review2-$fxStamp.dump"
$fxCodeBackup = "/data/backups/pre-asset-review2-code-$fxStamp.tgz"
docker exec factorix-appliance mkdir -p /data/backups
if ($LASTEXITCODE -ne 0) { throw 'Could not prepare the backup directory.' }
docker exec -u postgres factorix-appliance /usr/lib/postgresql/17/bin/pg_dump --format=custom --dbname=factorix --file=$fxDatabaseBackup
if ($LASTEXITCODE -ne 0) { throw 'Database backup failed; deployment was not started.' }
docker exec factorix-appliance tar -czf $fxCodeBackup -C /opt/factorix apps/center/src apps/center/migrations apps/edge/src apps/web/dist
if ($LASTEXITCODE -ne 0) { throw 'Code backup failed; deployment was not started.' }
docker exec factorix-appliance chmod 600 $fxDatabaseBackup $fxCodeBackup
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict backup permissions; deployment was not started.' }
Write-Output "Backups saved: $fxDatabaseBackup and $fxCodeBackup"
# This Windows Docker host reproducibly drops actual port publishing on restart,
# despite retaining HostConfig.PortBindings. Recreate the appliance using its
# exact image/environment/volume and keep the stopped original for recovery.
& (Join-Path $PSScriptRoot 'repair_appliance_port.ps1')
$fxPage = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:8080/' -TimeoutSec 10
if ($fxPage.StatusCode -ne 200 -or $fxPage.Content -notmatch 'src="([^"]+\.js)"' -or $Matches[1] -ne $fxExpectedBundle) {
    throw 'The served frontend bundle does not match the tested build.'
}
$fxRevision = docker exec -u postgres factorix-appliance /usr/lib/postgresql/17/bin/psql -d factorix -tAc 'SELECT version_num FROM alembic_version'
if ($LASTEXITCODE -ne 0 -or ([string]$fxRevision).Trim() -ne '0009_mqtt_topic_capture') { throw 'The asset/capture migration has not reached its expected revision.' }
Write-Output "Verified localhost:8080, schema 0009_mqtt_topic_capture, bundle $fxExpectedBundle."
