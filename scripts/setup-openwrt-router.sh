#!/bin/sh

# MoCI OpenWrt bootstrap script
# Intended for fresh/new routers and safe to rerun.

set -u

if [ "$(id -u)" != "0" ]; then
	echo "Run as root."
	exit 1
fi

log() {
	echo "[moci-setup] $*"
}

have_cmd() {
	command -v "$1" >/dev/null 2>&1
}

SCRIPT_PATH="$0"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" 2>/dev/null && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd)"
INSTALL_PROFILE=""
INSTALL_ADBLOCK=0
INSTALL_PBR=0
INSTALL_NETIFY=0
INSTALL_ADBLOCK_OVERRIDE=""
INSTALL_PBR_OVERRIDE=""
INSTALL_NETIFY_OVERRIDE=""

usage() {
	cat <<'EOF'
Usage: sh scripts/setup-openwrt-router.sh [--profile=1|2|3] [--with-netify] [--without-netify] [--with-adblock] [--without-adblock] [--with-pbr] [--without-pbr] [--help]

Profiles:
  1  Install Moci Stack (Ping, Speedtest, Flows, nlbw, vnstat)
  2  Install Moci Stack + Adblock + PBR
  3  Install Moci Stack + Adblock + PBR + Netify

Options:
  --profile=N         Choose profile 1, 2, or 3 (non-interactive)
  --with-netify      Install and enable netifyd + netify-collector
  --without-netify   Skip netifyd + netify-collector install (default)
  --with-adblock     Install adblock package(s)
  --without-adblock  Skip adblock package(s)
  --with-pbr         Install pbr package(s)
  --without-pbr      Skip pbr package(s)
  --help             Show this help
EOF
}

prompt_install_profile() {
	while true; do
		cat <<'EOF'

Select installation profile:
  1) Install Moci Stack (Ping, Speedtest, Flows, nlbw, vnstat)
  2) Install Moci Stack + Adblock + PBR
  3) Install Moci Stack + Adblock + PBR + Netify
EOF
		printf "Enter option [1-3] (default: 1): "
		read -r choice
		choice="${choice:-1}"
		case "$choice" in
		1|2|3)
			INSTALL_PROFILE="$choice"
			return 0
			;;
		*)
			echo "Invalid selection: $choice"
			;;
		esac
	done
}

apply_install_profile() {
	case "$INSTALL_PROFILE" in
	1)
		INSTALL_ADBLOCK=0
		INSTALL_PBR=0
		INSTALL_NETIFY=0
		;;
	2)
		INSTALL_ADBLOCK=1
		INSTALL_PBR=1
		INSTALL_NETIFY=0
		;;
	3)
		INSTALL_ADBLOCK=1
		INSTALL_PBR=1
		INSTALL_NETIFY=1
		;;
	*)
		echo "Invalid profile: $INSTALL_PROFILE"
		exit 1
		;;
	esac
}

for arg in "$@"; do
	case "$arg" in
	--profile=*)
		INSTALL_PROFILE="${arg#*=}"
		;;
	--with-netify)
		INSTALL_NETIFY_OVERRIDE=1
		;;
	--without-netify)
		INSTALL_NETIFY_OVERRIDE=0
		;;
	--with-adblock)
		INSTALL_ADBLOCK_OVERRIDE=1
		;;
	--without-adblock)
		INSTALL_ADBLOCK_OVERRIDE=0
		;;
	--with-pbr)
		INSTALL_PBR_OVERRIDE=1
		;;
	--without-pbr)
		INSTALL_PBR_OVERRIDE=0
		;;
	--help|-h)
		usage
		exit 0
		;;
	*)
		echo "Unknown option: $arg"
		usage
		exit 1
		;;
	esac
done

if [ -z "$INSTALL_PROFILE" ]; then
	if [ "$#" -eq 0 ] && [ -t 0 ]; then
		prompt_install_profile
	else
		INSTALL_PROFILE=1
	fi
fi

apply_install_profile

[ -n "$INSTALL_ADBLOCK_OVERRIDE" ] && INSTALL_ADBLOCK="$INSTALL_ADBLOCK_OVERRIDE"
[ -n "$INSTALL_PBR_OVERRIDE" ] && INSTALL_PBR="$INSTALL_PBR_OVERRIDE"
[ -n "$INSTALL_NETIFY_OVERRIDE" ] && INSTALL_NETIFY="$INSTALL_NETIFY_OVERRIDE"

