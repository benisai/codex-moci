#!/bin/sh

# OpenWrt bootstrap script for MoCI-related tooling.
# Safe to run multiple times.

set -u

if [ "$(id -u)" != "0" ]; then
	echo "Please run as root (use: su - or sudo)."
	exit 1
fi

log() {
	echo "[setup] $*"
}

have_command() {
	command -v "$1" >/dev/null 2>&1
}

SCRIPT_PATH="$0"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" 2>/dev/null && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd)"

# -----------------------------------------------------------------------------
# Set custom alias: cls -> clear
# -----------------------------------------------------------------------------
mkdir -p /etc/profile.d
cat <<'ALIAS_EOF' >/etc/profile.d/alias.sh
alias cls="clear"
ALIAS_EOF
log "Configured shell alias: cls"

# -----------------------------------------------------------------------------
# Check if USB/SD storage exists
# -----------------------------------------------------------------------------
get_mounted_location() {
	mount | grep -E '/dev/sd|/dev/mmcblk' | awk '{print $3}' | head -n 1
}

MOUNTED_DIR="$(get_mounted_location)"
if [ -n "$MOUNTED_DIR" ]; then
	extexist=1
	log "External storage detected at: $MOUNTED_DIR"
else
	extexist=0
	log "No external USB/SD storage detected"
fi

# -----------------------------------------------------------------------------
# Update package repositories
# -----------------------------------------------------------------------------
log "Updating package repositories"
opkg update

# -----------------------------------------------------------------------------
# Install required software if missing
# -----------------------------------------------------------------------------
software="nano vnstat2 vnstati2 luci-app-vnstat2 netifyd netdata nlbwmon luci-app-nlbwmon htop tcpdump-mini uhttpd-mod-ubus sqlite3-cli netcat"

for s in $software; do
	if opkg list-installed | grep -q "^$s -"; then
		log "$s is already installed"
		continue
	fi

	if ! opkg list | grep -q "^$s -"; then
		log "$s not found in current repo, skipping"
		continue
	fi

	log "$s is not installed. Installing..."
	if opkg install "$s"; then
		log "$s installation complete"
	else
		log "Failed to install $s"
	fi
done

# -----------------------------------------------------------------------------
# Install Netify collector files from repo into runtime paths
# -----------------------------------------------------------------------------
SRC_COLLECTOR="$REPO_DIR/files/moci-netify-collector.sh"
SRC_INIT="$REPO_DIR/files/netify-collector.init"

if [ -f "$SRC_COLLECTOR" ]; then
	cp "$SRC_COLLECTOR" /usr/bin/moci-netify-collector
	chmod +x /usr/bin/moci-netify-collector
	log "Installed /usr/bin/moci-netify-collector"
else
	log "Missing file, skipping collector install: $SRC_COLLECTOR"
fi

if [ -f "$SRC_INIT" ]; then
	cp "$SRC_INIT" /etc/init.d/netify-collector
	chmod +x /etc/init.d/netify-collector
	log "Installed /etc/init.d/netify-collector"
else
	log "Missing file, skipping init script install: $SRC_INIT"
fi

# -----------------------------------------------------------------------------
# Update netifyd config listen address to LAN IP
# -----------------------------------------------------------------------------
LAN_IP="$(uci -q get network.lan.ipaddr 2>/dev/null || true)"
CONFIG_FILE="/etc/netifyd.conf"

if [ -n "$LAN_IP" ] && [ -f "$CONFIG_FILE" ]; then
	cp "$CONFIG_FILE" "$CONFIG_FILE.bak"

	if grep -q "^listen_address\[0\]" "$CONFIG_FILE"; then
		sed -i "s|^listen_address\[0\].*|listen_address[0] = $LAN_IP|" "$CONFIG_FILE"
		log "Updated listen_address[0] with LAN IP: $LAN_IP"
	else
		if grep -q "^\[socket\]" "$CONFIG_FILE"; then
			sed -i "/^\[socket\]/a listen_address[0] = $LAN_IP" "$CONFIG_FILE"
			log "Added listen_address[0] under [socket] with LAN IP: $LAN_IP"
		else
			echo "[socket]" >>"$CONFIG_FILE"
			echo "listen_address[0] = $LAN_IP" >>"$CONFIG_FILE"
			log "Added [socket] and listen_address[0] with LAN IP: $LAN_IP"
		fi
	fi
else
	log "Could not update netifyd.conf (missing LAN IP or /etc/netifyd.conf)"
fi

# -----------------------------------------------------------------------------
# Update nlbwmon refresh interval
# -----------------------------------------------------------------------------
NLBW_CONFIG_FILE="/etc/config/nlbwmon"
if [ -f "$NLBW_CONFIG_FILE" ]; then
	if grep -q "option refresh_interval '10s'" "$NLBW_CONFIG_FILE" || grep -q "option refresh_interval 10s" "$NLBW_CONFIG_FILE"; then
		log "nlbwmon refresh_interval already set to 10s"
	else
		sed -i "s/option refresh_interval '30s'/option refresh_interval '10s'/" "$NLBW_CONFIG_FILE"
		sed -i "s/option refresh_interval 30s/option refresh_interval 10s/" "$NLBW_CONFIG_FILE"
		log "Updated nlbwmon refresh_interval to 10s"
	fi
else
	log "$NLBW_CONFIG_FILE does not exist; skipping nlbwmon tuning"
fi

# -----------------------------------------------------------------------------
# Enable and restart services
# -----------------------------------------------------------------------------
log "Enabling and restarting services"

for svc in nlbw-compare-rate-service.sh nlbwmon vnstat netifyd; do
	if [ -x "/etc/init.d/$svc" ]; then
		/etc/init.d/"$svc" enable || true
		/etc/init.d/"$svc" restart || true
		log "Restarted service: $svc"
	else
		if [ "$svc" = "netifyd" ] && have_command service; then
			service netifyd restart || true
			log "Restarted service via service command: netifyd"
		else
			log "Service not found, skipping: $svc"
		fi
	fi
done

if [ -x /usr/bin/moci-netify-collector ]; then
	/usr/bin/moci-netify-collector --init-db || true
	log "Ran Netify collector DB initialization"
else
	log "Skipping Netify DB init (collector binary missing)"
fi

if [ -x /etc/init.d/netify-collector ]; then
	/etc/init.d/netify-collector enable || true
	/etc/init.d/netify-collector start || true
	log "Enabled and started netify-collector service"
fi

log "Setup complete. A router reboot is recommended."
exit 0
