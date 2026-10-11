# ParallelBrowser Automated Build & Packaging Script for Windows
$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "ParallelBrowser - Windows Packaging Script" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

$RootDir = Split-Path -Parent $PSScriptRoot

# 1. Build Shared
Write-Host "`n[1/5] Building @parallelbrowser/shared..." -ForegroundColor Yellow
Set-Location "$RootDir\shared"
npm run build

# 2. Build Host
Write-Host "`n[2/5] Building ParallelBrowser Host..." -ForegroundColor Yellow
Set-Location "$RootDir\host-app"
npm run build

# 3. Build Client
Write-Host "`n[3/5] Building ParallelBrowser Client..." -ForegroundColor Yellow
Set-Location "$RootDir\client-app"
npm run build

# 4. Run Tests
Write-Host "`n[4/5] Running Automated Test Suite..." -ForegroundColor Yellow
Set-Location $RootDir
npm test

# 5. Pack / Distribute
Write-Host "`n[5/5] Packaging Host & Client Applications..." -ForegroundColor Yellow

Write-Host "Packaging Host App..." -ForegroundColor Gray
Set-Location "$RootDir\host-app"
npm run pack

Write-Host "Packaging Client App..." -ForegroundColor Gray
Set-Location "$RootDir\client-app"
npm run pack

Set-Location $RootDir
Write-Host "`n========================================" -ForegroundColor Green
Write-Host "Build & Packaging completed successfully!" -ForegroundColor Green
Write-Host "Host App unpacked binary:  $RootDir\host-app\release\win-unpacked\" -ForegroundColor Green
Write-Host "Client App unpacked binary:$RootDir\client-app\release\win-unpacked\" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
