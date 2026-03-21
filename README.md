<div align="center">

# MoCI

**Modern Configuration Interface for OpenWrt**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

[Demo](https://hudsongraeme.github.io/MoCI/) • [Install](#installation) • [Features](#features)

</div>

![MoCI Dashboard](https://github.com/user-attachments/assets/dc150d3c-75fc-480b-a0bd-10b67cdc6226)

---

## What is this?

A complete standalone web interface for OpenWrt routers. Not a LuCI theme—pure vanilla JavaScript SPA using OpenWrt's native ubus API.

```bash
scp -r moci/* root@192.168.1.1:/www/moci/
# Access at http://192.168.1.1/moci/
```

---

## Features

<table>
<tr>
<td width="50%">

### Dashboard
- Live system stats & graphs
- Network traffic monitoring
- System logs
- Active connections
- Quick actions

### Network
- Interface configuration
- Wireless management (SSID, encryption)
- Firewall & port forwarding
- DHCP leases (active + static)
- Diagnostics (ping, traceroute, WOL)

</td>
<td width="50%">

### System
- Hostname & timezone
- Password management
- Backup & restore
- Package management
- Service control
- Init script management

### Design
- Dark glassmorphic UI
- Responsive tables
- Real-time updates
- Toast notifications
- Smooth animations

</td>
</tr>
</table>

---

## Installation

### Option 1: Package (Recommended)

Download the ipk for your architecture from [Releases](https://github.com/HudsonGraeme/MoCI/releases/latest):

```bash
wget https://github.com/HudsonGraeme/MoCI/releases/latest/download/moci_VERSION_ARCH.ipk
opkg install moci_VERSION_ARCH.ipk
```

Available architectures: x86_64, ramips/mt7621, ath79, mediatek/filogic, bcm27xx, ipq40xx, mvebu, ipq806x

Replace `VERSION_ARCH` with your specific file from the releases page.

### Option 2: Manual Install

**Quick start:**

```bash
scp -r moci/* root@192.168.1.1:/www/moci/
scp rpcd-acl.json root@192.168.1.1:/usr/share/rpcd/acl.d/moci.json
ssh root@192.168.1.1 "/etc/init.d/rpcd restart"
```

**First time setup** (if you get 404):

```bash
ssh root@192.168.1.1
uci set uhttpd.main.home='/www'
uci commit uhttpd
/etc/init.d/uhttpd restart
```

**What the ACL grants:**
- WAN/LAN status display on dashboard
- Bandwidth monitoring
- Device count
- Package list viewing in Software tab

Access at `http://192.168.1.1/moci/` and login with your root credentials.

---

## Building from Source

To build the ipk package yourself:

```bash
# In OpenWrt buildroot
git clone https://github.com/HudsonGraeme/MoCI.git package/moci
make package/moci/compile
```

The package will be in `bin/packages/*/base/moci_*.ipk`

---

## Monitoring & Netify Backends

MoCI’s Monitoring and Netify tabs are backed by local services running on the router.  
The frontend reads data via `ubus` (`file.read`, `file.exec`, `uci.get`) and does not do in-browser probing.

### Monitoring backend (Ping service)

**Service and scripts**
- Init script: `files/ping-monitor.init`
- Worker: `files/moci-ping-monitor.sh`
- Runtime command: `/usr/bin/moci-ping-monitor`

**Data flow**
1. Procd starts `moci-ping-monitor` (if `moci.ping_monitor.enabled=1`).
2. Script loads config from UCI (`moci.ping_monitor.*`).
3. It pings target (default `1.1.1.1`) on interval and appends rows to flat file.
4. Rows are stored in `output_file` (default `/tmp/pingTest.txt`) as:
   - `timestamp|target|status|latency|message`
5. Monitoring UI reads `/tmp/pingTest.txt` and renders:
   - status cards
   - timeline
   - recent samples table

**Config keys (`/etc/config/moci`)**
- `config ping 'ping_monitor'`
- `option enabled '1'`
- `option target '1.1.1.1'`
- `option interval '60'`
- `option timeout '2'`
- `option output_file '/tmp/pingTest.txt'`
- `option max_lines '2000'`

**Service control**
```bash
/etc/init.d/ping-monitor enable
/etc/init.d/ping-monitor start
/etc/init.d/ping-monitor restart
```

### Netify backend (Collector + JSONL flow file)

**Service and scripts**
- Init script: `files/netify-collector.init`
- Worker: `files/moci-netify-collector.sh`
- Runtime command: `/usr/bin/moci-netify-collector`

**Data flow**
1. Procd starts `moci-netify-collector` (if `moci.collector.enabled=1`).
2. Collector reads UCI config (`moci.collector.*`).
3. It connects to Netify stream via netcat (`nc host port`).
4. `type:"flow"` events are written to a local JSONL file.
5. Netify UI reads/parses that file via `file.read` and renders:
   - flow/app/device counters
   - top applications
   - recent flows
   - collector and file status

**Default output file**
- `/tmp/moci-netify-flow.jsonl`

**Config keys (`/etc/config/moci`)**
- `config netify 'collector'`
- `option enabled '1'`
- `option host '127.0.0.1'`
- `option port '7150'`
- `option output_file '/tmp/moci-netify-flow.jsonl'`
- `option max_lines '5000'`

**Service control**
```bash
/etc/init.d/netify-collector enable
/etc/init.d/netify-collector start
/etc/init.d/netify-collector restart
```

### Local demo mode

When using the root `index.html` demo wrapper (`/index.html`), Monitoring and Netify data are mocked in-browser:
- ping history/service responses are simulated
- Netify flow JSONL input is simulated

This lets you test UI behavior locally without running router services.

---

## Security

Uses OpenWrt's native authentication system. Same security model as LuCI:

| Feature | MoCI | LuCI |
|---------|------|------|
| Authentication | ubus sessions | ubus sessions |
| Authorization | rpcd ACLs | rpcd ACLs |

All operations validated server-side. No privilege escalation paths.

---

## Development

**Auto-deploy on save:**

```bash
# QEMU VM
pnpm dev

# Physical router
pnpm dev:physical 192.168.1.1
```

**Project structure:**

```
moci/
├── index.html    - Application shell
├── app.css       - Styling
└── js/
    ├── core.js   - Core functionality
    └── modules/  - Feature modules (dashboard, network, system, vpn, services)
```

**Adding features:**

```javascript
const [status, result] = await this.ubusCall('system', 'info', {});
```

---

## Browser Support

Chrome 90+ • Firefox 88+ • Safari 14+ • Any modern browser

---

## License

MIT
