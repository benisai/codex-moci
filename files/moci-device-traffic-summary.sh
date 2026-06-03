#!/bin/sh

# MoCI real-time device traffic summary for OpenWrt.
# Reads conntrack byte counters and emits cumulative per-device byte totals.

PATH="/usr/sbin:/usr/bin:/sbin:/bin"
export PATH

get_lan_device() {
	local dev
	dev="$(uci -q get network.lan.device 2>/dev/null || true)"
	if [ -z "$dev" ]; then
		dev="$(uci -q get network.lan.ifname 2>/dev/null || true)"
	fi
	if [ -z "$dev" ]; then
		dev="br-lan"
	fi
	printf "%s\n" "$dev"
}

conntrack_source() {
	if [ -r /proc/net/nf_conntrack ]; then
		cat /proc/net/nf_conntrack
		return 0
	fi
	if [ -r /proc/net/ip_conntrack ]; then
		cat /proc/net/ip_conntrack
		return 0
	fi
	if command -v conntrack >/dev/null 2>&1; then
		conntrack -L 2>/dev/null
		return 0
	fi
	return 1
}

LAN_DEV="$(get_lan_device)"
LAN_SUBNET="$(ip -4 addr show dev "$LAN_DEV" 2>/dev/null | awk "/inet / {print \$2; exit}")"
LAN_IP="${LAN_SUBNET%%/*}"
LAN_PREFIX="$(printf "%s\n" "$LAN_IP" | awk -F. 'NF >= 3 {print $1 "." $2 "." $3}')"

conntrack_source | awk -v lan_prefix="$LAN_PREFIX" -v lan_ip="$LAN_IP" '
function is_private_ip(ip) {
	return (ip ~ /^10\./ || ip ~ /^192\.168\./ || ip ~ /^172\.(1[6-9]|2[0-9]|3[0-1])\./)
}

function is_lan_device_ip(ip) {
	if (ip == "" || ip == lan_ip || ip ~ /^127\./ || ip ~ /^255\./ || ip ~ /\.255$/) return 0
	if (lan_prefix != "") return index(ip, lan_prefix ".") == 1
	return is_private_ip(ip)
}

function add_flow(ip, upload_bytes, download_bytes) {
	if (!is_lan_device_ip(ip)) return
	seen[ip] = 1
	tx[ip] += upload_bytes + 0
	rx[ip] += download_bytes + 0
}

{
	src_count = 0
	dst_count = 0
	bytes_count = 0
	for (i = 1; i <= NF; i++) {
		if ($i ~ /^src=/) {
			src_count++
			src[src_count] = substr($i, 5)
		} else if ($i ~ /^dst=/) {
			dst_count++
			dst[dst_count] = substr($i, 5)
		} else if ($i ~ /^bytes=/) {
			bytes_count++
			b[bytes_count] = substr($i, 7) + 0
		}
	}

	if (src_count >= 1 && dst_count >= 1 && bytes_count >= 1 && src[1] != dst[1] && is_lan_device_ip(src[1])) {
		download = 0
		if (src_count >= 2 && dst_count >= 2 && bytes_count >= 2 && dst[2] == src[1])
			download = b[2]
		add_flow(src[1], b[1], download)
	}
}

END {
	for (ip in seen) {
		printf "%s\t%.0f\t%.0f\n", ip, rx[ip] + 0, tx[ip] + 0
	}
}
' | awk '
BEGIN {
	while ((getline line < "/tmp/dhcp.leases") > 0) {
		n = split(line, f, /[ \t]+/)
		if (n >= 4 && f[2] ~ /^([0-9a-fA-F][0-9a-fA-F]:){5}[0-9a-fA-F][0-9a-fA-F]$/)
			mac[tolower(f[3])] = tolower(f[2])
	}

	while ((getline line < "/proc/net/arp") > 0) {
		if (line ~ /^IP/) continue
		n = split(line, f, /[ \t]+/)
		if (n >= 4 && f[4] ~ /^([0-9a-fA-F][0-9a-fA-F]:){5}[0-9a-fA-F][0-9a-fA-F]$/)
			mac[tolower(f[1])] = tolower(f[4])
	}

	cmd = "ip neigh 2>/dev/null"
	while ((cmd | getline line) > 0) {
		n = split(line, f, /[ \t]+/)
		ip = f[1]
		for (i = 2; i <= n; i++) {
			if (f[i] == "lladdr" && (i + 1) <= n && f[i + 1] ~ /^([0-9a-fA-F][0-9a-fA-F]:){5}[0-9a-fA-F][0-9a-fA-F]$/)
				mac[tolower(ip)] = tolower(f[i + 1])
		}
	}
	close(cmd)

	printf "["
	first = 1
}

{
	ip = $1
	rx = $2 + 0
	tx = $3 + 0
	m = mac[tolower(ip)]
	if (!first) printf ","
	first = 0
	printf "{\"ip\":\"%s\",\"mac\":\"%s\",\"rx_bytes\":%.0f,\"tx_bytes\":%.0f}", ip, m, rx, tx
}

END {
	printf "]\n"
}
'
