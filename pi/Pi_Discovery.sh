#!/bin/bash

# Raspberry Pi Discovery & SSH Setup Script
# This script helps find your Pi on the network and establish SSH connection

echo "=========================================="
echo "Raspberry Pi Discovery & SSH Setup"
echo "=========================================="
echo ""

# Raspberry Pi MAC OUI prefixes (all known models including Pi 5)
PI_MAC_PATTERN="b8[:-]27[:-]eb|dc[:-]a6[:-]32|e4[:-]5f[:-]01|28[:-]cd[:-]c1|d8[:-]3a[:-]dd"

# Function to detect OS
detect_os() {
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        echo "linux"
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        echo "mac"
    elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]]; then
        echo "windows"
    else
        echo "unknown"
    fi
}

# Function to auto-detect the local /24 subnet
get_local_subnet() {
    local os=$(detect_os)
    local subnet=""

    if [[ "$os" == "windows" ]]; then
        # Parse ipconfig for the first active non-loopback IPv4
        local ip
        ip=$(ipconfig 2>/dev/null | grep -A 5 "Ethernet\|Wi-Fi\|Wireless" \
            | grep "IPv4 Address" \
            | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' \
            | grep -v '^127\.' | head -1)
        if [[ -n "$ip" ]]; then
            subnet=$(echo "$ip" | sed 's/\.[0-9]*$/.0\/24/')
        fi
    elif [[ "$os" == "linux" ]]; then
        local ip
        ip=$(ip route show | grep -oE 'src [0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | awk '{print $2}' | grep -v '^127\.' | head -1)
        if [[ -n "$ip" ]]; then
            subnet=$(echo "$ip" | sed 's/\.[0-9]*$/.0\/24/')
        fi
    elif [[ "$os" == "mac" ]]; then
        local ip
        ip=$(ifconfig | grep 'inet ' | grep -v '127.0.0.1' | awk '{print $2}' | head -1)
        if [[ -n "$ip" ]]; then
            subnet=$(echo "$ip" | sed 's/\.[0-9]*$/.0\/24/')
        fi
    fi

    # Fallback
    echo "${subnet:-192.168.1.0/24}"
}

# Function to try mDNS resolution (fastest path — works if Bonjour/Avahi is active)
# Sets global FOUND_PI_IP on success
try_mdns() {
    local os=$(detect_os)
    local hostnames=("raspberrypi.local" "pi5.local" "pi.local")

    echo "[*] Trying mDNS hostname resolution..."
    for hostname in "${hostnames[@]}"; do
        local ip=""
        if [[ "$os" == "windows" ]]; then
            ip=$(ping -n 1 -w 500 "$hostname" 2>/dev/null \
                | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1)
        else
            ip=$(ping -c 1 -W 1 "$hostname" 2>/dev/null \
                | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1)
        fi

        if [[ -n "$ip" ]]; then
            echo "✓ Found via mDNS: $hostname → $ip"
            FOUND_PI_IP="$ip"
            return 0
        fi
    done

    echo "  (mDNS not found — falling back to network scan)"
    return 1
}

# Function to do a fast parallel ping sweep to populate the ARP cache
ping_sweep() {
    local subnet_base="$1"   # e.g. "192.168.1"
    local os=$(detect_os)

    echo "[*] Ping sweep on ${subnet_base}.0/24 to populate ARP cache..."

    if [[ "$os" == "windows" ]]; then
        # Use PowerShell for async pings (much faster than sequential bash loop)
        powershell -Command "
            1..254 | ForEach-Object {
                \$ip = '${subnet_base}.' + \$_
                (New-Object System.Net.NetworkInformation.Ping).SendAsync(\$ip, 200) | Out-Null
            }
        " 2>/dev/null &
    else
        for i in {1..254}; do
            (ping -c 1 -W 1 "${subnet_base}.$i" &>/dev/null) &
        done
    fi

    echo "[*] Waiting for replies..."
    sleep 3
}

# Function to scan ARP table for Pi MAC addresses
# Sets global FOUND_PI_IP on success
scan_arp() {
    echo "[*] Scanning ARP table for Raspberry Pi MAC addresses..."
    local results
    results=$(arp -a 2>/dev/null | grep -iE "$PI_MAC_PATTERN" || true)

    if [[ -n "$results" ]]; then
        echo "✓ Raspberry Pi(s) found:"
        echo "$results"
        local ip
        ip=$(echo "$results" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1)
        FOUND_PI_IP="$ip"
        return 0
    else
        echo "  (No Pi MAC addresses found in ARP table)"
        return 1
    fi
}

# Function to scan network for Pi
# Sets global FOUND_PI_IP on success
scan_network() {
    local os=$(detect_os)
    FOUND_PI_IP=""
    echo "[*] Scanning network for Raspberry Pi..."
    echo ""

    # Step 1: Try mDNS first (fastest)
    if try_mdns && [[ -n "$FOUND_PI_IP" ]]; then
        return 0
    fi

    echo ""

    # Step 2: Auto-detect subnet
    local subnet
    subnet=$(get_local_subnet)
    local subnet_base
    subnet_base=$(echo "$subnet" | sed 's/\.[0-9]*\/[0-9]*//')
    echo "[*] Detected local subnet: $subnet"

    # Step 3: Ping sweep to populate ARP cache
    ping_sweep "$subnet_base"

    echo ""

    # Step 4: ARP scan
    if scan_arp && [[ -n "$FOUND_PI_IP" ]]; then
        return 0
    fi

    echo ""

    # Step 5: nmap or PowerShell deep scan fallback
    if command -v nmap &>/dev/null; then
        echo "[*] Running nmap scan on $subnet (may take 30-60 seconds)..."
        nmap -sn "$subnet" 2>/dev/null | grep -iE "raspberry|$subnet_base" || true
    elif [[ "$os" == "windows" ]]; then
        echo "[*] nmap not found — using PowerShell port check on port 22..."
        powershell -Command "
            1..254 | ForEach-Object {
                \$ip = '${subnet_base}.' + \$_
                \$tcp = New-Object System.Net.Sockets.TcpClient
                \$conn = \$tcp.BeginConnect(\$ip, 22, \$null, \$null)
                if (\$conn.AsyncWaitHandle.WaitOne(200, \$false)) {
                    Write-Host ('SSH open: ' + \$ip)
                }
                \$tcp.Close()
            }
        " 2>/dev/null || true
    fi

    return 1
}

# Function to prompt for Pi IP
get_pi_ip() {
    echo ""
    echo "=========================================="
    echo "Enter your Raspberry Pi's IP address"
    echo "=========================================="
    echo "Hint: Look for an IP in the scan results above"
    echo ""

    while true; do
        read -p "Pi IP Address: " PI_IP </dev/tty
        if [[ $PI_IP =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
            echo "✓ Using Pi IP: $PI_IP"
            return 0
        fi
        echo "Invalid IP format — enter something like 192.168.1.42"
    done
}

# Function to test SSH connection
test_ssh() {
    echo ""
    echo "[*] Testing SSH connection to $PI_IP..."

    if timeout 5 ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=accept-new pi@$PI_IP "echo 'SSH connection successful!'" 2>/dev/null; then
        echo "✓ SSH connection successful!"
        return 0
    else
        echo "SSH could not connect to pi@$PI_IP"
        echo ""
        echo "Options:"
        echo "1. Verify the IP address is correct"
        echo "2. Make sure Pi is powered on"
        echo "3. Try enabling SSH via SD card (see instructions below)"
        return 1
    fi
}

# Function to enable SSH via headless setup
enable_ssh_headless() {
    echo ""
    echo "=========================================="
    echo "Headless SSH Setup Instructions"
    echo "=========================================="
    echo ""
    echo "To enable SSH without a screen:"
    echo "1. Insert your Pi's SD card into your PC's card reader"
    echo "2. Create an empty file named 'ssh' in the /boot directory"
    echo "   Windows: Right-click → New → Text Document → rename to 'ssh'"
    echo "   Mac/Linux: touch /Volumes/boot/ssh"
    echo "3. Eject the SD card safely"
    echo "4. Insert it back into the Pi and power on"
    echo "5. Wait 30 seconds and try SSH again"
    echo ""
    echo "Then run this script again to connect."
}

# Function to set up SSH keys
setup_ssh_keys() {
    echo ""
    echo "=========================================="
    echo "Setting Up SSH Keys (Optional but Recommended)"
    echo "=========================================="
    echo ""

    read -p "Generate SSH key pair? (y/n): " -n 1 -r </dev/tty
    echo

    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "[*] Generating SSH key..."

        if [ ! -d ~/.ssh ]; then
            mkdir -p ~/.ssh
            chmod 700 ~/.ssh
        fi

        if [ ! -f ~/.ssh/id_ed25519 ]; then
            ssh-keygen -t ed25519 -C "pi_health_hub" -f ~/.ssh/id_ed25519 -N ""
            echo "✓ SSH key generated at ~/.ssh/id_ed25519"
        else
            echo "✓ SSH key already exists"
        fi

        echo ""
        echo "[*] Copying public key to Pi..."

        if ssh-copy-id -i ~/.ssh/id_ed25519.pub pi@$PI_IP 2>/dev/null; then
            echo "✓ Public key installed on Pi"
            echo "✓ You can now SSH without a password!"
        else
            echo "Could not copy SSH key. Make sure you can SSH first."
        fi
    fi
}

# Function to get system info
get_pi_info() {
    echo ""
    echo "=========================================="
    echo "Raspberry Pi System Information"
    echo "=========================================="
    echo ""

    ssh pi@$PI_IP "
    echo 'Hostname:' \$(hostname)
    echo 'IP Address:' \$(hostname -I)
    echo 'OS:' \$(cat /etc/os-release | grep PRETTY_NAME | cut -d'=' -f2)
    echo 'Kernel:' \$(uname -r)
    echo 'Memory:' \$(free -h | grep Mem | awk '{print \$2}')
    echo 'CPU:' \$(nproc) cores
    echo 'Disk:' \$(df -h / | tail -1 | awk '{print \$2}')
    "
}

# Function to create migration checklist
create_migration_checklist() {
    echo ""
    echo "=========================================="
    echo "Migration Checklist"
    echo "=========================================="
    echo ""
    cat > ~/pi_migration_checklist.txt << 'EOF'
Raspberry Pi Health Hub Migration Checklist
============================================

PRE-MIGRATION:
[ ] Pi is powered on and connected to ethernet
[ ] SSH connection established and working
[ ] Pi IP address noted: ____________________
[ ] SSH key pair set up (optional but recommended)

HARDWARE SETUP:
[ ] 1TB SSD purchased (Samsung T7 Shield or Crucial X10)
[ ] SSD connected to Pi via USB-C
[ ] Verified SSD power draw is within Pi's PSU limits
[ ] Run: ssh pi@IP_ADDRESS "lsblk" to verify SSD is recognized

OS & ENVIRONMENT:
[ ] Update Pi OS: sudo apt update && sudo apt upgrade -y
[ ] Install Node.js (if needed): sudo apt install nodejs npm -y
[ ] Install Python (if needed): sudo apt install python3 python3-pip -y
[ ] Install PostgreSQL: sudo apt install postgresql postgresql-contrib -y

DATABASE:
[ ] PostgreSQL started: sudo systemctl start postgresql
[ ] Create database user for health app
[ ] Create health_data database
[ ] Restore/initialize database schema
[ ] Verify database is accessible: psql -U postgres -d health_data

APPLICATION:
[ ] Clone/transfer app code to Pi
[ ] Install app dependencies
[ ] Update app config to point to Pi database
[ ] Test app connectivity to PostgreSQL
[ ] Set up systemd service for app (auto-start on boot)

STORAGE MONITORING:
[ ] Deploy storage monitoring script
[ ] Set up cron job for weekly monitoring
[ ] Verify log file is being created: /var/log/pg_storage_monitor.log

VERIFICATION:
[ ] App is running and accessible
[ ] Database is stable
[ ] Storage usage tracked
[ ] Backup plan in place

NOTES:
_________________________________________________________________
_________________________________________________________________

EOF

    echo "✓ Checklist created at: ~/pi_migration_checklist.txt"
    cat ~/pi_migration_checklist.txt
}

# Main execution
main() {
    echo "[*] Detecting operating system..."
    OS=$(detect_os)
    echo "✓ OS detected: $OS"
    echo ""

    # Scan network — may auto-discover IP (stored in FOUND_PI_IP)
    scan_network

    if [[ -n "$FOUND_PI_IP" ]]; then
        echo ""
        echo "✓ Pi discovered at: $FOUND_PI_IP"
        read -p "Use this IP? (y/n): " -n 1 -r </dev/tty
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            PI_IP="$FOUND_PI_IP"
        else
            get_pi_ip
        fi
    else
        get_pi_ip
    fi

    # Test SSH
    if ! test_ssh; then
        enable_ssh_headless
        echo ""
        read -p "Press Enter once you've enabled SSH and want to retry..." </dev/tty
        test_ssh || return 1
    fi

    # Get Pi info
    if get_pi_info; then
        echo "✓ Successfully connected to Pi!"
    fi

    # Setup SSH keys
    setup_ssh_keys

    # Create migration checklist
    create_migration_checklist

    echo ""
    echo "=========================================="
    echo "✓ Setup Complete!"
    echo "=========================================="
    echo ""
    echo "Next steps:"
    echo "1. Review the migration checklist at ~/pi_migration_checklist.txt"
    echo "2. Connect your SSD to the Pi"
    echo "3. Run: ssh pi@$PI_IP"
    echo "4. Follow the checklist to migrate your app"
    echo ""
    echo "Quick commands:"
    echo "  - SSH into Pi: ssh pi@$PI_IP"
    echo "  - Copy files: scp local_file pi@$PI_IP:~/remote_path"
    echo "  - Remote command: ssh pi@$PI_IP 'command_here'"
    echo ""
}

# Run main
main
