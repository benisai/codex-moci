export default class NetifyModule {
	constructor(core) {
		this.core = core;
		this.initialized = false;
		this.pollInterval = null;
		this.dbPath = '/tmp/moci-netify.sqlite';
		this.isRefreshing = false;

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
		document.getElementById('netify-init-db-btn')?.addEventListener('click', () => this.initDatabase());
		document
			.getElementById('netify-collector-toggle-btn')
			?.addEventListener('click', () => this.toggleCollectorPanel());
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
			if (status === 0 && result?.values?.db_path) {
				this.dbPath = result.values.db_path;
			}
		} catch {}

		const dbPathEl = document.getElementById('netify-db-path');
		if (dbPathEl) dbPathEl.textContent = this.dbPath;
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

	async initDatabase() {
		try {
			await this.exec('/usr/bin/moci-netify-collector', ['--init-db']);
			this.core.showToast('Netify database initialized', 'success');
			await this.refresh(false);
		} catch (err) {
			console.error('Failed to initialize Netify DB:', err);
			this.core.showToast('Failed to initialize database', 'error');
		}
	}

	async refresh(showErrorToast = true) {
		if (this.isRefreshing) return;
		this.isRefreshing = true;

		try {
			await this.updateStatus();
			await Promise.all([this.loadOverview(), this.loadTopApps(), this.loadRecentFlows()]);
		} catch (err) {
			console.error('Failed to refresh Netify view:', err);
			if (showErrorToast) this.core.showToast('Failed to refresh Netify data', 'error');
		} finally {
			this.isRefreshing = false;
		}
	}

	async updateStatus() {
		const statusEl = document.getElementById('netify-service-status');
		const dbStatusEl = document.getElementById('netify-db-status');
		if (!statusEl || !dbStatusEl) return;

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
			const checkDb = await this.execShell(`[ -f ${this.shellQuote(this.dbPath)} ] && echo PRESENT || echo MISSING`);
			const dbPresent = (checkDb.stdout || '').trim() === 'PRESENT';
			dbStatusEl.innerHTML = dbPresent
				? this.core.renderBadge('success', 'READY')
				: this.core.renderBadge('error', 'MISSING');
		} catch {
			dbStatusEl.innerHTML = this.core.renderBadge('error', 'UNKNOWN');
		}
	}

	async loadOverview() {
		const overviewSql = `
			SELECT
				COUNT(*) AS flow_count,
				COUNT(DISTINCT local_mac) AS device_count,
				COUNT(DISTINCT COALESCE(NULLIF(detected_app_name, ''), NULLIF(fqdn, ''), dest_ip)) AS app_count
			FROM flow
		`;
		const purgeSql = `
			SELECT COALESCE(SUM(total_bytes), 0) AS total_bytes
			FROM stats_purge
		`;

		const [flowOut, purgeOut] = await Promise.all([this.querySql(overviewSql), this.querySql(purgeSql)]);

		const flowRow = this.firstRow(flowOut);
		const bytesRow = this.firstRow(purgeOut);

		document.getElementById('netify-flow-count').textContent = flowRow[0] || '0';
		document.getElementById('netify-device-count').textContent = flowRow[1] || '0';
		document.getElementById('netify-app-count').textContent = flowRow[2] || '0';
		document.getElementById('netify-total-bytes').textContent = this.core.formatBytes(parseInt(bytesRow[0] || '0', 10));
	}

	async loadTopApps() {
		const sql = `
			SELECT
				COALESCE(NULLIF(detected_app_name, ''), NULLIF(fqdn, ''), dest_ip, 'Unknown') AS app,
				COUNT(*) AS flows,
				MAX(timeinsert) AS last_seen
			FROM flow
			GROUP BY app
			ORDER BY flows DESC
			LIMIT 20
		`;

		const out = await this.querySql(sql);
		const rows = this.parseTsv(out).map(cols => ({
			app: cols[0] || 'Unknown',
			flows: cols[1] || '0',
			lastSeen: cols[2] || '-'
		}));

		const tbody = document.querySelector('#netify-top-apps-table tbody');
		if (!tbody) return;

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

	async loadRecentFlows() {
		const sql = `
			SELECT
				timeinsert,
				COALESCE(NULLIF(local_mac, ''), 'unknown') AS device,
				COALESCE(NULLIF(detected_app_name, ''), NULLIF(fqdn, ''), dest_ip, 'Unknown') AS app,
				COALESCE(NULLIF(detected_protocol_name, ''), 'N/A') AS proto,
				COALESCE(NULLIF(dest_ip, ''), '-') AS dest_ip,
				COALESCE(dest_port, 0) AS dest_port
			FROM flow
			ORDER BY id DESC
			LIMIT 50
		`;

		const out = await this.querySql(sql);
		const rows = this.parseTsv(out);
		const tbody = document.querySelector('#netify-flows-table tbody');
		if (!tbody) return;

		if (rows.length === 0) {
			this.core.renderEmptyTable(tbody, 6, 'No Netify flow data yet');
			return;
		}

		tbody.innerHTML = rows
			.map(cols => {
				const time = cols[0] || '-';
				const device = cols[1] || '-';
				const app = cols[2] || '-';
				const proto = cols[3] || '-';
				const destIp = cols[4] || '-';
				const destPort = cols[5] || '0';
				return `<tr>
					<td>${this.core.escapeHtml(time)}</td>
					<td>${this.core.escapeHtml(device)}</td>
					<td>${this.core.escapeHtml(app)}</td>
					<td>${this.core.escapeHtml(proto)}</td>
					<td>${this.core.escapeHtml(destIp)}</td>
					<td>${this.core.escapeHtml(destPort)}</td>
				</tr>`;
			})
			.join('');
	}

	firstRow(text) {
		const rows = this.parseTsv(text);
		return rows[0] || ['0', '0', '0'];
	}

	parseTsv(text) {
		return (text || '')
			.split('\n')
			map(line => line.trim())
			.filter(Boolean)
			.map(line => line.split('\t'));
	}

	async querySql(sql) {
		const result = await this.exec('/usr/bin/sqlite3', [this.dbPath, '-separator', '\t', sql]);
		if (result.stderr && result.stderr.trim()) {
			throw new Error(result.stderr.trim());
		}
		return result.stdout || '';
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
