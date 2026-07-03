# Ensures a Redis-compatible server is listening on localhost:6379.
# Order of preference:
#   1. Memurai Windows service (Redis 7.x compat, recommended)
#   2. Bundled portable Redis 5.0.14 in .redis/ (legacy fallback, BullMQ will warn)
# Usage:  pwsh ./scripts/start-redis.ps1   (or via npm prestart hooks)

$ErrorActionPreference = 'Stop'

function Test-RedisPort {
    return (Test-NetConnection -ComputerName localhost -Port 6379 -WarningAction SilentlyContinue).TcpTestSucceeded
}

if (Test-RedisPort) {
    Write-Host "Redis already listening on localhost:6379" -ForegroundColor Green
    exit 0
}

# 1. Try Memurai service.
$memurai = Get-Service -Name 'Memurai' -ErrorAction SilentlyContinue
if ($memurai) {
    if ($memurai.Status -ne 'Running') {
        Start-Service -Name 'Memurai'
        Start-Sleep -Seconds 1
    }
    if (Test-RedisPort) {
        Write-Host "Memurai service running on localhost:6379" -ForegroundColor Green
        exit 0
    }
    Write-Warning "Memurai service present but port 6379 not responding; falling back to portable Redis."
}

# 2. Fall back to bundled portable Redis (Redis 5.0.14, BullMQ will warn).
$root = Split-Path -Parent $PSScriptRoot
$redisDir = Join-Path $root '.redis'
$exe  = Join-Path $redisDir 'redis-server.exe'
$conf = Join-Path $redisDir 'redis.windows.conf'

if (-not (Test-Path $exe)) {
    Write-Error @"
No Redis available.
Install Memurai Developer: https://www.memurai.com/get-memurai
Or restore portable Redis at $exe.
"@
    exit 1
}

Start-Process -FilePath $exe -ArgumentList $conf -WindowStyle Hidden
Start-Sleep -Seconds 1
Write-Warning "Started portable Redis 5.0.14 (BullMQ recommends >=6.2 - install Memurai to silence warning)."
Write-Host "Redis started on localhost:6379" -ForegroundColor Green
