export default class FlowsModule {
	constructor(core) {
		this.core = core;
		this.initialized = false;
		this.pollInterval = null;
		this.isRefreshing = false;
		this.dbPath = '/tmp/connection-flows.sqlite';
		this.maxRows = 200;
		this.rows = [];
		this.visibleRows = [];

		this.core.registerRoute('/flows', async () => {
			const pageElement = document.getElementById('flows-page');
			if (pageElement) pageElement.classList.remove('hidden');

			if (!this.initialized) {
				this.setupHandlers();
				this.initialized = true;
			}

			await this.load();
		});
	}

	setupHandlers() {
		document.getElementById('flows-refresh-btn')?.addEventListener('click', () => this.refresh(true));
		document.getElementById('flows-start-btn')?.addEventListener('click', () => this.runServiceAction('start'));
		document.getElementById('flows-stop-btn')?.addEventListener('click', () => this.runServiceAction('stop'));
		document.getElementById('flows-restart-btn')?.addEventListener('click', () => this.runServiceAction('restart'));
		document.getElementById('flows-init-db-btn')?.addEventListener('click', () => this.initCollectorDb());
		document.getElementById('flows-collector-toggle-btn')?.addEventListener('click', () => this.toggleCollectorPanel());

		document.querySelector('#flows-table tbody')?.addEventListener('click', event => this.handleRowClick(event));
		document.getElementById('flows-action-type')?.addEventListener('change', () => this.syncActionTypeUi());
		document.getElementById('save-flows-action-btn')?.addEventListener('click', () => this.saveFlowAction());
		document.getElementById('cancel-flows-action-btn')?.addEventListener('click', () =>
			this.core.closeModal('flows-action-modal')
		);
		document.getElementById('close-flows-action-modal')?.addEventListener('click', () =>
			this.core.closeModal('flows-action-modal')
		);

		this.syncCollectorPanel();
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
			if (this.core.currentRoute && this.core.currentRoute.startsWith('/flows')) {
				this.refresh(false);
			}
		}, 10000);
	}

	toggleCollectorPanel() {
		const body = document.getElementById('flows-collector-body');
		const icon = document.getElementById('flows-collector-toggle-icon');
		const btn = document.getElementById('flows-collector-toggle-btn');
		if (!body || !icon || !btn) return;

		const hidden = body.style.display === 'none' || body.style.display === '';
		if (hidden) {
			body.style.display = 'block';
			icon.textContent = '▾';
			btn.setAttribute('aria-expanded', 'true');
			localStorage.setItem('flows_collector_expanded', '1');
		} else {
			body.style.display = 'none';
			icon.textContent = '▸';
			btn.setAttribute('aria-expanded', 'false');
			localStorage.setItem('flows_collector_expanded', '0');
		}
	}

	syncCollectorPanel() {
		const body = document.getElementById('flows-collector-body');
		const icon = document.getElementById('flows-collector-toggle-icon');
		const btn = document.getElementById('flows-collector-toggle-btn');
		if (!body || !icon || !btn) return;

		const expanded = localStorage.getItem('flows_collector_expanded') === '1';
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
			const [status, result] = await this.core.uciGet('moci', 'connection_flows');
			if (status === 0 && result?.values) {
				const values = result.values;
				const db = String(values.db_path || '').trim();
				if (db) this.dbPath = db;
				const limit = Number(values.retention_rows || values.max_rows || 0);
				if (Number.isFinite(limit) && limit > 0) this.maxRows = Math.min(500, Math.max(50, limit));
			}
		} catch {}

		const pathEl = document.getElementById('flows-db-path');
		if (pathEl) pathEl.textContent = this.dbPath;
	}

	async refresh(showErrorToast = true) {
		if (this.isRefreshing) return;
		this.isRefreshing = true;
		try {
			await this.updateStatus();
			await this.loadRows();
			this.renderRows();
		} catch (err) {
			console.error('Failed to refresh flows:', err);
			if (showErrorToast) this.core.showToast('Failed to refresh flows', 'error');
		} finally {
			this.isRefreshing = false;
		}
	}

	async updateStatus() {
		const serviceEl = document.getElementById('flows-service-status');
		const dbEl = document.getElementById('flows-db-status');
		if (!serviceEl || !dbEl) return;

		try {
			const running = await this.execShell('pgrep -f moci-connection-flow-collector >/dev/null && echo RUNNING || echo STOPPED');
			serviceEl.innerHTML = String(running?.stdout || '').trim() === 'RUNNING'
				? this.core.renderBadge('success', 'RUNNING')
				: this.core.renderBadge('error', 'STOPPED');
		} catch {
			serviceEl.innerHTML = this.core.renderBadge('error', 'UNKNOWN');
		}

		try {
			const checkFile = await this.execShell(`[ -f ${this.shellQuote(this.dbPath)} ] && echo PRESENT || echo MISSING`);
			dbEl.innerHTML = String(checkFile?.stdout || '').trim() === 'PRESENT'
				? this.core.renderBadge('success', 'READY')
				: this.core.renderBadge('error', 'MISSING');
		} catch {
			dbEl.innerHTML = this.core.renderBadge('error', 'UNKNOWN');
		}
	}

	async runServiceAction(action) {
		try {
			await this.exec('/etc/init.d/connection-flows-collector', [action]);
			this.core.showToast(`Connection flows collector ${action}ed`, 'success');
			setTimeout(() => this.refresh(false), 500);
		} catch (err) {
			console.error(`Failed to ${action} connection-flows collector:`, err);
			this.core.showToast(this.describeExecFailure(err, `Failed to ${action} collector`), 'error');
		}
	}

	async initCollectorDb() {
		try {
			await this.exec('/usr/bin/moci-connection-flow-collector', ['--init-db']);
			this.core.showToast('Connection flows database initialized', 'success');
			await this.refresh(false);
		} catch (err) {
			console.error('Failed to initialize connection flows db:', err);
			this.core.showToast(this.describeExecFailure(err, 'Failed to initialize database'), 'error');
		}
	}

	async loadRows() {
		const limit = Math.min(500, Math.max(50, Number(this.maxRows) || 200));
		const sql = `SELECT protocol, source, destination, transfer, status FROM connection_flows ORDER BY id DESC LIMIT ${limit};`;
		const out = await this.querySql(sql);
		const lines = String(out || '')
			.split('\n')
			.map(line => line.trim())
			.filter(Boolean);
		this.rows = lines
			.map(line => {
				const parts = line.split('|');
				if (parts.length < 5) return null;
				return {
					protocol: parts[0] || 'UNKNOWN',
					source: parts[1] || 'N/A',
					destination: parts[2] || 'N/A',
					transfer: parts[3] || '0 B (0 Pkts.)',
					status: parts[4] || 'ACTIVE'
				};
			})
			.filter(Boolean);
	}

	renderRows() {
		const tbody = document.querySelector('#flows-table tbody');
		if (!tbody) return;
		this.visibleRows = this.rows;
		if (!this.rows.length) {
			this.core.renderEmptyTable(tbody, 5, 'No connection flow data yet');
			return;
		}

		tbody.innerHTML = this.rows
			.map(
				(row, idx) => `<tr class="netify-flow-row" data-flow-index="${idx}" style="cursor: pointer" title="Click for actions">
				<td>${this.core.escapeHtml(row.protocol)}</td>
				<td>${this.core.escapeHtml(row.source)}</td>
				<td>${this.core.escapeHtml(row.destination)}</td>
				<td>${this.core.escapeHtml(row.transfer)}</td>
				<td>${this.core.escapeHtml(row.status)}</td>
			</tr>`
			)
			.join('');
	}

	handleRowClick(event) {
		const tr = event.target?.closest?.('tr[data-flow-index]');
		if (!tr) return;
		const idx = Number(tr.getAttribute('data-flow-index'));
		if (!Number.isInteger(idx) || idx < 0 || idx >= this.visibleRows.length) return;
		this.openActionModal(idx);
	}

	openActionModal(index) {
		const row = this.visibleRows[index];
		if (!row) return;

		document.getElementById('flows-action-row-index').value = String(index);
		const sourceIp = this.extractIpFromEndpoint(row.source);
		const destIp = this.extractIpFromEndpoint(row.destination);
		const srcInput = document.getElementById('flows-action-source-ip');
		const dstInput = document.getElementById('flows-action-dest-ip');
		if (srcInput) srcInput.value = sourceIp;
		if (dstInput) dstInput.value = destIp;

		const scopeSelect = document.getElementById('flows-action-scope');
		if (scopeSelect) scopeSelect.value = this.isValidIp(sourceIp) ? 'source_dest' : 'all_sources';
		this.syncActionTypeUi();
		this.core.openModal('flows-action-modal');
	}

	syncActionTypeUi() {
		const type = document.getElementById('flows-action-type')?.value || 'ip';
		const domainGroup = document.getElementById('flows-domain-group');
		const ipGroup = document.getElementById('flows-ip-block-group');
		if (!domainGroup || !ipGroup) return;
		const isDomain = type === 'domain';
		domainGroup.classList.toggle('hidden', !isDomain);
		ipGroup.classList.toggle('hidden', isDomain);
	}

	async saveFlowAction() {
		this.setFlowActionBusy(true);
		const index = Number(document.getElementById('flows-action-row-index')?.value || -1);
		if (!Number.isInteger(index) || index < 0 || index >= this.visibleRows.length) {
			this.core.showToast('Flow row not found', 'error');
			this.setFlowActionBusy(false);
			return;
		}

		const row = this.visibleRows[index];
		const type = document.getElementById('flows-action-type')?.value || 'ip';
		try {
			if (type === 'domain') {
				const domain = this.sanitizeDomain(document.getElementById('flows-action-domain')?.value || '');
				if (!domain) {
					this.core.showToast('Enter a valid domain', 'error');
					return;
				}
				await this.blockDomainInCustomDns(domain);
				this.core.showToast(`Blocked domain via custom DNS: ${domain}`, 'success');
			} else {
				const scope = document.getElementById('flows-action-scope')?.value || 'all_sources';
				await this.blockDestinationIp(row, scope);
				this.core.showToast('Firewall block rule added', 'success');
			}

			this.core.closeModal('flows-action-modal');
		} catch (err) {
			console.error('Failed to save flow action:', err);
			this.core.showToast(`Failed to save action: ${err?.message || 'unknown error'}`, 'error');
		} finally {
			this.setFlowActionBusy(false);
		}
	}

	setFlowActionBusy(busy) {
		const btn = document.getElementById('save-flows-action-btn');
		if (!btn) return;
		btn.disabled = Boolean(busy);
		btn.style.opacity = busy ? '0.55' : '1';
		btn.style.cursor = busy ? 'not-allowed' : '';
		btn.textContent = busy ? 'SAVING...' : 'SAVE ACTION';
	}

	async blockDomainInCustomDns(domain) {
		let targetSection = '';
		try {
			const [status, result] = await this.core.uciGet('dhcp');
			if (status === 0 && result?.values) {
				for (const [section, cfg] of Object.entries(result.values)) {
					if (cfg?.['.type'] !== 'domain') continue;
					if (String(cfg.name || '').trim().toLowerCase() === domain) {
						targetSection = section;
						break;
					}
				}
			}
		} catch {}

		const values = { name: domain, ip: '127.0.0.1' };
		if (targetSection) {
			await this.core.uciSet('dhcp', targetSection, values);
		} else {
			const [, res] = await this.core.uciAdd('dhcp', 'domain');
			const section = res?.section;
			if (!section) throw new Error('Failed to create custom DNS entry');
			await this.core.uciSet('dhcp', section, values);
		}
		await this.core.uciCommit('dhcp');
		try {
			await this.exec('/etc/init.d/dnsmasq', ['restart']);
		} catch {}
	}

	async blockDestinationIp(row, scope) {
		const destIp = this.extractIpFromEndpoint(row.destination);
		if (!this.isValidIp(destIp)) throw new Error('Destination IP missing/invalid');

		const values = {
			name: `moci_flow_block_${Date.now()}`,
			src: 'lan',
			dest: 'wan',
			proto: 'all',
			dest_ip: destIp,
			target: 'REJECT',
			enabled: '1'
		};

		if (scope === 'source_dest') {
			const srcIp = this.extractIpFromEndpoint(row.source);
			if (!this.isValidIp(srcIp)) throw new Error('Source IP missing/invalid for source→dest block');
			values.src_ip = srcIp;
		}

		if (this.isIPv6(destIp)) values.family = 'ipv6';
		if (this.isIPv4(destIp)) values.family = 'ipv4';

		const [, res] = await this.core.uciAdd('firewall', 'rule');
		const section = res?.section;
		if (!section) throw new Error('Failed to create firewall rule');
		await this.core.uciSet('firewall', section, values);
		await this.core.uciCommit('firewall');
		try {
			await this.exec('/etc/init.d/firewall', ['restart']);
		} catch {}
	}

	extractIpFromEndpoint(value) {
		const text = String(value || '').trim();
		if (!text) return '';
		const bracket = text.match(/^\[([0-9a-f:]+)\](?::\d+)?$/i);
		if (bracket) return bracket[1];
		if (this.isIPv4(text)) return text;
		if (this.isIPv6(text)) return text;
		const ipv4Port = text.match(/^((?:\d{1,3}\.){3}\d{1,3})(?::\d+)?$/);
		if (ipv4Port) return ipv4Port[1];
		const noPort = text.replace(/:\d+$/, '');
		if (this.isIPv4(noPort) || this.isIPv6(noPort)) return noPort;
		return '';
	}

	sanitizeDomain(value) {
		const v = String(value || '')
			.trim()
			.toLowerCase();
		if (!v) return '';
		if (!/^[a-z0-9.-]+$/.test(v)) return '';
		if (v.length > 253 || v.startsWith('.') || v.endsWith('.') || v.includes('..')) return '';
		if (this.isValidIp(v)) return '';
		return v;
	}

	isIPv4(value) {
		const parts = String(value || '').trim().split('.');
		if (parts.length !== 4) return false;
		return parts.every(part => {
			if (!/^\d+$/.test(part)) return false;
			const n = Number(part);
			return n >= 0 && n <= 255;
		});
	}

	isIPv6(value) {
		return /^[0-9a-f:]+$/i.test(String(value || '').trim()) && String(value || '').includes(':');
	}

	isValidIp(value) {
		return this.isIPv4(value) || this.isIPv6(value);
	}

	async querySql(sql) {
		const statement = `PRAGMA busy_timeout=3000; ${sql}`;
		const db = this.shellQuote(this.dbPath);
		const sqlQuoted = this.shellQuote(statement);
		const shellCmd = `if command -v sqlite3 >/dev/null 2>&1; then sqlite3 ${db} ${sqlQuoted}; elif command -v sqlite3-cli >/dev/null 2>&1; then sqlite3-cli ${db} ${sqlQuoted}; else echo "sqlite3 not installed" >&2; exit 127; fi`;
		const result = await this.exec('/bin/sh', ['-c', shellCmd], { timeout: 12000 });
		return String(result?.stdout || '');
	}

	async execShell(cmd) {
		return this.exec('/bin/sh', ['-c', cmd], { timeout: 12000 });
	}

	async exec(command, params = [], options = {}) {
		const [status, result] = await this.core.ubusCall('file', 'exec', { command, params }, options);
		if (status !== 0) {
			const err = new Error(`${command} failed with status ${status}`);
			err.ubusStatus = status;
			throw err;
		}
		if (result && Number(result.code) !== 0) {
			const stderr = String(result.stderr || '').trim();
			const stdout = String(result.stdout || '').trim();
			const details = stderr || stdout || `exit ${result.code}`;
			const err = new Error(`${command} failed: ${details}`);
			err.exitCode = Number(result.code);
			err.stderr = stderr;
			err.stdout = stdout;
			throw err;
		}
		return result || {};
	}

	describeExecFailure(err, fallback) {
		const msg = String(err?.message || '').trim();
		if (String(err?.ubusStatus) === '6' || /status 6/.test(msg)) {
			return `${fallback}: permission denied (ACL/session). Re-login and restart rpcd if needed.`;
		}
		return msg ? `${fallback}: ${msg}` : fallback;
	}

	shellQuote(value) {
		return `'${String(value).replace(/'/g, `'\\''`)}'`;
	}
}
