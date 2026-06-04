#!/bin/sh

RULE_PREFIX="moci_paternal_time_"

log() {
	logger -t moci-paternal-time "$*" 2>/dev/null || true
}

uci_get() {
	uci -q get "$1" 2>/dev/null || true
}

safe_name() {
	echo "$1" | tr 'A-Z' 'a-z' | sed 's/[^a-z0-9_]/_/g; s/__*/_/g; s/^_//; s/_$//'
}

time_to_minutes() {
	local value hour minute
	value="$1"
	hour="${value%:*}"
	minute="${value#*:}"
	case "$hour:$minute" in
		[0-9][0-9]:[0-9][0-9]) ;;
		*) echo 0; return ;;
	esac
	hour="${hour#0}"
	minute="${minute#0}"
	[ -n "$hour" ] || hour=0
	[ -n "$minute" ] || minute=0
	echo $((hour * 60 + minute))
}

has_day() {
	local wanted item
	wanted="$1"
	shift
	for item in "$@"; do
		[ "$item" = "$wanted" ] && return 0
	done
	return 1
}

rule_active_now() {
	local start end now today yesterday
	start="$(time_to_minutes "$1")"
	end="$(time_to_minutes "$2")"
	now="$(time_to_minutes "$(date '+%H:%M')")"
	today="$(date '+%u')"
	yesterday=$((today - 1))
	[ "$yesterday" -lt 1 ] && yesterday=7
	shift 2

	if [ "$start" -le "$end" ]; then
		has_day "$today" "$@" && [ "$now" -ge "$start" ] && [ "$now" -lt "$end" ]
		return $?
	fi

	if [ "$now" -ge "$start" ]; then
		has_day "$today" "$@"
		return $?
	fi
	if [ "$now" -lt "$end" ]; then
		has_day "$yesterday" "$@"
		return $?
	fi
	return 1
}

current_schedule_rules() {
	uci show firewall 2>/dev/null | awk -F'[.=]' -v p="$RULE_PREFIX" '
		$1 == "firewall" && $3 == "name" {
			value=$0
			sub(/^[^=]*=/, "", value)
			gsub(/^'\''|'\''$/, "", value)
			if (index(value, p) == 1) print $2
		}
	'
}

current_schedule_state() {
	uci show firewall 2>/dev/null | awk -F= -v p="$RULE_PREFIX" '
		{
			split($1, key, ".")
			section=key[2]
			option=key[3]
			value=$2
			gsub(/^'\''|'\''$/, "", value)
			if (option == "name" && index(value, p) == 1) name[section]=value
			if (option == "src_mac") mac[section]=value
		}
		END {
			for (section in name) {
				if (mac[section] != "") print name[section] "|" mac[section]
			}
		}
	' | sort
}

clear_schedule_rules() {
	local section
	while :; do
		section="$(current_schedule_rules | head -n 1)"
		[ -n "$section" ] || break
		uci -q delete "firewall.$section" 2>/dev/null || true
	done
}

add_schedule_rule() {
	local name mac section
	name="$1"
	mac="$2"
	section="$(uci add firewall rule 2>/dev/null)"
	[ -n "$section" ] || return 1
	uci -q set "firewall.$section.name=$name"
	uci -q set "firewall.$section.src=lan"
	uci -q set "firewall.$section.dest=wan"
	uci -q set "firewall.$section.src_mac=$mac"
	uci -q set "firewall.$section.proto=all"
	uci -q set "firewall.$section.target=REJECT"
	uci -q set "firewall.$section.family=any"
	uci -q set "firewall.$section.enabled=1"
}

apply_rules() {
	local tmp desired current section enabled start end rule_name mac suffix
	tmp="/tmp/moci-paternal-time.desired.$$"
	desired="/tmp/moci-paternal-time.desired.sorted.$$"
	current="/tmp/moci-paternal-time.current.$$"
	: > "$tmp"

	for section in $(uci show moci 2>/dev/null | sed -n "s/^moci\\.\\([^.=]*\\)=paternal_rule$/\\1/p"); do
		enabled="$(uci_get "moci.$section.enabled")"
		[ "$enabled" = "0" ] && continue
		start="$(uci_get "moci.$section.start_time")"
		end="$(uci_get "moci.$section.end_time")"
		[ -n "$start" ] || start="21:00"
		[ -n "$end" ] || end="07:00"
		# shellcheck disable=SC2046
		if ! rule_active_now "$start" "$end" $(uci_get "moci.$section.day"); then
			continue
		fi
		for mac in $(uci_get "moci.$section.mac"); do
			case "$mac" in
				??:??:??:??:??:??) ;;
				*) continue ;;
			esac
			rule_name="$(uci_get "moci.$section.name")"
			[ -n "$rule_name" ] || rule_name="$section"
			suffix="$(safe_name "${rule_name}_${mac}")"
			echo "${RULE_PREFIX}${suffix}|$mac" >> "$tmp"
		done
	done

	sort "$tmp" > "$desired"
	current_schedule_state > "$current"
	if cmp -s "$desired" "$current"; then
		rm -f "$tmp" "$desired" "$current"
		return 0
	fi

	clear_schedule_rules
	while IFS='|' read -r rule_name mac; do
		[ -n "$rule_name" ] && [ -n "$mac" ] || continue
		add_schedule_rule "$rule_name" "$mac"
	done < "$desired"
	rm -f "$tmp" "$desired" "$current"
	uci commit firewall
	/etc/init.d/firewall reload >/dev/null 2>&1 || /etc/init.d/firewall restart >/dev/null 2>&1 || true
	log "applied time-of-use firewall rules"
}

case "$1" in
	--apply | apply | "")
		apply_rules
		;;
	*)
		echo "Usage: $0 [--apply]"
		exit 1
		;;
esac
