#!/bin/sh

# MoCI per-device byte counters via nftables dynamic maps.
# Output: JSON array [{"mac":"aa:bb:cc:dd:ee:ff","ip":"192.168.1.10","tx_bytes":123,"rx_bytes":456}]

set -u

PATH="/usr/sbin:/usr/bin:/sbin:/bin"
TABLE_FAMILY="inet"
TABLE_NAME="moci_devmon"
CHAIN_NAME="forward_mon"
TX_MAP_NAME="tx_bytes_by_src"
RX_MAP_NAME="rx_bytes_by_dst"

get_lan_device() {
	local dev
	dev="$(uci -q get network.lan.device 2>/dev/null || true)"
	if [ -z "$dev" ]; then dev="$(uci -q get network.lan.ifname 2>/dev/null || true)"; fi
	if [ -z "$dev" ]; then dev="br-lan"; fi
	printf "%s" "$dev"
}

ensure_nft_counters() {
	nft add table "$TABLE_FAMILY" "$TABLE_NAME" 2>/dev/null || true
	nft add map "$TABLE_FAMILY" "$TABLE_NAME" "$TX_MAP_NAME" '{ type ipv4_addr : counter; flags dynamic; }' 2>/dev/null || true
	nft add map "$TABLE_FAMILY" "$TABLE_NAME" "$RX_MAP_NAME" '{ type ipv4_addr : counter; flags dynamic; }' 2>/dev/null || true
	nft add chain "$TABLE_FAMILY" "$TABLE_NAME" "$CHAIN_NAME" '{ type filter hook forward priority -200; policy accept; }' 2>/dev/null || true

	nft list chain "$TABLE_FAMILY" "$TABLE_NAME" "$CHAIN_NAME" 2>/dev/null | grep -q "update @$TX_MAP_NAME" || \
		nft add rule "$TABLE_FAMILY" "$TABLE_NAME" "$CHAIN_NAME" "update @$TX_MAP_NAME { ip saddr : counter }" 2>/dev/null || true
	nft list chain "$TABLE_FAMILY" "$TABLE_NAME" "$CHAIN_NAME" 2>/dev/null | grep -q "update @$RX_MAP_NAME" || \
		nft add rule "$TABLE_FAMILY" "$TABLE_NAME" "$CHAIN_NAME" "update @$RX_MAP_NAME { ip daddr : counter }" 2>/dev/null || true
}

collect_ip_mac_map() {
	local lan_dev="$1"

	{
		# dnsmasq lease file: <expiry> <mac> <ip> <hostname> <clientid>
		if [ -f /tmp/dhcp.leases ]; then
			awk '
				$2 ~ /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/ && $3 ~ /^([0-9]{1,3}\.){3}[0-9]{1,3}$/ {
					print $3 "|" tolower($2)
				}
			' /tmp/dhcp.leases
		fi

		# ARP table constrained to LAN interface
		if [ -r /proc/net/arp ]; then
			awk -v dev="$lan_dev" '
				NR > 1 {
					ip=$1
					mac=tolower($4)
					ifname=$6
					if (ifname == dev && ip ~ /^([0-9]{1,3}\.){3}[0-9]{1,3}$/ && mac ~ /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/) {
						print ip "|" mac
					}
				}
			' /proc/net/arp
		fi

		# Neighbor table constrained to LAN interface
		ip neigh show dev "$lan_dev" 2>/dev/null | awk '
			{
				ip=$1
				mac=""
				for (i=1; i<=NF; i++) {
					if ($i == "lladdr" && (i+1) <= NF) { mac=tolower($(i+1)); break }
				}
				if (ip ~ /^([0-9]{1,3}\.){3}[0-9]{1,3}$/ && mac ~ /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/) {
					print ip "|" mac
				}
			}
		'
	} | awk -F'|' '
		{
			ip=$1
			mac=$2
			if (!(ip in seen)) {
				seen[ip]=1
				print ip "|" mac
			}
		}
	'
}

main() {
	command -v nft >/dev/null 2>&1 || {
		echo "[]"
		exit 0
	}

	local lan_dev ipmac_tmp in_map out_map
	lan_dev="$(get_lan_device)"
	ensure_nft_counters

	ipmac_tmp="/tmp/.moci_device_bytes_ipmac.$$"
	collect_ip_mac_map "$lan_dev" > "$ipmac_tmp"

	in_map="$(nft list map "$TABLE_FAMILY" "$TABLE_NAME" "$TX_MAP_NAME" 2>/dev/null || true)"
	out_map="$(nft list map "$TABLE_FAMILY" "$TABLE_NAME" "$RX_MAP_NAME" 2>/dev/null || true)"

	{
		printf "%s\n" "$in_map"
		echo "__SEP__"
		printf "%s\n" "$out_map"
		echo "__IPMAC__"
		cat "$ipmac_tmp" 2>/dev/null || true
	} | awk -F'|' '
		/^__SEP__$/ { phase=1; next }
		/^__IPMAC__$/ { phase=2; next }

		phase < 2 && /[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+ : counter/ {
			ip=""
			bytes=0
			for (i=1; i<=NF; i++) {
				if ($i ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/) ip=$i
				if ($i == "bytes") bytes=$(i+1)+0
			}
			if (ip != "") {
				if (phase == 0) tx_by_ip[ip] += bytes
				else rx_by_ip[ip] += bytes
			}
			next
		}

		phase == 2 {
			ip=$1
			mac=tolower($2)
			if (ip ~ /^([0-9]{1,3}\.){3}[0-9]{1,3}$/ && mac ~ /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/) {
				ip_to_mac[ip]=mac
				if (!(mac in mac_ip)) mac_ip[mac]=ip
			}
			next
		}

		END {
			for (ip in tx_by_ip) {
				mac=ip_to_mac[ip]
				if (mac != "") tx_by_mac[mac] += tx_by_ip[ip]
			}
			for (ip in rx_by_ip) {
				mac=ip_to_mac[ip]
				if (mac != "") rx_by_mac[mac] += rx_by_ip[ip]
			}

			printf "["
			n=0
			for (mac in tx_by_mac) {
				if (n > 0) printf ","
				printf "{\"mac\":\"%s\",\"ip\":\"%s\",\"tx_bytes\":%d,\"rx_bytes\":%d}", mac, mac_ip[mac], tx_by_mac[mac], rx_by_mac[mac]+0
				n++
			}
			for (mac in rx_by_mac) {
				if (!(mac in tx_by_mac)) {
					if (n > 0) printf ","
					printf "{\"mac\":\"%s\",\"ip\":\"%s\",\"tx_bytes\":0,\"rx_bytes\":%d}", mac, mac_ip[mac], rx_by_mac[mac]
					n++
				}
			}
			printf "]\n"
		}
	'

	rm -f "$ipmac_tmp"
}

main "$@"
