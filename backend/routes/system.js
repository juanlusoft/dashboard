/**
 * HomePiNAS - System Routes
 * v1.5.6 - Modular Architecture
 *
 * System monitoring: stats, fans, disks
 */

const log = require('../utils/logger');
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const si = require('systeminformation');
const { execFileSync } = require('child_process');

const { requireAuth } = require('../middleware/auth');
const { logSecurityEvent } = require('../utils/security');
const { getData, saveData } = require('../utils/data');
const { validateFanId, validateFanMode } = require('../utils/sanitize');

// Fan mode presets configuration (v1.5.5 with hysteresis)
const FANCTL_CONF = '/usr/local/bin/homepinas-fanctl.conf';

// EMC2305 I2C constants
const EMC2305_I2C_BUS = 10;
const EMC2305_I2C_ADDR = '0x2e';
const EMC2305_FAN1_REG = '0x30'; // PWM setting register fan1
const EMC2305_FAN2_REG = '0x40'; // PWM setting register fan2
// Tach reading registers (MSB/LSB): fan1=0x3E/0x3F, fan2=0x42/0x43, fan3=0x46/0x47
const EMC2305_TACH_REGS = [
    { name: 'EMC2305 Fan 1', msbReg: '0x3e', lsbReg: '0x3f' },
    { name: 'EMC2305 Fan 2', msbReg: '0x42', lsbReg: '0x43' }
];
const I2CSET_PATH = '/usr/sbin/i2cset';
const I2CGET_PATH = '/usr/sbin/i2cget';
const EMC2305_I2C_DEVICE = '/sys/bus/i2c/devices/10-002e';

// Find the real hwmon path for EMC2305 (hwmon number varies by kernel boot order)
function getEmc2305HwmonPath() {
    try {
        const hwmonDir = path.join(EMC2305_I2C_DEVICE, 'hwmon');
        if (!fs.existsSync(hwmonDir)) return null;
        const entries = fs.readdirSync(hwmonDir);
        if (entries.length > 0) return path.join(hwmonDir, entries[0]);
    } catch (e) {}
    return null;
}

const FAN_PRESETS = {
    silent: `# =========================================
# HomePinas Fan Control - SILENT preset
# Quiet operation, higher temperatures allowed
# v1.5.5 with hysteresis support
# =========================================

PWM1_T30=60
PWM1_T35=80
PWM1_T40=110
PWM1_T45=150
PWM1_TMAX=200

PWM2_T40=70
PWM2_T50=100
PWM2_T60=140
PWM2_TMAX=200

MIN_PWM1=60
MIN_PWM2=70
MAX_PWM=255

# Hysteresis: 5C means fans won't slow down until temp drops 5C below threshold
# Higher value = more stable fan speed, but slower response to cooling
HYST_TEMP=5
`,
    balanced: `# =========================================
# HomePinas Fan Control - BALANCED preset
# Recommended default settings
# v1.5.5 with hysteresis support
# =========================================

# PWM1 (HDD / SSD)
PWM1_T30=65
PWM1_T35=90
PWM1_T40=130
PWM1_T45=180
PWM1_TMAX=230

# PWM2 (NVMe + CPU)
PWM2_T40=80
PWM2_T50=120
PWM2_T60=170
PWM2_TMAX=255

# Safety limits
MIN_PWM1=65
MIN_PWM2=80
MAX_PWM=255

# Hysteresis: 3C is balanced between stability and responsiveness
HYST_TEMP=3
`,
    performance: `# =========================================
# HomePinas Fan Control - PERFORMANCE preset
# Cooling first, louder fans
# v1.5.5 with hysteresis support
# =========================================

PWM1_T30=80
PWM1_T35=120
PWM1_T40=170
PWM1_T45=220
PWM1_TMAX=255

PWM2_T40=120
PWM2_T50=170
PWM2_T60=220
PWM2_TMAX=255

MIN_PWM1=80
MIN_PWM2=120
MAX_PWM=255

# Hysteresis: 2C for quick response to temperature changes
HYST_TEMP=2
`
};

