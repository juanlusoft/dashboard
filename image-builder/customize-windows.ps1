# HomePiNAS - Windows Image Customizer (via WSL)
# Run this in PowerShell as Administrator

param(
    [Parameter(Mandatory=$true)]
    [string]$ImagePath
)

Write-Host "=========================================" -ForegroundColor Blue
Write-Host "  HomePiNAS Image Customizer (Windows)  " -ForegroundColor Blue
Write-Host "=========================================" -ForegroundColor Blue

# Check if WSL is available
$wslCheck = wsl --list 2>$null
if (-not $wslCheck) {
    Write-Host "ERROR: WSL is not installed or not available" -ForegroundColor Red
    Write-Host "Please install WSL first: wsl --install" -ForegroundColor Yellow
    exit 1
}

# Check if image exists
if (-not (Test-Path $ImagePath)) {
    Write-Host "ERROR: Image file not found: $ImagePath" -ForegroundColor Red
    exit 1
}

# Convert Windows path to WSL path
$WslPath = wsl wslpath -a "'$ImagePath'"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WslScriptDir = wsl wslpath -a "'$ScriptDir'"

Write-Host "Image: $ImagePath" -ForegroundColor Cyan
Write-Host "WSL Path: $WslPath" -ForegroundColor Cyan

# Copy the customize script to WSL and run it
Write-Host "`nRunning customization in WSL..." -ForegroundColor Blue
wsl -u root bash "$WslScriptDir/customize-image.sh" "$WslPath"

if ($LASTEXITCODE -eq 0) {
    Write-Host "`n=========================================" -ForegroundColor Green
    Write-Host "  Customization complete!               " -ForegroundColor Green
    Write-Host "=========================================" -ForegroundColor Green
    Write-Host "`nYou can now flash the image using Raspberry Pi Imager or balenaEtcher" -ForegroundColor Yellow
} else {
    Write-Host "`nCustomization failed. Check the output above for errors." -ForegroundColor Red
}
