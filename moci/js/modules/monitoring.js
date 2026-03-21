export default class MonitoringModule {
	constructor(core) {
		this.core = core;
		this.initialized = false;
		this.refreshTimer = null;
		this.serviceRunning = false;
		this.target = '1.1.1.1';
		this.intervalSec = 60;
		this.outputFile = '/tmp/moci-ping-monitor.txt';
		this.samples = [];

		this.core.registerRoute('/monitoring', async () => {
			const pageElement = document.getElementById('monitoring-page');
			if (pageElement) pageElement.classList.remove('hidden');

			if (!this.initialized) {
				this.setupHandlers();
				this.initialized = true;
			}

			await this.loadConfig();
			await this.refresh();
			this.startRefreshLoop();
		});
	}

	setupHandlers() {
		const targetInput = document.getElementById('monitoring-target');
		const intervalInput = document.getElementById('monitoring-interval');
		if (targetInput) targetInput.value = this.target;
		if (intervalInput) intervalInput.value = String(this.intervalSec);

		document.getElementById('monitoring-apply-btn')?.addEventListener('click', () => this.applySettings());
		document.getElementById('monitoring-toggle-btn')?.addEventListener('click', () => this.toggleService());
		document.getElementById('monitoring-run-now-btn')?.addEventListener('click', () => this.runOnce());
		document.getElementById('monitoring-clear-btn')?.addEventListener('click', () => this.clearHistory());
		document
			.getElementById('monitoring-settings-toggle-btn')
			?.addEventListener('click', () => this.toggleSettingsPanel());
		this.syncSettingsPanel();
	}

	toggleSettingsPanel() {
		const body = document.getElementById('monitoring-settings-body');
		const icon = document.getElementById('monitoring-settings-toggle-icon');
		const btn = document.getElementById('monitoring-settings-toggle-btn');
		if (!body || !icon || !btn) return;

		const isHidden = body.style.display === 'none' || body.style.display === '';
		if (isHidden) {
			body.style.display = 'block';
			icon.textContent = '▾';
			btn.setAttribute('aria-expanded', 'true');
			localStorage.setItem('monitoring_settings_expanded', '1');
		} else {
			body.style.display = 'none';
			icon.textContent = '▸';
			btn.setAttribute('aria-expanded', 'false');
			localStorage.setItem('monitoring_settings_expanded', '0');
		}
	}

	syncSettingsPanel() {
		const body = document.getElementById('monitoring-settings-body');
		const icon = document.getElementById('monitoring-settings-toggle-icon');
		const btn = document.getElementById('monitoring-settings-toggle-btn');
		if (!body || !icon || !btn) return;

		const expanded = localStorage.getItem('monitoring_settings_expanded') === '1';
		if (expanded) {
			body.style.display = 'block';
			icon.textContent = '▾';
			btn.setAttribute('aria-expanded', 'true');
		} else {
			body.style.display = 'none';
			icon.textContent = '▸';
			btn.setAttribute('aria-expanded', 'false');
		}
	}

	async loadConfig() {
		try {
			const [status, result] = await this.core.uciGet('moci', 'ping_monitor');
			if (status === 0 && result?.values) {
				const c = result.values;
				this.target = c.target || this.target;
				this.intervalSec = Number(c.interval) || this.intervalSec;
				this.outputFile = c.output_file || this.outputFile;
			}
		} catch {}

		const targetInput = document.getElementById('monitoring-target');
		const intervalInput = document.getElementById('monitoring-interval');
		if (targetInput) targetInput.value = this.target;
		if (intervalInput) intervalInput.value = String(this.intervalSec);
	}

	async applySettings() {
		const targetInput = document.getElementById('monitoring-target');
		const intervalInput = document.getElementById('monitoring-interval');

		const target = (targetInput?.value || '').trim() || '1.1.1.1';
		const interval = Number(intervalInput?.value || 60);

		if (!/^[a-zA-Z0-9.\-:]+$/.test(target)) {
			this.core.showToast('Invalid target host/IP', 'error');
			return;
		}
		if (!Number.isFinite(interval) || interval < 5 || interval > 3600) {
			this.core.showToast('Interval must be between 5 and 3600 seconds', 'error');
			return;
		}

		try {
			await this.core.uciSet('moci', 'ping_monitor', {
				target,
				interval: String(interval)
			});
			await this.core.uciCommit('moci');
			this.target = target;
			this.intervalSec = interval;
			await this.exec('/etc/init.d/ping-monitor', ['restart']);
			await this.refresh();
			this.core.showToast('Ping monitor settings applied', 'success');
		} catch (err) {
			console.error('Failed to apply ping monitor settings:', err);
			this.core.showToast('Failed to apply settings', 'error');
		}
	}

	startRefreshLoop() {
		if (this.refreshTimer) clearInterval(this.refreshTimer);
		this.refreshTimer = setInterval(() => {
			if (this.core.currentRoute?.startsWith('/monitoring')) {
				this.refresh();
			}
		}, 5000);
	}

	async refresh() {
		try {
			await this.updateServiceStatus();
			await this.readPingFile();
			this.renderAll();
		} catch (err) {
			console.error('Monitoring refresh failed:', err);
		}
	}

	async updateServiceStatus() {
		try {
			const result = await this.exec('/bin/sh', ['-c', 'pgrep -f moci-ping-monitor >/dev/null && echo RUNNING || echo STOPPED']);
			this.serviceRunning = (result.stdout || '').trim() === 'RUNNING';
		} catch {
			this.serviceRunning = false;
		}
	}

	async readPingFile() {
		try {
			const [status, result] = await this.core.ubusCall('file', 'read', { path: this.outputFile });
			if (status !== 0 || !result?.data) {
				this.samples = [];
				return;
			}
			this.samples = this.parseSamples(result.data);
		} catch {
			this.samples = [];
		}
	}

	parseSamples(raw) {
		return raw
			.split('\n')
			.map(line => line.trim())
			.filter(Boolean)
			.map(line => {
				const [ts, target, status, latency, message] = line.split('|');
				const parsedTs = Date.parse(ts);
				return {
					ts: Number.isNaN(parsedTs) ? Date.now() : parsedTs,
					target: target || this.target,
					status: status === 'OK' ? this.getStatusFromLatency(latency) : 'error',
					latency: latency && latency !== 'N/A' ? parseFloat(latency) : null,
					message: message || ''
				};
			})
			.slice(-2000);
	}

	getStatusFromLatency(latency) {
		const value = parseFloat(latency);
		if (Number.isNaN(value)) return 'error';
		if (value >= 125) return 'warn';
		if (value >= 75) return 'good';
		return 'ok';
	}

	async toggleService() {
		const action = this.serviceRunning ? 'stop' : 'start';
		try {
			await this.exec('/etc/init.d/ping-monitor', [action]);
			await this.refresh();
			this.core.showToast(`Ping service ${action}ed`, 'success');
		} catch (err) {
			console.error(`Failed to ${action} ping service:`, err);
			this.core.showToast(`Failed to ${action} service`, 'error');
		}
	}

	async runOnce() {
		try {
			await this.exec('/usr/bin/moci-ping-monitor', ['--once'], { timeout: 12000 });
			await this.refresh();
			this.core.showToast('One ping sample captured', 'success');
		} catch (err) {
			console.error('Failed to run ping once:', err);
			this.core.showToast('Failed to run ping once', 'error');
		}
	}

	async clearHistory() {
		try {
			await this.core.ubusCall('file', 'write', { path: this.outputFile, data: '' });
			await this.refresh();
			this.core.showToast('Ping history cleared', 'success');
		} catch (err) {
			console.error('Failed to clear ping history:', err);
			this.core.showToast('Failed to clear history', 'error');
		}
	}

	renderStatusCard() {
		const toggleBtn = document.getElementById('monitoring-toggle-btn');
		if (toggleBtn) toggleBtn.textContent = this.serviceRunning ? 'STOP SERVICE' : 'START SERVICE';

		const latest = this.samples[this.samples.length - 1];
		const latencyEl = document.getElementById('monitoring-latency');
		const statusEl = document.getElementById('monitoring-status');
		const avgEl = document.getElementById('monitoring-avg');
		const lossEl = document.getElementById('monitoring-loss');

		if (latencyEl) {
			latencyEl.textContent = latest?.latency != null ? `${latest.latency.toFixed(1)} ms` : 'N/A';
		}

		if (statusEl) {
			const statusBadge = this.getStatusBadge(latest?.status || 'error');
			statusEl.innerHTML = statusBadge;
		}

		const windowSamples = this.samples.slice(-12);
		const valid = windowSamples.filter(s => s.latency != null);
		const avg = valid.length > 0 ? valid.reduce((sum, s) => sum + s.latency, 0) / valid.length : 0;
		const loss = windowSamples.length > 0 ? ((windowSamples.length - valid.length) / windowSamples.length) * 100 : 0;

		if (avgEl) avgEl.textContent = `${avg.toFixed(1)} ms`;
		if (lossEl) lossEl.textContent = `${loss.toFixed(0)}%`;
	}

	getStatusBadge(status) {
		if (status === 'ok') return this.core.renderBadge('success', 'excellent');
		if (status === 'good') return this.core.renderBadge('info', 'good');
		if (status === 'warn') return this.core.renderBadge('warning', 'high latency');
		return this.core.renderBadge('error', 'outage');
	}

	renderTimeline() {
		const bars = document.getElementById('monitoring-timeline-bars');
		const labels = document.getElementById('monitoring-timeline-labels');
		if (!bars || !labels) return;

		const segments = this.samples.slice(-12);
		if (segments.length === 0) {
			bars.innerHTML = '<div class="monitoring-empty">No data yet</div>';
			labels.innerHTML = '';
			return;
		}

		bars.innerHTML = segments
			.map(segment => {
				const cls = this.getSegmentClass(segment);
				const latency = segment.latency != null ? `${segment.latency.toFixed(1)}ms` : 'timeout';
				const title = `${this.formatTime(segment.ts)} • ${latency}`;
				return `<div class="monitoring-segment ${cls}" title="${this.core.escapeHtml(title)}"></div>`;
			})
			.join('');

		labels.innerHTML = segments
			.map(segment => `<span>${this.formatTime(segment.ts, true)}</span>`)
			.join('');
	}

	getSegmentClass(segment) {
		if (segment.status === 'error') return 'seg-error';
		if (segment.status === 'warn') return 'seg-warn';
		if (segment.status === 'good') return 'seg-good';
		return 'seg-ok';
	}

	renderRecentTable() {
		const tbody = document.querySelector('#monitoring-recent-table tbody');
		if (!tbody) return;

		const rows = this.samples.slice(-20).reverse();
		if (rows.length === 0) {
			this.core.renderEmptyTable(tbody, 4, 'No ping samples yet');
			return;
		}

		tbody.innerHTML = rows
			.map(row => {
					const latency = row.latency != null ? `${row.latency.toFixed(1)} ms` : 'timeout';
					return `<tr>
						<td>${this.core.escapeHtml(this.formatTime(row.ts))}</td>
						<td>${this.core.escapeHtml(row.target || this.target)}</td>
						<td>${this.core.escapeHtml(latency)}</td>
						<td>${this.getStatusBadge(row.status)}</td>
					</tr>`;
			})
			.join('');
	}

	formatTime(ts, short = false) {
		const d = new Date(ts);
		return short
			? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
			: d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
	}

	async exec(command, params = [], options = {}) {
		const [status, result] = await this.core.ubusCall('file', 'exec', { command, params }, options);
		if (status !== 0) {
			throw new Error(`${command} failed (${status})`);
		}
		return result || {};
	}
}
