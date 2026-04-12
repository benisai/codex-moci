#!/bin/sh

# MoCI Netify collector for OpenWrt.
# Captures Netify flow JSON events and stores them in a local SQLite database.

set -e

DEFAULT_HOST="127.0.0.1"
DEFAULT_PORT="7150"
DEFAULT_DB="/tmp/moci-netify.sqlite"
DEFAULT_RETENTION_ROWS="500000"
DEFAULT_STREAM_TIMEOUT="45"
DEFAULT_EXCLUDE_PROTOCOLS="MDNS,DNS,QUIC,DHCPv6,ICMP"
DEFAULT_IGNORE_WAN_SOURCE="1"
RECONNECT_DELAY="3"
LOG_FILE="/tmp/moci-netify-collector.log"

NETIFY_HOST="$DEFAULT_HOST"
NETIFY_PORT="$DEFAULT_PORT"
NETIFY_DB="$DEFAULT_DB"
RETENTION_ROWS="$DEFAULT_RETENTION_ROWS"
STREAM_TIMEOUT="$DEFAULT_STREAM_TIMEOUT"
EXCLUDE_PROTOCOLS="$DEFAULT_EXCLUDE_PROTOCOLS"
IGNORE_WAN_SOURCE="$DEFAULT_IGNORE_WAN_SOURCE"
WAN_PREFIX=""
LAN_PREFIX=""
SQLITE_BIN=""
NETIFY_FEATURE_ENABLED="1"
LAST_DB_DAY=""
WAN_FILTER_AUTO_DISABLED="0"

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
	local query output rc
	query="$1"
	output="$("$SQLITE_BIN" "$NETIFY_DB" "PRAGMA busy_timeout=3000; $query" 2>&1)"
	rc=$?
	if [ "$rc" -ne 0 ]; then
		log "sqlite error: $output"
		return "$rc"
	fi
	return 0
}

load_config() {
	if command -v uci >/dev/null 2>&1; then
		local value

		value="$(uci -q get moci.collector.host 2>/dev/null || true)"
		value="$(sanitize_text "$value")"
		[ -n "$value" ] && NETIFY_HOST="$value"

		value="$(uci -q get moci.collector.port 2>/dev/null || true)"
		value="$(sanitize_text "$value")"
		[ -n "$value" ] && NETIFY_PORT="$value"

		value="$(uci -q get moci.collector.db_path 2>/dev/null || true)"
		value="$(sanitize_text "$value")"
		[ -n "$value" ] && NETIFY_DB="$value"

		# Backward compatibility with older key.
		value="$(uci -q get moci.collector.output_file 2>/dev/null || true)"
		value="$(sanitize_text "$value")"
		if [ -n "$value" ] && [ "$NETIFY_DB" = "$DEFAULT_DB" ]; then
			case "$value" in
				*.sqlite | *.sqlite3)
					NETIFY_DB="$value"
					;;
			esac
		fi

		value="$(uci -q get moci.collector.retention_rows 2>/dev/null || true)"
		value="$(sanitize_text "$value")"
		[ -n "$value" ] && RETENTION_ROWS="$value"

		# Backward compatibility with older key.
		value="$(uci -q get moci.collector.max_lines 2>/dev/null || true)"
		value="$(sanitize_text "$value")"
		if [ -n "$value" ] && [ "$RETENTION_ROWS" = "$DEFAULT_RETENTION_ROWS" ]; then
			RETENTION_ROWS="$value"
		fi

		value="$(uci -q get moci.collector.stream_timeout 2>/dev/null || true)"
		value="$(sanitize_text "$value")"
		[ -n "$value" ] && STREAM_TIMEOUT="$value"

		value="$(uci -q get moci.collector.exclude_protocols 2>/dev/null || true)"
		value="$(sanitize_text "$value")"
		[ -n "$value" ] && EXCLUDE_PROTOCOLS="$value"

		value="$(uci -q get moci.collector.ignore_wan_source 2>/dev/null || true)"
		value="$(sanitize_text "$value")"
		[ -n "$value" ] && IGNORE_WAN_SOURCE="$value"

		value="$(uci -q get moci.features.netify 2>/dev/null || true)"
		value="$(sanitize_text "$value")"
		[ -n "$value" ] && NETIFY_FEATURE_ENABLED="$value"
	fi
}