// INA238 Power Monitor
function readIna238() {
    const INA238_ADDRS = ['0x40', '0x41', '0x44', '0x45', '0x48', '0x49', '0x4c', '0x4d'];

    // Helper: scan hwmon for ina238, returns path or null
    function findIna238Hwmon() {
        const hwmonBase = '/sys/class/hwmon';
        if (!fs.existsSync(hwmonBase)) return null;
        for (const hwmon of fs.readdirSync(hwmonBase)) {
            const namePath = path.join(hwmonBase, hwmon, 'name');
            try {
                const name = fs.readFileSync(namePath, 'utf8').trim();
                if (name === 'ina238' || name.startsWith('ina238')) {
                    return path.join(hwmonBase, hwmon);
                }
            } catch (e) {}
        }
        return null;
    }

    try {
        let inaPath = findIna238Hwmon();

        // If not found in hwmon, attempt to activate the driver
        if (!inaPath) {
            try {
                const data = getData();
                let inaConfig = (data && data.ina238Config) ? data.ina238Config : null;

                if (!inaConfig) {
                    // Scan I2C buses dynamically — only done once
                    if (fs.existsSync(I2CGET_PATH)) {
                        const i2cDevs = fs.readdirSync('/dev').filter(f => f.startsWith('i2c-'));
                        outer: for (const dev of i2cDevs) {
                            const bus = dev.replace('i2c-', '');
                            for (const addr of INA238_ADDRS) {
                                try {
                                    execFileSync(I2CGET_PATH, ['-y', bus, addr, '0x00'], {
                                        encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe']
                                    });
                                    inaConfig = { bus, addr };
                                    break outer;
                                } catch (e) {}
                            }
                        }
                    }

                    if (inaConfig) {
                        // Persist config to skip scanning next time
                        try {
                            const d = getData() || {};
                            d.ina238Config = inaConfig;
                            saveData(d);
                        } catch (e) {}
                    }
                }

                if (inaConfig) {
                    // Instantiate the driver via sysfs
                    try {
                        fs.writeFileSync(
                            `/sys/bus/i2c/devices/i2c-${inaConfig.bus}/new_device`,
                            `ina238 ${inaConfig.addr}`
                        );
                    } catch (e) {}

                    // Wait 500 ms for the driver to enumerate, then re-scan hwmon
                    const waitUntil = Date.now() + 500;
                    while (Date.now() < waitUntil) { /* spin */ }
                    inaPath = findIna238Hwmon();
                }
            } catch (e) {
                // I2C not available on this system — not an error
            }
        }

        if (!inaPath) return null;

        const readVal = (file) => {
            try { return parseInt(fs.readFileSync(path.join(inaPath, file), 'utf8').trim()); } catch (e) { return null; }
        };

        const voltRaw  = readVal('in1_input');
        const currRaw  = readVal('curr1_input');
        const powerRaw = readVal('power1_input');
        const tempRaw  = readVal('temp1_input');

        if (voltRaw === null && currRaw === null && powerRaw === null) return null;

        return {
            volts:    voltRaw  !== null ? parseFloat((voltRaw  / 1000).toFixed(2))    : null,
            amps:     currRaw  !== null ? parseFloat((currRaw  / 1000).toFixed(2))    : null,
            watts:    powerRaw !== null ? parseFloat((powerRaw / 1000000).toFixed(2)) : null,
            chipTemp: tempRaw  !== null ? parseFloat((tempRaw  / 1000).toFixed(2))    : null
        };
    } catch (e) {
        return null;
    }
}

// System Hardware Telemetry
// Cache static system info (doesn't change between reboots)
let staticInfoCache = null;
let staticInfoTime = 0;

