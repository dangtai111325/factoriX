# Copy only test inputs and source to the existing appliance's temporary test tree.
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$testRoot = 'factorix-appliance:/tmp/factorix-review2'
docker exec factorix-appliance mkdir -p /tmp/factorix-review2/test_support /tmp/factorix-review2/apps/center /tmp/factorix-review2/apps/edge /tmp/factorix-review2/tests/unit /tmp/factorix-review2/scripts /tmp/factorix-review2/infrastructure/postgres
if ($LASTEXITCODE -ne 0) { throw 'Could not prepare test directory.' }
foreach ($taskPath in @('apps/center', 'apps/edge', 'tests/unit', 'test_support', 'scripts', 'infrastructure/postgres')) {
    docker cp "$projectRoot/$taskPath/." "$testRoot/$taskPath"
    if ($LASTEXITCODE -ne 0) { throw "Could not copy $taskPath" }
}
foreach ($taskFile in @('conftest.py', 'pytest.ini')) {
    docker cp "$projectRoot/$taskFile" "$testRoot/$taskFile"
    if ($LASTEXITCODE -ne 0) { throw "Could not copy $taskFile" }
}
