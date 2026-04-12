#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  ✦ Nexus AI — One-Line Installer (macOS / Linux)
#  
#  Usage:
#    curl -fsSL https://raw.githubusercontent.com/khellon21/nexus-ai/main/install.sh | bash
#
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

set -e

# ── Colors ──────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
MAGENTA='\033[0;35m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m' # No Color

REPO_URL="https://github.com/khellon21/nexus-ai.git"
INSTALL_DIR="$HOME/nexus-ai"

# ── Banner ──────────────────────────────────────────────
echo ""
echo -e "${MAGENTA}${BOLD}"
echo "  ███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗     █████╗ ██╗"
echo "  ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝    ██╔══██╗██║"
echo "  ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗    ███████║██║"
echo "  ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║    ██╔══██║██║"
echo "  ██║ ╚████║███████╗██╔╝ ╚██╗╚██████╔╝███████║    ██║  ██║██║"
echo "  ╚═╝  ╚═══╝╚══════╝╚═╝   ╚═╝ ╚═════╝ ╚══════╝    ╚═╝  ╚═╝╚═╝"
echo -e "${NC}"
echo -e "${CYAN}  Your Private AI Assistant — Local, Fast, Always-On${NC}"
echo -e "${DIM}  ─────────────────────────────────────────────────────${NC}"
echo ""

# ── Helper Functions ────────────────────────────────────
info()    { echo -e "  ${CYAN}ℹ${NC}  $1"; }
success() { echo -e "  ${GREEN}✓${NC}  $1"; }
warn()    { echo -e "  ${YELLOW}⚠${NC}  $1"; }
fail()    { echo -e "  ${RED}✗${NC}  $1"; exit 1; }
step()    { echo -e "\n  ${BOLD}${MAGENTA}[$1/${TOTAL_STEPS}]${NC} ${BOLD}$2${NC}"; }

TOTAL_STEPS=5

# ── Step 1: Check Prerequisites ────────────────────────
step 1 "Checking prerequisites..."

# Check for Git
if command -v git &> /dev/null; then
    GIT_VERSION=$(git --version | awk '{print $3}')
    success "Git found (v${GIT_VERSION})"
else
    fail "Git is not installed. Please install Git first:\n       ${DIM}https://git-scm.com/downloads${NC}"
fi

# Check for Node.js
if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v | sed 's/v//')
    NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
    if [ "$NODE_MAJOR" -ge 18 ]; then
        success "Node.js found (v${NODE_VERSION})"
    else
        fail "Node.js v18+ is required but found v${NODE_VERSION}.\n       Download: ${DIM}https://nodejs.org${NC}"
    fi
else
    fail "Node.js is not installed. Please install Node.js 18+:\n       ${DIM}https://nodejs.org${NC}"
fi

# Check for npm
if command -v npm &> /dev/null; then
    NPM_VERSION=$(npm -v)
    success "npm found (v${NPM_VERSION})"
else
    fail "npm is not installed. It should come with Node.js."
fi

# ── Step 2: Clone Repository ───────────────────────────
step 2 "Cloning Nexus AI..."

if [ -d "$INSTALL_DIR" ]; then
    warn "Directory ${INSTALL_DIR} already exists."
    echo -e "  ${DIM}   Pulling latest changes...${NC}"
    cd "$INSTALL_DIR"
    git pull origin main --quiet 2>/dev/null || true
    success "Updated existing installation"
else
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" --quiet
    success "Cloned to ${INSTALL_DIR}"
    cd "$INSTALL_DIR"
fi

# ── Step 3: Detect System Resources ────────────────────
step 3 "Detecting system resources..."

LOW_SPEC=false
SWAP_CREATED=false

# Detect available RAM (works on both Linux and macOS)
if [ -f /proc/meminfo ]; then
    TOTAL_RAM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
    TOTAL_RAM_MB=$((TOTAL_RAM_KB / 1024))
    AVAIL_RAM_KB=$(grep MemAvailable /proc/meminfo | awk '{print $2}')
    AVAIL_RAM_MB=$((AVAIL_RAM_KB / 1024))
