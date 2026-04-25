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
		this.searchQuery = '';
		this.flowsPage = 0;
		this.flowsPageSize = 50;
		this.sqlChunkSize = 200;
		this.sqlChunkCalls = 15;
		this.loadedOffset = 0;
		this.hasMoreRows = true;
		this.isLoadingMore = false;
		this.totalRowCount = 0;

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
		document.getElementById('flows-search-input')?.addEventListener('input', event => {
			this.searchQuery = String(event?.target?.value || '')
				.trim()
				.toLowerCase();
			this.flowsPage = 0;
			this.renderRows();
		});
		document.getElementById('flows-prev-btn')?.addEventListener('click', () => {
			this.flowsPage = Math.max(0, this.flowsPage - 1);
			this.renderRows();
		});
		document.getElementById('flows-next-btn')?.addEventListener('click', async () => {
			const totalLoaded = this.getFilteredRows().length;
			const maxLoadedPage = totalLoaded > 0 ? Math.max(0, Math.ceil(totalLoaded / this.flowsPageSize) - 1) : 0;

			if (this.flowsPage >= maxLoadedPage && this.hasMoreRows) {
				const loaded = await this.loadMoreRows();
				if (loaded) this.flowsPage += 1;
			} else {
				this.flowsPage += 1;
			}
			this.renderRows();
		});

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
			// Preserve user paging position while browsing history.
			if (this.core.currentRoute && this.core.currentRoute.startsWith('/flows') && this.flowsPage === 0) {
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
				if (Number.isFinite(limit) && limit > 0) this.maxRows = Math.max(50, limit);
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
			await this.loadRows(true);
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

	async loadRows(reset = false) {
		const limit = this.getWindowRows();
		if (reset) {
			this.rows = [];
			this.visibleRows = [];
			this.loadedOffset = 0;
			this.hasMoreRows = true;
			this.isLoadingMore = false;
			try {
				this.totalRowCount = await this.queryTotalCount();
			} catch {
				this.totalRowCount = 0;
			}
		}
		const sql = `SELECT id, protocol, source, destination, transfer, status FROM connection_flows ORDER BY id DESC LIMIT ${limit} OFFSET ${this.loadedOffset};`;
		const out = await this.querySql(sql);
		const lines = String(out || '')
			.split('\n')
			.map(line => line.trim())
			.filter(Boolean);
		const newRows = lines
			.map(line => {
				const parts = line.split('|');
				if (parts.length < 6) return null;
				return {
					id: Number(parts[0]) || 0,
					protocol: parts[1] || 'UNKNOWN',
					source: parts[2] || 'N/A',
					destination: parts[3] || 'N/A',
					transfer: parts[4] || '0 B (0 Pkts.)',
					status: parts[5] || 'ACTIVE'
				};
			})
			.filter(Boolean);
		this.loadedOffset += newRows.length;
		this.hasMoreRows = newRows.length >= limit;

		if (reset || this.rows.length === 0) {
			this.rows = newRows;
			return;
		}

		const seen = new Set(this.rows.map(r => r.id));
		for (const row of newRows) {
			if (!seen.has(row.id)) this.rows.push(row);
		}
	}

	async loadMoreRows() {
		if (this.isLoadingMore || !this.hasMoreRows) return false;
		this.isLoadingMore = true;
		const before = this.rows.length;
		try {
			await this.loadRows(false);
			return this.rows.length > before;
		} finally {
			this.isLoadingMore = false;
		}
	}

	async queryTotalCount() {
		const out = await this.querySql('SELECT COUNT(*) FROM connection_flows;');
		const first = String(out || '')
			.split('\n')
			.map(v => v.trim())
			.find(Boolean);
		const n = Number(first);
		return Number.isFinite(n) && n >= 0 ? n : 0;
	}

	getWindowRows() {
		const maxWindowRows = Math.max(20, this.sqlChunkSize * this.sqlChunkCalls);
		if (Number.isFinite(this.maxRows) && this.maxRows > 0) {
			return Math.min(maxWindowRows, Math.max(50, Number(this.maxRows)));
		}
		return maxWindowRows;
	}

	getFilteredRows() {
		return this.searchQuery
			? this.rows.filter(row =>
					[row.protocol, row.source, row.destination, row.transfer, row.status]
						.map(v => String(v || '').toLowerCase())
						.some(v => v.includes(this.searchQuery))
			  )
			: this.rows;
	}

	renderRows() {
		const tbody = document.querySelector('#flows-table tbody');
		if (!tbody) return;
		if (!this.rows.length) {
			this.core.renderEmptyTable(tbody, 5, 'No connection flow data yet');
			this.updatePagination(0, 0, 0, 0);
			return;
		}
		const filteredRows = this.getFilteredRows();
		if (!filteredRows.length) {
			this.core.renderEmptyTable(tbody, 5, 'No matching flows');
			this.visibleRows = [];
			this.flowsPage = 0;
			this.updatePagination(0, 0, 0, 0);
			return;
		}
		const total = filteredRows.length;
		const maxPage = Math.max(0, Math.ceil(total / this.flowsPageSize) - 1);
		this.flowsPage = Math.min(this.flowsPage, maxPage);
		const startIdx = this.flowsPage * this.flowsPageSize;
		const endIdx = Math.min(total, startIdx + this.flowsPageSize);
		const pageRows = filteredRows.slice(startIdx, endIdx);
		this.visibleRows = pageRows;

		tbody.innerHTML = pageRows
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
		this.updatePagination(total, startIdx + 1, endIdx, maxPage);
	}

	updatePagination(total, start, end, maxPage) {
		const infoEl = document.getElementById('flows-page-info');
		const prevBtn = document.getElementById('flows-prev-btn');
		const nextBtn = document.getElementById('flows-next-btn');
		const effectiveTotal = this.searchQuery ? total : Math.max(total, Number(this.totalRowCount) || 0);
		if (infoEl) infoEl.textContent = total > 0 ? `${start}-${end} of ${effectiveTotal}` : '0-0 of 0';
		if (prevBtn) prevBtn.disabled = this.flowsPage <= 0 || total <= 0;
		if (nextBtn) nextBtn.disabled = (this.flowsPage >= maxPage && !this.hasMoreRows) || total <= 0 || this.isLoadingMore;
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
