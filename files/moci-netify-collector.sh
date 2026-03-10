#!/bin/sh

# MoCI Netify collector for OpenWrt.
# Connects to a Netify JSONL stream and stores selected fields in SQLite.

set -u

JSHN_LIB="/usr/share/libubox/jshn.sh"
DEFAULT_HOST="127.0.0.1"
DEFAULT_PORT="7150"
DEFAULT_DB="/tmp/moci-netify.sqlite"
DEFAULT_RETENTION_ROWS="5000"
RECONNECT_DELAY="3"

NETIFY_HOST="$DEFAULT_HOST"
NETIFY_PORT="$DEFAULT_PORT"
NETIFY_DB="$DEFAULT_DB"
RETENTION_ROWS="$DEFAULT_RETENTION_ROWS"

[ -f "$JSHN_LIB" ] && . "$JSHN_LIB"

log() {
	logger -t moci-netify-collector "$*"
}

sql_escape() {
	printf "%s" "$1" | sed "s/'/''/g"
}

sql_text() {
	local value="$1"
	printf "'%s'" "$(sql_escape "$value")"
}

sql_int() {
	case "${1:-}" in
		'' | *[!0-9]*)
			printf "0"
			;;
		*)
			printf "%s" "$1"
			;;
	esac
}

bool_to_int() {
	case "${1:-}" in
		1 | true | TRUE | yes | on)
			printf "1"
			;;
		*)
			printf "0"
			;;
	esac
}

load_config() {
	if command -v uci >/dev/null 2>&1; then
		local value

		value="$(uci -q get moci.collector.host 2>/dev/null || true)"
		[ -n "$value" ] && NETIFY_HOST="$value"

		value="$(uci -q get moci.collector.port 2>/dev/null || true)"
		[ -n "$value" ] && NETIFY_PORT="$value"

		value="$(uci -q get moci.collector.db_path 2>/dev/null || true)"
		[ -n "$value" ] && NETIFY_DB="$value"

		value="$(uci -q get moci.collector.retention_rows 2>/dev/null || true)"
		[ -n "$value" ] && RETENTION_ROWS="$value"
	fi
}

require_dependencies() {
	command -v sqlite3 >/dev/null 2>&1 || {
		log "sqlite3 not found; install sqlite3-cli"
		exit 1
	}

	command -v nc >/dev/null 2>&1 || {
		log "nc not found; install netcat"
		exit 1
	}

	[ -f "$JSHN_LIB" ] || {
		log "jshn library not found at $JSHN_LIB"
		exit 1
	}
}

