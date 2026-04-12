#!/bin/bash
# HomePiNAS — Fan Test Script (EMC2305)
# Tests fan hardware on I2C bus 10, address 0x2e
# Usage: sudo bash fan-test.sh

EMC_BUS=10
EMC_ADDR=0x2e
I2CGET=/usr/sbin/i2cget
I2CSET=/usr/sbin/i2cset

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║   HomePiNAS Fan Test — EMC2305 I2C       ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
echo ""

# Check root
if [ "$(id -u)" -ne 0 ]; then
    echo -e "${RED}Error: ejecuta con sudo${NC}"
    exit 1
fi

# Check i2c-tools
if [ ! -x "$I2CGET" ]; then
    echo -e "${YELLOW}i2c-tools no encontrado, instalando...${NC}"
    apt-get install -y i2c-tools > /dev/null 2>&1
fi

# Load i2c-dev
modprobe i2c-dev 2>/dev/null

# Check I2C bus exists
if [ ! -e "/dev/i2c-${EMC_BUS}" ]; then
    echo -e "${RED}Error: /dev/i2c-${EMC_BUS} no encontrado${NC}"
    echo "Buses disponibles:"
    i2cdetect -l 2>/dev/null
    exit 1
fi

# --- PASO 1: Detectar chip ---
echo -e "${YELLOW}[1/4] Detectando EMC2305 en bus ${EMC_BUS} addr ${EMC_ADDR}...${NC}"
PRODUCT_ID=$($I2CGET -y $EMC_BUS $EMC_ADDR 0xfd 2>/dev/null)
if [ $? -ne 0 ] || [ -z "$PRODUCT_ID" ]; then
    echo -e "${RED}✗ EMC2305 no responde en bus ${EMC_BUS} addr ${EMC_ADDR}${NC}"
    echo "Escaneando buses disponibles:"
    for bus in $(i2cdetect -l 2>/dev/null | awk '{print $1}' | sed 's/i2c-//'); do
        echo "  Bus $bus:"
        i2cdetect -y $bus 2>/dev/null | grep -v "^     " | head -5
    done
    exit 1
fi
echo -e "${GREEN}✓ Chip detectado — Product ID: ${PRODUCT_ID}${NC}"
if [ "$PRODUCT_ID" = "0x36" ]; then
    echo -e "${GREEN}  → EMC2305 confirmado (0x36)${NC}"
elif [ "$PRODUCT_ID" = "0x34" ]; then
    echo -e "${GREEN}  → EMC2303 detectado (0x34)${NC}"
else
    echo -e "${YELLOW}  → Chip desconocido (${PRODUCT_ID}), continuando igualmente${NC}"
fi
echo ""

# --- PASO 2: Lectura en reposo ---
echo -e "${YELLOW}[2/4] Lectura en reposo...${NC}"
read_fan() {
    local msbReg=$1; local lsbReg=$2; local pwmReg=$3
    local MSB=$($I2CGET -y $EMC_BUS $EMC_ADDR $msbReg 2>/dev/null || echo 0x00)
    local LSB=$($I2CGET -y $EMC_BUS $EMC_ADDR $lsbReg 2>/dev/null || echo 0x00)
    local PWM=$($I2CGET -y $EMC_BUS $EMC_ADDR $pwmReg 2>/dev/null || echo 0x00)
    local MSB_D=$((16#${MSB:2})); local LSB_D=$((16#${LSB:2})); local PWM_D=$((16#${PWM:2}))
    local TACH=$(( (MSB_D << 5) | (LSB_D >> 3) ))
    local RPM=$(( TACH > 0 ? 3932160 / TACH : 0 ))
    local PCT=$(( PWM_D * 100 / 255 ))
    echo "${RPM} RPM | PWM: ${PWM_D} (${PCT}%)"
}
TEMP=$(( $(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo 0) / 1000 ))
echo "  CPU temp : ${TEMP}°C"
echo "  Fan 1    : $(read_fan 0x3e 0x3f 0x30)"
echo "  Fan 2    : $(read_fan 0x42 0x43 0x40)"
echo ""

# --- PASO 3: Prueba respuesta PWM ---
echo -e "${YELLOW}[3/4] Prueba respuesta PWM (25% → 75% → 100% → reposo)...${NC}"
for pct in 25 75 100; do
    PWM_VAL=$(( pct * 255 / 100 ))
    HEX=$(printf "0x%02x" $PWM_VAL)
    $I2CSET -y $EMC_BUS $EMC_ADDR 0x30 $HEX 2>/dev/null
    $I2CSET -y $EMC_BUS $EMC_ADDR 0x40 $HEX 2>/dev/null
    sleep 3
    RPM_LINE=$(read_fan 0x3e 0x3f 0x30)
    echo "  ${pct}% PWM → ${RPM_LINE}"
done

# Restaurar a fanctl o a 50% por defecto
if [ -x /usr/local/bin/homepinas-fanctl.sh ]; then
    bash /usr/local/bin/homepinas-fanctl.sh > /dev/null 2>&1
    echo "  → Curva de ventilador restaurada por fanctl"
else
    $I2CSET -y $EMC_BUS $EMC_ADDR 0x30 0x80 2>/dev/null
    $I2CSET -y $EMC_BUS $EMC_ADDR 0x40 0x80 2>/dev/null
    echo "  → Restaurado a 50% (fanctl no encontrado)"
fi
echo ""

# --- PASO 4: Stress test ---
echo -e "${YELLOW}[4/4] Stress test 60s — monitorizando RPM cada 5s...${NC}"
if ! command -v stress-ng > /dev/null 2>&1; then
    echo "  stress-ng no encontrado, instalando..."
    apt-get install -y stress-ng > /dev/null 2>&1
fi
NCPU=$(nproc)
stress-ng --cpu $NCPU --timeout 60s > /dev/null 2>&1 &
STRESS_PID=$!
echo "  stress-ng lanzado (${NCPU} cores, 60s)"
echo ""
printf "  %-6s %-8s %-20s %-20s\n" "t(s)" "CPU°C" "Fan 1" "Fan 2"
printf "  %-6s %-8s %-20s %-20s\n" "------" "--------" "--------------------" "--------------------"
for i in $(seq 5 5 65); do
    sleep 5
    TEMP=$(( $(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo 0) / 1000 ))
    F1=$(read_fan 0x3e 0x3f 0x30)
    F2=$(read_fan 0x42 0x43 0x40)
    printf "  %-6s %-8s %-20s %-20s\n" "${i}s" "${TEMP}°C" "$F1" "$F2"
done
wait $STRESS_PID 2>/dev/null

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   Test completado                        ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
