#!/bin/sh

# MoCI DNS Monitor
# Runs continuously on OpenWrt and writes DNS resolution samples to /tmp/moci-dns-monitor.txt

set -u

DEFAULT_TARGET="openwrt.org"
DEFAULT_INTERVAL="60"
DEFAULT_TIMEOUT="3"
DEFAULT_OUTPUT="/tmp/moci-dns-monitor.txt"
DEFAULT_MAX_LINES="2000"
DEFAULT_THRESHOLD="1000"

DNS_TARGET="$DEFAULT_TARGET"
DNS_INTERVAL="$DEFAULT_INTERVAL"
DNS_TIMEOUT="$DEFAULT_TIMEOUT"
DNS_OUTPUT="$DEFAULT_OUTPUT"
DNS_MAX_LINES="$DEFAULT_MAX_LINES"
DNS_THRESHOLD="$DEFAULT_THRESHOLD"

load_config() {
	if command -v uci >/dev/null 2>&1; then
		local value
		value="$(uci -q get moci.dns_monitor.target 2>/dev/null || true)"
		[ -n "$value" ] && DNS_TARGET="$value"

		value="$(uci -q get moci.dns_monitor.timeout 2>/dev/null || true)"
		[ -n "$value" ] && DNS_TIMEOUT="$value"

		value="$(uci -q get moci.dns_monitor.output_file 2>/dev/null || true)"
		[ -n "$value" ] && DNS_OUTPUT="$value"

		value="$(uci -q get moci.dns_monitor.max_lines 2>/dev/null || true)"
		[ -n "$value" ] && DNS_MAX_LINES="$value"

		value="$(uci -q get moci.dns_monitor.threshold 2>/dev/null || true)"
		[ -n "$value" ] && DNS_THRESHOLD="$value"
	fi
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

refresh_runtime_config() {
	load_config
	DNS_INTERVAL="$(sanitize_int "$DNS_INTERVAL" "$DEFAULT_INTERVAL")"
	DNS_TIMEOUT="$(sanitize_int "$DNS_TIMEOUT" "$DEFAULT_TIMEOUT")"
	DNS_MAX_LINES="$(sanitize_int "$DNS_MAX_LINES" "$DEFAULT_MAX_LINES")"
	DNS_THRESHOLD="$(sanitize_int "$DNS_THRESHOLD" "$DEFAULT_THRESHOLD")"
	ensure_output_file
}

ensure_output_file() {
	local dir
	dir="$(dirname "$DNS_OUTPUT")"
	mkdir -p "$dir"
	[ -f "$DNS_OUTPUT" ] || : >"$DNS_OUTPUT"
}

append_sample() {
	local ts="$1"
	local target="$2"
	local status="$3"
	local latency="$4"
	local msg="$5"

	printf "%s|%s|%s|%s|%s\n" "$ts" "$target" "$status" "$latency" "$msg" >>"$DNS_OUTPUT"
}

prune_file() {
	local max_lines
	max_lines="$(sanitize_int "$DNS_MAX_LINES" "$DEFAULT_MAX_LINES")"
	local current
	current="$(wc -l <"$DNS_OUTPUT" 2>/dev/null || echo 0)"
	current="$(sanitize_int "$current" "0")"

	if [ "$current" -gt "$max_lines" ]; then
		tail -n "$max_lines" "$DNS_OUTPUT" >"${DNS_OUTPUT}.tmp" && mv "${DNS_OUTPUT}.tmp" "$DNS_OUTPUT"
	fi
}

run_dns_once() {
	local now start_ms end_ms elapsed output status latency message
	now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
	start_ms="$(date +%s%3N 2>/dev/null || echo 0)"

	if command -v nslookup >/dev/null 2>&1; then
		output="$(nslookup "$DNS_TARGET" 2>&1 || true)"
	else
		output="nslookup not found"
	fi

	end_ms="$(date +%s%3N 2>/dev/null || echo 0)"
	if [ "$start_ms" -gt 0 ] && [ "$end_ms" -ge "$start_ms" ]; then
		elapsed=$((end_ms - start_ms))
	else
		elapsed=0
	fi

	if echo "$output" | grep -qE '(Address [0-9]+:|Address: [0-9a-fA-F:.]+)'; then
		status="OK"
		latency="$elapsed"
		message="resolved"
	else
		status="ERROR"
		latency="N/A"
		message="$(echo "$output" | tail -n 1 | tr '|' ' ' | tr -s ' ')"
		[ -z "$message" ] && message="resolve failed"
	fi

	append_sample "$now" "$DNS_TARGET" "$status" "$latency" "$message"
	prune_file
}

run_forever() {
	refresh_runtime_config
	while true; do
		refresh_runtime_config
		run_dns_once
		sleep "$DNS_INTERVAL"
	done
}

main() {
	refresh_runtime_config
	case "${1:-}" in
	--once)
		run_dns_once
		;;
	*)
		run_forever
		;;
	esac
}

main "$@"
