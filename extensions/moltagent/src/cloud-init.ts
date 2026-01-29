/**
 * Cloud-Init Script Generator
 *
 * Generates the bash script that runs on a fresh VPS to bootstrap it into
 * a fully configured MoltAgent. This script is passed as user_data to the
 * cloud provider (Hetzner, DigitalOcean, etc.) and runs on first boot.
 *
 * The script:
 * 1. Installs system deps (Node 22, Chrome, misc tools)
 * 2. Installs moltbot globally
 * 3. Writes the agent manifest to disk
 * 4. Clones any configured repos
 * 5. Starts the moltbot gateway with the agent config
 * 6. Connects the bridge back to the control plane
 */
import type { MoltAgentManifest } from "./schema.js";

export function generateCloudInit(manifest: MoltAgentManifest): string {
  const manifestJson = JSON.stringify(manifest);
  // Base64-encode to avoid shell escaping issues
  const manifestB64 = Buffer.from(manifestJson).toString("base64");

  const repoSetupCommands = manifest.capabilities.repos
    .map(
      (repo) =>
        `echo "[moltagent] Cloning ${repo.url} -> ${repo.path}"
mkdir -p "$(dirname '${repo.path}')"
git clone --branch '${repo.branch}' --depth 1 '${repo.url}' '${repo.path}'
${repo.setupCommand ? `cd '${repo.path}' && ${repo.setupCommand}` : ""}`,
    )
    .join("\n\n");

  const systemPkgs = manifest.capabilities.systemPackages.length
    ? `apt-get install -y ${manifest.capabilities.systemPackages.join(" ")}`
    : "";

  const npmGlobals = manifest.capabilities.npmGlobals.length
    ? `npm install -g ${manifest.capabilities.npmGlobals.join(" ")}`
    : "";

  const pipPkgs = manifest.capabilities.pipPackages.length
    ? `pip3 install ${manifest.capabilities.pipPackages.join(" ")}`
    : "";

  const chromeInstall = manifest.capabilities.webBrowsing
    ? `
# -- Chrome for web browsing --
echo "[moltagent] Installing Chrome..."
wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
apt-get install -y /tmp/chrome.deb || apt-get install -yf
rm -f /tmp/chrome.deb
# Install Playwright browsers
npx playwright install --with-deps chromium`
    : "";

  const pythonInstall =
    manifest.capabilities.pipPackages.length > 0
      ? `
echo "[moltagent] Installing Python..."
apt-get install -y python3 python3-pip python3-venv`
      : "";

  const gatewayPort = 18789;

  return `#!/bin/bash
set -euo pipefail

# ============================================================
# MoltAgent Cloud-Init Bootstrap
# Agent: ${manifest.identity.name} (${manifest.identity.id})
# Generated: ${new Date().toISOString()}
# ============================================================

export DEBIAN_FRONTEND=noninteractive

echo "[moltagent] Starting bootstrap..."

# -- System update --
apt-get update -qq
apt-get upgrade -y -qq

# -- Core system packages --
apt-get install -y -qq \\
  curl wget git jq unzip ca-certificates gnupg \\
  build-essential

# -- Node.js 22 --
echo "[moltagent] Installing Node.js 22..."
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
npm install -g pnpm@latest

${pythonInstall}

${chromeInstall}

# -- Additional system packages --
${systemPkgs}

# -- Moltbot --
echo "[moltagent] Installing moltbot..."
npm install -g moltbot@latest

# -- Additional npm globals --
${npmGlobals}

# -- Additional pip packages --
${pipPkgs}

# -- Write agent manifest --
echo "[moltagent] Writing agent manifest..."
mkdir -p /opt/moltagent
echo '${manifestB64}' | base64 -d > /opt/moltagent/manifest.json
chmod 600 /opt/moltagent/manifest.json

# -- Workspace directory --
mkdir -p /workspace
cd /workspace

# -- Clone repos --
${repoSetupCommands}

# -- Configure moltbot --
echo "[moltagent] Configuring moltbot..."
moltbot config set gateway.mode local
moltbot config set gateway.port ${gatewayPort}

# Configure channels from manifest
CHANNELS=$(cat /opt/moltagent/manifest.json | jq -r '.channels.channels[]? | select(.enabled == true) | .type')
for CHANNEL in $CHANNELS; do
  echo "[moltagent] Enabling channel: $CHANNEL"
done

# -- Create systemd service --
echo "[moltagent] Creating systemd service..."
cat > /etc/systemd/system/moltagent.service << 'SYSTEMD_EOF'
[Unit]
Description=MoltAgent Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/workspace
Environment=NODE_ENV=production
Environment=MOLTAGENT_MANIFEST=/opt/moltagent/manifest.json
Environment=MOLTAGENT_ID=${manifest.identity.id}
ExecStart=/usr/bin/moltbot gateway run --bind 0.0.0.0 --port ${gatewayPort} --force
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SYSTEMD_EOF

systemctl daemon-reload
systemctl enable moltagent
systemctl start moltagent

# -- Signal readiness to control plane --
echo "[moltagent] Bootstrap complete. Agent ${manifest.identity.name} is live."
echo "[moltagent] Gateway running on port ${gatewayPort}"

# Notify control plane that we're ready (best-effort)
CONTROL_PLANE_URL="${manifest.controlPlane.url.replace("wss://", "https://").replace("ws://", "http://").replace(/\\/ws$/, "")}"
curl -sf -X POST "\${CONTROL_PLANE_URL}/agents/${manifest.identity.id}/status" \\
  -H "Authorization: Bearer ${manifest.controlPlane.token}" \\
  -H "Content-Type: application/json" \\
  -d '{"status":"ready","ip":"'"$(curl -sf https://checkip.amazonaws.com || echo unknown)"'"}' \\
  || echo "[moltagent] Control plane notification failed (non-fatal)"

echo "[moltagent] Done."
`;
}