else
    # macOS fallback
    TOTAL_RAM_MB=$(( $(sysctl -n hw.memsize) / 1024 / 1024 ))
    AVAIL_RAM_MB=$TOTAL_RAM_MB
fi

info "Total RAM: ${TOTAL_RAM_MB}MB | Available: ${AVAIL_RAM_MB}MB"

if [ "$TOTAL_RAM_MB" -lt 2048 ]; then
    LOW_SPEC=true
    warn "Low-spec server detected (< 2GB RAM). Enabling memory-safe install mode."

    # Auto-create swap if running as root on Linux and no swap exists
    CURRENT_SWAP=$(free -m 2>/dev/null | grep Swap | awk '{print $2}' || echo "0")
    if [ "$CURRENT_SWAP" = "0" ] && [ "$(id -u)" = "0" ] && [ -f /proc/meminfo ]; then
        info "Creating 1GB swap file for compilation..."
        dd if=/dev/zero of=/swapfile bs=1M count=1024 status=none 2>/dev/null || true
        chmod 600 /swapfile 2>/dev/null || true
        mkswap /swapfile 2>/dev/null | tail -1 || true
        swapon /swapfile 2>/dev/null || true
        SWAP_CREATED=true
        success "Temporary 1GB swap enabled"
    elif [ "$CURRENT_SWAP" = "0" ] && [ "$(id -u)" != "0" ]; then
        warn "No swap detected. If install freezes, re-run with: sudo bash install.sh"
    fi
fi

# ── Step 4: Install Dependencies ───────────────────────
step 4 "Installing npm packages..."

if [ "$LOW_SPEC" = true ]; then
    info "Using low-memory mode: throttled concurrency, capped heap size"
    export NODE_OPTIONS="--max-old-space-size=256"
    npm install --maxsockets=2 --no-optional 2>&1 | tail -5
else
    npm install 2>&1 | tail -3
fi
success "npm packages installed"

# ── Step 5: Install Playwright (Optional) ──────────────
step 5 "Installing Playwright Chromium (for Cipher Academic Agent)..."

if [ "$LOW_SPEC" = true ]; then
    info "Low-spec mode: skipping Playwright auto-install to save resources."
    warn "To install Playwright later, run:  npx playwright install chromium"
else
    npx playwright install chromium 2>&1 | tail -3
    success "Playwright Chromium installed"
fi

# ── Cleanup Swap ───────────────────────────────────────
if [ "$SWAP_CREATED" = true ]; then
    swapoff /swapfile 2>/dev/null || true
    rm -f /swapfile 2>/dev/null || true
    info "Temporary swap removed"
fi

# ── Done ───────────────────────────────────────────────
echo ""
echo -e "  ${DIM}─────────────────────────────────────────────────────${NC}"
echo ""
echo -e "  ${GREEN}${BOLD}✦ Nexus AI has been installed successfully!${NC}"
echo ""
echo -e "  ${BOLD}Next steps:${NC}"
echo ""
echo -e "    ${CYAN}1.${NC} cd ${INSTALL_DIR}"
echo -e "    ${CYAN}2.${NC} npm run setup       ${DIM}# Configure AI provider, Telegram, etc.${NC}"
echo -e "    ${CYAN}3.${NC} npm run dev         ${DIM}# Start Nexus AI${NC}"
echo ""
echo -e "  ${BOLD}Cipher Academic Agent (optional):${NC}"
echo ""
echo -e "    ${CYAN}4.${NC} npm run cipher -- set-credentials   ${DIM}# Store portal login${NC}"
echo -e "    ${CYAN}5.${NC} npm run cipher -- scan-now           ${DIM}# Test a manual scan${NC}"
echo ""
echo -e "  ${BOLD}Run in background 24/7:${NC}"
echo ""
echo -e "    ${CYAN}$${NC} npm install -g pm2"
echo -e "    ${CYAN}$${NC} pm2 start ecosystem.config.cjs"
echo ""
echo -e "  ${DIM}─────────────────────────────────────────────────────${NC}"
echo -e "  ${DIM}All data stays local on your machine. Your data, your rules.${NC}"
echo ""
