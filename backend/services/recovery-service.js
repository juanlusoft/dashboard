/**
 * Recovery Service — Recovery ISO building and device setup instructions
 * Single Responsibility: Recovery tool builder and instructions
 */

const path = require('path');
const fs = require('fs');

/**
 * Generate image backup instructions for a device (Windows or Linux)
 * @param {object} device Device configuration
 * @param {string} uncPath UNC/SMB path for the share
 * @param {string} nasHostname NAS hostname
 * @returns {object} Instructions object with steps
 */
function getImageBackupInstructions(device, uncPath, nasHostname) {
  if (device.os === 'windows') {
    return getWindowsImageInstructions(device, uncPath);
  }

  return getLinuxImageInstructions(device, uncPath);
}

/**
 * Generate Windows image backup setup instructions
 * @private
 */
function getWindowsImageInstructions(device, uncPath) {
  const nasIP = '192.168.1.123'; // TODO: detect dynamically
  const shareName = device.sambaShare;

  return {
    title: 'Configurar Backup de Imagen en Windows',
    steps: [
      {
        title: '1. Programar backup automático (recomendado)',
        description: 'Abre PowerShell como Administrador y ejecuta:',
        command: `wbadmin start backup -backupTarget:\\\\${nasIP}\\${shareName} -user:homepinas -password:homepinas -allCritical -systemState -vssFull -quiet`,
      },
      {
        title: '2. Programar con Task Scheduler',
        description: 'Para backup automático diario, ejecuta en PowerShell (Admin):',
        command: `$action = New-ScheduledTaskAction -Execute "wbadmin" -Argument "start backup -backupTarget:\\\\${nasIP}\\${shareName} -user:homepinas -password:homepinas -allCritical -systemState -vssFull -quiet"\n$trigger = New-ScheduledTaskTrigger -Daily -At 3am\n$settings = New-ScheduledTaskSettingsSet -RunOnlyIfNetworkAvailable -WakeToRun\nRegister-ScheduledTask -TaskName "HomePiNAS Backup" -Action $action -Trigger $trigger -Settings $settings -User "SYSTEM" -RunLevel Highest`,
      },
      {
        title: '3. Para restaurar',
        description: 'Si necesitas restaurar la imagen completa:',
        command:
          'Arranca con USB de instalación de Windows → Reparar → Solucionar problemas → Recuperación de imagen del sistema → Selecciona la imagen de red',
      },
      {
        title: '4. Activar Windows Server Backup (si no está)',
        description: 'Si wbadmin no funciona, actívalo primero:',
        command:
          'En Windows 10/11 Pro: dism /online /enable-feature /featurename:WindowsServerBackup\nEn Windows Home: usa el Panel de Control → Copia de seguridad → Crear imagen del sistema → Red',
      },
    ],
  };
}

/**
 * Generate Linux image backup setup instructions
 * @private
 */
function getLinuxImageInstructions(device, uncPath) {
  const nasIP = '192.168.1.123'; // TODO: detect dynamically

  return {
    title: 'Configurar Backup de Imagen en Linux',
    steps: [
      {
        title: '1. Backup completo del disco',
        description: 'Ejecuta como root en el equipo:',
        command: `dd if=/dev/sda bs=4M status=progress | gzip | ssh homepinas@${nasIP} "cat > /mnt/storage/active-backup/${device.id}/image-$(date +%Y%m%d).img.gz"`,
      },
      {
        title: '2. Solo partición del sistema',
        description: 'Para copiar solo la partición principal:',
        command: `dd if=/dev/sda1 bs=4M status=progress | gzip | ssh homepinas@${nasIP} "cat > /mnt/storage/active-backup/${device.id}/sda1-$(date +%Y%m%d).img.gz"`,
      },
      {
        title: '3. Con partclone (más eficiente)',
        description: 'Instala partclone y haz backup solo de bloques usados:',
        command: `sudo apt install partclone\nsudo partclone.ext4 -c -s /dev/sda1 | gzip | ssh homepinas@${nasIP} "cat > /mnt/storage/active-backup/${device.id}/sda1-$(date +%Y%m%d).pcl.gz"`,
      },
      {
        title: '4. Restaurar',
        description: 'Para restaurar la imagen:',
        command: `ssh homepinas@${nasIP} "cat /mnt/storage/active-backup/${device.id}/image-FECHA.img.gz" | gunzip | sudo dd of=/dev/sda bs=4M status=progress`,
      },
    ],
  };
}

/**
 * Get SSH setup instructions for file backup
 * @param {string} publicKey SSH public key
 * @returns {object} Instructions object
 */
function getSSHSetupInstructions(publicKey) {
  return {
    title: 'Configurar acceso SSH',
    command: `mkdir -p ~/.ssh && echo '${publicKey}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`,
  };
}

/**
 * Check if recovery ISO exists and provide build status
 * @returns {object} Status object with iso info
 */
function getRecoveryStatus() {
  const isoDir = path.join(__dirname, '..', '..', 'recovery-usb');
  const isoPath = path.join(isoDir, 'homepinas-recovery.iso');
  const scriptsExist = fs.existsSync(path.join(isoDir, 'build-recovery-iso.sh'));

  let isoInfo = null;
  if (fs.existsSync(isoPath)) {
    const stat = fs.statSync(isoPath);
    isoInfo = {
      exists: true,
      size: stat.size,
      modified: stat.mtime,
    };
  }

  return {
    scriptsAvailable: scriptsExist,
    iso: isoInfo,
  };
}

/**
 * Get recovery ISO path for download
 * @returns {string|null} Path to ISO file or null if not found
 */
function getRecoveryISOPath() {
  const isoPath = path.join(__dirname, '..', '..', 'recovery-usb', 'homepinas-recovery.iso');
  return fs.existsSync(isoPath) ? isoPath : null;
}

/**
 * Get recovery scripts directory for archiving
 * @returns {string|null} Path to scripts dir or null if not found
 */
function getRecoveryScriptsDir() {
  const scriptsDir = path.join(__dirname, '..', '..', 'recovery-usb');
  return fs.existsSync(scriptsDir) ? scriptsDir : null;
}

/**
 * Get build script path
 * @returns {string|null} Path to build script or null if not found
 */
function getRecoveryBuildScript() {
  const buildScript = path.join(__dirname, '..', '..', 'recovery-usb', 'build-recovery-iso.sh');
  return fs.existsSync(buildScript) ? buildScript : null;
}

module.exports = {
  getImageBackupInstructions,
  getSSHSetupInstructions,
  getRecoveryStatus,
  getRecoveryISOPath,
  getRecoveryScriptsDir,
  getRecoveryBuildScript,
};
