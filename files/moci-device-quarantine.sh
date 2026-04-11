#!/bin/sh

# MoCI Device Quarantine service
# Detects newly seen DHCP lease MACs and creates firewall reject rules.

set -u

DEFAULT_INTERVAL=15
DEFAULT_LEASES_FILE="/tmp/dhcp.leases"
DEFAULT_STATE_FILE="/tmp/moci-quarantine-known.txt"
DEFAULT_RULE_PREFIX="moci_quarantine_"
DEFAULT_LAN_NETWORK="lan"
DEFAULT_LAN_DEVICE="br-lan"
LOG_FILE="/tmp/moci-device-quarantine.log"

log() {
	local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
	echo "$msg" >>"$LOG_FILE" 2>/dev/null || true
	logger -t moci-device-quarantine "$*" 2>/dev/null || true
}

uci_get() {
	uci -q get "$1" 2>/dev/null || true
}

is_enabled_flag() {
	case "$1" in
	1|on|true|yes|enabled) return 0 ;;
	*) return 1 ;;
	esac
}

sanitize_name() {
	echo "$1" | tr '[:upper:]' '[:lower:]' | tr ' ' '_' | sed 's/[^a-z0-9_.-]//g' | cut -c1-24
}

load_config() {
	local v
	v="$(uci_get moci.features.quarantine)"
	if [ -z "$v" ]; then v="1"; fi
	FEATURE_ENABLED="$v"

	v="$(uci_get moci.quarantine.enabled)"
	if [ -z "$v" ]; then v="0"; fi
	QUARANTINE_ENABLED="$v"

	v="$(uci_get moci.quarantine.interval)"
	case "$v" in ''|*[!0-9]*) v="$DEFAULT_INTERVAL" ;; esac
	if [ "$v" -lt 10 ]; then v=10; fi
	if [ "$v" -gt 3600 ]; then v=3600; fi
	INTERVAL="$v"

	v="$(uci_get moci.quarantine.leases_file)"
	if [ -z "$v" ]; then v="$DEFAULT_LEASES_FILE"; fi
	LEASES_FILE="$v"

	v="$(uci_get moci.quarantine.state_file)"
	if [ -z "$v" ]; then v="$DEFAULT_STATE_FILE"; fi
	STATE_FILE="$v"

	v="$(uci_get moci.quarantine.rule_prefix)"
	if [ -z "$v" ]; then v="$DEFAULT_RULE_PREFIX"; fi
	RULE_PREFIX="$v"

	v="$(uci_get moci.quarantine.lan_network)"
	if [ -z "$v" ]; then v="$DEFAULT_LAN_NETWORK"; fi
	LAN_NETWORK="$v"

	v="$(uci_get moci.quarantine.lan_device)"
	if [ -z "$v" ]; then v="$(uci_get network.lan.device)"; fi
	if [ -z "$v" ]; then v="$(uci_get network.lan.ifname)"; fi
	if [ -z "$v" ]; then v="$DEFAULT_LAN_DEVICE"; fi
	LAN_DEVICE="$v"
}

service_enabled() {
	is_enabled_flag "$FEATURE_ENABLED" && is_enabled_flag "$QUARANTINE_ENABLED"
}

collect_leases() {
	if [ ! -f "$LEASES_FILE" ]; then
		return 0
	fi
	awk '{ if ($2 ~ /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/) print tolower($2) "|" $3 "|" $4 }' "$LEASES_FILE"
}

collect_ip_neigh() {
	# Collect only neighbors on the LAN device (for example br-lan), never apcli/wan side.
	ip neigh show dev "$LAN_DEVICE" 2>/dev/null | awk '{
		ip=$1
		mac=""
		for (i=1; i<=NF; i++) {
			if ($i == "lladdr" && (i+1) <= NF) { mac=$(i+1); break }
		}
		if (mac ~ /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/) {
			print tolower(mac) "|" ip "|"
		}
	}'
}