derive_wan_prefix() {
	local wan_ip cleaned
	WAN_PREFIX=""
	command -v uci >/dev/null 2>&1 || return 0
	wan_ip="$(uci -q get network.wan.ipaddr 2>/dev/null || true)"
	wan_ip="$(sanitize_text "$wan_ip")"
	if [ -z "$wan_ip" ] && command -v ubus >/dev/null 2>&1; then
		wan_ip="$(
			ubus call network.interface.wan status 2>/dev/null |
				sed -n 's/.*"address"[[:space:]]*:[[:space:]]*"\([0-9.]\+\)".*/\1/p' |
				head -n 1
		)"
	fi
	if [ -z "$wan_ip" ] && command -v ip >/dev/null 2>&1; then
		wan_ip="$(
			ip -4 route get 1.1.1.1 2>/dev/null |
				sed -n 's/.*src[[:space:]]\([0-9.]\+\).*/\1/p' |
				head -n 1
		)"
	fi
	cleaned="$(printf "%s" "$wan_ip" | sed -n "s/^\([0-9]\+\)\.\([0-9]\+\)\.\([0-9]\+\)\.[0-9]\+$/\1.\2.\3/p")"
	[ -n "$cleaned" ] && WAN_PREFIX="$cleaned"
}

derive_lan_prefix() {
	local lan_ip cleaned
	LAN_PREFIX=""
	command -v uci >/dev/null 2>&1 || return 0
	lan_ip="$(uci -q get network.lan.ipaddr 2>/dev/null || true)"
	lan_ip="$(sanitize_text "$lan_ip")"
	if [ -z "$lan_ip" ] && command -v ubus >/dev/null 2>&1; then
		lan_ip="$(
			ubus call network.interface.lan status 2>/dev/null |
				sed -n 's/.*"address"[[:space:]]*:[[:space:]]*"\([0-9.]\+\)".*/\1/p' |
				head -n 1
		)"
	fi
	cleaned="$(printf "%s" "$lan_ip" | sed -n "s/^\([0-9]\+\)\.\([0-9]\+\)\.\([0-9]\+\)\.[0-9]\+$/\1.\2.\3/p")"
	[ -n "$cleaned" ] && LAN_PREFIX="$cleaned"
}

refresh_runtime_config() {
	load_config
	RETENTION_ROWS="$(sanitize_int "$RETENTION_ROWS" "$DEFAULT_RETENTION_ROWS")"
	STREAM_TIMEOUT="$(sanitize_int "$STREAM_TIMEOUT" "$DEFAULT_STREAM_TIMEOUT")"
	IGNORE_WAN_SOURCE="$(sanitize_int "$IGNORE_WAN_SOURCE" "$DEFAULT_IGNORE_WAN_SOURCE")"
	derive_wan_prefix
	derive_lan_prefix
	if [ "$IGNORE_WAN_SOURCE" = "1" ] && [ -n "$WAN_PREFIX" ] && [ -n "$LAN_PREFIX" ] && [ "$WAN_PREFIX" = "$LAN_PREFIX" ]; then
		IGNORE_WAN_SOURCE="0"
		if [ "$WAN_FILTER_AUTO_DISABLED" != "1" ]; then
			log "auto-disabled ignore_wan_source: WAN and LAN share prefix $WAN_PREFIX"
			WAN_FILTER_AUTO_DISABLED="1"
		fi
	fi
	ensure_db_file
	[ -n "$LAST_DB_DAY" ] || LAST_DB_DAY="$(date '+%Y-%m-%d')"
}

require_dependencies() {
	command -v nc >/dev/null 2>&1 || {
		log "nc not found; install netcat"
		exit 1
	}
	find_sqlite_bin || {
		log "sqlite3 not found; install sqlite3-cli"
		exit 1
	}
}

ensure_db_file() {
	local dir
	dir="$(dirname "$NETIFY_DB")"
	mkdir -p "$dir"
	[ -f "$NETIFY_DB" ] || : >"$NETIFY_DB"
	init_db
}

day_suffix() {
	local day y m d
	day="$1"
	y="${day%%-*}"
	day="${day#*-}"
	m="${day%%-*}"
	d="${day#*-}"
	printf "%s.%s.%s" "$m" "$d" "$y"
}

rotate_db_if_new_day() {
	local today old_day suffix dir backup backup_try n
	today="$(date '+%Y-%m-%d')"
	if [ -z "$LAST_DB_DAY" ]; then
		LAST_DB_DAY="$today"
		return 0
	fi
	[ "$today" = "$LAST_DB_DAY" ] && return 0

	old_day="$LAST_DB_DAY"
	LAST_DB_DAY="$today"
	dir="$(dirname "$NETIFY_DB")"
	mkdir -p "$dir"
	suffix="$(day_suffix "$old_day")"
	backup="$dir/netify.$suffix"

	n=1
	backup_try="$backup"
	while [ -e "$backup_try" ]; do
		backup_try="$backup.$n"
		n=$((n + 1))
	done
	backup="$backup_try"

	log "daily rollover detected ($old_day -> $today), rotating sqlite db"
	sql_exec "PRAGMA wal_checkpoint(TRUNCATE);" || true
	if [ -f "$NETIFY_DB" ]; then
		mv "$NETIFY_DB" "$backup" 2>/dev/null || cp "$NETIFY_DB" "$backup" 2>/dev/null || true
	fi
	rm -f "${NETIFY_DB}-wal" "${NETIFY_DB}-shm"
	: >"$NETIFY_DB"
	init_db
	log "netify db rotated: $backup"
}

