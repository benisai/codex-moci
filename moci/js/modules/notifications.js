export default class NotificationsModule {
	constructor(core) {
		this.core = core;
		this.initialized = false;
		this.dbPath = '/tmp/moci-notifications.sqlite';
		this.pollInterval = null;
		this.showArchived = false;

		this.core.registerRoute('/notifications', async () => {
			const pageElement = document.getElementById('notifications-page');
			if (pageElement) pageElement.classList.remove('hidden');

			if (!this.initialized) {
				this.bindHandlers();
				this.initialized = true;
			}

			await this.load();
		});
	}

	bindHandlers() {
		document.getElementById('notifications-refresh-btn')?.addEventListener('click', () => this.loadRows(true));
		document
			.getElementById('notifications-toggle-archived-btn')
			?.addEventListener('click', () => this.toggleArchivedFilter());

		const tbody = document.querySelector('#notifications-table tbody');
		tbody?.addEventListener('click', async event => {
			const btn = event.target.closest('button[data-action][data-id]');
			if (!btn) return;

			const action = btn.getAttribute('data-action');
			const id = Number(btn.getAttribute('data-id'));
			if (!Number.isFinite(id) || id < 1) return;

			if (action === 'archive') await this.archiveRow(id);
			if (action === 'delete') await this.softDeleteRow(id);
		});
	}

	async load() {
		await this.loadConfig();
		this.updateArchivedToggleLabel();
		this.startPolling();
		await this.loadRows(false);
	}

	toggleArchivedFilter() {
		this.showArchived = !this.showArchived;
		this.updateArchivedToggleLabel();
		this.loadRows(false);
	}

	updateArchivedToggleLabel() {
		const btn = document.getElementById('notifications-toggle-archived-btn');
		if (!btn) return;
		btn.textContent = this.showArchived ? 'HIDE ARCHIVED' : 'SHOW ARCHIVED';
	}

	startPolling() {
		if (this.pollInterval) return;
		this.pollInterval = setInterval(() => {
			if (this.core.currentRoute && this.core.currentRoute.startsWith('/notifications')) {
				this.loadRows(false);
			}
		}, 15000);
	}

	async loadConfig() {
		try {
			const [status, result] = await this.core.uciGet('moci', 'notifications');
			if (status === 0 && result?.values?.db_path) {
				this.dbPath = String(result.values.db_path).trim() || this.dbPath;
			}
		} catch {}
	}

	async loadRows(showToast) {
		const tbody = document.querySelector('#notifications-table tbody');
		if (!tbody) return;

		try {
			const rows = await this.fetchRows();
			if (!rows.length) {
				this.core.renderEmptyTable(tbody, 4, 'No notifications');
				return;
			}

			tbody.innerHTML = rows
				.map(row => {
					const archiveBtn =
						Number(row.archived) === 1
							? ''
							: `<button class="action-btn-sm" data-action="archive" data-id="${row.id}">ARCHIVE</button>`;

					return `<tr>
						<td>${this.core.escapeHtml(this.formatTimestamp(row.timestamp))}</td>
						<td>${this.core.escapeHtml(row.app || '-')}</td>
						<td>${this.core.escapeHtml(row.msg || '-')}</td>
						<td>
							<div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
								${archiveBtn}
								<button class="action-btn-sm danger" data-action="delete" data-id="${row.id}">DELETE</button>
							</div>
						</td>
					</tr>`;
				})
				.join('');

			if (showToast) this.core.showToast('Notifications refreshed', 'success');
		} catch (err) {
			console.error('Failed to load notifications:', err);
			this.core.renderEmptyTable(tbody, 4, 'Failed to load notifications');
			if (showToast) this.core.showToast('Failed to load notifications', 'error');
		}
	}

	async fetchRows() {
		const archivedClause = this.showArchived ? '' : ' AND archived = 0';
		const sql = `SELECT id, timestamp, app, msg, archived, "delete" FROM notifications WHERE "delete" = 0${archivedClause} ORDER BY timestamp DESC LIMIT 200;`;
		const cmd = `
SQLITE_BIN="$(command -v sqlite3 || command -v sqlite3-cli || true)"
[ -n "$SQLITE_BIN" ] || exit 7
[ -f ${this.shellQuote(this.dbPath)} ] || exit 0
"$SQLITE_BIN" -separator '|' ${this.shellQuote(this.dbPath)} ${this.shellQuote(sql)}
`;
		const result = await this.execShell(cmd);
		const out = String(result?.stdout || '').trim();
		if (!out) return [];

		return out
			.split('\n')
			.map(line => line.trim())
			.filter(Boolean)
			.map(line => {
				const [id, timestamp, app, msg, archived, deleted] = line.split('|');
				return {
					id: Number(id || 0),
					timestamp: Number(timestamp || 0),
					app: app || '',
					msg: msg || '',
					archived: Number(archived || 0),
					deleted: Number(deleted || 0)
				};
			})
			.filter(row => row.id > 0);
	}

	async archiveRow(id) {
		try {
			await this.execSql(`UPDATE notifications SET archived = 1 WHERE id = ${Number(id)};`);
			this.core.showToast('Notification archived', 'success');
			await this.loadRows(false);
		} catch (err) {
			console.error('Archive failed:', err);
			this.core.showToast('Failed to archive notification', 'error');
		}
	}

	async softDeleteRow(id) {
		try {
			await this.execSql(`UPDATE notifications SET "delete" = 1 WHERE id = ${Number(id)};`);
			this.core.showToast('Notification deleted', 'success');
			await this.loadRows(false);
		} catch (err) {
			console.error('Delete failed:', err);
			this.core.showToast('Failed to delete notification', 'error');
		}
	}

	async execSql(sql) {
		const cmd = `
SQLITE_BIN="$(command -v sqlite3 || command -v sqlite3-cli || true)"
[ -n "$SQLITE_BIN" ] || exit 7
[ -f ${this.shellQuote(this.dbPath)} ] || exit 9
"$SQLITE_BIN" ${this.shellQuote(this.dbPath)} ${this.shellQuote(sql)}
`;
		await this.execShell(cmd);
	}

	formatTimestamp(ts) {
		const ms = Number(ts || 0) * 1000;
		if (!Number.isFinite(ms) || ms <= 0) return '-';
		return new Date(ms).toLocaleString([], {
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		});
	}

	async execShell(cmd) {
		const [status, result] = await this.core.ubusCall(
			'file',
			'exec',
			{ command: '/bin/sh', params: ['-c', cmd] },
			{ timeout: 12000 }
		);
		if (status !== 0) throw new Error(`/bin/sh failed (${status})`);
		if (result?.code && Number(result.code) !== 0) throw new Error(`/bin/sh failed (${result.code})`);
		return result || {};
	}

	shellQuote(value) {
		return `'${String(value).replace(/'/g, `'\\''`)}'`;
	}
}