router.get('/stats', requireAuth, async (req, res) => {
    try {
        // Fetch static info once (cpu, osInfo, graphics don't change)
        const now = Date.now();
        if (!staticInfoCache || now - staticInfoTime > 300000) {
            const [cpuInfo, osInfo, graphics] = await Promise.all([
                si.cpu(), si.osInfo(), si.graphics()
            ]);
            staticInfoCache = { cpuInfo, osInfo, graphics };
            staticInfoTime = now;
        }
        const { cpuInfo, osInfo, graphics } = staticInfoCache;

        // Fetch dynamic stats only
        const [cpu, mem, temp] = await Promise.all([
            si.currentLoad(),
            si.mem(),
            si.cpuTemperature()
        ]);

        // Try to get fan speeds
        let fans = [];
        try {
            const fanList = [];
            // Read fan speeds from /sys/class/hwmon without shell
            const hwmonBase = '/sys/class/hwmon';
            if (fs.existsSync(hwmonBase)) {
                const hwmonDirs = fs.readdirSync(hwmonBase);
                for (const hwmon of hwmonDirs) {
                    const hwmonPath = path.join(hwmonBase, hwmon);
                    let hwmonName = 'unknown';
                    try { hwmonName = fs.readFileSync(path.join(hwmonPath, 'name'), 'utf8').trim(); } catch (e) {}

                    // Find fan*_input files
                    try {
                        const entries = fs.readdirSync(hwmonPath);
                        for (const entry of entries) {
                            const fanMatch = entry.match(/^fan(\d+)_input$/);
                            if (fanMatch) {
                                try {
                                    const rpm = parseInt(fs.readFileSync(path.join(hwmonPath, entry), 'utf8').trim()) || 0;
                                    fanList.push({
                                        id: fanList.length + 1,
                                        name: `${hwmonName} Fan ${fanMatch[1]}`,
                                        rpm
                                    });
                                } catch (e) {}
                            }
                        }
                    } catch (e) {}
                }
            }
            // Check RPi cooling fan
            try {
                const rpiFanPaths = fs.readdirSync('/sys/devices/platform/cooling_fan/hwmon/');
                for (const hwDir of rpiFanPaths) {
                    const fanInputPath = `/sys/devices/platform/cooling_fan/hwmon/${hwDir}/fan1_input`;
                    if (fs.existsSync(fanInputPath)) {
                        const rpm = parseInt(fs.readFileSync(fanInputPath, 'utf8').trim()) || 0;
                        fanList.push({ id: fanList.length + 1, name: 'RPi Fan 1', rpm });
                    }
                }
            } catch (e) {}
            // Detect EMC2305 fans via I2C (driver may not create hwmon entries)
            if (fs.existsSync(I2CGET_PATH) && fs.existsSync(`/dev/i2c-${EMC2305_I2C_BUS}`)) {
                try {
                    // Check if emc2305 responds on i2c bus (read product ID register 0xFD)
                    execFileSync(I2CGET_PATH, ['-y', String(EMC2305_I2C_BUS), EMC2305_I2C_ADDR, '0xfd'], {
                        encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
                    });
                    // Check if already listed via hwmon (avoid duplicates)
                    const hasEmc = fanList.some(f => f.name.toLowerCase().includes('emc'));
                    if (!hasEmc) {
                        for (const fan of EMC2305_TACH_REGS) {
                            try {
                                const msb = parseInt(execFileSync(I2CGET_PATH, ['-y', String(EMC2305_I2C_BUS), EMC2305_I2C_ADDR, fan.msbReg], {
                                    encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe']
                                }).trim(), 16) || 0;
                                const lsb = parseInt(execFileSync(I2CGET_PATH, ['-y', String(EMC2305_I2C_BUS), EMC2305_I2C_ADDR, fan.lsbReg], {
                                    encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe']
                                }).trim(), 16) || 0;
                                // EMC2305 tach: 13-bit value, RPM = 3932160 / tachCount
                                const tachCount = (msb << 5) | (lsb >> 3);
                                const rpm = tachCount > 0 ? Math.round(3932160 / tachCount) : 0;
                                fanList.push({ id: fanList.length + 1, name: fan.name, rpm });
                            } catch (e) {}
                        }
                    }
                } catch (e) {
                    // EMC2305 not present or not responding on i2c bus
                }
            }
            fans = fanList;
        } catch (e) {
            fans = [];
        }

        const coreTemps = temp.cores && temp.cores.length > 0
            ? temp.cores.map((t, i) => ({ core: i, temp: Math.round(t) }))
            : [];

        const coreLoads = cpu.cpus
            ? cpu.cpus.map((c, i) => ({ core: i, load: Math.round(c.load) }))
            : [];

        res.json({
            cpuModel: cpuInfo.manufacturer + ' ' + cpuInfo.brand,
            cpuCores: cpuInfo.cores,
            cpuPhysicalCores: cpuInfo.physicalCores,
            cpuSpeed: cpuInfo.speed,
            cpuSpeedMax: cpuInfo.speedMax,
            cpuLoad: Math.round(cpu.currentLoad),
            coreLoads,
            cpuTemp: Math.round(temp.main || 0),
            cpuTempMax: Math.round(temp.max || 0),
            coreTemps,
            gpuTemp: graphics.controllers && graphics.controllers[0]
                ? Math.round(graphics.controllers[0].temperatureGpu || 0)
                : null,
            ramUsed: (mem.active / 1024 / 1024 / 1024).toFixed(1),
            ramTotal: (mem.total / 1024 / 1024 / 1024).toFixed(1),
            ramFree: (mem.free / 1024 / 1024 / 1024).toFixed(1),
            ramUsedPercent: Math.round((mem.active / mem.total) * 100),
            swapUsed: (mem.swapused / 1024 / 1024 / 1024).toFixed(1),
            swapTotal: (mem.swaptotal / 1024 / 1024 / 1024).toFixed(1),
            fans,
            power: readIna238(),
            uptime: si.time().uptime,
            hostname: osInfo.hostname,
            platform: osInfo.platform,
            distro: osInfo.distro,
            kernel: osInfo.kernel
        });
    } catch (e) {
        log.error('Stats error:', e);
        res.status(500).json({ error: 'Failed to fetch system stats' });
    }
});

