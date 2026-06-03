export default class ThroughputModule {
	constructor(core) {
		this.core = core;
		this.initialized = false;
		this.pollTimer = null;
		this.pollMs = 2000;
		this.maxSamples = 90;
		this.previousSnapshot = new Map();
		this.deviceSamples = new Map();
		this.deviceMeta = new Map();
		this.hiddenDevices = new Set();
		this.canvas = null;
		this.ctx = null;
		this.tooltip = null;
		this.hoverSlot = -1;
		this.hoverBound = false;
		this.maxBytesPerSecond = 125 * 1024 * 1024;
		this.colors = [
			'#84d2ff',
			'#ffc17a',
			'#8df0a4',
			'#ff8c8c',
			'#d0a7ff',
			'#78e4ff',
			'#f6e27f',
			'#ff9bd1'
		];

		this.core.registerRoute('/throughput', async () => this.load());
	}

	async load() {
		const pageElement = document.getElementById('throughput-page');
		if (pageElement) pageElement.classList.remove('hidden');
		this.setupHandlers();
		this.canvas = document.getElementById('throughput-graph');
		this.ctx = this.canvas?.getContext?.('2d') || null;
		this.bindGraphHover();
		this.ensureTooltip();
		await this.refreshDeviceLabels();
		await this.poll();
		this.startPolling();
	}

	setupHandlers() {
		if (this.initialized) return;
		this.initialized = true;
		document.getElementById('throughput-device-list')?.addEventListener('click', event => {
			const chip = event.target?.closest?.('[data-throughput-device]');
			if (!chip) return;
			const key = chip.getAttribute('data-throughput-device');
			if (!key) return;
			if (this.hiddenDevices.has(key)) this.hiddenDevices.delete(key);
			else this.hiddenDevices.add(key);
			this.render();
		});
	}

	bindGraphHover() {
		if (!this.canvas || this.hoverBound) return;
		this.hoverBound = true;
		this.canvas.addEventListener('mousemove', event => this.handleGraphHover(event));
		this.canvas.addEventListener('mouseleave', () => {
			this.hoverSlot = -1;
			this.hideTooltip();
			this.drawGraph();
		});
		this.canvas.addEventListener('touchstart', event => this.handleGraphTouch(event), { passive: true });
		this.canvas.addEventListener('touchmove', event => this.handleGraphTouch(event), { passive: true });
	}

	ensureTooltip() {
		if (this.tooltip) return;
		const container = this.canvas?.closest?.('.throughput-graph-container');
		if (!container) return;
		const tooltip = document.createElement('div');
		tooltip.className = 'bandwidth-tooltip throughput-tooltip hidden';
		container.appendChild(tooltip);
		this.tooltip = tooltip;
	}

	handleGraphTouch(event) {
		const touch = event.touches?.[0];
		if (!touch) return;
		this.handleGraphHover(touch);
	}

	handleGraphHover(event) {
		if (!this.canvas || !this.ctx) return;
		const rect = this.canvas.getBoundingClientRect();
		const localX = event.clientX - rect.left;
		const localY = event.clientY - rect.top;
		const slot = this.resolveHoverSlot(localX, rect.width);
		if (slot !== this.hoverSlot) {
			this.hoverSlot = slot;
			this.drawGraph();
		}
		if (slot < 0) {
			this.hideTooltip();
			return;
		}
		this.showTooltip(slot, localX, localY, rect.width);
	}

	startPolling() {
		if (this.pollTimer) return;
		this.pollTimer = setInterval(() => {
			if (this.core.currentRoute?.startsWith('/throughput')) {
				this.poll().catch(err => console.error('Failed to poll live throughput:', err));
			}
		}, this.pollMs);
	}

	async refreshDeviceLabels() {
		try {
			const [status, result] = await this.core.ubusCall('luci-rpc', 'getDHCPLeases', {});
			if (status !== 0 || !Array.isArray(result?.dhcp_leases)) return;
			for (const lease of result.dhcp_leases) {
				const mac = this.normalizeMac(lease?.macaddr || '');
				const ip = String(lease?.ipaddr || '').trim();
				const hostname = String(lease?.hostname || '').trim();
				if (mac) this.deviceMeta.set(mac, { mac, ip, hostname });
				if (ip) this.deviceMeta.set(ip, { mac, ip, hostname });
			}
		} catch {}
	}

	async poll() {
		const snapshot = await this.fetchSummary();
		this.updateSamples(snapshot);
		this.render();
	}

	async fetchSummary() {
		const result = {
			available: false,
			timestamp: Date.now(),
			rows: []
		};
		try {
			const [status, execResult] = await this.core.ubusCall(
				'file',
				'exec',
				{ command: '/usr/bin/moci-device-traffic-summary', params: [] },
				{ timeout: 8000 }
			);
			if (status !== 0) return result;
			const rows = JSON.parse(String(execResult?.stdout || '[]'));
			if (!Array.isArray(rows)) return result;
			result.rows = rows
				.map(row => ({
					key: this.getDeviceKey(row),
					mac: this.normalizeMac(row?.mac || ''),
					ip: String(row?.ip || '').trim(),
					rxBytes: Math.max(0, Number(row?.rx_bytes) || 0),
					txBytes: Math.max(0, Number(row?.tx_bytes) || 0)
				}))
				.filter(row => row.key);
			result.available = result.rows.length > 0;
			return result;
		} catch (err) {
			console.warn('Live throughput summary unavailable:', err);
			return result;
		}
	}

	updateSamples(snapshot) {
		const nextSnapshot = new Map();
		const now = Number(snapshot?.timestamp || Date.now());
		let totalRx = 0;
		let totalTx = 0;

		for (const row of snapshot.rows || []) {
			const current = {
				rxBytes: row.rxBytes,
				txBytes: row.txBytes,
				timestamp: now
			};
			nextSnapshot.set(row.key, current);
			this.mergeDeviceMeta(row.key, row);

			const previous = this.previousSnapshot.get(row.key);
			if (!previous || current.timestamp <= previous.timestamp) {
				this.pushDeviceSample(row.key, { timestamp: now, rxRate: 0, txRate: 0 });
				continue;
			}

			const intervalSeconds = Math.max(0.25, (current.timestamp - previous.timestamp) / 1000);
			const rxRate = this.calculateRate(current.rxBytes, previous.rxBytes, intervalSeconds);
			const txRate = this.calculateRate(current.txBytes, previous.txBytes, intervalSeconds);
			const sample = {
				timestamp: now,
				rxRate: rxRate ?? 0,
				txRate: txRate ?? 0
			};
			this.pushDeviceSample(row.key, sample);
			totalRx += sample.rxRate;
			totalTx += sample.txRate;
		}

		for (const key of this.deviceSamples.keys()) {
			if (nextSnapshot.has(key)) continue;
			this.pushDeviceSample(key, { timestamp: now, rxRate: 0, txRate: 0 });
		}

		this.previousSnapshot = nextSnapshot;
		this.latestTotalRx = totalRx;
		this.latestTotalTx = totalTx;
		this.latestDeviceCount = snapshot.rows?.length || 0;
	}

	mergeDeviceMeta(key, row) {
		const existing = this.deviceMeta.get(key) || this.deviceMeta.get(row.mac) || this.deviceMeta.get(row.ip) || {};
		const meta = {
			mac: row.mac || existing.mac || '',
			ip: row.ip || existing.ip || '',
			hostname: existing.hostname || ''
		};
		this.deviceMeta.set(key, meta);
		if (meta.mac) this.deviceMeta.set(meta.mac, meta);
		if (meta.ip) this.deviceMeta.set(meta.ip, meta);
	}

	pushDeviceSample(key, sample) {
		const list = this.deviceSamples.get(key) || [];
		list.push(sample);
		while (list.length > this.maxSamples) list.shift();
		this.deviceSamples.set(key, list);
	}

	calculateRate(currentBytes, previousBytes, intervalSeconds) {
		const delta = Math.max(0, Number(currentBytes || 0) - Number(previousBytes || 0));
		const rate = delta / Math.max(0.25, Number(intervalSeconds || 0));
		if (!Number.isFinite(rate)) return null;
		if (rate > this.maxBytesPerSecond) return null;
		return Math.max(0, rate);
	}

	render() {
		this.renderSummary();
		this.renderDeviceList();
		this.drawGraph();
	}

	renderSummary() {
		const setText = (id, value) => {
			const el = document.getElementById(id);
			if (el) el.textContent = value;
		};
		setText('throughput-total-download', this.formatBitRate(this.latestTotalRx || 0));
		setText('throughput-total-upload', this.formatBitRate(this.latestTotalTx || 0));
		setText('throughput-device-count', String(this.latestDeviceCount || this.getDeviceKeys().length || 0));
	}

	renderDeviceList() {
		const container = document.getElementById('throughput-device-list');
		if (!container) return;
		const keys = this.getDeviceKeys();
		if (keys.length === 0) {
			container.innerHTML = '<div class="stat-label">No live device data yet</div>';
			return;
		}

		container.innerHTML = keys
			.map((key, index) => {
				const latest = this.getLatestSample(key);
				const color = this.getColor(index);
				const hidden = this.hiddenDevices.has(key);
				const label = this.getDeviceLabel(key);
				return `<button class="throughput-device-chip ${hidden ? 'is-hidden' : ''}" data-throughput-device="${this.core.escapeHtml(key)}" type="button" style="--device-color:${this.core.escapeHtml(color)}">
					<span class="throughput-device-dot"></span>
					<span class="throughput-device-name">${this.core.escapeHtml(label)}</span>
					<span class="throughput-device-rate">D ${this.core.escapeHtml(this.formatBitRate(latest?.rxRate || 0))}</span>
					<span class="throughput-device-rate">U ${this.core.escapeHtml(this.formatBitRate(latest?.txRate || 0))}</span>
				</button>`;
			})
			.join('');
	}

	drawGraph() {
		if (!this.canvas || !this.ctx) return;
		const rect = this.canvas.getBoundingClientRect();
		const dpr = window.devicePixelRatio || 1;
		const width = Math.max(320, Math.floor(rect.width || this.canvas.clientWidth || 900));
		const height = Math.max(220, Math.floor(rect.height || this.canvas.clientHeight || 320));
		if (this.canvas.width !== Math.floor(width * dpr) || this.canvas.height !== Math.floor(height * dpr)) {
			this.canvas.width = Math.floor(width * dpr);
			this.canvas.height = Math.floor(height * dpr);
		}
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.ctx.clearRect(0, 0, width, height);

		const pad = { left: 54, right: 14, top: 18, bottom: 30 };
		const plotW = Math.max(1, width - pad.left - pad.right);
		const plotH = Math.max(1, height - pad.top - pad.bottom);
		const keys = this.getVisibleDeviceKeys();
		const maxRate = Math.max(1, ...keys.flatMap(key => (this.deviceSamples.get(key) || []).map(s => s.rxRate + s.txRate)));

		this.drawGrid(width, height, pad, plotW, plotH, maxRate);
		if (keys.length === 0) {
			this.drawEmptyState(width, height);
			return;
		}

		const allKeys = this.getDeviceKeys();
		keys.forEach(key => {
			const samples = this.deviceSamples.get(key) || [];
			if (samples.length < 2) return;
			const offset = Math.max(0, this.maxSamples - samples.length);
			this.ctx.beginPath();
			samples.forEach((sample, i) => {
				const x = pad.left + ((offset + i) / Math.max(1, this.maxSamples - 1)) * plotW;
				const y = pad.top + plotH - ((sample.rxRate + sample.txRate) / maxRate) * plotH;
				if (i === 0) this.ctx.moveTo(x, y);
				else this.ctx.lineTo(x, y);
			});
			this.ctx.strokeStyle = this.getColor(allKeys.indexOf(key));
			this.ctx.lineWidth = 2;
			this.ctx.lineJoin = 'round';
			this.ctx.lineCap = 'round';
			this.ctx.stroke();
		});
		this.drawHoverGuide(width, height, pad, plotW);
	}

	drawGrid(width, height, pad, plotW, plotH, maxRate) {
		this.ctx.save();
		this.ctx.strokeStyle = 'rgba(255,255,255,0.08)';
		this.ctx.fillStyle = 'rgba(226,226,229,0.58)';
		this.ctx.font = '10px SF Mono, Monaco, monospace';
		this.ctx.lineWidth = 1;
		for (let i = 0; i <= 4; i++) {
			const y = pad.top + (plotH / 4) * i;
			this.ctx.beginPath();
			this.ctx.moveTo(pad.left, y);
			this.ctx.lineTo(width - pad.right, y);
			this.ctx.stroke();
			const value = maxRate * (1 - i / 4);
			this.ctx.fillText(this.formatBitRate(value), 6, y + 3);
		}
		this.ctx.strokeStyle = 'rgba(255,255,255,0.12)';
		this.ctx.strokeRect(pad.left, pad.top, plotW, plotH);
		this.ctx.fillStyle = 'rgba(226,226,229,0.45)';
		this.ctx.fillText(`${Math.round((this.maxSamples * this.pollMs) / 1000)}s window`, pad.left, height - 9);
		this.ctx.restore();
	}

	drawEmptyState(width, height) {
		this.ctx.save();
		this.ctx.fillStyle = 'rgba(226,226,229,0.55)';
		this.ctx.font = '13px SF Mono, Monaco, monospace';
		this.ctx.textAlign = 'center';
		this.ctx.fillText('Select at least one device with samples', width / 2, height / 2);
		this.ctx.restore();
	}

	drawHoverGuide(width, height, pad, plotW) {
		if (this.hoverSlot < 0) return;
		const x = pad.left + (this.hoverSlot / Math.max(1, this.maxSamples - 1)) * plotW;
		this.ctx.save();
		this.ctx.strokeStyle = 'rgba(255,255,255,0.32)';
		this.ctx.lineWidth = 1;
		this.ctx.setLineDash([4, 4]);
		this.ctx.beginPath();
		this.ctx.moveTo(x, pad.top);
		this.ctx.lineTo(x, height - pad.bottom);
		this.ctx.stroke();
		this.ctx.setLineDash([]);
		this.ctx.fillStyle = 'rgba(255,255,255,0.68)';
		this.ctx.beginPath();
		this.ctx.arc(x, height - pad.bottom, 3, 0, Math.PI * 2);
		this.ctx.fill();
		this.ctx.restore();
	}

	resolveHoverSlot(localX, containerWidth) {
		const width = Math.max(320, Math.floor(containerWidth || this.canvas?.clientWidth || 900));
		const pad = { left: 54, right: 14 };
		const plotW = Math.max(1, width - pad.left - pad.right);
		if (localX < pad.left || localX > width - pad.right) return -1;
		const ratio = (localX - pad.left) / plotW;
		return Math.min(Math.max(Math.round(ratio * (this.maxSamples - 1)), 0), this.maxSamples - 1);
	}

	showTooltip(slot, localX, localY, containerWidth) {
		if (!this.tooltip) return;
		const entries = this.getVisibleDeviceKeys()
			.map(key => {
				const sample = this.getSampleAtSlot(key, slot);
				if (!sample) return null;
				return {
					key,
					label: this.getDeviceLabel(key),
					rxRate: sample.rxRate || 0,
					txRate: sample.txRate || 0,
					total: (sample.rxRate || 0) + (sample.txRate || 0),
					timestamp: sample.timestamp || 0
				};
			})
			.filter(Boolean)
			.sort((a, b) => b.total - a.total);

		const activeEntries = entries.filter(entry => entry.total > 0).slice(0, 6);
		const shownEntries = activeEntries.length > 0 ? activeEntries : entries.slice(0, 4);
		const newestTimestamp = shownEntries.find(entry => entry.timestamp)?.timestamp || 0;
		const title = newestTimestamp ? this.formatSampleAge(newestTimestamp) : 'No sample';
		const allKeys = this.getDeviceKeys();

		this.tooltip.innerHTML = `
			<div class="bandwidth-tooltip-title">${this.core.escapeHtml(title)}</div>
			${
				shownEntries.length
					? shownEntries
							.map(entry => {
								const color = this.getColor(allKeys.indexOf(entry.key));
								return `<div class="throughput-tooltip-row">
									<span class="throughput-tooltip-dot" style="background:${this.core.escapeHtml(color)}"></span>
									<span class="throughput-tooltip-name">${this.core.escapeHtml(entry.label)}</span>
									<span>${this.core.escapeHtml(this.formatBitRate(entry.total))}</span>
								</div>
								<div class="throughput-tooltip-sub">D ${this.core.escapeHtml(this.formatBitRate(entry.rxRate))} / U ${this.core.escapeHtml(this.formatBitRate(entry.txRate))}</div>`;
							})
							.join('')
					: '<div>No visible device samples</div>'
			}
		`;

		this.tooltip.classList.remove('hidden');
		const tooltipWidth = this.tooltip.offsetWidth || 220;
		const left = Math.min(Math.max(12, localX + 12), Math.max(12, containerWidth - tooltipWidth - 12));
		const top = Math.max(8, localY - 72);
		this.tooltip.style.left = `${left}px`;
		this.tooltip.style.top = `${top}px`;
	}

	hideTooltip() {
		if (!this.tooltip) return;
		this.tooltip.classList.add('hidden');
	}

	getSampleAtSlot(key, slot) {
		const samples = this.deviceSamples.get(key) || [];
		const offset = Math.max(0, this.maxSamples - samples.length);
		const idx = slot - offset;
		if (idx < 0 || idx >= samples.length) return null;
		return samples[idx] || null;
	}

	formatSampleAge(timestamp) {
		const secondsAgo = Math.max(0, Math.round((Date.now() - Number(timestamp || 0)) / 1000));
		if (secondsAgo <= 2) return 'Now';
		if (secondsAgo < 60) return `${secondsAgo}s ago`;
		const minutes = Math.floor(secondsAgo / 60);
		const seconds = secondsAgo % 60;
		return `${minutes}m ${seconds}s ago`;
	}

	getDeviceKeys() {
		return Array.from(this.deviceSamples.keys()).sort((a, b) => this.getDeviceLabel(a).localeCompare(this.getDeviceLabel(b)));
	}

	getVisibleDeviceKeys() {
		return this.getDeviceKeys().filter(key => !this.hiddenDevices.has(key));
	}

	getLatestSample(key) {
		const list = this.deviceSamples.get(key) || [];
		return list[list.length - 1] || null;
	}

	getDeviceKey(row) {
		const mac = this.normalizeMac(row?.mac || '');
		const ip = String(row?.ip || '').trim();
		return mac || ip;
	}

	getDeviceLabel(key) {
		const meta = this.deviceMeta.get(key) || {};
		return meta.hostname || meta.ip || meta.mac || key;
	}

	getColor(index) {
		return this.colors[index % this.colors.length];
	}

	formatBitRate(bytesPerSecond) {
		const value = Math.max(0, Number(bytesPerSecond) || 0) * 8;
		const units = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'];
		let scaled = value;
		let unitIndex = 0;
		while (scaled >= 1000 && unitIndex < units.length - 1) {
			scaled /= 1000;
			unitIndex++;
		}
		const digits = scaled >= 100 || unitIndex === 0 ? 0 : scaled >= 10 ? 1 : 2;
		return `${scaled.toFixed(digits)} ${units[unitIndex]}`;
	}

	normalizeMac(value) {
		const mac = String(value || '').trim().toLowerCase();
		return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac) ? mac : '';
	}
}
