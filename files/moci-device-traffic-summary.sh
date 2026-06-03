#!/bin/sh

# MoCI real-time device traffic summary for OpenWrt.
# Reads conntrack byte counters and emits cumulative per-device byte totals.

PATH="/usr/sbin:/usr/bin:/sbin:/bin"
export PATH

is_device_ip() {
	case "${1:-}" in
		10.* | 192.168.* | 172.1[6-9].* | 172.2[0-9].* | 172.3[0-1].* | 100.6[4-9].* | 100.[7-9][0-9].* | 100.1[01][0-9].* | 100.12[0-7].*)
			return 0
			;;
		*)
			return 1
			;;
	esac
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

conntrack_source | awk '
function is_device_ip(ip) {
	return (ip ~ /^10\./ ||
		ip ~ /^192\.168\./ ||
		ip ~ /^172\.(1[6-9]|2[0-9]|3[0-1])\./ ||
		ip ~ /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./)
}

function add_bytes(ip, direction, bytes) {
	if (!is_device_ip(ip)) return
	if (bytes < 0) return
	seen[ip] = 1
	if (direction == "tx") tx[ip] += bytes
	else rx[ip] += bytes
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

	if (src_count >= 1 && dst_count >= 1 && bytes_count >= 1) {
		add_bytes(src[1], "tx", b[1])
		add_bytes(dst[1], "rx", b[1])
	}
	if (src_count >= 2 && dst_count >= 2 && bytes_count >= 2) {
		add_bytes(src[2], "tx", b[2])
		add_bytes(dst[2], "rx", b[2])
	}
}

END {
	for (ip in seen) {
		printf "%s\t%.0f\t%.0f\n", ip, rx[ip] + 0, tx[ip] + 0
	}
}
' | awk '
BEGIN {
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