// Fan control endpoint
router.post('/fan', requireAuth, (req, res) => {
    const { fanId, speed } = req.body;

    // Validate speed
    if (typeof speed !== 'number' || speed < 0 || speed > 100) {
        return res.status(400).json({ error: 'Invalid fan speed (0-100)' });
    }

    // SECURITY: Validate fanId - must be a small positive integer
    const validatedFanId = validateFanId(fanId);
    if (validatedFanId === null) {
        return res.status(400).json({ error: 'Invalid fan ID (must be 1-10)' });
    }

    const pwmValue = Math.round((speed / 100) * 255);
    const fanNum = validatedFanId;

    try {
        let found = false;

        // Method 0: Direct EMC2305 hwmon path (dynamic, fastest when driver exposes hwmon)
        const emc2305Hwmon = getEmc2305HwmonPath();
        if (!found && emc2305Hwmon) {
            const pwmPath = path.join(emc2305Hwmon, `pwm${fanNum}`);
            if (fs.existsSync(pwmPath)) {
                execFileSync('sudo', ['tee', pwmPath], {
                    input: String(pwmValue),
                    encoding: 'utf8',
                    timeout: 10000,
                    stdio: ['pipe', 'pipe', 'pipe']
                });
                found = true;
            }
        }

        // Method 1: Search hwmon devices for pwm control
        const hwmonBase = '/sys/class/hwmon';
        if (!found && fs.existsSync(hwmonBase)) {
            const hwmonDirs = fs.readdirSync(hwmonBase);
            for (const hwmon of hwmonDirs) {
                const pwmPath = path.join(hwmonBase, hwmon, `pwm${fanNum}`);
                if (fs.existsSync(pwmPath)) {
                    execFileSync('sudo', ['tee', pwmPath], {
                        input: String(pwmValue),
                        encoding: 'utf8',
                        timeout: 10000,
                        stdio: ['pipe', 'pipe', 'pipe']
                    });
                    found = true;
                    break;
                }
            }
        }

        // Method 2: RPi cooling fan (pwmfan via sysfs)
        if (!found) {
            try {
                const rpiFanBase = '/sys/devices/platform/cooling_fan/hwmon/';
                if (fs.existsSync(rpiFanBase)) {
                    const rpiFanDirs = fs.readdirSync(rpiFanBase);
                    for (const dir of rpiFanDirs) {
                        const pwmPath = path.join(rpiFanBase, dir, 'pwm1');
                        if (fs.existsSync(pwmPath)) {
                            execFileSync('sudo', ['tee', pwmPath], {
                                input: String(pwmValue),
                                encoding: 'utf8',
                                timeout: 10000,
                                stdio: ['pipe', 'pipe', 'pipe']
                            });
                            found = true;
                            break;
                        }
                    }
                }
            } catch (e) {}
        }

        // Method 3: EMC2305 via I2C (when kernel driver doesn't expose hwmon)
        if (!found && fs.existsSync(I2CSET_PATH) && fs.existsSync(`/dev/i2c-${EMC2305_I2C_BUS}`)) {
            try {
                // fanNum 1 → reg 0x30, fanNum 2 → reg 0x40
                const regMap = { 1: EMC2305_FAN1_REG, 2: EMC2305_FAN2_REG };
                const reg = regMap[fanNum];
                if (reg) {
                    const hexValue = '0x' + pwmValue.toString(16).padStart(2, '0');
                    execFileSync('sudo', [I2CSET_PATH, '-y', String(EMC2305_I2C_BUS), EMC2305_I2C_ADDR, reg, hexValue], {
                        encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
                    });
                    found = true;
                }
            } catch (e) {
                log.error('EMC2305 i2c fan control error:', e.message);
            }
        }

        // Method 4: Thermal cooling device
        if (!found) {
            const coolingStatePath = '/sys/class/thermal/cooling_device0/cur_state';
            const coolingMaxPath = '/sys/class/thermal/cooling_device0/max_state';
            if (fs.existsSync(coolingStatePath)) {
                let maxState = 255;
                try { maxState = parseInt(fs.readFileSync(coolingMaxPath, 'utf8').trim()) || 255; } catch (e) {}
                const state = Math.round(pwmValue * maxState / 255);
                execFileSync('sudo', ['tee', coolingStatePath], {
                    input: String(state),
                    encoding: 'utf8',
                    timeout: 10000,
                    stdio: ['pipe', 'pipe', 'pipe']
                });
                found = true;
            }
        }

        if (found) {
            logSecurityEvent('FAN_CONTROL', { fanId: fanNum, speed, pwmValue }, req.ip);
            res.json({ success: true, message: `Fan ${fanNum} speed set to ${speed}%` });
        } else {
            res.status(500).json({ error: 'PWM control not available for this fan' });
        }
    } catch (e) {
        log.error('Fan control error:', e);
        res.status(500).json({ error: 'Fan control not available on this system' });
    }
});

