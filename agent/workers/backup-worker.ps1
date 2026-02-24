# HomePiNAS Backup Worker - PowerShell
# Se ejecuta como proceso separado del agente Node.js
# Escribe estado a archivo JSON para que el agente lo monitoree

param(
    [Parameter(Mandatory=$true)]
    [string]$ConfigJson
)

$ErrorActionPreference = "Stop"

# Parse config
$config = $ConfigJson | ConvertFrom-Json

# Paths
$CONFIG_DIR = "$env:PROGRAMDATA\HomePiNAS"
$STATUS_FILE = $config.statusFile
$LOG_FILE = "$CONFIG_DIR\backup-worker.log"

# Ensure config dir exists
if (-not (Test-Path $CONFIG_DIR)) {
    New-Item -ItemType Directory -Path $CONFIG_DIR -Force | Out-Null
}

# ── Logging ──────────────────────────────────────────────────────────────────

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$timestamp] [$Level] $Message"
    Write-Host $line
    Add-Content -Path $LOG_FILE -Value $line
}

# ── Status Updates ───────────────────────────────────────────────────────────

function Update-Status {
    param(
        [string]$Phase,
        [int]$Progress,
        [string]$Message,
        [string]$Status = "running"
    )
    
    $statusObj = @{
        phase = $Phase
        progress = $Progress
        message = $Message
        status = $Status
        timestamp = (Get-Date -Format "o")
    }
    
    # Write atomically - write to temp then rename
    $tempFile = "$STATUS_FILE.tmp"
    $statusObj | ConvertTo-Json | Out-File -FilePath $tempFile -Encoding utf8
    if (Test-Path $STATUS_FILE) {
        Remove-Item -Path $STATUS_FILE -Force
    }
    Move-Item -Path $tempFile -Destination $STATUS_FILE -Force
}

function Complete-Status {
    param(
        [string]$Result,
        [string]$Error = $null,
        [hashtable]$Details = $null
    )
    
    $statusObj = @{
        status = $Result
        progress = 100
        message = if ($Result -eq "success") { "Backup completado" } else { "Backup fallido: $Error" }
        timestamp = (Get-Date -Format "o")
        error = $Error
        details = $Details
    }
    
    $tempFile = "$STATUS_FILE.tmp"
    $statusObj | ConvertTo-Json | Out-File -FilePath $tempFile -Encoding utf8
    if (Test-Path $STATUS_FILE) {
        Remove-Item -Path $STATUS_FILE -Force
    }
    Move-Item -Path $tempFile -Destination $STATUS_FILE -Force
}

# ── Helper Functions ─────────────────────────────────────────────────────────

function Get-LocalIP {
    $ip = Get-NetIPAddress -AddressFamily IPv4 | 
          Where-Object { $_.InterfaceAlias -notlike "*Loopback*" -and $_.IPAddress -notlike "169.254.*" } |
          Select-Object -First 1 -ExpandProperty IPAddress
    return $ip ?? "0.0.0.0"
}

