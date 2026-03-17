export default class DevicesModule {
	constructor(core) {
		this.core = core;
		this.initialized = false;
		this.refreshTimer = null;

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
			const [leases, arpMacs, usage] = await Promise.all([
				this.fetchLeases(),
				this.fetchArpMacs(),
				this.fetchNlbwmonUsage()
			]);

			this.renderSourceStatus(usage.available);
			const rows = this.mergeRows(leases, arpMacs, usage.totalsByClient);
			this.renderRows(rows);
		} catch (err) {
			console.error('Failed to load devices page:', err);
			this.core.renderEmptyTable(tbody, 6, 'Failed to load device data');
			this.renderSourceStatus(false, 'Failed to load nlbwmon data');
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

	mergeRows(leases, arpMacs, totalsByClient) {
		const merged = [];
		const seen = new Set();

		for (const lease of leases) {
			const mac = String(lease.macaddr || '').toLowerCase();
			const ip = String(lease.ipaddr || '');
			const key = mac || ip;
			const usage = totalsByClient.get(key) || totalsByClient.get(ip) || null;
			merged.push({
				hostname: lease.hostname || 'Unknown',
				ip: ip || 'N/A',
				mac: mac || 'N/A',
				tx: usage ? usage.tx : null,
				rx: usage ? usage.rx : null,
				online: mac ? arpMacs.has(mac) : false
			});
			if (key) seen.add(key);
			if (ip) seen.add(ip);
		}

		for (const [key, usage] of totalsByClient.entries()) {
			if (seen.has(key)) continue;
			const mac = usage.mac || '';
			const ip = usage.ip || '';
			merged.push({
				hostname: 'Unknown',
				ip: ip || 'N/A',
				mac: mac || 'N/A',
				tx: usage.tx,
				rx: usage.rx,
				online: mac ? arpMacs.has(mac) : false
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

		if (rows.length === 0) {
			this.core.renderEmptyTable(tbody, 6, 'No DHCP lease or nlbwmon client data found');
			return;
		}

		tbody.innerHTML = rows
			.map(row => {
				const upload = row.tx == null ? 'N/A' : this.core.formatBytes(row.tx);
				const download = row.rx == null ? 'N/A' : this.core.formatBytes(row.rx);
				return `<tr>
					<td>${this.core.escapeHtml(row.hostname)}</td>
					<td>${this.core.escapeHtml(row.ip)}</td>
					<td>${this.core.escapeHtml(row.mac)}</td>
					<td>${this.core.escapeHtml(upload)}</td>
					<td>${this.core.escapeHtml(download)}</td>
					<td>${row.online ? this.core.renderBadge('success', 'ONLINE') : this.core.renderBadge('error', 'OFFLINE')}</td>
				</tr>`;
			})
			.join('');
	}

	renderSourceStatus(nlbwmonAvailable, message = '') {
		const el = document.getElementById('devices-source-status');
		if (!el) return;

		if (message) {
			el.textContent = message;
			return;
		}

		el.textContent = nlbwmonAvailable
			? 'Bandwidth source: luci-app-nlbwmon'
			: 'Bandwidth source: unavailable (install/enable luci-app-nlbwmon)';
	}
}