collect_wireless_clients() {
	# Prefer jsonfilter if available. Filter to interfaces attached to LAN network only.
	# Output format: mac|ip|host (ip/host may be empty here).
	command -v jsonfilter >/dev/null 2>&1 || return 0
	command -v ubus >/dev/null 2>&1 || return 0

	local json out
	json="$(ubus call network.wireless status 2>/dev/null || true)"
	[ -n "$json" ] || return 0

	out="$(
		{
			jsonfilter -s "$json" -e "@.*.interfaces[@.config.network='$LAN_NETWORK'].stations[*].mac" 2>/dev/null || true
			jsonfilter -s "$json" -e "@.*.interfaces[@.config.network[0]='$LAN_NETWORK'].stations[*].mac" 2>/dev/null || true
		} | tr ' ' '\n' | sed '/^$/d' | tr '[:upper:]' '[:lower:]' | sort -u
	)"

	[ -n "$out" ] || return 0
	echo "$out" | awk '{ print $1 "||" }'
}

collect_candidates() {
	{
		collect_leases
		collect_ip_neigh
		collect_wireless_clients
	} | awk -F'|' '
		{
			mac=tolower($1)
			ip=$2
			host=$3
			if (mac ~ /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/) {
				if (!(mac in seen)) {
					seen[mac]=1
					print mac "|" ip "|" host
				}
			}
		}
	'
}

rule_name_for() {
	local mac="$1"
	local host="$2"
	local safe
	safe="$(sanitize_name "$host")"
	if [ -z "$safe" ] || [ "$safe" = "*" ]; then
		safe="$(echo "$mac" | tr -d ':')"
	fi
	echo "${RULE_PREFIX}${safe}"
}

rule_exists_by_name() {
	local name="$1"
	uci -q show firewall | grep -q "name='$name'"
}

add_fw_rule() {
	local name="$1"
	local mac="$2"
	local dest="$3"
	local sid
	sid="$(uci add firewall rule 2>/dev/null || true)"
	[ -n "$sid" ] || return 1
	uci set firewall."$sid".name="$name"
	uci set firewall."$sid".src="lan"
	uci set firewall."$sid".dest="$dest"
	uci set firewall."$sid".src_mac="$mac"
	uci set firewall."$sid".proto="all"
	uci set firewall."$sid".target="REJECT"
	uci set firewall."$sid".family="any"
	uci set firewall."$sid".enabled="1"
	return 0
}

quarantine_new_device() {
	local mac="$1"
	local ip="$2"
	local host="$3"
	local base lan wan
	base="$(rule_name_for "$mac" "$host")"
	lan="${base}_lan"
	wan="${base}_wan"

	if ! rule_exists_by_name "$lan"; then
		add_fw_rule "$lan" "$mac" "lan" || true
	fi
	if ! rule_exists_by_name "$wan"; then
		add_fw_rule "$wan" "$mac" "wan" || true
	fi

	log "quarantined new device mac=$mac ip=$ip host=$host rules=[$lan,$wan]"
}

ensure_state_file() {
	local dir
	dir="$(dirname "$STATE_FILE")"
	mkdir -p "$dir" 2>/dev/null || true
	[ -f "$STATE_FILE" ] || : >"$STATE_FILE"
}

discover_once() {
	local changed tmp lease mac ip host
	load_config
	if ! service_enabled; then
		log "quarantine disabled (feature=$FEATURE_ENABLED enabled=$QUARANTINE_ENABLED); skipping scan"
		return 0
	fi

	ensure_state_file

	# First run: seed known list, do not quarantine current devices.
	if [ ! -s "$STATE_FILE" ]; then
		collect_candidates | cut -d'|' -f1 | sort -u >"$STATE_FILE"
		log "initialized known devices state at $STATE_FILE"
		return 0
	fi

	changed=0
	tmp="/tmp/moci-quarantine-seen.$$"
	collect_candidates >"$tmp"
	while IFS='|' read -r mac ip host; do
		[ -n "$mac" ] || continue
		if grep -qx "$mac" "$STATE_FILE" 2>/dev/null; then
			continue
		fi
		quarantine_new_device "$mac" "$ip" "$host"
		echo "$mac" >>"$STATE_FILE"
		changed=1
	done <"$tmp"
	rm -f "$tmp"

	if [ "$changed" = "1" ]; then
		uci commit firewall
		/etc/init.d/firewall reload >/dev/null 2>&1 || /etc/init.d/firewall restart >/dev/null 2>&1 || true
	fi
}

run_daemon() {
	log "starting quarantine daemon"
	while true; do
		load_config
		discover_once
		sleep "$INTERVAL"
	done
}

case "${1:-}" in
--once)
	discover_once
	;;
--daemon|"")
	run_daemon
	;;
*)
	echo "Usage: $0 [--once|--daemon]"
	exit 1
	;;
esac

exit 0