init_db() {
	sql_exec "PRAGMA journal_mode=WAL;"
	sql_exec "CREATE TABLE IF NOT EXISTS flow_raw (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		timeinsert INTEGER NOT NULL DEFAULT (strftime('%s','now')),
		json TEXT NOT NULL
	);"
	sql_exec "CREATE INDEX IF NOT EXISTS idx_flow_raw_time ON flow_raw(timeinsert);"
}

prune_db() {
	local keep
	keep="$(sanitize_int "$RETENTION_ROWS" "$DEFAULT_RETENTION_ROWS")"
	sql_exec "DELETE FROM flow_raw
		WHERE id <= (
			SELECT CASE
				WHEN MAX(id) > $keep THEN MAX(id) - $keep
				ELSE 0
			END
			FROM flow_raw
		);"
}

is_flow_event() {
	echo "$1" | grep -Eq '"type"[[:space:]]*:[[:space:]]*"flow"'
}

sql_escape() {
	printf "%s" "$1" | sed "s/'/''/g"
}

normalize_protocol() {
	printf "%s" "$1" | tr '[:lower:]' '[:upper:]' | tr -cd 'A-Z0-9'
}

extract_protocol_name() {
	printf "%s\n" "$1" | sed -n 's/.*"detected_protocol_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

extract_local_ip() {
	printf "%s\n" "$1" | sed -n 's/.*"local_ip"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

should_skip_wan_source() {
	local line local_ip
	[ "$IGNORE_WAN_SOURCE" = "1" ] || return 1
	[ -n "$WAN_PREFIX" ] || return 1
	line="$1"
	local_ip="$(extract_local_ip "$line")"
	case "$local_ip" in
		"$WAN_PREFIX".*)
			return 0
			;;
		*)
			return 1
			;;
	esac
}

should_skip_protocol() {
	local line proto token normalized_proto normalized_token old_ifs
	line="$1"
	proto="$(extract_protocol_name "$line")"
	[ -n "$proto" ] || return 1

	normalized_proto="$(normalize_protocol "$proto")"
	[ -n "$normalized_proto" ] || return 1

	old_ifs="$IFS"
	IFS=','
	for token in $EXCLUDE_PROTOCOLS; do
		token="$(sanitize_text "$token")"
		token="$(printf "%s" "$token" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
		[ -n "$token" ] || continue
		normalized_token="$(normalize_protocol "$token")"
		[ -n "$normalized_token" ] || continue
		case "$normalized_proto" in
			"$normalized_token"|"$normalized_token"*)
				IFS="$old_ifs"
				return 0
				;;
		esac
	done
	IFS="$old_ifs"
	return 1
}

insert_flow() {
	local escaped
	escaped="$(sql_escape "$1")"
	sql_exec "INSERT INTO flow_raw(timeinsert, json) VALUES (strftime('%s','now'), '$escaped');"
}

consume_stream() {
	local line counter
	counter=0

	nc -w "$STREAM_TIMEOUT" "$NETIFY_HOST" "$NETIFY_PORT" | while IFS= read -r line; do
		[ -n "$line" ] || continue
		rotate_db_if_new_day
		if ! is_flow_event "$line"; then
			continue
		fi
		if should_skip_protocol "$line"; then
			continue
		fi
		if should_skip_wan_source "$line"; then
			continue
		fi

		insert_flow "$line" || continue
		counter=$((counter + 1))
		if [ $((counter % 200)) -eq 0 ]; then
			prune_db || true
		fi
	done
}

run_forever() {
	refresh_runtime_config
	if [ "$NETIFY_FEATURE_ENABLED" != "1" ]; then
		log "netify feature disabled (moci.features.netify=$NETIFY_FEATURE_ENABLED); exiting collector"
		exit 0
	fi
	log "starting netify collector host=$NETIFY_HOST port=$NETIFY_PORT db=$NETIFY_DB timeout=${STREAM_TIMEOUT}s ignore_wan_source=$IGNORE_WAN_SOURCE wan_prefix=${WAN_PREFIX:-none}"
	while true; do
		refresh_runtime_config
		if [ "$NETIFY_FEATURE_ENABLED" != "1" ]; then
			log "netify feature disabled (moci.features.netify=$NETIFY_FEATURE_ENABLED); exiting collector"
			exit 0
		fi
		log "connecting to netify stream at $NETIFY_HOST:$NETIFY_PORT"
		consume_stream || true
		log "stream disconnected; retrying in ${RECONNECT_DELAY}s"
		sleep "$RECONNECT_DELAY"
	done
}

main() {
	init_logging
	require_dependencies
	refresh_runtime_config

	case "${1:-}" in
		--init-db | --init-file)
			log "netify sqlite database initialized at $NETIFY_DB"
			exit 0
			;;
	esac

	run_forever
}

main "$@"