function Test-Administrator {
    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($currentUser)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-WimlibPath {
    $wimlibDir = "$env:LOCALAPPDATA\HomePiNAS\wimlib"
    
    # Check common locations
    $candidates = @()
    if (Test-Path $wimlibDir) {
        $candidates += Get-ChildItem -Path $wimlibDir -Filter "wimlib-imagex.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
    }
    
    # Check PATH
    $pathExe = Get-Command "wimlib-imagex.exe" -ErrorAction SilentlyContinue
    if ($pathExe) {
        $candidates += $pathExe.Source
    }
    
    if ($candidates.Count -gt 0) {
        return $candidates[0]
    }
    
    return $null
}

function Install-Wimlib {
    Write-Log "wimlib not found - downloading..."
    
    $installDir = "$env:LOCALAPPDATA\HomePiNAS\wimlib"
    if (-not (Test-Path $installDir)) {
        New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    }
    
    $zipUrl = "https://wimlib.net/downloads/wimlib-1.14.4-windows-x86_64-bin.zip"
    $zipPath = "$installDir\wimlib.zip"
    
    # Download
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing
    
    # Extract
    Expand-Archive -Path $zipPath -DestinationPath $installDir -Force
    
    # Cleanup
    if (Test-Path $zipPath) {
        Remove-Item -Path $zipPath -Force
    }
    
    Write-Log "wimlib installed to $installDir"
    return Get-WimlibPath
}

# ── VSS Functions ────────────────────────────────────────────────────────────

$global:ShadowId = $null

function Create-VSS {
    Write-Log "Creating VSS shadow copy for C:\"
    Update-Status -Phase "vss" -Progress 20 -Message "Creando shadow copy VSS"
    
    try {
        $shadow = (Get-WmiObject -List Win32_ShadowCopy).Create("C:\", "ClientAccessible")
        if ($shadow.ReturnValue -ne 0) {
            throw "VSS creation failed with code $($shadow.ReturnValue)"
        }
        
        $global:ShadowId = $shadow.ShadowID
        $sc = Get-WmiObject Win32_ShadowCopy | Where-Object { $_.ID -eq $global:ShadowId }
        
        if (-not $sc) {
            throw "Could not find created shadow copy"
        }
        
        $devicePath = $sc.DeviceObject
        if (-not $devicePath.EndsWith("\")) {
            $devicePath += "\"
        }
        
        Write-Log "VSS shadow created: ID=$global:ShadowId, Device=$devicePath"
        return $devicePath
    }
    catch {
        Write-Log "VSS creation failed: $_" -Level "ERROR"
        throw
    }
}

function Delete-VSS {
    if (-not $global:ShadowId) {
        return
    }
    
    Write-Log "Deleting VSS shadow: $global:ShadowId"
    
    try {
        $sc = Get-WmiObject Win32_ShadowCopy | Where-Object { $_.ID -eq $global:ShadowId }
        if ($sc) {
            $sc.Delete()
            Write-Log "VSS shadow deleted"
        }
    }
    catch {
        Write-Log "VSS deletion failed (non-fatal): $_" -Level "WARN"
    }
    
    $global:ShadowId = $null
}

# ── Backup Functions ─────────────────────────────────────────────────────────

function Run-ImageBackup {
    param(
        [string]$SharePath,
        [pscredential]$Credential,
        [string]$WimlibExe
    )
    
    $hostname = $env:COMPUTERNAME
    $timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
    $destDir = "$SharePath\ImageBackup\$hostname\$timestamp"
    
    Write-Log "Image backup destination: $destDir"
    
    # Create destination directory
    Update-Status -Phase "connect" -Progress 15 -Message "Conectando a share del NAS"
    
    # Map network drive
    $driveLetter = "Z"
    $netUseArgs = "use $driveLetter`: $SharePath /user:`"$($Credential.UserName)`" `"$($Credential.GetNetworkCredential().Password)`""
    
    Write-Log "Mapping drive: net use $netUseArgs"
    $result = cmd /c "net use $netUseArgs" 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to connect to NAS share: $result"
    }
    
    try {
        # Create dest dir
        New-Item -ItemType Directory -Path $destDir -Force | Out-Null
        
        # Create VSS
        $devicePath = Create-VSS
        $wimPath = "$destDir\disk.wim"
        
        # Capture with wimlib
        Update-Status -Phase "capture" -Progress 30 -Message "Capturando imagen del sistema"
        
        Write-Log "wimlib capture: $devicePath -> $wimPath"
        
        $wimArgs = @(
            "capture",
            $devicePath,
            $wimPath,
            "$hostname-C",
            "--compress=LZX",
            "--threads=$([Environment]::ProcessorCount)",
            "--no-acls"
        )
        
        $wimProcess = Start-Process -FilePath $WimlibExe -ArgumentList $wimArgs -NoNewWindow -Wait -PassThru
        
        if ($wimProcess.ExitCode -ne 0 -and $wimProcess.ExitCode -ne 47) {
            throw "wimlib capture failed with exit code $($wimProcess.ExitCode)"
        }
        
        Write-Log "wimlib capture completed"
        
        # Capture EFI partition (if exists)
        Update-Status -Phase "efi" -Progress 80 -Message "Capturando partición EFI"
        
        try {
            $efiPartition = Get-Partition | Where-Object { $_.Type -eq "System" -or $_.GptType -like "*c12a7328*" } | Select-Object -First 1
            if ($efiPartition -and $efiPartition.DriveLetter) {
                $efiWimPath = "$destDir\efi.wim"
                $efiArgs = @(
                    "capture",
                    "$($efiPartition.DriveLetter):\",
                    $efiWimPath,
                    "$hostname-EFI",
                    "--compress=LZX",
                    "--no-acls"
                )
                
                $efiProcess = Start-Process -FilePath $WimlibExe -ArgumentList $efiArgs -NoNewWindow -Wait -PassThru
                if ($efiProcess.ExitCode -eq 0 -or $efiProcess.ExitCode -eq 47) {
                    Write-Log "EFI capture completed"
                } else {
                    Write-Log "EFI capture failed (non-fatal): exit code $($efiProcess.ExitCode)" -Level "WARN"
                }
            }
        }
        catch {
            Write-Log "EFI capture error (non-fatal): $_" -Level "WARN"
        }
        
        # Write manifest
        Update-Status -Phase "manifest" -Progress 85 -Message "Escribiendo manifiesto"
        
        $metadata = @{
            hostname = $hostname
            timestamp = (Get-Date -Format "o")
            platform = "windows"
            arch = (Get-CimInstance Win32_OperatingSystem).OSArchitecture
            totalMemory = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
            backupType = "image"
        }
        
        $metadata | ConvertTo-Json | Out-File -FilePath "$destDir\manifest.json" -Encoding utf8
        
        Update-Status -Phase "done" -Progress 100 -Message "Backup completado"
        
        return @{
            type = "image"
            destination = $destDir
            timestamp = (Get-Date -Format "o")
        }
    }
    finally {
        # Cleanup VSS
        Delete-VSS
        
        # Unmap drive
        Write-Log "Unmapping drive"
        cmd /c "net use $driveLetter`: /delete /y" 2>&1 | Out-Null
    }
}

function Run-FileBackup {
    param(
        [string]$SharePath,
        [string[]]$Paths,
        [pscredential]$Credential
    )
    
    if (-not $Paths -or $Paths.Count -eq 0) {
        throw "No backup paths configured"
    }
    
    $hostname = $env:COMPUTERNAME
    $timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
    $destBase = "$SharePath\FileBackup\$hostname\$timestamp"
    
    Write-Log "File backup destination: $destBase"
    
    # Map network drive
    $driveLetter = "Z"
    $netUseArgs = "use $driveLetter`: $SharePath /user:`"$($Credential.UserName)`" `"$($Credential.GetNetworkCredential().Password)`""
    
    Update-Status -Phase "connect" -Progress 10 -Message "Conectando a share del NAS"
    
    Write-Log "Mapping drive: net use $netUseArgs"
    $result = cmd /c "net use $netUseArgs" 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to connect to NAS share: $result"
    }
    
    try {
        New-Item -ItemType Directory -Path $destBase -Force | Out-Null
        
        $results = @()
        $totalPaths = $Paths.Count
        
        for ($i = 0; $i -lt $Paths.Count; $i++) {
            $srcPath = $Paths[$i]
            $folderName = Split-Path -Path $srcPath -Leaf
            $dest = "$destBase\$folderName"
            $pct = 20 + [int](($i / $totalPaths) * 70)
            
            Update-Status -Phase "copy" -Progress $pct -Message "Copiando $folderName ($($i+1)/$totalPaths)"
            
            Write-Log "robocopy: $srcPath -> $dest"
            
            $robocopyArgs = @(
                $srcPath, $dest,
                "/MIR",
                "/COPY:DT",
                "/DCOPY:T",
                "/R:2",
                "/W:5",
                "/NP",
                "/NFL",
                "/NDL",
                "/MT:8"
            )
            
            $robocopyResult = Start-Process -FilePath "robocopy.exe" -ArgumentList $robocopyArgs -NoNewWindow -Wait -PassThru
            
            # robocopy exit codes: 0-7 = success, 8+ = error
            if ($robocopyResult.ExitCode -ge 8) {
                Write-Log "robocopy failed for $srcPath: exit code $($robocopyResult.ExitCode)" -Level "ERROR"
                $results += @{ path = $srcPath; success = $false; error = "Exit code $($robocopyResult.ExitCode)" }
            } else {
                Write-Log "robocopy completed for $srcPath"
                $results += @{ path = $srcPath; success = $true }
            }
        }
        
        $failed = $results | Where-Object { -not $_.success }
        if ($failed.Count -gt 0) {
            throw "$($failed.Count) folders failed: $($failed.path -join ', ')"
        }
        
        Update-Status -Phase "done" -Progress 100 -Message "Backup de archivos completado"
        
        return @{
            type = "files"
            destination = $destBase
            timestamp = (Get-Date -Format "o")
            results = $results
        }
    }
    finally {
        # Unmap drive
        Write-Log "Unmapping drive"
        cmd /c "net use $driveLetter`: /delete /y" 2>&1 | Out-Null
    }
}

# ── Main Execution ───────────────────────────────────────────────────────────

try {
    Write-Log "═══════════════════════════════════════════════════════════"
    Write-Log "HomePiNAS Backup Worker starting"
    Write-Log "Backup type: $($config.backupType)"
    Write-Log "NAS: $($config.nasAddress):$($config.nasPort)"
    Write-Log "═══════════════════════════════════════════════════════════"
    
    Update-Status -Phase "init" -Progress 5 -Message "Iniciando backup worker"
    
    # Check admin privileges for image backup
    if ($config.backupType -eq "image") {
        if (-not (Test-Administrator)) {
            throw "Administrator privileges required for image backup"
        }
        Write-Log "Administrator privileges confirmed"
    }
    
    # Build share path
    $sharePath = "\\$($config.nasAddress)\$($config.sambaShare ?? 'active-backup')"
    Write-Log "Share path: $sharePath"
    
    # Create credentials
    $securePass = ConvertTo-SecureString -String $config.sambaPass -AsPlainText -Force
    $credential = New-Object System.Management.Automation.PSCredential($config.sambaUser, $securePass)
    
    # Get/install wimlib for image backup
    $wimlibExe = $null
    if ($config.backupType -eq "image") {
        Update-Status -Phase "wimlib" -Progress 15 -Message "Verificando wimlib"
        $wimlibExe = Get-WimlibPath
        if (-not $wimlibExe) {
            $wimlibExe = Install-Wimlib
        }
        Write-Log "wimlib path: $wimlibExe"
    }
    
    # Run backup
    $result = $null
    if ($config.backupType -eq "image") {
        $result = Run-ImageBackup -SharePath $sharePath -Credential $credential -WimlibExe $wimlibExe
    } else {
        $result = Run-FileBackup -SharePath $sharePath -Paths $config.backupPaths -Credential $credential
    }
    
    Write-Log "Backup completed successfully"
    Complete-Status -Result "success" -Details $result
    
    Write-Log "Worker finished"
    exit 0
}
catch {
    Write-Log "Backup failed: $_" -Level "ERROR"
    Complete-Status -Result "error" -Error $_.Exception.Message
    
    # Cleanup VSS if still active
    Delete-VSS
    
    Write-Log "Worker finished with error"
    exit 1
}