log "Selected profile=$INSTALL_PROFILE (adblock=$INSTALL_ADBLOCK pbr=$INSTALL_PBR netify=$INSTALL_NETIFY)"

require_file() {
	if [ ! -f "$1" ]; then
		echo "Missing required file: $1"
		exit 1
	fi
}

install_file() {
	src="$1"
	dst="$2"
	mode="$3"
	cp "$src" "$dst"
	chmod "$mode" "$dst"
	log "Installed $dst"
}

install_pkg_if_available() {
	pkg="$1"
	case "$PKG_MGR" in
	opkg)
		if opkg list-installed | grep -q "^$pkg -"; then
			log "Package already installed: $pkg"
			return 0
		fi
		if ! opkg list | grep -q "^$pkg -"; then
			log "Package unavailable in current feed, skipping: $pkg"
			return 1
		fi
		opkg install "$pkg" && log "Installed package: $pkg" && return 0
		log "Failed to install package: $pkg"
		return 1
		;;
	apk)
		if apk info -e "$pkg" >/dev/null 2>&1; then
			log "Package already installed: $pkg"
			return 0
		fi
		if ! apk search -x "$pkg" >/dev/null 2>&1; then
			log "Package unavailable in current feed, skipping: $pkg"
			return 1
		fi
		apk add "$pkg" && log "Installed package: $pkg" && return 0
		log "Failed to install package: $pkg"
		return 1
		;;
	*)
		log "No supported package manager available; skipping package: $pkg"
		return 1
		;;
	esac
}

install_first_available_pkg() {
	label="$1"
	shift
	for candidate in "$@"; do
		[ -n "$candidate" ] || continue
		if install_pkg_if_available "$candidate"; then
			log "Using package for $label: $candidate"
			return 0
		fi
	done
	log "No installable package found for $label"
	return 1
}

set_uci() {
	key="$1"
	value="$2"
	value="${value#\'}"
	value="${value%\'}"
	value="${value#\"}"
	value="${value%\"}"
	uci set "$key=$value"
}

require_file "$REPO_DIR/files/moci-connection-flow-collector.sh"
require_file "$REPO_DIR/files/moci-ping-monitor.sh"
require_file "$REPO_DIR/files/moci-dns-monitor.sh"
require_file "$REPO_DIR/files/moci-speedtest-monitor.sh"
require_file "$REPO_DIR/files/moci-notifications-db.sh"
require_file "$REPO_DIR/files/moci-state-sync.sh"
require_file "$REPO_DIR/files/moci-device-quarantine.sh"
require_file "$REPO_DIR/files/connection-flows-collector.init"
require_file "$REPO_DIR/files/ping-monitor.init"
require_file "$REPO_DIR/files/dns-monitor.init"
require_file "$REPO_DIR/files/moci-state-sync.init"
require_file "$REPO_DIR/files/device-quarantine.init"
require_file "$REPO_DIR/files/moci.config"
require_file "$REPO_DIR/rpcd-acl.json"
require_file "$REPO_DIR/moci/index.html"
if [ "$INSTALL_NETIFY" = "1" ]; then
	require_file "$REPO_DIR/files/moci-netify-collector.sh"
	require_file "$REPO_DIR/files/netify-collector.init"
fi

log "Updating package feeds"
PKG_MGR=""
if have_cmd opkg; then
	PKG_MGR="opkg"
	opkg update
elif have_cmd apk; then
	PKG_MGR="apk"
	apk update
else
	log "No supported package manager found (opkg/apk). Package install steps will be skipped."
fi

for pkg in \
	nano \
	htop \
	gawk \
	grep \
	sed \
	coreutils-sort \
	uhttpd-mod-ubus \
	vnstat2 \
	vnstati2 \
	luci-app-vnstat2 \
	nlbwmon \
	luci-app-nlbwmon \
	qos-scripts \
	luci-app-qos \
	wireguard-tools \
	kmod-wireguard \
	luci-proto-wireguard \
	tcpdump-mini \
	qrencode \
	sqlite3-cli
do
	install_pkg_if_available "$pkg"
done

if [ "$INSTALL_ADBLOCK" = "1" ]; then
	install_pkg_if_available "adblock"
	install_pkg_if_available "luci-app-adblock"
	install_pkg_if_available "adblock-fast"
	install_pkg_if_available "luci-app-adblock-fast"
