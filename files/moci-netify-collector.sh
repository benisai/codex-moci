#!/bin/sh

# MoCI Netify collector for OpenWrt.
# Captures Netify flow JSON events and stores them as JSONL in a local file.

set -e

DEFAULT_HOST="127.0.0.1"
DEFAULT_PORT="7150"
DEFAULT_OUTPUT="/tmp/moci-netify-flow.jsonl"
DEFAULT_MAX_LINES="5000"
RECONNECT_DELAY="3"

NETIFY_HOST="$DEFAULT_HOST"
NETIFY_PORT="$DEFAULT_PORT"
NETIFY_OUTPUT="$DEFAULT_OUTPUT"
MAX_LINES="$DEFAULT_MAX_LINES"

log() {
	logger -t moci-netify-collector "$*"
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

load_config() {
	if command -v uci >/dev/null 2>&1; then
		local value

		value="$(uci -q get moci.collector.host 2>/dev/null || true)"
		[ -n "$value" ] && NETIFY_HOST="$value"

		value="$(uci -q get moci.collector.port 2>/dev/null || true)"
		[ -n "$value" ] && NETIFY_PORT="$value"

		# New config key
		value="$(uci -q get moci.collector.output_file 2>/dev/null || true)"
		[ -n "$value" ] && NETIFY_OUTPUT="$value"

		# Backward compatibility with previous db_path key
		value="$(uci -q get moci.collector.db_path 2>/dev/null || true)"
		if [ -n "$value" ] && [ "$NETIFY_OUTPUT" = "$DEFAULT_OUTPUT" ]; then
			NETIFY_OUTPUT="$value"
		fi

		value="$(uci -q get moci.collector.max_lines 2>/dev/null || true)"
		[ -n "$value" ] && MAX_LINES="$value"

		# Backward compatibility with previous retention_rows key
		value="$(uci -q get moci.collector.retention_rows 2>/dev/null || true)"
		if [ -n "$value" ] && [ "$MAX_LINES" = "$DEFAULT_MAX_LINES" ]; then
			MAX_LINES="$value"
		fi
	fi
}

require_dependencies() {
	command -v nc >/dev/null 2>&1 || {
		log "nc not found; install netcat"
		exit 1
	}
}

ensure_output_file() {
	local dir
	dir="$(dirname "$NETIFY_OUTPUT")"
	mkdir -p "$dir"
	[ -f "$NETIFY_OUTPUT" ] || : >"$NETIFY_OUTPUT"
}

prune_file() {
	local max_lines current
	max_lines="$(sanitize_int "$MAX_LINES" "$DEFAULT_MAX_LINES")"
	current="$(wc -l <"$NETIFY_OUTPUT" 2>/dev/null || echo 0)"
	current="$(sanitize_int "$current" 0)"

	if [ "$current" -gt "$max_lines" ]; then
		tail -n "$max_lines" "$NETIFY_OUTPUT" >"${NETIFY_OUTPUT}.tmp" && mv "${NETIFY_OUTPUT}.tmp" "$NETIFY_OUTPUT"
	fi
}

is_flow_event() {
	# Accept both compact and spaced JSON formats.
	echo "$1" | grep -Eq '"type"[[:space:]]*:[[:space:]]*"flow"'
}

consume_stream() {
	local line counter
	counter=0

	nc "$NETIFY_HOST" "$NETIFY_PORT" | while IFS= read -r line; do
		[ -n "$line" ] || continue
		if ! is_flow_event "$line"; then
			continue
		fi

		printf "%s\n" "$line" >>"$NETIFY_OUTPUT"
		counter=$((counter + 1))
		if [ $((counter % 200)) -eq 0 ]; then
			prune_file
		fi
	done
}

run_forever() {
	log "starting netify collector host=$NETIFY_HOST port=$NETIFY_PORT output=$NETIFY_OUTPUT"
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
	MAX_LINES="$(sanitize_int "$MAX_LINES" "$DEFAULT_MAX_LINES")"
	ensure_output_file

	case "${1:-}" in
		--init-db | --init-file)
			log "output file initialized at $NETIFY_OUTPUT"
			exit 0
			;;
	esac

	run_forever
}

main "$@"
