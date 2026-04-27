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
		this.sqlChunkCalls = 100;
		this.loadedOffset = 0;
		this.hasMoreRows = true;
		this.isLoadingMore = false;
		this.hostnameByIp = new Map();
		this.lastHostRefreshAt = 0;
		this.destinationDnsCache = new Map();

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
		document.getElementById('flows-save-settings-btn')?.addEventListener('click', () => this.saveCollectorSettings());
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
				if (loaded) {
					await this.resolveDestinationHostnames(this.rows);
					this.flowsPage += 1;
				}
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
				const lanWanOnlyInput = document.getElementById('flows-lan-wan-only-checkbox');
				if (lanWanOnlyInput) lanWanOnlyInput.checked = String(values.lan_to_wan_only || '0') === '1';
			}
		} catch {}

		const pathEl = document.getElementById('flows-db-path');
		if (pathEl) pathEl.textContent = this.dbPath;
	}

	async saveCollectorSettings() {
		const saveBtn = document.getElementById('flows-save-settings-btn');
		const lanWanOnlyInput = document.getElementById('flows-lan-wan-only-checkbox');
		if (!lanWanOnlyInput) return;
		if (saveBtn) {
			saveBtn.disabled = true;
			saveBtn.style.opacity = '0.6';
			saveBtn.textContent = 'SAVING...';
		}
		try {
			const lanToWanOnly = lanWanOnlyInput.checked ? '1' : '0';
			await this.core.uciSet('moci', 'connection_flows', { lan_to_wan_only: lanToWanOnly });
			await this.core.uciCommit('moci');
			try {
				await this.exec('/etc/init.d/connection-flows-collector', ['restart']);
			} catch {
				await this.exec('/bin/sh', ['-c', '/etc/init.d/connection-flows-collector restart']);
			}
			this.core.showToast('Flow collector settings saved', 'success');
			await this.refresh(false);
		} catch (err) {
			console.error('Failed to save flow collector settings:', err);
			this.core.showToast(this.describeExecFailure(err, 'Failed to save flow collector settings'), 'error');
		} finally {
			if (saveBtn) {
				saveBtn.disabled = false;
				saveBtn.style.opacity = '1';
				saveBtn.textContent = 'SAVE SETTINGS';
			}
		}
	}

	async refresh(showErrorToast = true) {
		if (this.isRefreshing) return;
		this.isRefreshing = true;
		try {
			await this.updateStatus();
			await this.loadRows(true);
			await this.refreshHostnameMap();
			await this.resolveDestinationHostnames(this.rows);
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
			// ACL/session profiles can block direct init.d exec; fallback via /bin/sh command path.
			try {
				await this.exec('/bin/sh', ['-c', `/etc/init.d/connection-flows-collector ${action}`]);
				this.core.showToast(`Connection flows collector ${action}ed`, 'success');
				setTimeout(() => this.refresh(false), 500);
				return;
			} catch (fallbackErr) {
				console.error(`Failed to ${action} connection-flows collector:`, fallbackErr);
				this.core.showToast(this.describeExecFailure(fallbackErr, `Failed to ${action} collector`), 'error');
			}
		}
	}

	async initCollectorDb() {
		try {
			await this.exec('/usr/bin/moci-connection-flow-collector', ['--init-db']);
			this.core.showToast('Connection flows database initialized', 'success');
			await this.refresh(false);
		} catch (err) {
			try {
				await this.exec('/bin/sh', ['-c', '/usr/bin/moci-connection-flow-collector --init-db']);
				this.core.showToast('Connection flows database initialized', 'success');
				await this.refresh(false);
				return;
			} catch (fallbackErr) {
				console.error('Failed to initialize connection flows db:', fallbackErr);
				this.core.showToast(this.describeExecFailure(fallbackErr, 'Failed to initialize database'), 'error');
			}
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
		}
		const sql = `SELECT id, timeinsert, protocol, source, destination, transfer, status FROM connection_flows ORDER BY id DESC LIMIT ${limit} OFFSET ${this.loadedOffset};`;
		const out = await this.querySql(sql);
		const lines = String(out || '')
			.split('\n')
			.map(line => line.trim())
			.filter(Boolean);
			const newRows = lines
				.map(line => {
					const parts = line.split('|');
					if (parts.length < 7) return null;
					const ts = Number(parts[1]) || 0;
					return {
						id: Number(parts[0]) || 0,
						timeinsert: ts,
						timeLabel: this.formatTimestamp(ts),
						protocol: parts[2] || 'UNKNOWN',
						source: parts[3] || 'N/A',
						sourceIp: this.extractIpFromEndpoint(parts[3]) || '',
						destination: parts[4] || 'N/A',
						destinationIp: this.extractIpFromEndpoint(parts[4]) || '',
						transfer: parts[5] || '0 B (0 Pkts.)',
						status: parts[6] || 'ACTIVE'
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
					[
						row.protocol,
						this.resolveSourceLabel(row),
						row.source,
						row.sourceIp,
						this.resolveDestinationLabel(row),
						row.destination,
						row.destinationIp,
						row.transfer,
						row.status
					]
						.map(v => String(v || '').toLowerCase())
						.some(v => v.includes(this.searchQuery))
			  )
			: this.rows;
	}

	renderRows() {
		const tbody = document.querySelector('#flows-table tbody');
		if (!tbody) return;
		if (!this.rows.length) {
			this.core.renderEmptyTable(tbody, 6, 'No connection flow data yet');
			this.updatePagination(0, 0, 0, 0);
			return;
		}
		const filteredRows = this.getFilteredRows();
		if (!filteredRows.length) {
			this.core.renderEmptyTable(tbody, 6, 'No matching flows');
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
				<td>${this.core.escapeHtml(row.timeLabel || '-')}</td>
				<td title="${this.core.escapeHtml(row.source)}">${this.core.escapeHtml(this.resolveSourceLabel(row))}</td>
				<td title="${this.core.escapeHtml(row.destination)}">${this.core.escapeHtml(this.resolveDestinationLabel(row))}</td>
				<td>${this.core.escapeHtml(row.transfer)}</td>
				<td>${this.core.escapeHtml(row.protocol)}</td>
				<td>${this.core.escapeHtml(row.status)}</td>
			</tr>`
			)
			.join('');
		this.updatePagination(total, startIdx + 1, endIdx, maxPage);
	}

	formatTimestamp(tsSeconds) {
		if (!Number.isFinite(tsSeconds) || tsSeconds <= 0) return '-';
		const d = new Date(tsSeconds * 1000);
		if (Number.isNaN(d.getTime())) return '-';
		return d.toLocaleString([], {
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		});
	}

	updatePagination(total, start, end, maxPage) {
		const infoEl = document.getElementById('flows-page-info');
		const prevBtn = document.getElementById('flows-prev-btn');
		const nextBtn = document.getElementById('flows-next-btn');
		if (infoEl) {
			if (total <= 0) infoEl.textContent = '0-0 of 0';
			else infoEl.textContent = `${start}-${end} of ${total}`;
		}
		if (prevBtn) prevBtn.disabled = this.flowsPage <= 0 || total <= 0;
		if (nextBtn) nextBtn.disabled = (this.flowsPage >= maxPage && !this.hasMoreRows) || total <= 0 || this.isLoadingMore;
	}

	async refreshHostnameMap() {
		const now = Date.now();
		if (now - this.lastHostRefreshAt < 15000 && this.hostnameByIp.size > 0) return;

		const byIp = new Map();
		try {
			const [status, result] = await this.core.ubusCall('luci-rpc', 'getDHCPLeases', {});
			if (status === 0 && Array.isArray(result?.dhcp_leases)) {
				for (const lease of result.dhcp_leases) {
					const hostname = String(lease.hostname || '').trim();
					const ip = String(lease.ipaddr || '').trim();
					if (hostname && ip) byIp.set(ip, hostname);
				}
			}
		} catch {}

		try {
			const [status, result] = await this.core.uciGet('dhcp');
			if (status === 0 && result?.values) {
				for (const [, cfg] of Object.entries(result.values)) {
					if (cfg?.['.type'] !== 'host') continue;
					const hostname = String(cfg.name || '').trim();
					const ip = String(cfg.ip || '').trim();
					if (hostname && ip && !byIp.has(ip)) byIp.set(ip, hostname);
				}
			}
		} catch {}

		this.hostnameByIp = byIp;
		this.lastHostRefreshAt = now;
	}

	resolveSourceLabel(row) {
		const ip = String(row?.sourceIp || this.extractIpFromEndpoint(row?.source || '') || '').trim();
		if (!ip) return row?.source || 'N/A';
		const host = this.hostnameByIp.get(ip);
		return host || ip;
	}

	resolveDestinationLabel(row) {
		const ip = String(row?.destinationIp || this.extractIpFromEndpoint(row?.destination || '') || '').trim();
		const endpoint = String(row?.destination || '').trim() || 'N/A';
		if (!ip) return endpoint;
		const resolved = String(this.destinationDnsCache.get(ip) || '').trim();
		if (resolved) return `${resolved} (${endpoint})`;
		return endpoint;
	}

	isLikelyIpv4(ip) {
		const parts = String(ip || '')
			.trim()
			.split('.');
		if (parts.length !== 4) return false;
		return parts.every(part => {
			if (!/^\d+$/.test(part)) return false;
			const n = Number(part);
			return Number.isInteger(n) && n >= 0 && n <= 255;
		});
	}

	isLikelyIpv6(ip) {
		return String(ip || '')
			.trim()
			.includes(':');
	}

	isLikelyIpAddress(ip) {
		return this.isLikelyIpv4(ip) || this.isLikelyIpv6(ip);
	}

	async resolveDestinationHostnames(rows) {
		const unresolvedIps = [
			...new Set(
				(rows || [])
					.map(row => String(row?.destinationIp || '').trim())
					.filter(ip => ip && this.isLikelyIpAddress(ip) && !this.destinationDnsCache.has(ip))
			)
		];
		if (unresolvedIps.length === 0) return;

		const batch = unresolvedIps.slice(0, 12);
		const byIp = await this.reverseLookupIps(batch);
		for (const ip of batch) {
			const name = String(byIp.get(ip) || '').trim();
			this.destinationDnsCache.set(ip, name);
		}
	}

	async reverseLookupIps(ips) {
		const results = new Map();
		const list = Array.isArray(ips) ? ips.filter(Boolean) : [];
		if (list.length === 0) return results;

		try {
			const [status, result] = await this.core.ubusCall('file', 'exec', {
				command: '/bin/sh',
				params: [
					'-c',
					`for ip in "$@"; do
name=""
if command -v nslookup >/dev/null 2>&1; then
	if command -v timeout >/dev/null 2>&1; then
		name="$(timeout 2 nslookup "$ip" 2>/dev/null | sed -n 's/^.*name = //p' | head -n 1 | sed 's/\\.$//')"
	else
		name="$(nslookup "$ip" 2>/dev/null | sed -n 's/^.*name = //p' | head -n 1 | sed 's/\\.$//')"
	fi
fi
if [ -z "$name" ] && command -v getent >/dev/null 2>&1; then
	name="$(getent hosts "$ip" 2>/dev/null | awk '{print $2}' | head -n 1)"
fi
if [ -z "$name" ] && [ -r /etc/hosts ]; then
	name="$(awk -v ip="$ip" '$1==ip {print $2; exit}' /etc/hosts 2>/dev/null)"
fi
printf '%s\\t%s\\n' "$ip" "$name"
done`,
					'sh',
					...list
				]
			});
			if (status !== 0) return results;
			const lines = String(result?.stdout || '').split('\n');
			for (const line of lines) {
				const raw = String(line || '').replace(/\r$/, '');
				if (!raw) continue;
				const tab = raw.indexOf('\t');
				if (tab < 0) continue;
				const ip = raw.slice(0, tab).trim();
				const name = raw.slice(tab + 1).trim();
				if (ip) results.set(ip, name);
			}
		} catch {}
		return results;
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
