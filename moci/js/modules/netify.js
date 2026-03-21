export default class NetifyModule {
	constructor(core) {
		this.core = core;
		this.initialized = false;
		this.pollInterval = null;
		this.outputPath = '/tmp/moci-netify-flow.jsonl';
		this.maxLines = 5000;
		this.isRefreshing = false;
		this.flows = [];

		this.core.registerRoute('/netify', async () => {
			const pageElement = document.getElementById('netify-page');
			if (pageElement) pageElement.classList.remove('hidden');

			if (!this.initialized) {
				this.setupHandlers();
				this.initialized = true;
			}

			await this.load();
		});
	}

	setupHandlers() {
		document.getElementById('netify-refresh-btn')?.addEventListener('click', () => this.refresh(true));
		document.getElementById('netify-start-btn')?.addEventListener('click', () => this.runServiceAction('start'));
		document.getElementById('netify-stop-btn')?.addEventListener('click', () => this.runServiceAction('stop'));
		document.getElementById('netify-restart-btn')?.addEventListener('click', () => this.runServiceAction('restart'));
		document.getElementById('netify-init-db-btn')?.addEventListener('click', () => this.initCollectorOutput());
		document.getElementById('netify-collector-toggle-btn')?.addEventListener('click', () => this.toggleCollectorPanel());
		this.syncCollectorPanel();
	}

	toggleCollectorPanel() {
		const body = document.getElementById('netify-collector-body');
		const icon = document.getElementById('netify-collector-toggle-icon');
		const btn = document.getElementById('netify-collector-toggle-btn');
		if (!body || !icon || !btn) return;

		const isHidden = body.style.display === 'none' || body.style.display === '';
		if (isHidden) {
			body.style.display = 'block';
			icon.textContent = '▾';
			btn.setAttribute('aria-expanded', 'true');
			localStorage.setItem('netify_collector_expanded', '1');
		} else {
			body.style.display = 'none';
			icon.textContent = '▸';
			btn.setAttribute('aria-expanded', 'false');
			localStorage.setItem('netify_collector_expanded', '0');
		}
	}

	syncCollectorPanel() {
		const body = document.getElementById('netify-collector-body');
		const icon = document.getElementById('netify-collector-toggle-icon');
		const btn = document.getElementById('netify-collector-toggle-btn');
		if (!body || !icon || !btn) return;

		const expanded = localStorage.getItem('netify_collector_expanded') === '1';
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

	async load() {
		await this.loadConfig();
		this.syncCollectorPanel();
		this.startPolling();
		await this.refresh(false);
	}

	startPolling() {
		if (this.pollInterval) return;
		this.pollInterval = setInterval(() => {
			if (this.core.currentRoute && this.core.currentRoute.startsWith('/netify')) {
				this.refresh(false);
			}
		}, 10000);
	}

	async loadConfig() {
		try {
			const [status, result] = await this.core.uciGet('moci', 'collector');
			if (status === 0 && result?.values) {
				const c = result.values;
				const configuredOutput = String(c.output_file || '').trim();
				const configuredDbPath = String(c.db_path || '').trim();
				if (configuredOutput) {
					this.outputPath = configuredOutput;
				} else if (configuredDbPath && !/\.sqlite(?:3)?$/i.test(configuredDbPath)) {
					// Keep backward compatibility only for file-based collectors.
					this.outputPath = configuredDbPath;
				}
				this.maxLines = Number(c.max_lines || c.retention_rows) || this.maxLines;
			}
		} catch {}

		const pathEl = document.getElementById('netify-db-path');
		if (pathEl) pathEl.textContent = this.outputPath;
	}

	async runServiceAction(action) {
		try {
			await this.exec('/etc/init.d/netify-collector', [action]);
			this.core.showToast(`Netify collector ${action}ed`, 'success');
			setTimeout(() => this.refresh(false), 600);
		} catch (err) {
			console.error(`Failed to ${action} netify collector:`, err);
			this.core.showToast(`Failed to ${action} collector`, 'error');
		}
	}

	async initCollectorOutput() {
		try {
			await this.exec('/usr/bin/moci-netify-collector', ['--init-file']);
			this.core.showToast('Netify output file initialized', 'success');
			await this.refresh(false);
		} catch (err) {
			console.error('Failed to initialize Netify output file:', err);
			this.core.showToast('Failed to initialize output file', 'error');
		}
	}

	async refresh(showErrorToast = true) {
		if (this.isRefreshing) return;
		this.isRefreshing = true;

		try {
			await this.updateStatus();
			await this.loadFlowFile();
			this.renderOverview();
			this.renderTopApps();
			this.renderRecentFlows();
		} catch (err) {
			console.error('Failed to refresh Netify view:', err);
			if (showErrorToast) this.core.showToast('Failed to refresh Netify data', 'error');
		} finally {
			this.isRefreshing = false;
		}
	}

	async updateStatus() {
		const statusEl = document.getElementById('netify-service-status');
		const fileStatusEl = document.getElementById('netify-db-status');
		if (!statusEl || !fileStatusEl) return;

		try {
			const running = await this.execShell('pgrep -f moci-netify-collector >/dev/null && echo RUNNING || echo STOPPED');
			const serviceUp = (running.stdout || '').trim() === 'RUNNING';
			statusEl.innerHTML = serviceUp
				? this.core.renderBadge('success', 'RUNNING')
				: this.core.renderBadge('error', 'STOPPED');
		} catch {
			statusEl.innerHTML = this.core.renderBadge('error', 'UNKNOWN');
		}

		try {
			const checkFile = await this.execShell(`[ -f ${this.shellQuote(this.outputPath)} ] && echo PRESENT || echo MISSING`);
			const filePresent = (checkFile.stdout || '').trim() === 'PRESENT';
			fileStatusEl.innerHTML = filePresent
				? this.core.renderBadge('success', 'READY')
				: this.core.renderBadge('error', 'MISSING');
		} catch {
			fileStatusEl.innerHTML = this.core.renderBadge('error', 'UNKNOWN');
		}
	}

	async loadFlowFile() {
		try {
			let data = '';

			// Prefer file.read because it works with stricter rpcd ACL profiles.
			try {
				const [readStatus, readResult] = await this.core.ubusCall('file', 'read', { path: this.outputPath });
				if (readStatus === 0 && readResult?.data) {
					data = String(readResult.data || '');
				}
			} catch {}

			// Fallback to tail for larger files or routers where file.read is restricted.
			if (!data.trim()) {
				const limit = Math.min(Math.max(Number(this.maxLines) || 5000, 50), 20000);
				const cmd = `tail -n ${limit} ${this.shellQuote(this.outputPath)} 2>/dev/null || true`;
				const result = await this.execShell(cmd);
				data = String(result?.stdout || '');
			}

			if (!data.trim()) {
				this.flows = [];
				return;
			}

			this.flows = this.parseFlowJsonl(data);
		} catch {
			this.flows = [];
		}
	}

	parseFlowJsonl(content) {
		return (content || '')
			.split('\n')
			.map(line => line.trim())
			.filter(Boolean)
			.map(line => {
				let parsed;
				try {
					parsed = JSON.parse(line);
				} catch {
					return null;
				}
				if (!parsed || parsed.type !== 'flow' || !parsed.flow) return null;

				const flow = parsed.flow;
				const tsRaw = flow.last_seen_at || flow.first_seen_at || Date.now();
				const tsMs = Number(tsRaw) > 1e12 ? Number(tsRaw) : Number(tsRaw) * 1000;
				const ts = Number.isFinite(tsMs) && tsMs > 0 ? tsMs : Date.now();

				const app =
					flow.detected_application_name ||
					flow.detected_app_name ||
					flow.host_server_name ||
					flow.dns_host_name ||
					flow.ssl?.client_sni ||
					flow.other_ip ||
					'Unknown';

				const proto = flow.detected_protocol_name || 'N/A';
				const device = flow.local_mac || 'unknown';
				const localIp = flow.local_ip || '-';
				const destIp = flow.other_ip || '-';
				const destPort = flow.other_port || 0;
				const bytes =
					Number(flow.total_bytes || 0) ||
					Number(flow.other_bytes || 0) ||
					Number(flow.local_bytes || 0) ||
					0;

				return {
					ts,
					timeLabel: this.formatTimestamp(ts),
					device,
					localIp,
					app,
					proto,
					destIp,
					destPort,
					bytes
				};
			})
			.filter(Boolean)
			.slice(-this.maxLines);
	}

	renderOverview() {
		const flowCount = this.flows.length;
		const devices = new Set(this.flows.map(f => f.device).filter(v => v && v !== 'unknown'));
		const apps = new Set(this.flows.map(f => f.app).filter(Boolean));
		const totalBytes = this.flows.reduce((sum, f) => sum + (f.bytes || 0), 0);

		document.getElementById('netify-flow-count').textContent = String(flowCount);
		document.getElementById('netify-device-count').textContent = String(devices.size);
		document.getElementById('netify-app-count').textContent = String(apps.size);
		document.getElementById('netify-total-bytes').textContent = this.core.formatBytes(totalBytes);
	}

	renderTopApps() {
		const tbody = document.querySelector('#netify-top-apps-table tbody');
		if (!tbody) return;

		const map = new Map();
		for (const flow of this.flows) {
			const key = flow.app || 'Unknown';
			const current = map.get(key) || { app: key, flows: 0, lastTs: 0 };
			current.flows += 1;
			if (flow.ts > current.lastTs) current.lastTs = flow.ts;
			map.set(key, current);
		}

		const rows = Array.from(map.values())
			.sort((a, b) => b.flows - a.flows)
			.slice(0, 20)
			.map(item => ({
				app: item.app,
				flows: String(item.flows),
				lastSeen: item.lastTs ? this.formatTimestamp(item.lastTs) : '-'
			}));

		if (rows.length === 0) {
			this.core.renderEmptyTable(tbody, 3, 'No Netify flow data yet');
			return;
		}

		tbody.innerHTML = rows
			.map(
				row => `<tr>
				<td>${this.core.escapeHtml(row.app)}</td>
				<td>${this.core.escapeHtml(row.flows)}</td>
				<td>${this.core.escapeHtml(row.lastSeen)}</td>
			</tr>`
			)
			.join('');
	}

	renderRecentFlows() {
		const tbody = document.querySelector('#netify-flows-table tbody');
		if (!tbody) return;

		const rows = [...this.flows]
			.sort((a, b) => b.ts - a.ts)
			.slice(0, 50);

		if (rows.length === 0) {
			this.core.renderEmptyTable(tbody, 7, 'No Netify flow data yet');
			return;
		}

		tbody.innerHTML = rows
			.map(row => `<tr>
				<td>${this.core.escapeHtml(row.timeLabel)}</td>
				<td>${this.core.escapeHtml(row.device)}</td>
				<td>${this.core.escapeHtml(row.localIp || '-')}</td>
				<td>${this.core.escapeHtml(row.app)}</td>
				<td>${this.core.escapeHtml(row.proto)}</td>
				<td>${this.core.escapeHtml(row.destIp)}</td>
				<td>${this.core.escapeHtml(String(row.destPort || 0))}</td>
			</tr>`)
			.join('');
	}

	formatTimestamp(ts) {
		const d = new Date(ts);
		return d.toLocaleString([], {
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		});
	}

	async execShell(cmd) {
		return this.exec('/bin/sh', ['-c', cmd], { timeout: 12000 });
	}

	async exec(command, params = [], options = {}) {
		const [status, result] = await this.core.ubusCall('file', 'exec', { command, params }, options);
		if (status !== 0) {
			throw new Error(`${command} failed with status ${status}`);
		}
		return result || {};
	}

	shellQuote(value) {
		return `'${String(value).replace(/'/g, `'\\''`)}'`;
	}
}
