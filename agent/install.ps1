# HomePiNAS Backup Agent - Silent Installer
# Instala Node.js portable + agente + registra como servicio Windows
# SIN interacción del usuario - todo controlado desde el dashboard del NAS

param(
    [string]$NASAddress = "",
    [int]$NASPort = 443,
    [switch]$NoRestart
)

$ErrorActionPreference = "Stop"

# ── Configuration ────────────────────────────────────────────────────────────

$INSTALL_DIR = "$env:PROGRAMFILES\HomePiNAS"
$DATA_DIR = "$env:PROGRAMDATA\HomePiNAS"
$NODE_VERSION = "20.11.0"
$NODE_ARCH = "x64"
$NSSM_URL = "https://nssm.cc/release/nssm-2.24.zip"
$NODE_URL = "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-win-$NODE_ARCH.zip"

# ── Helper Functions ────────────────────────────────────────────────────────

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$timestamp] [$Level] $Message"
    Write-Host $line
    if ($logFile) {
        Add-Content -Path $logFile -Value $line
    }
}

function Test-Administrator {
    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($currentUser)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Download-File {
    param([string]$Url, [string]$Destination)
    
    Write-Log "Downloading: $Url"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    
    try {
        Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
        Write-Log "Downloaded: $Destination"
    }
    catch {
        Write-Log "Download failed: $_" -Level "ERROR"
        throw
    }
}

function Extract-Zip {
    param([string]$ZipPath, [string]$Destination)
    
    Write-Log "Extracting: $ZipPath -> $Destination"
    
    if (-not (Test-Path $Destination)) {
        New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    }
    
    Expand-Archive -Path $ZipPath -DestinationPath $Destination -Force
    
    Write-Log "Extraction completed"
}

function Install-Service {
    param(
        [string]$ServiceName,
        [string]$DisplayName,
        [string]$BinaryPath,
        [string]$Arguments = "",
        [string]$WorkingDirectory = "",
        [string]$StartType = "Automatic"
    )
    
    Write-Log "Installing Windows service: $DisplayName"
    
    # Check if service already exists
    $existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($existingService) {
        Write-Log "Service already exists - removing first"
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
        sc.exe delete $ServiceName
        Start-Sleep -Seconds 2
    }
    
    # Use nssm to install the service
    $nssmPath = "$INSTALL_DIR\nssm\nssm.exe"
    
    if (-not (Test-Path $nssmPath)) {
        throw "nssm.exe not found at $nssmPath"
    }
    
    $installArgs = @("install", $ServiceName, "node.exe")
    if ($Arguments) {
        $installArgs += $Arguments
    }
    
    Write-Log "Running: $nssmPath $($installArgs -join ' ')"
    
    $process = Start-Process -FilePath $nssmPath -ArgumentList $installArgs -NoNewWindow -Wait -PassThru
    
    if ($process.ExitCode -ne 0) {
        throw "Failed to install service with nssm (exit code $($process.ExitCode))"
    }
    
    # Configure service
    if ($WorkingDirectory) {
        & $nssmPath set $ServiceName AppDirectory $WorkingDirectory
    }
    
    & $nssmPath set $ServiceName AppStdout "$DATA_DIR\service.log"
    & $nssmPath set $ServiceName AppStderr "$DATA_DIR\service-error.log"
    & $nssmPath set $ServiceName AppRotateFiles 1
    & $nssmPath set $ServiceName AppRotateBytes 10485760  # 10MB
    
    # Set startup type
    if ($StartType -eq "Automatic") {
        sc.exe config $ServiceName start= auto
    } elseif ($StartType -eq "Delayed") {
        sc.exe config $ServiceName start= delayed-auto
    }
    
    Write-Log "Service installed successfully"
}

# ── Main Installation ───────────────────────────────────────────────────────

try {
    $logFile = "$env:TEMP\homepinas-install.log"
    
    Write-Log "═══════════════════════════════════════════════════════════"
    Write-Log "HomePiNAS Backup Agent Installer"
    Write-Log "═══════════════════════════════════════════════════════════"
    
    # Check admin privileges
    if (-not (Test-Administrator)) {
        Write-Log "ERROR: Administrator privileges required" -Level "ERROR"
        Write-Log "Please run this script as Administrator" -Level "ERROR"
        exit 1
    }
    
    Write-Log "Administrator privileges confirmed"
    
    # Create directories
    Write-Log "Creating directories..."
    if (-not (Test-Path $INSTALL_DIR)) {
        New-Item -ItemType Directory -Path $INSTALL_DIR -Force | Out-Null
    }
    if (-not (Test-Path $DATA_DIR)) {
        New-Item -ItemType Directory -Path $DATA_DIR -Force | Out-Null
    }
    
    # Install Node.js portable
    Write-Log "Installing Node.js $NODE_VERSION..."
    $nodeZip = "$env:TEMP\node.zip"
    $nodeTemp = "$env:TEMP\node-temp"
    
    if (-not (Test-Path "$INSTALL_DIR\node\node.exe")) {
        Download-File -Url $NODE_URL -Destination $nodeZip
        Extract-Zip -ZipPath $nodeZip -Destination $nodeTemp
        
        # Move node files to install directory
        $nodeSource = Get-ChildItem -Path $nodeTemp -Directory | Select-Object -First 1
        if ($nodeSource) {
            Move-Item -Path "$($nodeSource.FullName)\*" -Destination $INSTALL_DIR -Force
        }
        
        # Cleanup
        Remove-Item -Path $nodeZip -Force -ErrorAction SilentlyContinue
        Remove-Item -Path $nodeTemp -Recurse -Force -ErrorAction SilentlyContinue
        
        Write-Log "Node.js installed to $INSTALL_DIR"
    } else {
        Write-Log "Node.js already installed"
    }
    
    # Verify Node.js
    $nodeExe = "$INSTALL_DIR\node.exe"
    if (-not (Test-Path $nodeExe)) {
        throw "Node.js installation failed - node.exe not found"
    }
    
    $nodeVersion = & $nodeExe --version
    Write-Log "Node.js version: $nodeVersion"
    
    # Install nssm
    Write-Log "Installing nssm (Windows Service Wrapper)..."
    $nssmZip = "$env:TEMP\nssm.zip"
    $nssmTemp = "$env:TEMP\nssm-temp"
    
    if (-not (Test-Path "$INSTALL_DIR\nssm\nssm.exe")) {
        Download-File -Url $NSSM_URL -Destination $nssmZip
        Extract-Zip -ZipPath $nssmZip -Destination $nssmTemp
        
        # Find nssm.exe (it's in a subdirectory like nssm-2.24/win64/nssm.exe)
        $nssmExe = Get-ChildItem -Path $nssmTemp -Filter "nssm.exe" -Recurse | 
                   Where-Object { $_.FullName -like "*win64*" } | 
                   Select-Object -First 1
        
        if (-not $nssmExe) {
            $nssmExe = Get-ChildItem -Path $nssmTemp -Filter "nssm.exe" -Recurse | Select-Object -First 1
        }
        
        if ($nssmExe) {
            New-Item -ItemType Directory -Path "$INSTALL_DIR\nssm" -Force | Out-Null
            Copy-Item -Path $nssmExe.FullName -Destination "$INSTALL_DIR\nssm\nssm.exe" -Force
            
            Write-Log "nssm installed to $INSTALL_DIR\nssm"
        }
        
        # Cleanup
        Remove-Item -Path $nssmZip -Force -ErrorAction SilentlyContinue
        Remove-Item -Path $nssmTemp -Recurse -Force -ErrorAction SilentlyContinue
    } else {
        Write-Log "nssm already installed"
    }
    
    # Copy agent files
    Write-Log "Copying agent files..."
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    
    # Copy all agent files except install.ps1
    Get-ChildItem -Path $scriptDir -Exclude "install.ps1" | ForEach-Object {
        Copy-Item -Path $_.FullName -Destination $INSTALL_DIR -Recurse -Force
        Write-Log "  Copied: $($_.Name)"
    }
    
    # Create initial config if NAS address provided
    if ($NASAddress) {
        Write-Log "Creating initial config for NAS: $NASAddress"
        $config = @{
            nasAddress = $NASAddress
            nasPort = $NASPort
            status = "disconnected"
            autoStart = $true
        }
        $config | ConvertTo-Json | Out-File -FilePath "$DATA_DIR\config.json" -Encoding utf8
    } else {
        Write-Log "No NAS address provided - agent will auto-discover on first run"
    }
    
    # Install Windows service
    Write-Log "Installing HomePiNAS Backup Agent as Windows service..."
    
    $serviceArgs = "`"$INSTALL_DIR\agent-service.js`""
    
    Install-Service `
        -ServiceName "HomePiNASBackup" `
        -DisplayName "HomePiNAS Backup Agent" `
        -BinaryPath $nodeExe `
        -Arguments $serviceArgs `
        -WorkingDirectory $INSTALL_DIR `
        -StartType "Automatic"
    
    # Start the service
    Write-Log "Starting service..."
    Start-Service -Name "HomePiNASBackup"
    
    # Verify service is running
    $service = Get-Service -Name "HomePiNASBackup"
    if ($service.Status -eq "Running") {
        Write-Log "✓ Service started successfully"
    } else {
        Write-Log "Service status: $($service.Status)" -Level "WARN"
    }
    
    # Add to PATH for convenience
    Write-Log "Adding Node.js to system PATH..."
    $currentPath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    if ($currentPath -notlike "*$INSTALL_DIR*") {
        $newPath = "$currentPath;$INSTALL_DIR"
        [Environment]::SetEnvironmentVariable("Path", $newPath, "Machine")
    }
    
    # Create uninstaller
    Write-Log "Creating uninstaller..."
    $uninstaller = @"
@echo off
echo Uninstalling HomePiNAS Backup Agent...
net stop HomePiNASBackup
sc delete HomePiNASBackup
rmdir /s /q "$INSTALL_DIR"
rmdir /s /q "$DATA_DIR"
echo Uninstallation complete.
pause
"@
    $uninstaller | Out-File -FilePath "$INSTALL_DIR\uninstall.bat" -Encoding ascii
    
    Write-Log "═══════════════════════════════════════════════════════════"
    Write-Log "Installation completed successfully!"
    Write-Log "Service: HomePiNAS Backup Agent"
    Write-Log "Install dir: $INSTALL_DIR"
    Write-Log "Data dir: $DATA_DIR"
    Write-Log "═══════════════════════════════════════════════════════════"
    
    if (-not $NoRestart) {
        Write-Log "Agent will auto-discover NAS on first run"
        Write-Log "Or configure via NAS dashboard"
    }
    
    exit 0
}
catch {
    Write-Log "Installation failed: $_" -Level "ERROR"
    Write-Log $_.ScriptStackTrace -Level "ERROR"
    
    # Try to cleanup
    try {
        Stop-Service -Name "HomePiNASBackup" -Force -ErrorAction SilentlyContinue
        sc.exe delete HomePiNASBackup -ErrorAction SilentlyContinue
    } catch {}
    
    exit 1
}
