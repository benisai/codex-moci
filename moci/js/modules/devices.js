export default class DevicesModule {
	constructor(core) {
		this.core = core;
		this.initialized = false;
		this.refreshTimer = null;
		this.rowsByMac = new Map();
		this.staticByMac = new Map();

		this.core.registerRoute('/devices', async () => {
			const pageElement = document.getElementById('devices-page');
			if (pageElement) pageElement.classList.remove('hidden');

			if (!this.initialized) {
				this.setupHandlers();
				this.initialized = true;
			}

			await this.loadDevices();
			this.startRefreshLoop();
		});
	}

	setupHandlers() {
		document.getElementById('devices-refresh-btn')?.addEventListener('click', () => this.loadDevices());

		this.core.setupModal({
			modalId: 'devices-pin-modal',
			closeBtnId: 'close-devices-pin-modal',
			cancelBtnId: 'cancel-devices-pin-btn',
			saveBtnId: 'save-devices-pin-btn',
			saveHandler: () => this.savePinnedIp()
		});

		this.core.delegateActions('devices-table', {
			pin: mac => this.openPinDialog(mac)
		});
	}

	startRefreshLoop() {
		if (this.refreshTimer) return;
		this.refreshTimer = setInterval(() => {
			if (this.core.currentRoute?.startsWith('/devices')) {
				this.loadDevices();
			}
		}, 15000);
	}

	async loadDevices() {
		const tbody = document.querySelector('#devices-table tbody');
		if (!tbody) return;

		try {
			const [leases, arpMacs, usage, staticByMac] = await Promise.all([
				this.fetchLeases(),
				this.fetchArpMacs(),
				this.fetchNlbwmonUsage(),
				this.fetchStaticLeasesByMac()
			]);

			this.staticByMac = staticByMac;
			this.renderSourceStatus();
			const rows = this.mergeRows(leases, arpMacs, usage.totalsByClient, staticByMac);
			this.renderRows(rows);
		} catch (err) {
			console.error('Failed to load devices page:', err);
			this.core.renderEmptyTable(tbody, 7, 'Failed to load device data');
			this.renderSourceStatus();
		}
	}

	async fetchLeases() {
		try {
			const [status, result] = await this.core.ubusCall('luci-rpc', 'getDHCPLeases', {});
			if (status === 0 && Array.isArray(result?.dhcp_leases)) {
				return result.dhcp_leases;
			}
		} catch {}
		return [];
	}

	async fetchStaticLeasesByMac() {
		const map = new Map();
		try {
			const [status, result] = await this.core.uciGet('dhcp');
			if (status !== 0 || !result?.values) return map;

			for (const [section, config] of Object.entries(result.values)) {
				if (config['.type'] !== 'host') continue;
				const mac = this.normalizeMac(config.mac);
				if (!mac) continue;
				map.set(mac, {
					section,
					ip: config.ip || '',
					name: config.name || ''
				});
			}
		} catch {}
		return map;
	}

	normalizeMac(value) {
		if (Array.isArray(value)) {
			for (const item of value) {
				const parsed = this.normalizeMac(item);
				if (parsed) return parsed;
			}
			return '';
		}

		const raw = String(value || '')
			.trim()
			.toLowerCase();
		if (!raw) return '';
		const first = raw.split(/[\s,]+/)[0];
		return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(first) ? first : '';
	}

	async fetchArpMacs() {
		try {
			const [status, result] = await this.core.ubusCall('file', 'read', { path: '/proc/net/arp' });
			if (status !== 0 || !result?.data) return new Set();
			return this.parseArpMacs(result.data);
		} catch {
			return new Set();
		}
	}

	parseArpMacs(text) {
		const online = new Set();
		for (const line of text.split('\n').slice(1)) {
			const parts = line.trim().split(/\s+/);
			if (parts.length < 4) continue;
			const mac = (parts[3] || '').toLowerCase();
			if (mac && mac !== '00:00:00:00:00:00') online.add(mac);
		}
		return online;
	}

	async fetchNlbwmonUsage() {
		const result = {
			available: false,
			totalsByClient: new Map()
		};

		try {
			const [status, execResult] = await this.core.ubusCall('file', 'exec', {
				command: '/usr/libexec/nlbwmon-action',
				params: ['download', '-g', 'family,mac,ip,layer7', '-o', '-rx_bytes,-tx_bytes']
			});

			if (status !== 0 || !execResult?.stdout) return result;

			const parsed = this.parseNlbwmonOutput(execResult.stdout);
			result.available = parsed.available;
			result.totalsByClient = parsed.totalsByClient;
			return result;
		} catch {
			return result;
		}
	}

	parseNlbwmonOutput(stdout) {
		const empty = { available: false, totalsByClient: new Map() };
		let payload;
		try {
			payload = JSON.parse(stdout);
		} catch {
			return empty;
		}

		const columns = Array.isArray(payload?.columns) ? payload.columns : [];
		const data = Array.isArray(payload?.data) ? payload.data : [];
		const colIndex = name => columns.indexOf(name);

		const macIdx = colIndex('mac');
		const ipIdx = colIndex('ip');
		const rxIdx = colIndex('rx_bytes');
		const txIdx = colIndex('tx_bytes');
		if (rxIdx < 0 || txIdx < 0) return empty;

		const totalsByClient = new Map();

		for (const row of data) {
			if (!Array.isArray(row)) continue;
			const mac = macIdx >= 0 ? String(row[macIdx] || '').toLowerCase() : '';
			const ip = ipIdx >= 0 ? String(row[ipIdx] || '') : '';
			const key = mac || ip;
			if (!key) continue;

			const rx = Number(row[rxIdx]) || 0;
			const tx = Number(row[txIdx]) || 0;
			const current = totalsByClient.get(key) || { mac, ip, rx: 0, tx: 0 };
			current.rx += rx;
			current.tx += tx;
			if (!current.mac) current.mac = mac;
			if (!current.ip) current.ip = ip;
			totalsByClient.set(key, current);
		}

		return { available: true, totalsByClient };
	}

	mergeRows(leases, arpMacs, totalsByClient, staticByMac) {
		const merged = [];
		const seen = new Set();

		for (const lease of leases) {
			const mac = String(lease.macaddr || '').toLowerCase();
			const ip = String(lease.ipaddr || '');
			const key = mac || ip;
			const usage = totalsByClient.get(key) || totalsByClient.get(ip) || null;
			const pin = mac ? staticByMac.get(mac) : null;
			merged.push({
				hostname: lease.hostname || pin?.name || 'Unknown',
				ip: pin?.ip || ip || 'N/A',
				leaseIp: ip || 'N/A',
				mac: mac || 'N/A',
				tx: usage ? usage.tx : null,
				rx: usage ? usage.rx : null,
				online: mac ? arpMacs.has(mac) : false,
				pinned: Boolean(pin?.ip),
				staticSection: pin?.section || ''
			});
			if (key) seen.add(key);
			if (ip) seen.add(ip);
		}

		for (const [key, usage] of totalsByClient.entries()) {
			if (seen.has(key)) continue;
			const mac = usage.mac || '';
			const ip = usage.ip || '';
			const pin = mac ? staticByMac.get(mac) : null;
			merged.push({
				hostname: pin?.name || 'Unknown',
				ip: pin?.ip || ip || 'N/A',
				leaseIp: ip || 'N/A',
				mac: mac || 'N/A',
				tx: usage.tx,
				rx: usage.rx,
				online: mac ? arpMacs.has(mac) : false,
				pinned: Boolean(pin?.ip),
				staticSection: pin?.section || ''
			});
		}

		return merged.sort((a, b) => {
			const aTotal = (a.rx || 0) + (a.tx || 0);
			const bTotal = (b.rx || 0) + (b.tx || 0);
			return bTotal - aTotal;
		});
	}

	renderRows(rows) {
		const tbody = document.querySelector('#devices-table tbody');
		if (!tbody) return;

		this.rowsByMac.clear();
		for (const row of rows) {
			if (row.mac && row.mac !== 'N/A') {
				this.rowsByMac.set(row.mac, row);
			}
		}

		if (rows.length === 0) {
			this.core.renderEmptyTable(tbody, 7, 'No DHCP lease or nlbwmon client data found');
			return;
		}

		tbody.innerHTML = rows
			.map(row => {
				const upload = row.tx == null ? 'N/A' : this.core.formatBytes(row.tx);
				const download = row.rx == null ? 'N/A' : this.core.formatBytes(row.rx);
				const pinBtn =
					row.mac === 'N/A'
						? '-'
						: `<button class="action-btn-sm devices-action-btn" data-action="pin" data-id="${this.core.escapeHtml(row.mac)}" title="Device settings">ACTION</button>`;

				const ipText = row.pinned
					? `${this.core.escapeHtml(row.ip)} ${this.core.renderBadge('info', 'Pinned')}`
					: this.core.escapeHtml(row.ip);

				return `<tr>
					<td>${this.core.escapeHtml(row.hostname)}</td>
					<td>${ipText}</td>
					<td>${this.core.escapeHtml(row.mac)}</td>
					<td>${this.core.escapeHtml(upload)}</td>
					<td>${this.core.escapeHtml(download)}</td>
					<td>${row.online ? this.core.renderBadge('success', 'ONLINE') : this.core.renderBadge('error', 'OFFLINE')}</td>
					<td>${pinBtn}</td>
				</tr>`;
			})
			.join('');
	}

	openPinDialog(mac) {
		const normalizedMac = this.normalizeMac(mac);
		if (!normalizedMac) {
			this.core.showToast('Device MAC not available', 'error');
			return;
		}

		const row = this.rowsByMac.get(normalizedMac);
		if (!row) {
			this.core.showToast('Device not found', 'error');
			return;
		}

		document.getElementById('devices-pin-section').value = row.staticSection || '';
		document.getElementById('devices-pin-hostname').value = row.hostname || '';
		document.getElementById('devices-pin-mac').value = normalizedMac;
		document.getElementById('devices-pin-ip').value = row.ip && row.ip !== 'N/A' ? row.ip : '';
		this.core.openModal('devices-pin-modal');
	}

	isValidIpv4(ip) {
		const parts = String(ip || '').trim().split('.');
		if (parts.length !== 4) return false;
		return parts.every(part => {
			if (!/^\d+$/.test(part)) return false;
			const n = Number(part);
			return n >= 0 && n <= 255;
		});
	}

	async savePinnedIp() {
		const section = document.getElementById('devices-pin-section').value;
		const hostname = (document.getElementById('devices-pin-hostname').value || '').trim();
		const mac = this.normalizeMac(document.getElementById('devices-pin-mac').value);
		const ip = (document.getElementById('devices-pin-ip').value || '').trim();

		if (!mac) {
			this.core.showToast('Invalid MAC address', 'error');
			return;
		}
		if (!this.isValidIpv4(ip)) {
			this.core.showToast('Enter a valid IPv4 address', 'error');
			return;
		}

		try {
			let targetSection = section;
			if (!targetSection) {
				const [, addResult] = await this.core.uciAdd('dhcp', 'host');
				targetSection = addResult?.section;
				if (!targetSection) throw new Error('Failed to create DHCP host section');
			}

			const values = {
				mac,
				ip
			};
			if (hostname && hostname !== 'Unknown') values.name = hostname;

			await this.core.uciSet('dhcp', targetSection, values);
			await this.core.uciCommit('dhcp');
			try {
				await this.core.serviceReload('dnsmasq');
			} catch {}

			this.core.closeModal('devices-pin-modal');
			this.core.showToast('Static IP pinned for device', 'success');
			await this.loadDevices();
		} catch (err) {
			console.error('Failed to save pinned IP:', err);
			this.core.showToast('Failed to save static IP', 'error');
		}
	}

	renderSourceStatus() {
		const el = document.getElementById('devices-source-status');
		if (!el) return;
		el.textContent = '';
	}
}
