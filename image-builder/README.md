# HomePiNAS - Custom Image Builder

Create a custom Raspberry Pi OS image with HomePiNAS pre-configured for automatic installation.

## Quick Start

### On Linux/WSL:

```bash
# 1. Download Raspberry Pi OS
wget https://downloads.raspberrypi.com/raspios_lite_arm64/images/raspios_lite_arm64-2024-11-19/2024-11-19-raspios-bookworm-arm64-lite.img.xz

# 2. Run the customizer
sudo ./customize-image.sh 2024-11-19-raspios-bookworm-arm64-lite.img.xz

# 3. Flash to SD card
sudo dd if=2024-11-19-raspios-bookworm-arm64-lite-homepinas.img of=/dev/sdX bs=4M status=progress
```

### On Windows (with Raspberry Pi Imager):

1. Use the pre-built image (see Releases)
2. Or run the customizer in WSL

## What the Customizer Does

1. **Mounts** the Raspberry Pi OS image
2. **Adds** a first-boot script that installs HomePiNAS
3. **Enables** SSH by default
4. **Sets** hostname to "homepinas"
5. **Creates** the customized image

## First Boot Process

When the Raspberry Pi boots for the first time:

1. Waits for network connectivity
2. Downloads and runs the HomePiNAS installer
3. Installs all dependencies (Docker, MergerFS, SnapRAID, etc.)
4. Configures services
5. Reboots automatically

**Total time:** 5-15 minutes (depending on internet speed)

## Default Credentials

- **SSH:** Use Raspberry Pi Imager to set username/password
- **HomePiNAS:** Set up on first access to dashboard

## Network Access

After installation completes:

- **Dashboard:** `https://<ip-address>`
- **SSH:** `ssh user@<ip-address>`
- **SMB Share:** `\\<ip-address>\Storage`

## Requirements

- Raspberry Pi 4/5 or CM4/CM5 (arm64)
- 16GB+ SD card (32GB+ recommended)
- Internet connection for first boot
- Linux system for customization (or WSL on Windows)

## Supported Base Images

- Raspberry Pi OS Lite (64-bit) - **Recommended**
- Raspberry Pi OS Full (64-bit)
- Raspberry Pi OS Bookworm/Trixie

## Troubleshooting

### Installation log
```bash
cat /var/log/homepinas-firstboot.log
```

### Retry installation
```bash
sudo rm /opt/.homepinas-installed
sudo systemctl enable homepinas-firstboot.service
sudo reboot
```

### Manual installation
```bash
curl -fsSL https://raw.githubusercontent.com/juanlusoft/homepinas-v2/main/install.sh | sudo bash
```
