# Recreate only the appliance when Docker keeps HostConfig but loses its published port.
# Existing data/configuration are preserved; credentials are never printed.
$ErrorActionPreference = 'Stop'
$fxProjectRoot = Split-Path $PSScriptRoot -Parent
$fxInspectText = docker inspect factorix-appliance
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the existing appliance.' }
$fxOriginal = @($fxInspectText | ConvertFrom-Json)[0]
if ($fxOriginal.HostConfig.NetworkMode -ne 'bridge') { throw 'Unexpected appliance network mode; no changes made.' }
$fxMounts = @($fxOriginal.Mounts)
if ($fxMounts.Count -ne 1 -or $fxMounts[0].Type -ne 'volume' -or $fxMounts[0].Name -ne 'factorix-data' -or $fxMounts[0].Destination -ne '/data') {
    throw 'Unexpected appliance data mounts; no changes made.'
}
$fxSourcePaths = @('apps/center/src', 'apps/center/migrations', 'apps/edge/src', 'apps/web/dist')
foreach ($fxSourcePath in $fxSourcePaths) {
    if (-not (Test-Path -LiteralPath (Join-Path $fxProjectRoot $fxSourcePath))) { throw "Missing build input: $fxSourcePath" }
}
if (-not (Test-Path -LiteralPath (Join-Path $fxProjectRoot 'apps/web/dist/index.html'))) { throw 'Build the frontend first.' }
$fxTaskRoot = Join-Path $fxProjectRoot 'tests/artifacts/port-repair'
New-Item -ItemType Directory -Path $fxTaskRoot -Force | Out-Null
$fxUnique = [Guid]::NewGuid().ToString('N').Substring(0, 10)
$fxEnvPath = Join-Path $fxTaskRoot "$fxUnique.env"
$fxNewName = "factorix-portfix-$fxUnique"
$fxBackupName = "factorix-appliance-before-portfix-$fxUnique"
$fxOldRenamed = $false
$fxNewRenamed = $false
$fxOldStopped = $false
try {
    $fxEnvironment = @($fxOriginal.Config.Env)
    if (@($fxEnvironment | Where-Object { $_ -match "[\r\n]" }).Count) { throw 'Multiline environment cannot be copied safely.' }
    $fxEnvironment | Set-Content -LiteralPath $fxEnvPath -Encoding utf8NoBOM
    $fxRestartPolicy = [string]$fxOriginal.HostConfig.RestartPolicy.Name
    if (-not $fxRestartPolicy) { $fxRestartPolicy = 'no' }
    if ($fxRestartPolicy -eq 'on-failure' -and $fxOriginal.HostConfig.RestartPolicy.MaximumRetryCount -gt 0) {
        $fxRestartPolicy = "on-failure:$($fxOriginal.HostConfig.RestartPolicy.MaximumRetryCount)"
    }
    docker create --name $fxNewName --env-file $fxEnvPath --publish '0.0.0.0:8080:8080' --network bridge --restart $fxRestartPolicy --mount 'type=volume,source=factorix-data,target=/data' $fxOriginal.Image | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the replacement appliance.' }
    foreach ($fxSourcePath in $fxSourcePaths) {
        docker cp "$fxProjectRoot/$fxSourcePath/." "${fxNewName}:/opt/factorix/$fxSourcePath"
        if ($LASTEXITCODE -ne 0) { throw "Could not copy $fxSourcePath" }
    }
    # Preserve the original migration scripts before extending its revision graph.
    # A fallback must recognize a schema revision committed by the replacement;
    # restoring the older app must never require downgrading the live database.
    $fxMigrationBackup = "/data/backups/pre-portfix-migrations-$fxUnique.tgz"
    docker exec factorix-appliance mkdir -p /data/backups
    if ($LASTEXITCODE -ne 0) { throw 'Could not prepare the migration backup.' }
    docker exec factorix-appliance tar -czf $fxMigrationBackup -C /opt/factorix/apps/center migrations
    if ($LASTEXITCODE -ne 0) { throw 'Could not preserve the original migration scripts.' }
    docker exec factorix-appliance chmod 600 $fxMigrationBackup
    if ($LASTEXITCODE -ne 0) { throw 'Could not restrict the migration backup.' }
    docker cp "$fxProjectRoot/apps/center/migrations/." 'factorix-appliance:/opt/factorix/apps/center/migrations'
    if ($LASTEXITCODE -ne 0) { throw 'Could not extend the fallback migration graph; cutover was not started.' }
    docker stop --time 60 factorix-appliance | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not stop the original appliance safely.' }
    $fxOldStopped = $true
    docker rename factorix-appliance $fxBackupName
    if ($LASTEXITCODE -ne 0) { throw 'Could not preserve the original container.' }
    $fxOldRenamed = $true
    docker rename $fxNewName factorix-appliance
    if ($LASTEXITCODE -ne 0) { throw 'Could not assign the appliance name.' }
    $fxNewRenamed = $true
    docker start factorix-appliance | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not start the replacement appliance.' }
    $fxHealthy = $false
    # Starting Postgres/bootstrap/migrations on the existing volume can exceed
    # twenty seconds. A short host-health grace used to kill a healthy startup.
    for ($fxAttempt = 0; $fxAttempt -lt 120; $fxAttempt++) {
        try {
            $fxHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/health/live' -TimeoutSec 2
            if ($fxHealth.status -eq 'live') { $fxHealthy = $true; break }
        } catch { }
        if ($fxAttempt % 10 -eq 0) {
            $fxRunning = docker inspect factorix-appliance --format '{{.State.Running}}'
            if ($LASTEXITCODE -ne 0 -or ([string]$fxRunning).Trim() -ne 'true') { throw 'Replacement exited during startup; inspect its logs.' }
            Write-Output "Waiting for appliance startup and host port 8080 (check $($fxAttempt + 1)/120)."
        }
        Start-Sleep -Seconds 1
    }
    if (-not $fxHealthy) { throw 'Replacement did not become accessible from Windows.' }
    Write-Output "Appliance accessible on 127.0.0.1:8080; original container preserved as $fxBackupName."
} catch {
    if ($fxNewRenamed) {
        docker stop --time 60 factorix-appliance 2>$null | Out-Null
        docker rename factorix-appliance "factorix-portfix-failed-$fxUnique" 2>$null
    }
    if ($fxOldRenamed) { docker rename $fxBackupName factorix-appliance 2>$null }
    if ($fxOldStopped) { docker start factorix-appliance 2>$null | Out-Null }
    throw
} finally {
    if (Test-Path -LiteralPath $fxEnvPath) { Remove-Item -LiteralPath $fxEnvPath -Force }
}
