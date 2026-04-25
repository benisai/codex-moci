#!/bin/sh

# MoCI lightweight connection flow collector for OpenWrt.
# Samples conntrack every few seconds and stores unique snapshots in SQLite.

set -e

DEFAULT_DB="/tmp/connection-flows.sqlite"
DEFAULT_POLL_SECONDS="5"
DEFAULT_RETENTION_ROWS="50000"
LOG_FILE="/tmp/moci-connection-flows-collector.log"

FLOW_DB="$DEFAULT_DB"
POLL_SECONDS="$DEFAULT_POLL_SECONDS"
RETENTION_ROWS="$DEFAULT_RETENTION_ROWS"
SQLITE_BIN=""

log() {
	printf "%s %s\n" "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

init_logging() {
	local dir
	dir="$(dirname "$LOG_FILE")"
	mkdir -p "$dir"
	touch "$LOG_FILE"
	exec >>"$LOG_FILE" 2>&1
}

sanitize_text() {
	local value
	value="${1:-}"
	value="${value#\'}"
	value="${value%\'}"
	value="${value#\"}"
	value="${value%\"}"
	printf "%s" "$value"
}

sanitize_int() {
	case "${1:-}" in
		'' | *[!0-9]*)
			echo "$2"
			;;
		*)
			echo "$1"
			;;
	esac
}

find_sqlite_bin() {
	if command -v sqlite3 >/dev/null 2>&1; then
		SQLITE_BIN="$(command -v sqlite3)"
		return 0
	fi
	if command -v sqlite3-cli >/dev/null 2>&1; then
		SQLITE_BIN="$(command -v sqlite3-cli)"
		return 0
	fi
	return 1
}

sql_exec() {
	local query output
	query="$1"
	if ! output="$("$SQLITE_BIN" "$FLOW_DB" "PRAGMA busy_timeout=3000; $query" 2>&1)"; then
		log "sqlite error: $output"
		return 1
	fi
	return 0
}

load_config() {
	if command -v uci >/dev/null 2>&1; then
		local value
		value="$(uci -q get moci.connection_flows.db_path 2>/dev/null || true)"
		value="$(sanitize_text "$value")"
		[ -n "$value" ] && FLOW_DB="$value"

		value="$(uci -q get moci.connection_flows.poll_seconds 2>/dev/null || true)"
		value="$(sanitize_text "$value")"
		[ -n "$value" ] && POLL_SECONDS="$value"

		value="$(uci -q get moci.connection_flows.retention_rows 2>/dev/null || true)"
		value="$(sanitize_text "$value")"
		[ -n "$value" ] && RETENTION_ROWS="$value"
	fi

	POLL_SECONDS="$(sanitize_int "$POLL_SECONDS" "$DEFAULT_POLL_SECONDS")"
	RETENTION_ROWS="$(sanitize_int "$RETENTION_ROWS" "$DEFAULT_RETENTION_ROWS")"
	[ "$POLL_SECONDS" -lt 1 ] && POLL_SECONDS=5
	[ "$RETENTION_ROWS" -lt 100 ] && RETENTION_ROWS=100
}

ensure_db_file() {
	local dir
	dir="$(dirname "$FLOW_DB")"
	mkdir -p "$dir"
	[ -f "$FLOW_DB" ] || : >"$FLOW_DB"
	init_db
}

init_db() {
	sql_exec "PRAGMA journal_mode=WAL;"
	sql_exec "CREATE TABLE IF NOT EXISTS connection_flows (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		timeinsert INTEGER NOT NULL DEFAULT (strftime('%s','now')),
		protocol TEXT,
		source TEXT,
		destination TEXT,
		transfer TEXT,
		status TEXT,
		sig TEXT UNIQUE
	);"
	sql_exec "CREATE INDEX IF NOT EXISTS idx_connection_flows_time ON connection_flows(timeinsert);"
}

prune_db() {
	sql_exec "DELETE FROM connection_flows
		WHERE id <= (
			SELECT CASE
				WHEN MAX(id) > $RETENTION_ROWS THEN MAX(id) - $RETENTION_ROWS
				ELSE 0
			END
			FROM connection_flows
		);"
}

sql_escape() {
	printf "%s" "$1" | sed "s/'/''/g"
}