// Fan status endpoint — real-time RPM, PWM, fault and CPU temp from EMC2305 hwmon
router.get('/fan/status', requireAuth, (req, res) => {
    try {
        // Service active check
        let serviceActive = false;
        try {
            // homepinas-fanctl is a oneshot service triggered by a timer.
            // Check the timer is active (waiting) — that means fan control is working.
            const timerResult = execFileSync('systemctl', ['is-active', 'homepinas-fanctl.timer'], {
                encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe']
            }).trim();
            if (timerResult === 'active') {
                serviceActive = true;
            } else {
                // Fallback: check if the oneshot service itself is active (running right now)
                const svcResult = execFileSync('systemctl', ['is-active', 'homepinas-fanctl.service'], {
                    encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe']
                }).trim();
                serviceActive = svcResult === 'active';
            }
        } catch (e) {
            serviceActive = false;
        }

        // CPU temperature
        let temp = 0;
        try {
            const raw = parseInt(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8').trim()) || 0;
            temp = Math.round((raw / 1000) * 10) / 10;
        } catch (e) {}

        // Per-fan data: try hwmon first, fall back to I2C direct reads
        const fans = [];
        const hwmonPath = getEmc2305HwmonPath();
        const i2cAvailable = fs.existsSync(I2CGET_PATH) && fs.existsSync(`/dev/i2c-${EMC2305_I2C_BUS}`);
        const pwmRegs = { 1: EMC2305_FAN1_REG, 2: EMC2305_FAN2_REG };
        for (let n = 1; n <= 2; n++) {
            let rpm = 0, pwm = 0, fault = false;
            if (hwmonPath) {
                try { rpm = parseInt(fs.readFileSync(path.join(hwmonPath, `fan${n}_input`), 'utf8').trim()) || 0; } catch (e) {}
                try { pwm = parseInt(fs.readFileSync(path.join(hwmonPath, `pwm${n}`), 'utf8').trim()) || 0; } catch (e) {}
                try { fault = parseInt(fs.readFileSync(path.join(hwmonPath, `fan${n}_fault`), 'utf8').trim()) === 1; } catch (e) {}
            }
            // Fallback to I2C direct reads if hwmon not available
            if (rpm === 0 && i2cAvailable && EMC2305_TACH_REGS[n - 1]) {
                try {
                    const tachReg = EMC2305_TACH_REGS[n - 1];
                    const msb = parseInt(execFileSync(I2CGET_PATH, ['-y', String(EMC2305_I2C_BUS), EMC2305_I2C_ADDR, tachReg.msbReg], { encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }).trim(), 16) || 0;
                    const lsb = parseInt(execFileSync(I2CGET_PATH, ['-y', String(EMC2305_I2C_BUS), EMC2305_I2C_ADDR, tachReg.lsbReg], { encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }).trim(), 16) || 0;
                    const tachCount = (msb << 5) | (lsb >> 3);
                    rpm = tachCount > 0 ? Math.round(3932160 / tachCount) : 0;
                } catch (e) {}
            }
            if (pwm === 0 && i2cAvailable && pwmRegs[n]) {
                try {
                    pwm = parseInt(execFileSync(I2CGET_PATH, ['-y', String(EMC2305_I2C_BUS), EMC2305_I2C_ADDR, pwmRegs[n]], { encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }).trim(), 16) || 0;
                } catch (e) {}
            }
            fans.push({ id: n, rpm, pwm, pwmPercent: Math.round(pwm / 255 * 100), fault });
        }

        res.json({ serviceActive, temp, fans });
    } catch (e) {
        log.error('Fan status error:', e);
        res.status(500).json({ error: 'Failed to read fan status' });
    }
});

// Get current fan mode
router.get('/fan/mode', requireAuth, (req, res) => {
    try {
        // Read mode from data.json first (authoritative source)
        const data = getData();
        let currentMode = (data.system && data.system.fanMode) || 'balanced';

        // Validate the mode is one of the known presets
        if (!['silent', 'balanced', 'performance'].includes(currentMode)) {
            currentMode = 'balanced';
        }

        res.json({
            mode: currentMode,
            modes: [
                { id: 'silent', name: 'Silent', description: 'Quiet operation, higher temps allowed' },
                { id: 'balanced', name: 'Balanced', description: 'Recommended default settings' },
                { id: 'performance', name: 'Performance', description: 'Maximum cooling, louder fans' }
            ]
        });
    } catch (e) {
        log.error('Fan mode read error:', e);
        res.status(500).json({ error: 'Failed to read fan mode' });
    }
});

// Set fan mode preset
router.post('/fan/mode', requireAuth, (req, res) => {
    const { mode } = req.body;

    // SECURITY: Validate mode using sanitize function
    const validatedMode = validateFanMode(mode);
    if (!validatedMode || !FAN_PRESETS[validatedMode]) {
        return res.status(400).json({ error: 'Invalid mode. Must be: silent, balanced, or performance' });
    }

    try {
        const preset = FAN_PRESETS[validatedMode];
        // Use os.tmpdir() for temp file — /mnt/storage/.tmp may not exist yet
        const os = require('os');
        const tempFile = path.join(os.tmpdir(), 'homepinas-fanctl-temp.conf');
        fs.writeFileSync(tempFile, preset, 'utf8');
        execFileSync('sudo', ['cp', tempFile, FANCTL_CONF], { encoding: 'utf8', timeout: 10000 });
        execFileSync('sudo', ['chmod', '644', FANCTL_CONF], { encoding: 'utf8', timeout: 10000 });
        fs.unlinkSync(tempFile);

        try {
            execFileSync('sudo', ['systemctl', 'restart', 'homepinas-fanctl'], { encoding: 'utf8', timeout: 10000 });
        } catch (e) {}

        // Save mode to data.json for persistent tracking
        const data = getData();
        if (!data.system) data.system = {};
        data.system.fanMode = validatedMode;
        saveData(data);

        logSecurityEvent('FAN_MODE_CHANGE', { mode: validatedMode, user: req.user.username }, req.ip);
        res.json({ success: true, message: `Fan mode set to ${validatedMode}`, mode: validatedMode });
    } catch (e) {
        log.error('Fan mode set error:', e);
        res.status(500).json({ error: 'Failed to set fan mode' });
    }
});

// Real Disk Detection & SMART
// Disks endpoint - public (needed by frontend for storage wizard)
router.get('/disks', async (req, res) => {
    try {
        // Get disk info from lsblk (no sudo needed, includes serial)
        let lsblkData = {};
        try {
            const lsblkJson = execFileSync('lsblk', ['-J', '-b', '-o', 'NAME,SIZE,TYPE,MODEL,SERIAL,TRAN'], { encoding: 'utf8' });
            const parsed = JSON.parse(lsblkJson);
            for (const dev of (parsed.blockdevices || [])) {
                lsblkData[dev.name] = {
                    size: dev.size,
                    type: dev.type,
                    model: dev.model || '',
                    serial: dev.serial || '',
                    transport: dev.tran || ''
                };
            }
        } catch (e) {
            log.info('lsblk parse error:', e.message);
        }

        const blockDevices = await si.blockDevices();
        const diskLayout = await si.diskLayout();

        const disks = blockDevices
            .filter(dev => {
                if (dev.type !== 'disk') return false;
                if (dev.name && dev.name.startsWith('mmcblk')) return false;
                if (dev.name && dev.name.startsWith('zram')) return false;
                if (dev.name && dev.name.startsWith('loop')) return false;
                if (dev.name && dev.name.startsWith('ram')) return false;
                if (dev.name && dev.name.startsWith('dm-')) return false;
                const sizeGB = dev.size / 1024 / 1024 / 1024;
                if (sizeGB < 1) return false;
                // Filter phantom disks: must exist in lsblk AND have a real device node
                if (!lsblkData[dev.name]) return false;
                try { fs.statSync(`/dev/${dev.name}`); } catch { return false; }
                // Filter ghost SATA devices: phantom ports have numeric/empty model AND tiny/zero size
                // Real disks behind USB/SATA bridges (JMB585) can report "456" but have real size
                const devModel = (lsblkData[dev.name].model || dev.model || '').trim();
                const isPhantom = (!devModel || /^\d+$/.test(devModel)) && dev.size < 1000000000;
                if (isPhantom) return false;
                return true;
            })
            .map(dev => {
                const lsblk = lsblkData[dev.name] || {};
                const layoutInfo = diskLayout.find(d => d.device === dev.device) || {};
                const sizeGBraw = dev.size / 1024 / 1024 / 1024;
                const sizeGB = sizeGBraw.toFixed(0);

                // Determine disk type
                let diskType = 'HDD';
                if (layoutInfo.interfaceType === 'NVMe' || dev.name.includes('nvme') || lsblk.transport === 'nvme') {
                    diskType = 'NVMe';
                } else if ((layoutInfo.type || '').includes('SSD') || 
                           (lsblk.model || '').toLowerCase().includes('ssd') ||
                           (layoutInfo.name || '').toLowerCase().includes('ssd')) {
                    diskType = 'SSD';
                }

                // Get serial from lsblk (most reliable, no sudo)
                const serial = lsblk.serial || layoutInfo.serial || '';

                // Get model - prefer lsblk if it has a good value
                const lsblkModel = lsblk.model || '';
                const layoutModel = layoutInfo.model || layoutInfo.name || '';
                const finalModel = (lsblkModel && lsblkModel.length > 3) ? lsblkModel : 
                                   (layoutModel || lsblkModel || 'Unknown Drive');

                // Try to get temperature
                let temp = null;
                try {
                    // Method 1: drivetemp module exposes temps via hwmon
                    const tempBasePath = `/sys/block/${dev.name}/device/hwmon/`;
                    if (fs.existsSync(tempBasePath)) {
                        const hwmonDirs = fs.readdirSync(tempBasePath);
                        if (hwmonDirs.length > 0) {
                            const tempFile = path.join(tempBasePath, hwmonDirs[0], 'temp1_input');
                            if (fs.existsSync(tempFile)) {
                                const tempVal = parseInt(fs.readFileSync(tempFile, 'utf8').trim());
                                if (!isNaN(tempVal)) temp = Math.round(tempVal / 1000);
                            }
                        }
                    }
                } catch (e) {}

                // Method 2: smartctl fallback if hwmon didn't work
                if (temp === null) {
                    try {
                        const smartOut = execFileSync('sudo', ['smartctl', '-A', `/dev/${dev.name}`], { encoding: 'utf8', timeout: 5000 });
                        // SMART attributes format: ID ATTR_NAME FLAGS VALUE WORST THRESH TYPE UPDATED WHEN_FAILED RAW_VALUE
                        // We need RAW_VALUE (last column), not VALUE. Match the number after the dash (-) near end of line
                        const tempMatch = smartOut.match(/(?:Temperature_Celsius|Airflow_Temperature_Cel|Temperature_Internal|Temperature_Case)\s+\S+\s+\d+\s+\d+\s+\d+\s+\S+\s+\S+\s+\S+\s+(\d+)/);
                        if (tempMatch) {
                            temp = parseInt(tempMatch[1]);
                        } else {
                            // NVMe / newer format: "Temperature:    XX Celsius"
                            const nvmeMatch = smartOut.match(/Temperature:\s+(\d+)\s*Celsius/i);
                            if (nvmeMatch) temp = parseInt(nvmeMatch[1]);
                        }
                    } catch (e) {}
                }

                // Get disk usage from mounted partitions
                let usage = 0;
                let freeFormatted = null;
                let usedFormatted = null;
                try {
                    // Use execFileSync to avoid shell interpolation
                    const dfOutput = execFileSync('df', ['-P'], { encoding: 'utf8' });
                    // Filter lines matching this disk's partitions (e.g., /dev/sda1, /dev/sdb1)
                    const diskLine = dfOutput.split('\n')
                        .find(line => line.startsWith(`/dev/${dev.name}`));
                    if (diskLine) {
                        const parts = diskLine.trim().split(/\s+/);
                        if (parts.length >= 5) {
                            usage = parseInt(parts[4]) || 0; // Use% column
                            const freeKB = parseInt(parts[3]) || 0;
                            const usedKB = parseInt(parts[2]) || 0;
                            const fmt = (kb) => {
                                const gb = kb / 1024 / 1024;
                                return gb >= 1024 ? (gb / 1024).toFixed(1) + ' TB' : gb.toFixed(0) + ' GB';
                            };
                            freeFormatted = fmt(freeKB);
                            usedFormatted = fmt(usedKB);
                        }
                    }
                } catch (e) {}

                return {
                    id: dev.name,
                    device: dev.device,
                    type: diskType,
                    size: sizeGBraw >= 1024 ? (sizeGBraw / 1024).toFixed(1) + ' TB' : sizeGB + ' GB',
                    free: freeFormatted,
                    used: usedFormatted,
                    model: finalModel,
                    serial: serial || 'N/A',
                    temp: temp,
                    usage
                };
            });
        res.json(disks);
    } catch (e) {
        log.error('Disk scan error:', e);
        res.status(500).json({ error: 'Failed to scan disks' });
    }
});

// System Status
// Status endpoint - public (needed by frontend to check if user exists)
router.get('/status', async (req, res) => {
    const data = getData();
    // Read version from package.json
    let version = '';
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
        version = pkg.version || '';
    } catch { /* ignore */ }
    res.json({
        user: data.user ? { username: data.user.username } : null,
        storageConfig: data.storageConfig,
        poolConfigured: data.poolConfigured || false,
        network: data.network,
        version,
        _sig: 'hnv2'
    });
});