fi

if [ "$INSTALL_PBR" = "1" ]; then
	install_pkg_if_available "pbr"
	install_pkg_if_available "luci-app-pbr"
fi

if [ "$INSTALL_NETIFY" = "1" ]; then
	install_pkg_if_available "netifyd"
fi

# Dependency package names can vary between opkg and apk feeds.
if [ "$INSTALL_NETIFY" = "1" ]; then
	install_first_available_pkg "netcat" netcat netcat-openbsd
fi
install_first_available_pkg "sqlite-cli" sqlite3-cli sqlite3
install_first_available_pkg "speedtest" speedtestcpp python3-speedtest-cli

log "Deploying MoCI web app"
mkdir -p /www/moci
cp -r "$REPO_DIR/moci/"* /www/moci/

log "Installing ACL"
install_file "$REPO_DIR/rpcd-acl.json" /usr/share/rpcd/acl.d/moci.json 0644

log "Installing backend workers and init scripts"
install_file "$REPO_DIR/files/moci-connection-flow-collector.sh" /usr/bin/moci-connection-flow-collector 0755
install_file "$REPO_DIR/files/moci-ping-monitor.sh" /usr/bin/moci-ping-monitor 0755
install_file "$REPO_DIR/files/moci-dns-monitor.sh" /usr/bin/moci-dns-monitor 0755
install_file "$REPO_DIR/files/moci-speedtest-monitor.sh" /usr/bin/moci-speedtest-monitor 0755
install_file "$REPO_DIR/files/moci-notifications-db.sh" /usr/bin/moci-notifications-db 0755
install_file "$REPO_DIR/files/moci-state-sync.sh" /usr/bin/moci-state-sync 0755
install_file "$REPO_DIR/files/moci-device-quarantine.sh" /usr/bin/moci-device-quarantine 0755
install_file "$REPO_DIR/files/connection-flows-collector.init" /etc/init.d/connection-flows-collector 0755
install_file "$REPO_DIR/files/ping-monitor.init" /etc/init.d/ping-monitor 0755
install_file "$REPO_DIR/files/dns-monitor.init" /etc/init.d/dns-monitor 0755
install_file "$REPO_DIR/files/moci-state-sync.init" /etc/init.d/moci-state-sync 0755
install_file "$REPO_DIR/files/device-quarantine.init" /etc/init.d/moci-device-quarantine 0755
if [ "$INSTALL_NETIFY" = "1" ]; then
	install_file "$REPO_DIR/files/moci-netify-collector.sh" /usr/bin/moci-netify-collector 0755
	install_file "$REPO_DIR/files/netify-collector.init" /etc/init.d/netify-collector 0755
fi

if [ -f /etc/config/moci ]; then
	cp /etc/config/moci "/etc/config/moci.bak.$(date +%Y%m%d%H%M%S)"
	log "Backed up existing /etc/config/moci"
fi
install_file "$REPO_DIR/files/moci.config" /etc/config/moci 0644

log "Setting uhttpd home to /www"
set_uci uhttpd.main.home "/www"
uci commit uhttpd

