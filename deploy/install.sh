#!/bin/sh
# Installs rtp2ws natively on a clean Debian 13 (trixie) host: Asterisk from
# the Debian sid repository (carries the Asterisk LTS packages, AMR-WB codec
# included) and the pre-built sidecar under /opt/rtp2ws, both run by systemd.
#
# Expects the release-tarball layout (sidecar/, asterisk/, systemd/ next to
# this script) — see docs/debian-install.md. Idempotent: re-run to upgrade.
set -eu

[ "$(id -u)" -eq 0 ] || { echo "install.sh: must run as root" >&2; exit 1; }
HERE=$(CDPATH= cd "$(dirname "$0")" && pwd)

. /etc/os-release
[ "${VERSION_CODENAME:-}" = "trixie" ] \
  || echo "install.sh: warning: expected Debian 13 (trixie), found ${PRETTY_NAME:-unknown}" >&2

# --- Asterisk from sid ------------------------------------------------------
# trixie ships no asterisk package; sid carries the Asterisk LTS release
# (currently 22.x) including codec_amr.so / res_format_attr_amr.so (AMR +
# AMR-WB). Pin sid low globally so only the listed packages come from it.
cat > /etc/apt/sources.list.d/debian-sid.sources <<'EOF'
Types: deb
URIs: http://deb.debian.org/debian
Suites: sid
Components: main contrib non-free non-free-firmware
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
EOF
cat > /etc/apt/preferences.d/90-sid <<'EOF'
Package: *
Pin: release n=sid
Pin-Priority: 100
EOF
cat > /etc/apt/preferences.d/91-asterisk-sid <<'EOF'
Package: asterisk asterisk-* libasterisk* dahdi* libpri*
Pin: release n=sid
Pin-Priority: 990
EOF

apt-get update
# -t sid (the reference role's default_release) lets apt satisfy the asterisk
# packages' dependencies from sid where trixie's versions are too old —
# currently that pulls in sid's glibc and libsnmp. Without it the
# priority-100 pin blocks those upgrades and resolution fails. The AMR(-WB)
# libraries are hard dependencies of asterisk-modules and come in with it.
DEBIAN_FRONTEND=noninteractive apt-get install -y -t sid asterisk asterisk-modules
# nodejs runs the sidecar, python3-yaml the config renderer — from trixie.
DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs python3-yaml ca-certificates

# Run Asterisk as the asterisk user (Debian's unit reads these).
for kv in 'AST_USER="asterisk"' 'AST_GROUP="asterisk"' 'RUNASTERISK="yes"'; do
  k=${kv%%=*}
  if grep -q "^$k=" /etc/default/asterisk 2>/dev/null; then
    sed -i "s|^$k=.*|$kv|" /etc/default/asterisk
  else
    echo "$kv" >> /etc/default/asterisk
  fi
done

# --- Sidecar ----------------------------------------------------------------
id rtp2ws >/dev/null 2>&1 || useradd --system --shell /usr/sbin/nologin rtp2ws
mkdir -p /opt/rtp2ws
rm -rf /opt/rtp2ws/sidecar
cp -a "$HERE/sidecar" /opt/rtp2ws/sidecar
install -m 0755 "$HERE/asterisk/render-config.py" /opt/rtp2ws/render-config.py

# --- Config -----------------------------------------------------------------
# One YAML drives both services (spec §8). Never overwrite an existing one.
mkdir -p /etc/rtp2ws
FRESH_CONFIG=
if [ ! -e /etc/rtp2ws/rtp2ws.yaml ]; then
  install -m 0640 -g rtp2ws "$HERE/rtp2ws.example.yaml" /etc/rtp2ws/rtp2ws.yaml
  FRESH_CONFIG=1
fi

# --- systemd ----------------------------------------------------------------
mkdir -p /etc/systemd/system/asterisk.service.d
install -m 0644 "$HERE/systemd/asterisk-override.conf" \
  /etc/systemd/system/asterisk.service.d/rtp2ws.conf
install -m 0644 "$HERE/systemd/rtp2ws-sidecar.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable asterisk rtp2ws-sidecar

if [ -n "$FRESH_CONFIG" ]; then
  cat <<'EOF'

Installed. Now configure and start:

  1. Edit /etc/rtp2ws/rtp2ws.yaml   (publicIp, trunk, targets — see comments)
  2. systemctl restart asterisk rtp2ws-sidecar

EOF
else
  systemctl restart asterisk rtp2ws-sidecar
  echo "Upgraded; asterisk and rtp2ws-sidecar restarted."
fi
