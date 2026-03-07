/**
 * HomePiNAS - Health Monitor
 * 
 * Periodic background checks with Telegram alerts:
 * - Disk health (SMART status, sectors, life remaining)
 * - Temperature monitoring
 * - Pool usage
 * - SnapRAID sync status
 * - Badblocks completion
 * - Disk mount status
 */

const { execFileSync } = require('child_process');
const { sendViaTelegram } = require('./notify');
const { getData } = require('./data');

// Track last alert state to avoid spam
const alertState = {
    lastAlerts: {},      // key -> timestamp of last alert
    cooldownMs: 3600000  // 1 hour between repeated alerts for same issue
};

function shouldAlert(key) {
    const now = Date.now();
    const last = alertState.lastAlerts[key] || 0;
    if (now - last < alertState.cooldownMs) return false;
    alertState.lastAlerts[key] = now;
    return true;
}

/**
 * Format a Telegram alert message
 */
function formatAlert(emoji, title, details) {
    return `${emoji} *HomePiNAS — ${title}*\n\n${details}`;
}

/**
 * Run all health checks
 */
async function runHealthChecks() {
    const alerts = [];
    
    try {
        // ══════════════════════════════════════════════════════════
        // 1. DISK HEALTH (SMART)
        // ══════════════════════════════════════════════════════════
        try {
            const lsblkJson = execFileSync('lsblk', ['-J', '-d', '-o', 'NAME,TYPE,SIZE,MODEL,ROTA,TRAN'], {
                encoding: 'utf8', timeout: 10000
            });
            const lsblk = JSON.parse(lsblkJson);
            const devices = (lsblk.blockdevices || []).filter(dev => {
                if (dev.type !== 'disk') return false;
                if (/^(loop|zram|ram|mmcblk)/.test(dev.name)) return false;
                const sizeStr = String(dev.size || '0');
                if (sizeStr === '0' || sizeStr === '0B') return false;
                return true;
            });

            for (const device of devices) {
                const diskId = device.name;
                const devicePath = `/dev/${diskId}`;
                
                try {
                    let smartJson;
                    try {
                        smartJson = execFileSync('sudo', ['smartctl', '-j', '-a', devicePath], {
                            encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe']
                        });
                    } catch (e) {
                        smartJson = e.stdout ? e.stdout.toString() : null;
                        if (!smartJson) continue;
                    }
                    
                    const smart = JSON.parse(smartJson);
                    const model = smart.model_name || device.model || diskId;
                    
                    // SMART health failed
                    if (smart.smart_status && smart.smart_status.passed === false) {
                        if (shouldAlert(`smart-failed-${diskId}`)) {
                            // Find which attribute failed
                            let failReason = '';
                            const attrs = smart.ata_smart_attributes?.table || [];
                            for (const attr of attrs) {
                                if (attr.when_failed && attr.when_failed !== '-') {
                                    failReason += `\n  • ${attr.name}: ${attr.raw.value} (umbral: ${attr.thresh})`;
                                }
                            }
                            alerts.push(formatAlert('🔴', 'SMART FAILED',
                                `Disco *${model}* (${diskId}) reporta fallo SMART.\n${failReason}\n\n⚠️ El fabricante recomienda hacer backup inmediato.`));
                        }
                    }
                    
                    // Reallocated sectors (HDD)
                    if (smart.ata_smart_attributes?.table) {
                        const attrs = smart.ata_smart_attributes.table;
                        const reallocated = attrs.find(a => a.id === 5);
                        const pending = attrs.find(a => a.id === 197);
                        
                        if (reallocated && reallocated.raw.value > 0) {
                            if (shouldAlert(`reallocated-${diskId}`)) {
                                const severity = reallocated.raw.value > 10 ? '🔴' : '🟡';
                                alerts.push(formatAlert(severity, 'Sectores reasignados',
                                    `Disco *${model}* (${diskId}): ${reallocated.raw.value} sectores reasignados.`));
                            }
                        }
                        
                        if (pending && pending.raw.value > 0) {
                            if (shouldAlert(`pending-${diskId}`)) {
                                alerts.push(formatAlert('🔴', 'Sectores pendientes',
                                    `Disco *${model}* (${diskId}): ${pending.raw.value} sectores pendientes de reasignación.`));
                            }
                        }
                    }
                    
                    // Temperature
                    const temp = smart.temperature?.current || 0;
                    if (temp > 55) {
                        if (shouldAlert(`temp-hot-${diskId}`)) {
                            alerts.push(formatAlert('🔴', 'Temperatura crítica',
                                `Disco *${model}* (${diskId}): *${temp}°C*\nUmbral crítico: 55°C`));
                        }
                    } else if (temp > 50) {
                        if (shouldAlert(`temp-warm-${diskId}`)) {
                            alerts.push(formatAlert('🟡', 'Temperatura alta',
                                `Disco *${model}* (${diskId}): *${temp}°C*\nUmbral atención: 50°C`));
                        }
                    }
                    
                    // SSD/NVMe life remaining
                    if (smart.nvme_smart_health_information_log) {
                        const pctUsed = smart.nvme_smart_health_information_log.percentage_used || 0;
                        const lifeRemaining = 100 - pctUsed;
                        if (lifeRemaining < 10) {
                            if (shouldAlert(`life-critical-${diskId}`)) {
                                alerts.push(formatAlert('🔴', 'Vida SSD crítica',
                                    `Disco *${model}* (${diskId}): solo *${lifeRemaining}%* de vida restante.`));
                            }
                        } else if (lifeRemaining < 20) {
                            if (shouldAlert(`life-low-${diskId}`)) {
                                alerts.push(formatAlert('🟡', 'Vida SSD baja',
                                    `Disco *${model}* (${diskId}): *${lifeRemaining}%* de vida restante.`));
                            }
                        }
                    }
                    
                } catch (e) {
                    // SMART not available for this disk, skip
                }
            }
        } catch (e) {
            console.error('Health check - disk scan error:', e.message);
        }

        // ══════════════════════════════════════════════════════════
        // 2. POOL USAGE
        // ══════════════════════════════════════════════════════════
        try {
            const dfRaw = execFileSync('df', ['--output=pcent', '/mnt/storage'], {
                encoding: 'utf8', timeout: 5000
            });
            const pctMatch = dfRaw.match(/(\d+)%/);
            if (pctMatch) {
                const usedPct = parseInt(pctMatch[1]);
                if (usedPct > 95) {
                    if (shouldAlert('pool-critical')) {
                        alerts.push(formatAlert('🔴', 'Pool casi llena',
                            `El pool de almacenamiento está al *${usedPct}%*.\n\n⚠️ Libera espacio urgentemente.`));
                    }
                } else if (usedPct > 90) {
                    if (shouldAlert('pool-90')) {
                        alerts.push(formatAlert('🟡', 'Pool >90%',
                            `El pool de almacenamiento está al *${usedPct}%*.`));
                    }
                } else if (usedPct > 80) {
                    if (shouldAlert('pool-80')) {
                        alerts.push(formatAlert('🟡', 'Pool >80%',
                            `El pool de almacenamiento está al *${usedPct}%*.`));
                    }
                }
            }
        } catch (e) {
            // Pool not mounted, check if it should be
            const data = getData();
            if (data.storageConfig && data.storageConfig.length > 0) {
                if (shouldAlert('pool-offline')) {
                    alerts.push(formatAlert('🔴', 'Pool no disponible',
                        'El pool de almacenamiento no está montado pero hay discos configurados.'));
                }
            }
        }

        // ══════════════════════════════════════════════════════════
        // 3. SNAPRAID STATUS
        // ══════════════════════════════════════════════════════════
        try {
            const fs = require('fs');
            if (fs.existsSync('/var/log/snapraid-sync.log')) {
                const log = fs.readFileSync('/var/log/snapraid-sync.log', 'utf8');
                const lastLines = log.split('\n').slice(-20).join('\n');
                
                if (lastLines.includes('ERROR') && !lastLines.includes('completed successfully')) {
                    if (shouldAlert('snapraid-error')) {
                        alerts.push(formatAlert('🔴', 'SnapRAID Error',
                            'El último sync de SnapRAID tuvo errores. Revisa los logs.'));
                    }
                }
            }
        } catch (e) {
            // No SnapRAID, skip
        }

        // ══════════════════════════════════════════════════════════
        // 4. DISK MOUNT STATUS
        // ══════════════════════════════════════════════════════════
        try {
            const data = getData();
            const configuredDisks = data.storageConfig || [];
            
            for (const disk of configuredDisks) {
                if (disk.mountPoint) {
                    try {
                        execFileSync('mountpoint', ['-q', disk.mountPoint], { stdio: 'ignore' });
                    } catch (e) {
                        if (shouldAlert(`unmounted-${disk.id}`)) {
                            alerts.push(formatAlert('🔴', 'Disco desmontado',
                                `El disco *${disk.id}* no está montado en ${disk.mountPoint}.`));
                        }
                    }
                }
            }
        } catch (e) {
            // Skip
        }

    } catch (e) {
        console.error('Health monitor error:', e);
    }
    
    // Send alerts
    for (const alert of alerts) {
        try {
            await sendViaTelegram(alert);
            // Small delay between messages to avoid rate limiting
            await new Promise(r => setTimeout(r, 500));
        } catch (e) {
            console.error('Failed to send alert:', e.message);
        }
    }
    
    return alerts.length;
}