init_db() {
	local dir
	dir="$(dirname "$NETIFY_DB")"
	mkdir -p "$dir"

	sqlite3 "$NETIFY_DB" <<'SQL'
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS flow (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	timeinsert TEXT NOT NULL,
	local_ip TEXT,
	local_mac TEXT,
	fqdn TEXT,
	dest_ip TEXT,
	dest_port INTEGER,
	detected_protocol_name TEXT,
	detected_app_name TEXT,
	interface TEXT,
	internal INTEGER DEFAULT 0,
	client_sni TEXT,
	dns_host_name TEXT,
	host_server_name TEXT,
	digest TEXT
);

CREATE TABLE IF NOT EXISTS stats_purge (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	timeinsert TEXT NOT NULL,
	type TEXT,
	digest TEXT,
	local_bytes INTEGER,
	other_bytes INTEGER,
	total_bytes INTEGER,
	local_packets INTEGER,
	other_packets INTEGER,
	total_packets INTEGER,
	interface TEXT,
	internal INTEGER DEFAULT 0,
	reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_flow_time ON flow(timeinsert);
CREATE INDEX IF NOT EXISTS idx_flow_mac ON flow(local_mac);
CREATE INDEX IF NOT EXISTS idx_flow_app ON flow(detected_app_name);
CREATE INDEX IF NOT EXISTS idx_purge_time ON stats_purge(timeinsert);
SQL
}

prune_db() {
	sqlite3 "$NETIFY_DB" "
DELETE FROM flow
WHERE id NOT IN (
	SELECT id FROM flow ORDER BY id DESC LIMIT $(sql_int "$RETENTION_ROWS")
);

DELETE FROM stats_purge
WHERE id NOT IN (
	SELECT id FROM stats_purge ORDER BY id DESC LIMIT $(sql_int "$RETENTION_ROWS")
);
"
}

process_flow_purge() {
	local timestamp interface internal reason
	local digest local_bytes other_bytes total_bytes local_packets other_packets total_packets

	timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
	json_get_var interface interface
	json_get_var internal internal
	json_get_var reason reason

	json_select flow || return 0
	json_get_var digest digest
	json_get_var local_bytes local_bytes
	json_get_var other_bytes other_bytes
	json_get_var total_bytes total_bytes
	json_get_var local_packets local_packets
	json_get_var other_packets other_packets
	json_get_var total_packets total_packets
	json_select ..

	sqlite3 "$NETIFY_DB" "
INSERT INTO stats_purge (
	timeinsert, type, digest, local_bytes, other_bytes, total_bytes,
	local_packets, other_packets, total_packets, interface, internal, reason
) VALUES (
	$(sql_text "$timestamp"),
	'flow_purge',
	$(sql_text "$digest"),
	$(sql_int "$local_bytes"),
	$(sql_int "$other_bytes"),
	$(sql_int "$total_bytes"),
	$(sql_int "$local_packets"),
	$(sql_int "$other_packets"),
	$(sql_int "$total_packets"),
	$(sql_text "$interface"),
	$(bool_to_int "$internal"),
	$(sql_text "$reason")
);"
}

process_flow() {
	local timestamp interface internal
	local local_ip local_mac fqdn dest_ip dest_port protocol app
	local client_sni dns_host_name host_server_name digest

	timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
	json_get_var interface interface
	json_get_var internal internal

	json_select flow || return 0
	json_get_var local_ip local_ip
	json_get_var local_mac local_mac
	json_get_var dest_ip other_ip
	json_get_var dest_port other_port
	json_get_var protocol detected_protocol_name
	json_get_var app detected_application_name
	json_get_var dns_host_name dns_host_name
	json_get_var host_server_name host_server_name
	json_get_var digest digest

	client_sni=""
	if json_select ssl 2>/dev/null; then
		json_get_var client_sni client_sni
		json_select ..
	fi

	json_select ..

	if [ -n "$client_sni" ]; then
		fqdn="$client_sni"
	elif [ -n "$host_server_name" ]; then
		fqdn="$host_server_name"
	else
		fqdn="$dns_host_name"
	fi

	sqlite3 "$NETIFY_DB" "
INSERT INTO flow (
	timeinsert, local_ip, local_mac, fqdn, dest_ip, dest_port, detected_protocol_name,
	detected_app_name, interface, internal, client_sni, dns_host_name, host_server_name, digest
) VALUES (
	$(sql_text "$timestamp"),
	$(sql_text "$local_ip"),
	$(sql_text "$local_mac"),
	$(sql_text "$fqdn"),
	$(sql_text "$dest_ip"),
	$(sql_int "$dest_port"),
	$(sql_text "$protocol"),
	$(sql_text "$app"),
	$(sql_text "$interface"),
	$(bool_to_int "$internal"),
	$(sql_text "$client_sni"),
	$(sql_text "$dns_host_name"),
	$(sql_text "$host_server_name"),
	$(sql_text "$digest")
);"
}

process_line() {
	local line="$1"
	local type

	[ -n "$line" ] || return 0

	json_cleanup
	json_load "$line" 2>/dev/null || return 0
	json_get_var type type

	case "$type" in
		flow_purge)
			process_flow_purge
			;;
		flow)
			process_flow
			;;
		*)
			;;
	esac
}

consume_stream() {
	local line counter
	counter=0

	nc "$NETIFY_HOST" "$NETIFY_PORT" | while IFS= read -r line; do
		process_line "$line"
		counter=$((counter + 1))
		if [ $((counter % 200)) -eq 0 ]; then
			prune_db
		fi
	done
}

run_forever() {
	log "starting netify collector host=$NETIFY_HOST port=$NETIFY_PORT db=$NETIFY_DB"
	while true; do
		log "connecting to netify stream at $NETIFY_HOST:$NETIFY_PORT"
		consume_stream || true
		log "stream disconnected; retrying in ${RECONNECT_DELAY}s"
		sleep "$RECONNECT_DELAY"
	done
}

main() {
	load_config
	require_dependencies
	init_db

	case "${1:-}" in
		--init-db)
			log "database initialized at $NETIFY_DB"
			exit 0
			;;
	esac

	run_forever
}

main "$@"
