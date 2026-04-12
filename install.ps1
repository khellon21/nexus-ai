# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  ✦ Nexus AI — One-Line Installer (Windows PowerShell)
#
#  Usage:
#    powershell -c "irm https://raw.githubusercontent.com/khellon21/nexus-ai/main/install.ps1 | iex"
#
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

$ErrorActionPreference = "Stop"
$RepoUrl = "https://github.com/khellon21/nexus-ai.git"
$InstallDir = "$HOME\nexus-ai"

# ── Banner ──────────────────────────────────────────────
Write-Host ""
Write-Host "  ███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗     █████╗ ██╗" -ForegroundColor Magenta
Write-Host "  ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝    ██╔══██╗██║" -ForegroundColor Magenta
Write-Host "  ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗    ███████║██║" -ForegroundColor Magenta
Write-Host "  ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║    ██╔══██║██║" -ForegroundColor Magenta
Write-Host "  ██║ ╚████║███████╗██╔╝ ╚██╗╚██████╔╝███████║    ██║  ██║██║" -ForegroundColor Magenta
Write-Host "  ╚═╝  ╚═══╝╚══════╝╚═╝   ╚═╝ ╚═════╝ ╚══════╝    ╚═╝  ╚═╝╚═╝" -ForegroundColor Magenta
Write-Host ""
Write-Host "  Your Private AI Assistant — Local, Fast, Always-On" -ForegroundColor Cyan
Write-Host "  ─────────────────────────────────────────────────────" -ForegroundColor DarkGray
Write-Host ""

$TotalSteps = 5

function Write-Step($Num, $Msg) {
    Write-Host ""
    Write-Host "  [$Num/$TotalSteps] " -ForegroundColor Magenta -NoNewline
    Write-Host "$Msg" -ForegroundColor White
}

function Write-Success($Msg) {
    Write-Host "  ✓  $Msg" -ForegroundColor Green
}

function Write-Warn($Msg) {
    Write-Host "  ⚠  $Msg" -ForegroundColor Yellow
}

function Write-Fail($Msg) {
    Write-Host "  ✗  $Msg" -ForegroundColor Red
    exit 1
}

# ── Step 1: Check Prerequisites ────────────────────────
Write-Step 1 "Checking prerequisites..."

# Check Git
try {
    $gitVersion = (git --version) -replace 'git version ', ''
    Write-Success "Git found (v$gitVersion)"
} catch {
    Write-Fail "Git is not installed. Download: https://git-scm.com/downloads"
}

# Check Node.js
try {
    $nodeVersion = (node -v) -replace 'v', ''
    $nodeMajor = [int]($nodeVersion.Split('.')[0])
    if ($nodeMajor -ge 18) {
        Write-Success "Node.js found (v$nodeVersion)"
    } else {
        Write-Fail "Node.js v18+ required but found v$nodeVersion. Download: https://nodejs.org"
    }
} catch {
    Write-Fail "Node.js is not installed. Download: https://nodejs.org"
}

# Check npm
try {
    $npmVersion = npm -v
    Write-Success "npm found (v$npmVersion)"
} catch {
    Write-Fail "npm is not installed. It should come with Node.js."
}

# ── Step 2: Clone Repository ───────────────────────────
Write-Step 2 "Cloning Nexus AI..."

if (Test-Path $InstallDir) {
    Write-Warn "Directory $InstallDir already exists. Pulling latest..."
    Set-Location $InstallDir
    git pull origin main --quiet 2>$null
    Write-Success "Updated existing installation"
} else {
    git clone --depth 1 $RepoUrl $InstallDir --quiet
    Write-Success "Cloned to $InstallDir"
    Set-Location $InstallDir
}

# ── Step 3: Install Dependencies ───────────────────────
Write-Step 3 "Installing dependencies..."

npm install --silent 2>&1 | Select-Object -Last 1
Write-Success "npm packages installed"

# ── Step 4: Install Playwright Browser ─────────────────
Write-Step 4 "Installing Playwright Chromium (for Cipher Academic Agent)..."

npx playwright install chromium 2>&1 | Select-Object -Last 3
Write-Success "Playwright Chromium installed"

# ── Step 5: Done ───────────────────────────────────────
Write-Step 5 "Installation complete!"

Write-Host ""
Write-Host "  ─────────────────────────────────────────────────────" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  ✦ Nexus AI has been installed successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "  Next steps:" -ForegroundColor White
Write-Host ""
Write-Host "    1. " -ForegroundColor Cyan -NoNewline; Write-Host "cd $InstallDir"
Write-Host "    2. " -ForegroundColor Cyan -NoNewline; Write-Host "npm run setup       " -NoNewline; Write-Host "# Configure AI provider, Telegram, etc." -ForegroundColor DarkGray
Write-Host "    3. " -ForegroundColor Cyan -NoNewline; Write-Host "npm run dev         " -NoNewline; Write-Host "# Start Nexus AI" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Cipher Academic Agent (optional):" -ForegroundColor White
Write-Host ""
Write-Host "    4. " -ForegroundColor Cyan -NoNewline; Write-Host "npm run cipher -- set-credentials   " -NoNewline; Write-Host "# Store portal login" -ForegroundColor DarkGray
Write-Host "    5. " -ForegroundColor Cyan -NoNewline; Write-Host "npm run cipher -- scan-now           " -NoNewline; Write-Host "# Test a manual scan" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  ─────────────────────────────────────────────────────" -ForegroundColor DarkGray
Write-Host "  All data stays local on your machine. Your data, your rules." -ForegroundColor DarkGray
Write-Host ""