/**
 * Notify about badblocks completion
 */
async function notifyBadblocksComplete(device, result, badBlocksFound, durationMs) {
    const hours = (durationMs / 3600000).toFixed(1);
    
    if (badBlocksFound === 0 && result === 'passed') {
        await sendViaTelegram(formatAlert('✅', 'Test de disco completado',
            `Disco *${device}* escaneado en ${hours}h.\n\n*Resultado: Sin errores* — Disco OK.`));
    } else if (result === 'cancelled') {
        await sendViaTelegram(formatAlert('⏹', 'Test de disco cancelado',
            `El test de *${device}* fue cancelado tras ${hours}h.`));
    } else {
        await sendViaTelegram(formatAlert('❌', 'Test de disco — Errores encontrados',
            `Disco *${device}* escaneado en ${hours}h.\n\n*${badBlocksFound} sectores defectuosos encontrados.*\n\n⚠️ Considera reemplazar este disco.`));
    }
}

// Start periodic monitoring
let monitorInterval = null;

function startHealthMonitor(intervalMs = 300000) { // Default: every 5 minutes
    if (monitorInterval) return;
    
    console.log(`[HEALTH] Monitor started (interval: ${intervalMs / 1000}s)`);
    
    // Run first check after 30s (let server start up)
    setTimeout(() => {
        runHealthChecks().then(count => {
            if (count > 0) console.log(`[HEALTH] Sent ${count} alerts`);
        });
    }, 30000);
    
    monitorInterval = setInterval(() => {
        runHealthChecks().then(count => {
            if (count > 0) console.log(`[HEALTH] Sent ${count} alerts`);
        });
    }, intervalMs);
}

function stopHealthMonitor() {
    if (monitorInterval) {
        clearInterval(monitorInterval);
        monitorInterval = null;
        console.log('[HEALTH] Monitor stopped');
    }
}

module.exports = { 
    runHealthChecks, 
    startHealthMonitor, 
    stopHealthMonitor, 
    notifyBadblocksComplete 
};