conntrack_source() {
	if command -v conntrack >/dev/null 2>&1; then
		(conntrack -L -o extended 2>/dev/null || conntrack -L 2>/dev/null) | head -n 600
		return 0
	fi
	if [ -r /proc/net/nf_conntrack ]; then
		head -n 600 /proc/net/nf_conntrack 2>/dev/null
		return 0
	fi
	if [ -r /proc/net/ip_conntrack ]; then
		head -n 600 /proc/net/ip_conntrack 2>/dev/null
		return 0
	fi
	return 1
}

parse_conntrack() {
	awk '
		{
			proto="UNKNOWN"; state="ACTIVE";
			src=""; dst=""; sport=""; dport="";
			bytes=0; packets=0;
			for (i=1; i<=NF; i++) {
				t=$i;
				if (t ~ /^(tcp|udp|icmp|icmpv6|sctp|gre|dccp)$/) proto=toupper(t);
				if (t ~ /^src=/ && src=="") src=substr(t,5);
				if (t ~ /^dst=/ && dst=="") dst=substr(t,5);
				if (t ~ /^sport=/ && sport=="") sport=substr(t,7);
				if (t ~ /^dport=/ && dport=="") dport=substr(t,7);
				if (t ~ /^bytes=/) bytes += substr(t,7)+0;
				if (t ~ /^packets=/) packets += substr(t,9)+0;
				if (t ~ /^(ESTABLISHED|SYN_SENT|SYN_RECV|FIN_WAIT|TIME_WAIT|CLOSE|CLOSE_WAIT|LAST_ACK|LISTEN|CLOSING|UNREPLIED|ASSURED)$/) state=t;
				if (state=="ACTIVE" && t ~ /^\[[A-Z_]+\]$/) {
					state=substr(t,2,length(t)-2);
				}
			}
			if (src=="" || dst=="") next;
			source=src; if (sport!="") source=source ":" sport;
			destination=dst; if (dport!="") destination=destination ":" dport;
			transfer=bytes " B (" packets " Pkts.)";
			printf "%s|%s|%s|%s|%s\n", proto, source, destination, transfer, state;
		}
	'
}

insert_rows() {
	local tmp sql line protocol source destination transfer status sig
	tmp="$(mktemp)"
	cat >"$tmp"
	[ -s "$tmp" ] || {
		rm -f "$tmp"
		return 0
	}

	sql="BEGIN;"
	while IFS='|' read -r protocol source destination transfer status; do
		[ -n "$protocol" ] || continue
		sig="${protocol}|${source}|${destination}|${transfer}|${status}"
		protocol="$(sql_escape "$protocol")"
		source="$(sql_escape "$source")"
		destination="$(sql_escape "$destination")"
		transfer="$(sql_escape "$transfer")"
		status="$(sql_escape "$status")"
		sig="$(sql_escape "$sig")"
		sql="$sql INSERT OR IGNORE INTO connection_flows(timeinsert, protocol, source, destination, transfer, status, sig) VALUES (strftime('%s','now'), '$protocol', '$source', '$destination', '$transfer', '$status', '$sig');"
	done <"$tmp"
	sql="$sql COMMIT;"
	rm -f "$tmp"
	sql_exec "$sql"
}

run_once() {
	load_config
	ensure_db_file
	conntrack_source | parse_conntrack | insert_rows
	prune_db
}

run_daemon() {
	load_config
	ensure_db_file
	log "starting connection flow collector db=$FLOW_DB poll=${POLL_SECONDS}s"
	while true; do
		if ! run_once; then
			log "collector iteration failed"
		fi
		sleep "$POLL_SECONDS"
	done
}

main() {
	init_logging
	find_sqlite_bin || {
		log "sqlite3 not found; install sqlite3-cli"
		exit 1
	}
	command -v awk >/dev/null 2>&1 || {
		log "awk not found"
		exit 1
	}

	case "${1:-}" in
		--init-db)
			load_config
			ensure_db_file
			log "initialized sqlite db at $FLOW_DB"
			;;
		--once)
			run_once
			;;
		--daemon|"")
			run_daemon
			;;
		*)
			echo "Usage: $0 [--init-db|--once|--daemon]"
			exit 1
			;;
	esac
}

main "$@"