log "Applying MoCI runtime defaults"
set_uci moci.features.qosify "1"
set_uci moci.features.adblock "$INSTALL_ADBLOCK"
set_uci moci.features.adblock_fast "$INSTALL_ADBLOCK"
set_uci moci.features.pbr "$INSTALL_PBR"
set_uci moci.features.netify "$INSTALL_NETIFY"
set_uci moci.collector.enabled "$INSTALL_NETIFY"
set_uci moci.collector.host "127.0.0.1"
set_uci moci.collector.port "7150"
set_uci moci.collector.db_path "/tmp/moci-netify.sqlite"
set_uci moci.collector.retention_rows "500000"
set_uci moci.collector.stream_timeout "45"
set_uci moci.collector.exclude_protocols "MDNS,DNS,QUIC,DHCPv6,ICMP"
set_uci moci.collector.ignore_wan_source "1"
set_uci moci.connection_flows.enabled "1"
set_uci moci.connection_flows.db_path "/tmp/connection-flows.sqlite"
set_uci moci.connection_flows.poll_seconds "5"
set_uci moci.connection_flows.retention_rows "50000"
set_uci moci.connection_flows.exclude_endpoints "127.0.0.1"
set_uci moci.connection_flows.ignore_ipv6 "1"
set_uci moci.connection_flows.lan_to_wan_only "0"
set_uci moci.ping_monitor.enabled "1"
set_uci moci.ping_monitor.target "1.1.1.1"
set_uci moci.ping_monitor.interval "60"
set_uci moci.ping_monitor.threshold "100"
set_uci moci.ping_monitor.timeout "2"
set_uci moci.ping_monitor.output_file "/tmp/moci-ping-monitor.txt"
set_uci moci.ping_monitor.max_lines "2000"
set_uci moci.dns_monitor.enabled "1"
set_uci moci.dns_monitor.target "openwrt.org"
set_uci moci.dns_monitor.interval "60"
set_uci moci.dns_monitor.threshold "1000"
set_uci moci.dns_monitor.timeout "3"
set_uci moci.dns_monitor.output_file "/tmp/moci-dns-monitor.txt"
set_uci moci.dns_monitor.max_lines "2000"
set_uci moci.speedtest_monitor.enabled "1"
set_uci moci.speedtest_monitor.run_hour "3"
set_uci moci.speedtest_monitor.run_minute "15"
set_uci moci.speedtest_monitor.bin "/usr/bin/speedtest"
set_uci moci.speedtest_monitor.output_file "/tmp/moci-speedtest-monitor.txt"
set_uci moci.speedtest_monitor.max_lines "365"
set_uci moci.dashboard.provider "auto"
set_uci moci.dashboard.window_seconds "900"
set_uci moci.quarantine.enabled "0"
set_uci moci.quarantine.interval "15"
set_uci moci.quarantine.leases_file "/tmp/dhcp.leases"
set_uci moci.quarantine.state_file "/tmp/moci-quarantine-known.txt"
set_uci moci.quarantine.rule_prefix "moci_quarantine_"
set_uci moci.state_backup.backup_time "720"
set_uci moci.state_backup.state_dir "/overlay/moci-state"
set_uci moci.notifications.db_path "/tmp/moci-notifications.sqlite"
uci commit moci

if [ "$INSTALL_NETIFY" = "1" ]; then
	NETIFYD_CONF="/etc/netifyd.conf"
	if [ -f "$NETIFYD_CONF" ]; then
		if grep -q "^listen_address\[0\]" "$NETIFYD_CONF"; then
			sed -i "s|^listen_address\[0\].*|listen_address[0] = 127.0.0.1|" "$NETIFYD_CONF"
		else
			grep -q "^\[socket\]" "$NETIFYD_CONF" || echo "[socket]" >>"$NETIFYD_CONF"
			sed -i "/^\[socket\]/a listen_address[0] = 127.0.0.1" "$NETIFYD_CONF"
		fi
		log "Updated netifyd listen_address[0] to 127.0.0.1"
	fi
elif [ -x /etc/init.d/netify-collector ]; then
	/etc/init.d/netify-collector stop || true
	/etc/init.d/netify-collector disable || true
fi

NLBW_CONF="/etc/config/nlbwmon"
if [ -f "$NLBW_CONF" ]; then
	sed -i "s/option refresh_interval '30s'/option refresh_interval '10s'/" "$NLBW_CONF"
	sed -i "s/option refresh_interval 30s/option refresh_interval 10s/" "$NLBW_CONF"
	log "Set nlbwmon refresh_interval to 10s"
fi

log "Initializing data files"
if [ "$INSTALL_NETIFY" = "1" ] && [ -x /usr/bin/moci-netify-collector ]; then
	/usr/bin/moci-netify-collector --init-db || true
fi
/usr/bin/moci-connection-flow-collector --init-db || true
/usr/bin/moci-ping-monitor --once || true
/usr/bin/moci-dns-monitor --once || true
/usr/bin/moci-speedtest-monitor --init-file || true
/usr/bin/moci-notifications-db --init-db || true
/usr/bin/moci-state-sync restore || true
/usr/bin/moci-state-sync sync-cron || true

if [ "$INSTALL_NETIFY" = "1" ] && ! have_cmd nc; then
	log "WARNING: nc command not found; netify collector will not ingest flows."
fi
if [ "$INSTALL_NETIFY" = "1" ] && ! have_cmd sqlite3 && ! have_cmd sqlite3-cli; then
	log "WARNING: sqlite3/sqlite3-cli not found; netify collector and UI sqlite queries will fail."
