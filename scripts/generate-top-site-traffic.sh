#!/bin/sh

# Generate light HTTP(S) traffic to a common top-site domain set.
# Intended for OpenWrt diagnostics, traffic classification, and Netify/flow testing.

set -u

ROUNDS="${ROUNDS:-1}"
DELAY_SECONDS="${DELAY_SECONDS:-2}"
CONNECT_TIMEOUT="${CONNECT_TIMEOUT:-5}"
MAX_TIME="${MAX_TIME:-15}"
CURL_BIN="${CURL_BIN:-curl}"
USER_AGENT="${USER_AGENT:-Mozilla/5.0 (OpenWrt; MoCI traffic test) AppleWebKit/537.36}"
SITES_FILE="${SITES_FILE:-}"
LOG_FILE="${LOG_FILE:-}"
EXTRA_CURL_ARGS="${EXTRA_CURL_ARGS:-}"

DEFAULT_SITES='
google.com
youtube.com
facebook.com
instagram.com
whatsapp.com
x.com
tiktok.com
amazon.com
wikipedia.org
yahoo.com
reddit.com
netflix.com
microsoft.com
office.com
live.com
apple.com
linkedin.com
bing.com
openai.com
baidu.com
yandex.ru
vk.com
zoom.us
twitch.tv
discord.com
github.com
cloudflare.com
cnn.com
nytimes.com
weather.com
'

usage() {
	cat <<EOF
Usage: $0 [options]

Generates light curl traffic to 30 common top-site domains.

Options:
  -r ROUNDS       Number of passes through the site list (default: $ROUNDS)
  -d SECONDS      Delay between requests (default: $DELAY_SECONDS)
  -f FILE         Read domains/URLs from FILE instead of built-in list
  -l FILE         Append request results to FILE
  -h              Show this help

Environment:
  SITES           Whitespace-separated domains/URLs to use instead of defaults
  CURL_BIN        curl binary path/name (default: curl)
  CONNECT_TIMEOUT curl connect timeout seconds (default: 5)
  MAX_TIME        curl total request timeout seconds (default: 15)
  USER_AGENT      User-Agent header
  EXTRA_CURL_ARGS Extra arguments passed to curl

Examples:
  sh $0
  ROUNDS=3 DELAY_SECONDS=1 sh $0
  sh $0 -f /root/sites.txt -l /tmp/top-site-traffic.log
EOF
}

log() {
	local line
	line="$(date '+%Y-%m-%d %H:%M:%S') $*"
	printf '%s\n' "$line"
	if [ -n "$LOG_FILE" ]; then
		printf '%s\n' "$line" >>"$LOG_FILE"
	fi
}

is_uint() {
	case "${1:-}" in
	'' | *[!0-9]*)
		return 1
		;;
	*)
		return 0
		;;
	esac
}

normalize_url() {
	case "$1" in
	http://* | https://*)
		printf '%s\n' "$1"
		;;
	*)
		printf 'https://%s/\n' "$1"
		;;
	esac
}

read_sites() {
	if [ -n "${SITES:-}" ]; then
		printf '%s\n' $SITES
		return 0
	fi

	if [ -n "$SITES_FILE" ]; then
		if [ ! -r "$SITES_FILE" ]; then
			log "ERROR sites file is not readable: $SITES_FILE"
			return 1
		fi
		sed 's/#.*$//; s/^[[:space:]]*//; s/[[:space:]]*$//; /^$/d' "$SITES_FILE"
		return 0
	fi

	printf '%s\n' "$DEFAULT_SITES" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//; /^$/d'
}

run_request() {
	local url status total_time remote_ip
	url="$(normalize_url "$1")"

	# shellcheck disable=SC2086
	result="$("$CURL_BIN" \
		--location \
		--silent \
		--show-error \
		--output /dev/null \
		--connect-timeout "$CONNECT_TIMEOUT" \
		--max-time "$MAX_TIME" \
		--user-agent "$USER_AGENT" \
		--write-out '%{http_code} %{time_total} %{remote_ip}' \
		$EXTRA_CURL_ARGS \
		"$url" 2>&1)"
	rc=$?

	if [ "$rc" -eq 0 ]; then
		status="$(printf '%s' "$result" | awk '{print $1}')"
		total_time="$(printf '%s' "$result" | awk '{print $2}')"
		remote_ip="$(printf '%s' "$result" | awk '{print $3}')"
		log "OK url=$url status=$status time=${total_time}s remote=$remote_ip"
	else
		log "FAIL url=$url rc=$rc error=$(printf '%s' "$result" | tr '\n' ' ' | cut -c1-180)"
	fi
}

while getopts 'r:d:f:l:h' opt; do
	case "$opt" in
	r)
		ROUNDS="$OPTARG"
		;;
	d)
		DELAY_SECONDS="$OPTARG"
		;;
	f)
		SITES_FILE="$OPTARG"
		;;
	l)
		LOG_FILE="$OPTARG"
		;;
	h)
		usage
		exit 0
		;;
	*)
		usage >&2
		exit 2
		;;
	esac
done

if ! command -v "$CURL_BIN" >/dev/null 2>&1; then
	echo "ERROR: curl not found. Install it on OpenWrt with: opkg update && opkg install curl" >&2
	exit 1
fi

if ! is_uint "$ROUNDS" || [ "$ROUNDS" -lt 1 ]; then
	echo "ERROR: ROUNDS must be a positive integer" >&2
	exit 2
fi

if ! is_uint "$DELAY_SECONDS"; then
	echo "ERROR: DELAY_SECONDS must be a non-negative integer" >&2
	exit 2
fi

sites="$(read_sites)" || exit 1
site_count="$(printf '%s\n' "$sites" | sed '/^$/d' | wc -l | tr -d ' ')"

log "starting top-site traffic generation rounds=$ROUNDS sites=$site_count delay=${DELAY_SECONDS}s"

round=1
while [ "$round" -le "$ROUNDS" ]; do
	log "round $round/$ROUNDS"
	printf '%s\n' "$sites" | while IFS= read -r site; do
		[ -n "$site" ] || continue
		run_request "$site"
		[ "$DELAY_SECONDS" -gt 0 ] && sleep "$DELAY_SECONDS"
	done
	round=$((round + 1))
done

log "done"
