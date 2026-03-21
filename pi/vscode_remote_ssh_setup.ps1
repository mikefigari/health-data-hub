# VS Code Remote - SSH Setup for Raspberry Pi (Windows PowerShell)
# Run this in PowerShell on your Windows PC

$PI_USER    = "mike"
$PI_IP      = "10.0.0.135"
$PI_HOST    = "raspberry-pi-health-hub"
$SSH_DIR    = "$env:USERPROFILE\.ssh"
$SSH_CONFIG = "$SSH_DIR\config"

function Write-Step { param($msg) Write-Host "[*] $msg" -ForegroundColor Cyan }
function Write-OK   { param($msg) Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Write-Err  { param($msg) Write-Host "[ERROR] $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " VS Code Remote - SSH Setup (Windows)"     -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# ------------------------------------------------------------------
# 1. Check SSH
# ------------------------------------------------------------------
Write-Step "Checking SSH availability..."
try {
    $sshVersion = (& ssh -V 2>&1)
    Write-OK "SSH found: $sshVersion"
} catch {
    Write-Err "SSH not found. Install OpenSSH Client:"
    Write-Host "  Settings > Apps > Optional features > Add: OpenSSH Client"
    exit 1
}

# ------------------------------------------------------------------
# 2. Create ~/.ssh and config if missing
# ------------------------------------------------------------------
Write-Step "Checking SSH directory and config file..."

if (-not (Test-Path $SSH_DIR)) {
    New-Item -ItemType Directory -Path $SSH_DIR -Force | Out-Null
    Write-OK "Created $SSH_DIR"
} else {
    Write-OK "SSH directory exists: $SSH_DIR"
}

if (-not (Test-Path $SSH_CONFIG)) {
    New-Item -ItemType File -Path $SSH_CONFIG -Force | Out-Null
    Write-OK "Created SSH config: $SSH_CONFIG"
} else {
    Write-OK "SSH config exists: $SSH_CONFIG"
}

# ------------------------------------------------------------------
# 3. Add (or update) Host entry in SSH config
# ------------------------------------------------------------------
Write-Step "Configuring SSH host entry '$PI_HOST'..."

$currentConfig = Get-Content $SSH_CONFIG -Raw -ErrorAction SilentlyContinue
if ([string]::IsNullOrWhiteSpace($currentConfig)) { $currentConfig = "" }

if ($currentConfig -match "(?m)^Host\s+$PI_HOST\b") {
    $currentConfig = $currentConfig -replace "(?ms)(^|\r?\n)Host\s+$PI_HOST\b.*?(?=(\r?\n)Host\s|\z)", ""
    Write-Warn "Replaced existing '$PI_HOST' entry."
}

# Build host block as array then join to avoid here-string line-ending issues
$lines = @(
    "",
    "Host $PI_HOST",
    "    HostName $PI_IP",
    "    User $PI_USER",
    "    IdentityFile ~/.ssh/id_ed25519",
    "    AddKeysToAgent yes",
    "    StrictHostKeyChecking accept-new",
    "    ServerAliveInterval 60",
    "    ServerAliveCountMax 3"
)
$hostBlock = $lines -join "`r`n"

Set-Content -Path $SSH_CONFIG -Value ($currentConfig.TrimEnd() + $hostBlock) -NoNewline
Write-OK "Host '$PI_HOST' written to $SSH_CONFIG"

# ------------------------------------------------------------------
# 4. Test SSH connection and show Pi info
# ------------------------------------------------------------------
Write-Step "Testing SSH connection to $PI_USER@$PI_IP..."

# Simple commands with no complex quoting
$cmd = "hostname; hostname -I; cat /etc/os-release | grep PRETTY_NAME; uname -r; free -h | grep Mem; nproc; df -h /"
$piInfo = & ssh -o BatchMode=yes -o ConnectTimeout=5 "$PI_USER@$PI_IP" $cmd 2>&1

if ($LASTEXITCODE -ne 0) {
    Write-Err "Could not connect to $PI_USER@$PI_IP (exit $LASTEXITCODE)"
    Write-Host "  Ensure the Pi is on and SSH keys are set up."
    Write-Host "  From Git Bash run: ssh-copy-id $PI_USER@$PI_IP"
    exit 1
}

Write-OK "SSH connection successful!"
Write-Host ""
Write-Host "  Pi output:" -ForegroundColor Cyan
foreach ($line in $piInfo) {
    Write-Host "    $line"
}

# Verify the alias works
Write-Host ""
Write-Step "Verifying alias: ssh $PI_HOST ..."
& ssh -o BatchMode=yes -o ConnectTimeout=5 $PI_HOST "echo OK" 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-OK "Alias works: ssh $PI_HOST"
} else {
    Write-Warn "Alias test inconclusive. Try 'ssh $PI_HOST' manually after restarting your terminal."
}

# ------------------------------------------------------------------
# 5 & 6. VS Code instructions
# ------------------------------------------------------------------
Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " Step 1: Install Remote - SSH Extension"   -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  1. Open VS Code"
Write-Host "  2. Press Ctrl+Shift+X to open Extensions"
Write-Host "  3. Search for: Remote - SSH"
Write-Host "  4. Install the extension by Microsoft"
Write-Host "     (Publisher: ms-vscode-remote.remote-ssh)"
Write-Host ""

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " Step 2: Connect via Remote Explorer"      -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Option A - Remote Explorer sidebar:"
Write-Host "    1. Click the Remote Explorer icon (left sidebar)"
Write-Host "    2. Expand SSH under Remotes"
Write-Host "    3. Click '$PI_HOST'"
Write-Host "    4. Click 'Connect in New Window'"
Write-Host ""
Write-Host "  Option B - Command Palette:"
Write-Host "    1. Press Ctrl+Shift+P"
Write-Host "    2. Type: Remote-SSH: Connect to Host"
Write-Host "    3. Select '$PI_HOST'"
Write-Host ""
Write-Host "  First connection installs the VS Code server on the Pi"
Write-Host "  (~1-2 min, one-time only)."
Write-Host ""
Write-Host "  Once connected:"
Write-Host "    File > Open Folder > /home/$PI_USER"
Write-Host "    Press Ctrl+backtick to open a terminal running ON the Pi"
Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-OK   "Done. Connect with: ssh $PI_HOST"
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""