fi

log "Enabling and restarting services"
/etc/init.d/rpcd restart || true
/etc/init.d/uhttpd restart || true

log "Applying daily speedtest cron schedule"
SPEEDTEST_MARKER="# MOCI_SPEEDTEST_MONITOR"
CRON_PATH="/etc/crontabs/root"
TMP_CRON="/tmp/.moci_cron.$$"
HOUR="$(uci -q get moci.speedtest_monitor.run_hour 2>/dev/null || echo 3)"
MINUTE="$(uci -q get moci.speedtest_monitor.run_minute 2>/dev/null || echo 15)"
ENABLED="$(uci -q get moci.speedtest_monitor.enabled 2>/dev/null || echo 1)"
case "$HOUR" in ''|*[!0-9]*) HOUR=3 ;; esac
case "$MINUTE" in ''|*[!0-9]*) MINUTE=15 ;; esac
if [ "$HOUR" -gt 23 ]; then HOUR=3; fi
if [ "$MINUTE" -gt 59 ]; then MINUTE=15; fi
if [ -f "$CRON_PATH" ]; then
	grep -v "$SPEEDTEST_MARKER" "$CRON_PATH" >"$TMP_CRON" 2>/dev/null || : >"$TMP_CRON"
else
	: >"$TMP_CRON"
fi
if [ "$ENABLED" = "1" ]; then
	echo "$MINUTE $HOUR * * * /usr/bin/moci-speedtest-monitor --once >/tmp/moci-speedtest-monitor.last.log 2>&1 $SPEEDTEST_MARKER" >>"$TMP_CRON"
fi
cp "$TMP_CRON" "$CRON_PATH"
rm -f "$TMP_CRON"
/bin/sh -c '/etc/init.d/cron reload 2>/dev/null || /etc/init.d/cron restart 2>/dev/null || /etc/init.d/crond reload 2>/dev/null || /etc/init.d/crond restart 2>/dev/null || killall -HUP crond 2>/dev/null || true'

SERVICES="vnstat nlbwmon connection-flows-collector ping-monitor dns-monitor moci-state-sync moci-device-quarantine"
if [ "$INSTALL_NETIFY" = "1" ]; then
	SERVICES="vnstat nlbwmon netifyd netify-collector connection-flows-collector ping-monitor dns-monitor moci-state-sync moci-device-quarantine"
fi
if [ "$INSTALL_ADBLOCK" = "1" ]; then
	SERVICES="$SERVICES adblock adblock-fast"
fi
if [ "$INSTALL_PBR" = "1" ]; then
	SERVICES="$SERVICES pbr"
fi
for svc in $SERVICES; do
	if [ -x "/etc/init.d/$svc" ]; then
		/etc/init.d/"$svc" enable || true
		/etc/init.d/"$svc" restart || true
		log "Service restarted: $svc"
	fi
done

log "Finalizing ACL and web server settings"
cp "$REPO_DIR/rpcd-acl.json" /usr/share/rpcd/acl.d/moci.json
/etc/init.d/rpcd restart || true
/etc/init.d/uhttpd restart || true
uci set uhttpd.main.home='/www'
uci commit uhttpd
/etc/init.d/uhttpd restart || true

log "Ensuring moci-state-sync restore runs from rc.local"
if [ -f /etc/rc.local ]; then
	if ! grep -q '/usr/bin/moci-state-sync restore' /etc/rc.local 2>/dev/null; then
		RC_TMP="/tmp/.moci_rc_local.$$"
		awk '
			BEGIN { added=0 }
			/^exit 0$/ && !added { print "/usr/bin/moci-state-sync restore"; added=1 }
			{ print }
			END {
				if (!added) {
					print "/usr/bin/moci-state-sync restore"
					print "exit 0"
				}
			}
		' /etc/rc.local >"$RC_TMP"
		cp "$RC_TMP" /etc/rc.local
		rm -f "$RC_TMP"
	fi
else
	cat <<'EOF' >/etc/rc.local
/usr/bin/moci-state-sync restore
exit 0
EOF
fi
chmod +x /etc/rc.local

log "Setup complete."
log "Open: http://$(uci -q get network.lan.ipaddr 2>/dev/null || echo 192.168.1.1)/moci/"
log "Log out/in after ACL changes to refresh ubus session permissions."

exit 0