// System Architecture Detection
router.get('/arch', requireAuth, async (req, res) => {
    try {
        const os = require('os');
        const arch = os.arch(); // 'arm64', 'x64', 'arm', etc.
        const platform = os.platform(); // 'linux', 'darwin', 'win32'
        
        // Normalize architecture names
        let normalizedArch;
        switch (arch) {
            case 'arm64':
            case 'aarch64':
                normalizedArch = 'arm64';
                break;
            case 'arm':
            case 'armv7l':
                normalizedArch = 'arm';
                break;
            case 'x64':
            case 'amd64':
                normalizedArch = 'amd64';
                break;
            case 'ia32':
            case 'x86':
                normalizedArch = 'i386';
                break;
            default:
                normalizedArch = arch;
        }
        
        // Check if running on Raspberry Pi
        let isRaspberryPi = false;
        try {
            const cpuInfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
            isRaspberryPi = cpuInfo.toLowerCase().includes('raspberry') || 
                           cpuInfo.toLowerCase().includes('bcm2');
        } catch (e) {}
        
        res.json({
            arch: normalizedArch,
            rawArch: arch,
            platform,
            isRaspberryPi,
            isArm: normalizedArch === 'arm64' || normalizedArch === 'arm',
            isX86: normalizedArch === 'amd64' || normalizedArch === 'i386'
        });
    } catch (error) {
        log.error('Architecture detection error:', error);
        res.status(500).json({ error: 'Failed to detect architecture' });
    }
});

module.exports = router;
