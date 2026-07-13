#!/usr/bin/env bash
# Host provisioning for the TNL dashboard stack — Ubuntu 22.04/24.04.
#
#   ./deploy/provision-host.sh            # 4G swap (default)
#   SWAP_GB=2 ./deploy/provision-host.sh  # override
#
# Idempotent: safe to re-run; each step is skipped if already satisfied.
#
# DELIBERATELY does NOT: change firewall rules, install a reverse proxy, apply
# system updates, or reboot. This box may be SHARED with someone else's
# services — those actions are coordinated by a human, not a script.
set -euo pipefail

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[warn] %s\033[0m\n' "$*"; }

[ "$(id -u)" -eq 0 ] && { echo "Run as your normal user (the script calls sudo itself)."; exit 1; }

# ── 1. Docker Engine + compose plugin ────────────────────────────────────────
# The official Docker repo, not snap and not the distro's docker.io: we need a
# current engine plus the `docker compose` v2 plugin the stack's commands use.
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  log "Docker already present — $(docker --version)"
else
  log "Installing Docker Engine + compose plugin"
  sudo apt-get update -qq
  sudo apt-get install -y ca-certificates curl gnupg
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] " \
       "https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io \
                          docker-buildx-plugin docker-compose-plugin
fi

# ── 2. Run docker without sudo ───────────────────────────────────────────────
if id -nG "$USER" | grep -qw docker; then
  log "$USER is already in the docker group"
else
  log "Adding $USER to the docker group"
  sudo usermod -aG docker "$USER"
  warn "Log out and back in (or run: newgrp docker) before docker works without sudo."
fi

# ── 3. Node.js ───────────────────────────────────────────────────────────────
# The stack itself runs in containers, but the provisioning CLIs run on the HOST
# because they write host files (deploy/.env, the compose override, the nginx
# vhost): db/new-faction.mjs and db/migrate.mjs. Ubuntu 24.04 ships Node 18,
# which is too old — take Node 24 from NodeSource.
NODE_MAJOR="${NODE_MAJOR:-24}"
if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge "$NODE_MAJOR" ] 2>/dev/null; then
  log "Node already present — $(node --version)"
else
  log "Installing Node.js ${NODE_MAJOR}.x (NodeSource)"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# ── 4. Swap ──────────────────────────────────────────────────────────────────
# Hetzner images ship with none. The SPA image build (Vite/npm) can transiently
# want 1–2 GB; on a 4 GB box beside someone else's services that is a real
# OOM-kill risk. Swap is the cheap insurance.
SWAPFILE=/swapfile
SWAP_GB="${SWAP_GB:-4}"
if [ -n "$(swapon --show --noheadings 2>/dev/null)" ]; then
  log "Swap already active — $(swapon --show --noheadings | head -1)"
else
  log "Creating ${SWAP_GB}G swapfile (none present)"
  sudo fallocate -l "${SWAP_GB}G" "$SWAPFILE" 2>/dev/null \
    || sudo dd if=/dev/zero of="$SWAPFILE" bs=1M count=$((SWAP_GB * 1024)) status=none
  sudo chmod 600 "$SWAPFILE"
  sudo mkswap "$SWAPFILE" >/dev/null
  sudo swapon "$SWAPFILE"
  grep -qs "^${SWAPFILE}" /etc/fstab \
    || echo "${SWAPFILE} none swap sw 0 0" | sudo tee -a /etc/fstab >/dev/null
  # Prefer RAM; use swap as a cushion, not as routine storage.
  sudo sysctl -qw vm.swappiness=10
  grep -qs '^vm.swappiness' /etc/sysctl.conf \
    || echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf >/dev/null
fi

# ── 5. Report ────────────────────────────────────────────────────────────────
log "Provisioning complete"
docker --version || true
docker compose version || true
node --version || true
echo
free -h
echo
df -h /
