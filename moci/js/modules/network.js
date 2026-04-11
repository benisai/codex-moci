export default class NetworkModule {
	constructor(core) {
		this.core = core;
		this.subTabs = null;
		this.cleanups = [];
		this.hostsRaw = '';
		this.connectionsRefreshTimer = null;
		this.isRefreshingConnections = false;
		this.connectionsDnsLookupEnabled = localStorage.getItem('network_connections_dns_lookup') === '1';
		this.connectionsDestinationDnsCache = new Map();
		this.connectionsLeaseHostByIpCache = new Map();
		this.connectionsLeaseCacheAt = 0;
		this.adblockClassicSection = 'global';
		this.adblockClassicReportMaxTop = 10;
		this.adblockClassicReportMaxResults = 50;
		this.adblockClassicDebugLog = [];
		this.adblockClassicDebugLimit = 160;
		this.qosifyInstalled = null;
		this.wirelessBySection = new Map();
		this.wirelessWwanScanRows = [];
		this.wirelessWwanLastScanDevice = '';

		this.core.registerRoute('/network', async (path, subPaths) => {
			const pageElement = document.getElementById('network-page');
			if (pageElement) pageElement.classList.remove('hidden');

			if (!this.subTabs) {
				this.subTabs = this.core.setupSubTabs('network-page', {
					interfaces: () => this.loadInterfaces(),
					wireless: () => this.loadWireless(),
					firewall: () => this.loadFirewall(),
					dhcp: () => this.loadDHCP(),
					dns: () => this.loadDNS(),
					'adblock-classic': () => this.loadAdblockClassic(),
					'adblock-fast': () => this.loadAdblock(),
					pbr: () => this.loadPBR(),
					ddns: () => this.loadDDNS(),
					qos: () => this.loadQoS(),
					qosify: () => this.loadQoSify(),
					vpn: () => this.loadVPN(),
					connections: () => this.loadConnections(),
					diagnostics: () => this.loadDiagnostics(),
					quarantine: () => this.loadQuarantine()
				});
				this.subTabs.attachListeners();
				this.setupModals();
				this.setupDiagnostics();
			}

			await this.refreshQosifyAvailability();

			const tabRaw = subPaths[0] || 'interfaces';
			let tab = tabRaw === 'adblock' ? 'adblock-classic' : tabRaw;
			if (tab === 'qosify' && !this.canShowQosifyTab()) {
				tab = 'interfaces';
			}
			this.subTabs.showSubTab(tab);
			if (tab === 'adblock-classic') this.loadAdblockClassic();
			if (tab === 'adblock-fast') this.loadAdblock();
		});
	}

	setupModals() {
		this.core.setupModal({
			modalId: 'interface-modal',
			closeBtnId: 'close-interface-modal',
			cancelBtnId: 'cancel-interface-btn',
			saveBtnId: 'save-interface-btn',
			saveHandler: () => this.saveInterface()
		});

		this.core.setupModal({
			modalId: 'wireless-modal',
			closeBtnId: 'close-wireless-modal',
			cancelBtnId: 'cancel-wireless-btn',
			saveBtnId: 'save-wireless-btn',
			saveHandler: () => this.saveWireless()
		});

		this.core.setupModal({
			modalId: 'wireless-qr-modal',
			closeBtnId: 'close-wireless-qr-modal',
			cancelBtnId: 'cancel-wireless-qr-btn'
		});

		this.core.setupModal({
			modalId: 'wireless-wwan-connect-modal',
			closeBtnId: 'close-wireless-wwan-connect-modal',
			cancelBtnId: 'cancel-wireless-wwan-connect-btn',
			saveBtnId: 'save-wireless-wwan-connect-btn',
			saveHandler: () => this.connectWirelessWwan()
		});

		this.core.setupModal({
			modalId: 'forward-modal',
			closeBtnId: 'close-forward-modal',
			cancelBtnId: 'cancel-forward-btn',
			saveBtnId: 'save-forward-btn',
			saveHandler: () => this.saveForward()
		});

		this.core.setupModal({
			modalId: 'fw-rule-modal',
			closeBtnId: 'close-fw-rule-modal',
			cancelBtnId: 'cancel-fw-rule-btn',
			saveBtnId: 'save-fw-rule-btn',
			saveHandler: () => this.saveFirewallRule()
		});

		this.core.setupModal({
			modalId: 'static-lease-modal',
			closeBtnId: 'close-static-lease-modal',
			cancelBtnId: 'cancel-static-lease-btn',
			saveBtnId: 'save-static-lease-btn',
			saveHandler: () => this.saveStaticLease()
		});

		this.core.setupModal({
			modalId: 'dns-entry-modal',
			closeBtnId: 'close-dns-entry-modal',
			cancelBtnId: 'cancel-dns-entry-btn',
			saveBtnId: 'save-dns-entry-btn',
			saveHandler: () => this.saveDnsEntry()
		});

		this.core.setupModal({
			modalId: 'host-entry-modal',
			closeBtnId: 'close-host-entry-modal',
			cancelBtnId: 'cancel-host-entry-btn',
			saveBtnId: 'save-host-entry-btn',
			saveHandler: () => this.saveHostEntry()
		});

		this.core.setupModal({
			modalId: 'ddns-modal',
			closeBtnId: 'close-ddns-modal',
			cancelBtnId: 'cancel-ddns-btn',
			saveBtnId: 'save-ddns-btn',
			saveHandler: () => this.saveDDNS()
		});

		this.core.setupModal({
			modalId: 'qos-rule-modal',
			closeBtnId: 'close-qos-rule-modal',
			cancelBtnId: 'cancel-qos-rule-btn',
			saveBtnId: 'save-qos-rule-btn',
			saveHandler: () => this.saveQoSRule()
		});

		this.core.setupModal({
			modalId: 'wg-peer-modal',
			closeBtnId: 'close-wg-peer-modal',
			cancelBtnId: 'cancel-wg-peer-btn',
			saveBtnId: 'save-wg-peer-btn',
			saveHandler: () => this.saveWgPeer()
		});

		this.core.setupModal({
			modalId: 'wg-import-modal',
			closeBtnId: 'close-wg-import-modal',
			cancelBtnId: 'cancel-wg-import-btn',
			saveBtnId: 'save-wg-import-btn',
			saveHandler: () => this.importWgProfile()
		});

		this.core.setupModal({
			modalId: 'adblock-list-modal',
			closeBtnId: 'close-adblock-list-modal',
			cancelBtnId: 'cancel-adblock-list-btn',
			saveBtnId: 'save-adblock-list-btn',
			saveHandler: () => this.addAdblockTargetList()
		});

		this.core.setupModal({
			modalId: 'pbr-dns-policy-modal',
			closeBtnId: 'close-pbr-dns-policy-modal',
			cancelBtnId: 'cancel-pbr-dns-policy-btn',
			saveBtnId: 'save-pbr-dns-policy-btn',
			saveHandler: () => this.savePbrDnsPolicy()
		});

		this.core.setupModal({
			modalId: 'pbr-policy-add-modal',
			closeBtnId: 'close-pbr-policy-add-modal',
			cancelBtnId: 'cancel-pbr-policy-add-btn',
			saveBtnId: 'save-pbr-policy-add-btn',
			saveHandler: () => this.addPbrPolicy()
		});

		this.core.setupModal({
			modalId: 'pbr-dns-policy-add-modal',
			closeBtnId: 'close-pbr-dns-policy-add-modal',
			cancelBtnId: 'cancel-pbr-dns-policy-add-btn',
			saveBtnId: 'save-pbr-dns-policy-add-btn',
			saveHandler: () => this.addPbrDnsPolicy()
		});

		this.core.setupModal({
			modalId: 'pbr-include-add-modal',
			closeBtnId: 'close-pbr-include-add-modal',
			cancelBtnId: 'cancel-pbr-include-add-btn',
			saveBtnId: 'save-pbr-include-add-btn',
			saveHandler: () => this.addPbrInclude()
		});

		this.core.setupModal({
			modalId: 'pbr-policy-modal',
			closeBtnId: 'close-pbr-policy-modal',
			cancelBtnId: 'cancel-pbr-policy-btn',
			saveBtnId: 'save-pbr-policy-btn',
			saveHandler: () => this.savePbrPolicy()
		});

		this.core.setupModal({
			modalId: 'pbr-include-modal',
			closeBtnId: 'close-pbr-include-modal',
			cancelBtnId: 'cancel-pbr-include-btn',
			saveBtnId: 'save-pbr-include-btn',
			saveHandler: () => this.savePbrInclude()
		});

		const addBtn = (id, modalId) => {
			document.getElementById(id)?.addEventListener('click', () => {
				this.core.resetModal(modalId);
				if (id === 'add-forward-btn') {
					this.loadForwardDeviceOptions();
				}
				this.core.openModal(modalId);
			});
		};

		addBtn('add-forward-btn', 'forward-modal');
		addBtn('add-fw-rule-btn', 'fw-rule-modal');
		addBtn('add-static-lease-btn', 'static-lease-modal');
		addBtn('add-dns-entry-btn', 'dns-entry-modal');
		addBtn('add-host-entry-btn', 'host-entry-modal');
		addBtn('add-ddns-btn', 'ddns-modal');
		addBtn('add-qos-rule-btn', 'qos-rule-modal');
		addBtn('add-wg-peer-btn', 'wg-peer-modal');

		const tables = {
			'interfaces-table': {
				edit: id => this.editInterface(id),
				restart: id => this.restartInterface(id),
				delete: id => this.deleteInterface(id)
			},
			'wireless-table': {
				edit: id => this.editWireless(id),
				delete: id => this.deleteWireless(id),
				qr: id => this.openWirelessQr(id)
			},
			'wireless-wwan-scan-table': {
				connect: id => this.openWirelessWwanConnectModal(id)
			},
			'firewall-table': { edit: id => this.editForward(id), delete: id => this.deleteForward(id) },
			'fw-rules-table': { edit: id => this.editFirewallRule(id), delete: id => this.deleteFirewallRule(id) },
			'dhcp-static-table': { edit: id => this.editStaticLease(id), delete: id => this.deleteStaticLease(id) },
			'dns-entries-table': { edit: id => this.editDnsEntry(id), delete: id => this.deleteDnsEntry(id) },
			'hosts-table': { edit: id => this.editHostEntry(id), delete: id => this.deleteHostEntry(id) },
			'ddns-table': {
				toggle: id => this.toggleDDNS(id),
				edit: id => this.editDDNS(id),
				delete: id => this.deleteDDNS(id)
			},
			'qos-rules-table': { edit: id => this.editQoSRule(id), delete: id => this.deleteQoSRule(id) },
			'wg-peers-table': { edit: id => this.editWgPeer(id), delete: id => this.deleteWgPeer(id) }
		};

		for (const [tableId, handlers] of Object.entries(tables)) {
			const cleanup = this.core.delegateActions(tableId, handlers);
			if (cleanup) this.cleanups.push(cleanup);
		}

		document.getElementById('save-qos-config-btn')?.addEventListener('click', () => this.saveQoSConfig());
		document.getElementById('wireless-wwan-scan-btn')?.addEventListener('click', () => this.scanWirelessWwan());
		document.getElementById('save-qosify-config-btn')?.addEventListener('click', () => this.saveQoSifyConfig());
		document.getElementById('qosify-start-btn')?.addEventListener('click', () => this.runQoSifyServiceAction('start'));
		document.getElementById('qosify-stop-btn')?.addEventListener('click', () => this.runQoSifyServiceAction('stop'));
		document.getElementById('qosify-restart-btn')?.addEventListener('click', () => this.runQoSifyServiceAction('restart'));
		document.getElementById('qosify-enable-btn')?.addEventListener('click', () => this.runQoSifyServiceAction('enable'));
		document.getElementById('qosify-disable-btn')?.addEventListener('click', () => this.runQoSifyServiceAction('disable'));
		document.getElementById('save-wg-config-btn')?.addEventListener('click', () => this.saveWgConfig());
		document.getElementById('generate-wg-keys-btn')?.addEventListener('click', () => this.generateWgKeys());
		document.getElementById('import-wg-profile-btn')?.addEventListener('click', () => {
			this.core.resetModal('wg-import-modal');
			this.core.openModal('wg-import-modal');
		});
		document.getElementById('save-adblock-settings-btn')?.addEventListener('click', () => this.saveAdblockSettings());
		document.getElementById('refresh-adblock-btn')?.addEventListener('click', () => this.loadAdblock());
		document.getElementById('save-adblock-classic-btn')?.addEventListener('click', () => this.saveAdblockClassicSettings());
		document
			.getElementById('save-adblock-classic-config-btn')
			?.addEventListener('click', () => this.saveAdblockClassicSettings());
		document.getElementById('refresh-adblock-classic-btn')?.addEventListener('click', () => this.loadAdblockClassic());
		document
			.getElementById('refresh-adblock-classic-report-btn')
			?.addEventListener('click', () => this.loadAdblockClassicReport(true));
		document
			.getElementById('save-adblock-classic-report-settings-btn')
			?.addEventListener('click', () => this.saveAdblockClassicReportSettings());
		document
			.getElementById('adblock-classic-enabled-on-btn')
			?.addEventListener('click', () => this.setAdblockClassicSettingValue('enabled', '1'));
		document
			.getElementById('adblock-classic-enabled-off-btn')
			?.addEventListener('click', () => this.setAdblockClassicSettingValue('enabled', '0'));
		document
			.getElementById('adblock-classic-safesearch-on-btn')
			?.addEventListener('click', () => this.setAdblockClassicSettingValue('safesearch', '1'));
		document
			.getElementById('adblock-classic-safesearch-off-btn')
			?.addEventListener('click', () => this.setAdblockClassicSettingValue('safesearch', '0'));
		document.getElementById('adblock-classic-start-btn')?.addEventListener('click', () => this.runAdblockClassicServiceAction('start'));
		document.getElementById('adblock-classic-stop-btn')?.addEventListener('click', () => this.runAdblockClassicServiceAction('stop'));
		document.getElementById('adblock-classic-restart-btn')?.addEventListener('click', () => this.runAdblockClassicServiceAction('restart'));
		document.getElementById('refresh-adblock-classic-debug-btn')?.addEventListener('click', () => this.renderAdblockClassicDebugLog());
		document.getElementById('clear-adblock-classic-debug-btn')?.addEventListener('click', () => this.clearAdblockClassicDebugLog());
		document.getElementById('adblock-classic-feed-select')?.addEventListener('change', () => this.syncAdblockClassicFeedSummary());
		document.getElementById('add-adblock-list-btn')?.addEventListener('click', () => {
			this.core.resetModal('adblock-list-modal');
			this.resetAdblockListForm();
			this.core.openModal('adblock-list-modal');
		});
		document.getElementById('adblock-classic-settings-toggle-btn')?.addEventListener('click', () =>
			this.toggleAdblockClassicSettingsPanel()
		);
		document.getElementById('adblock-settings-toggle-btn')?.addEventListener('click', () =>
			this.toggleAdblockSettingsPanel()
		);
		document
			.getElementById('adblock-enabled-on-btn')
			?.addEventListener('click', () => this.setAdblockSettingValue('enabled', '1'));
		document
			.getElementById('adblock-enabled-off-btn')
			?.addEventListener('click', () => this.setAdblockSettingValue('enabled', '0'));
		document
			.getElementById('adblock-config-update-on-btn')
			?.addEventListener('click', () => this.setAdblockSettingValue('config_update', '1'));
		document
			.getElementById('adblock-config-update-off-btn')
			?.addEventListener('click', () => this.setAdblockSettingValue('config_update', '0'));
		document.getElementById('save-pbr-settings-btn')?.addEventListener('click', () => this.savePbrSettings());
		document.getElementById('refresh-pbr-btn')?.addEventListener('click', () => this.loadPBR());
		document.getElementById('pbr-start-btn')?.addEventListener('click', () => this.runPbrServiceAction('start'));
		document.getElementById('pbr-stop-btn')?.addEventListener('click', () => this.runPbrServiceAction('stop'));
		document.getElementById('pbr-restart-btn')?.addEventListener('click', () => this.runPbrServiceAction('restart'));
		document.getElementById('pbr-enable-btn')?.addEventListener('click', () => this.runPbrServiceAction('enable'));
		document.getElementById('pbr-disable-btn')?.addEventListener('click', () => this.runPbrServiceAction('disable'));
		document.getElementById('pbr-settings-toggle-btn')?.addEventListener('click', () =>
			this.togglePbrSettingsPanel()
		);
		document.getElementById('pbr-policies-toggle-btn')?.addEventListener('click', () =>
			this.togglePbrSectionPanel('policies')
		);
		document.getElementById('pbr-dns-toggle-btn')?.addEventListener('click', () =>
			this.togglePbrSectionPanel('dns')
		);
		document.getElementById('pbr-list-toggle-btn')?.addEventListener('click', () =>
			this.togglePbrSectionPanel('list')
		);
		document.getElementById('network-connections-refresh-btn')?.addEventListener('click', () =>
			this.refreshConnectionsManually()
		);
		document.getElementById('network-connections-dns-toggle-btn')?.addEventListener('click', () =>
			this.toggleConnectionsDnsLookup()
		);
		document.getElementById('quarantine-enable-btn')?.addEventListener('click', () => this.saveQuarantineSettings(true));
		document.getElementById('quarantine-disable-btn')?.addEventListener('click', () => this.saveQuarantineSettings(false));
		document.getElementById('quarantine-save-btn')?.addEventListener('click', () => this.saveQuarantineInterval());
		document.getElementById('quarantine-refresh-btn')?.addEventListener('click', () => this.loadQuarantine());
		document.getElementById('quarantine-discover-btn')?.addEventListener('click', () => this.runQuarantineDiscovery());
		document.getElementById('quarantine-settings-toggle-btn')?.addEventListener('click', () =>
			this.toggleQuarantineSettingsPanel()
		);
		document.getElementById('add-pbr-policy-btn')?.addEventListener('click', async () => {
			this.core.resetModal('pbr-policy-add-modal');
			await this.populatePbrInterfaceOptions();
			this.resetPbrPolicyAddForm();
			this.core.openModal('pbr-policy-add-modal');
		});
		document.getElementById('add-pbr-dns-policy-btn')?.addEventListener('click', async () => {
			this.core.resetModal('pbr-dns-policy-add-modal');
			this.resetPbrDnsPolicyAddForm();
			await this.loadPbrDnsSourceDeviceOptions();
			this.core.openModal('pbr-dns-policy-add-modal');
		});
		document.getElementById('add-pbr-include-btn')?.addEventListener('click', () => {
			this.core.resetModal('pbr-include-add-modal');
			this.resetPbrIncludeAddForm();
			this.core.openModal('pbr-include-add-modal');
		});
		this.syncAdblockSettingsPanel();
		this.syncAdblockClassicSettingsPanel();
		this.syncAdblockSettingsButtons();
		this.syncPbrSettingsPanel();
		this.syncAllPbrSectionPanels();
		this.syncQuarantineSettingsPanel();

		const adblockCleanup = this.core.delegateActions('adblock-targets-table', {
			toggle: id => this.toggleAdblockTargetList(id),
			delete: id => this.deleteAdblockTargetList(id)
		});
		if (adblockCleanup) this.cleanups.push(adblockCleanup);

		const pbrPolicyCleanup = this.core.delegateActions('pbr-policies-table', {
			toggle: id => this.togglePbrPolicy(id),
			edit: id => this.editPbrPolicy(id),
			delete: id => this.deletePbrPolicy(id)
		});
		if (pbrPolicyCleanup) this.cleanups.push(pbrPolicyCleanup);

		const pbrDnsCleanup = this.core.delegateActions('pbr-dns-policies-table', {
			toggle: id => this.togglePbrDnsPolicy(id),
			edit: id => this.editPbrDnsPolicy(id),
			delete: id => this.deletePbrDnsPolicy(id)
		});
		if (pbrDnsCleanup) this.cleanups.push(pbrDnsCleanup);

		const pbrIncludeCleanup = this.core.delegateActions('pbr-includes-table', {
			edit: id => this.editPbrInclude(id),
			delete: id => this.deletePbrInclude(id)
		});
		if (pbrIncludeCleanup) this.cleanups.push(pbrIncludeCleanup);

		const quarantineCleanup = this.core.delegateActions('quarantine-table', {
			release: id => this.releaseQuarantinedDevice(id)
		});
		if (quarantineCleanup) this.cleanups.push(quarantineCleanup);
	}

	setupDiagnostics() {
		document.getElementById('ping-btn')?.addEventListener('click', () => this.runDiagnostic('ping'));
		document.getElementById('traceroute-btn')?.addEventListener('click', () => this.runDiagnostic('traceroute'));
		document.getElementById('nslookup-btn')?.addEventListener('click', () => this.runDiagnostic('nslookup'));
		document.getElementById('wol-btn')?.addEventListener('click', () => this.runWoL());
	}

	toggleAdblockSettingsPanel() {
		const body = document.getElementById('adblock-settings-body');
		const icon = document.getElementById('adblock-settings-toggle-icon');
		const btn = document.getElementById('adblock-settings-toggle-btn');
		if (!body || !icon || !btn) return;

		const isHidden = body.style.display === 'none' || body.style.display === '';
		if (isHidden) {
			body.style.display = 'block';
			icon.textContent = '▾';
			btn.setAttribute('aria-expanded', 'true');
			localStorage.setItem('adblock_settings_expanded', '1');
		} else {
			body.style.display = 'none';
			icon.textContent = '▸';
			btn.setAttribute('aria-expanded', 'false');
			localStorage.setItem('adblock_settings_expanded', '0');
		}
	}

	syncAdblockSettingsPanel() {
		const body = document.getElementById('adblock-settings-body');
		const icon = document.getElementById('adblock-settings-toggle-icon');
		const btn = document.getElementById('adblock-settings-toggle-btn');
		if (!body || !icon || !btn) return;

		const expanded = localStorage.getItem('adblock_settings_expanded') === '1';
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

	toggleAdblockClassicSettingsPanel() {
		const body = document.getElementById('adblock-classic-settings-body');
		const icon = document.getElementById('adblock-classic-settings-toggle-icon');
		const btn = document.getElementById('adblock-classic-settings-toggle-btn');
		if (!body || !icon || !btn) return;

		const isHidden = body.style.display === 'none' || body.style.display === '';
		if (isHidden) {
			body.style.display = 'block';
			icon.textContent = '▾';
			btn.setAttribute('aria-expanded', 'true');
			localStorage.setItem('adblock_classic_settings_expanded', '1');
		} else {
			body.style.display = 'none';
			icon.textContent = '▸';
			btn.setAttribute('aria-expanded', 'false');
			localStorage.setItem('adblock_classic_settings_expanded', '0');
		}
	}

	syncAdblockClassicSettingsPanel() {
		const body = document.getElementById('adblock-classic-settings-body');
		const icon = document.getElementById('adblock-classic-settings-toggle-icon');
		const btn = document.getElementById('adblock-classic-settings-toggle-btn');
		if (!body || !icon || !btn) return;

		const expanded = localStorage.getItem('adblock_classic_settings_expanded') === '1';
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

	setAdblockSettingValue(setting, value, options = {}) {
		const next = String(value) === '1' ? '1' : '0';
		if (setting === 'enabled') {
			const input = document.getElementById('adblock-enabled');
			if (input) input.value = next;
		} else if (setting === 'config_update') {
			const input = document.getElementById('adblock-config-update');
			if (input) input.value = next;
		}
		this.syncAdblockSettingsButtons();
		if (options.syncOnly) return;
	}

	syncAdblockSettingsButtons() {
		const enabledValue = String(document.getElementById('adblock-enabled')?.value || '0') === '1';
		const configUpdateValue = String(document.getElementById('adblock-config-update')?.value || '0') === '1';
		this.syncAdblockTogglePair('adblock-enabled-on-btn', 'adblock-enabled-off-btn', enabledValue);
		this.syncAdblockTogglePair(
			'adblock-config-update-on-btn',
			'adblock-config-update-off-btn',
			configUpdateValue
		);
	}

	syncAdblockTogglePair(onId, offId, isEnabled) {
		const onBtn = document.getElementById(onId);
		const offBtn = document.getElementById(offId);
		if (!onBtn || !offBtn) return;

		onBtn.classList.toggle('success', Boolean(isEnabled));
		onBtn.classList.toggle('danger', false);
		offBtn.classList.toggle('danger', !isEnabled);
		offBtn.classList.toggle('success', false);

		onBtn.setAttribute('aria-pressed', isEnabled ? 'true' : 'false');
		offBtn.setAttribute('aria-pressed', isEnabled ? 'false' : 'true');
	}

	togglePbrSettingsPanel() {
		const body = document.getElementById('pbr-settings-body');
		const icon = document.getElementById('pbr-settings-toggle-icon');
		const btn = document.getElementById('pbr-settings-toggle-btn');
		if (!body || !icon || !btn) return;

		const isHidden = body.style.display === 'none' || body.style.display === '';
		if (isHidden) {
			body.style.display = 'block';
			icon.textContent = '▾';
			btn.setAttribute('aria-expanded', 'true');
			localStorage.setItem('pbr_settings_expanded', '1');
		} else {
			body.style.display = 'none';
			icon.textContent = '▸';
			btn.setAttribute('aria-expanded', 'false');
			localStorage.setItem('pbr_settings_expanded', '0');
		}
	}

	syncPbrSettingsPanel() {
		const body = document.getElementById('pbr-settings-body');
		const icon = document.getElementById('pbr-settings-toggle-icon');
		const btn = document.getElementById('pbr-settings-toggle-btn');
		if (!body || !icon || !btn) return;

		const expanded = localStorage.getItem('pbr_settings_expanded') === '1';
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

	togglePbrSectionPanel(name) {
		const body = document.getElementById(`pbr-${name}-body`);
		const icon = document.getElementById(`pbr-${name}-toggle-icon`);
		const btn = document.getElementById(`pbr-${name}-toggle-btn`);
		if (!body || !icon || !btn) return;

		const isHidden = body.style.display === 'none' || body.style.display === '';
		if (isHidden) {
			body.style.display = 'block';
			icon.textContent = '▾';
			btn.setAttribute('aria-expanded', 'true');
			localStorage.setItem(`pbr_${name}_expanded`, '1');
		} else {
			body.style.display = 'none';
			icon.textContent = '▸';
			btn.setAttribute('aria-expanded', 'false');
			localStorage.setItem(`pbr_${name}_expanded`, '0');
		}
	}

	syncPbrSectionPanel(name, defaultExpanded = true) {
		const body = document.getElementById(`pbr-${name}-body`);
		const icon = document.getElementById(`pbr-${name}-toggle-icon`);
		const btn = document.getElementById(`pbr-${name}-toggle-btn`);
		if (!body || !icon || !btn) return;

		const stored = localStorage.getItem(`pbr_${name}_expanded`);
		const expanded = stored === null ? defaultExpanded : stored === '1';
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

	syncAllPbrSectionPanels() {
		this.syncPbrSectionPanel('policies', true);
		this.syncPbrSectionPanel('dns', true);
		this.syncPbrSectionPanel('list', true);
	}

	toggleQuarantineSettingsPanel() {
		const body = document.getElementById('quarantine-settings-body');
		const icon = document.getElementById('quarantine-settings-toggle-icon');
		const btn = document.getElementById('quarantine-settings-toggle-btn');
		if (!body || !icon || !btn) return;

		const isHidden = body.style.display === 'none' || body.style.display === '';
		if (isHidden) {
			body.style.display = 'block';
			icon.textContent = '▾';
			btn.setAttribute('aria-expanded', 'true');
			localStorage.setItem('quarantine_settings_expanded', '1');
		} else {
			body.style.display = 'none';
			icon.textContent = '▸';
			btn.setAttribute('aria-expanded', 'false');
			localStorage.setItem('quarantine_settings_expanded', '0');
		}
	}

	syncQuarantineSettingsPanel() {
		const body = document.getElementById('quarantine-settings-body');
		const icon = document.getElementById('quarantine-settings-toggle-icon');
		const btn = document.getElementById('quarantine-settings-toggle-btn');
		if (!body || !icon || !btn) return;

		const expanded = localStorage.getItem('quarantine_settings_expanded') === '1';
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

	cleanup() {
		this.stopConnectionsAutoRefresh();
		if (this.subTabs) {
			this.subTabs.cleanup();
			this.subTabs = null;
		}
		this.cleanups.filter(Boolean).forEach(fn => {
			fn();
		});
		this.cleanups = [];
	}

	async loadInterfaces() {
		await this.core.loadResource('interfaces-table', 6, 'network', async () => {
			const [[, result], procNetDevMap] = await Promise.all([
				this.core.ubusCall('network.interface', 'dump', {}),
				this.readProcNetDevMap()
			]);
			if (!result?.interface) throw new Error('No data');
			const tbody = document.querySelector('#interfaces-table tbody');
			if (!tbody) return;
			if (result.interface.length === 0) {
				this.core.renderEmptyTable(tbody, 6, 'No interfaces found');
				return;
			}
			tbody.innerHTML = result.interface
				.map(iface => {
					const ipv4 = iface['ipv4-address']?.[0]?.address || '---.---.---.---';
					const { rxBytes, txBytes } = this.resolveInterfaceTotals(iface, procNetDevMap);
					const rx = this.core.formatBytes(rxBytes);
					const tx = this.core.formatBytes(txBytes);
					return `<tr>
					<td data-label="INTERFACE">${this.core.escapeHtml(iface.interface)}</td>
					<td data-label="PROTOCOL">${this.core.escapeHtml(iface.proto || 'none').toUpperCase()}</td>
					<td data-label="STATUS">${this.renderInterfaceStatusBadge(Boolean(iface.up))}</td>
					<td data-label="IPV4 ADDRESS">${this.core.escapeHtml(ipv4)}</td>
					<td data-label="RX/TX">${rx} / ${tx}</td>
					<td data-label="ACTIONS">${this.renderInterfaceActionButtons(iface.interface)}</td>
				</tr>`;
				})
				.join('');
		});
	}

	renderInterfaceStatusBadge(isUp) {
		if (!this.core.isFeatureEnabled('colorful_graphs')) {
			return this.core.renderBadge(isUp ? 'success' : 'error', isUp ? 'UP' : 'DOWN');
		}
		return `<span class="badge ${isUp ? 'badge-interface-up' : 'badge-interface-down'}">${isUp ? 'UP' : 'DOWN'}</span>`;
	}

	renderInterfaceActionButtons(id) {
		const eid = this.core.escapeHtml(id);
		return `<button class="action-btn-sm" data-action="edit" data-id="${eid}" style="font-size:11px;padding:4px 8px;line-height:1.2">EDIT</button><button class="action-btn-sm warning" data-action="restart" data-id="${eid}" style="font-size:11px;padding:4px 8px;line-height:1.2">RESTART</button><button class="action-btn-sm danger" data-action="delete" data-id="${eid}" style="font-size:11px;padding:4px 8px;line-height:1.2">DELETE</button>`;
	}

	async readProcNetDevMap() {
		const map = new Map();
		try {
			const [status, result] = await this.core.ubusCall('file', 'read', { path: '/proc/net/dev' });
			if (status !== 0 || !result?.data) return map;
			const lines = String(result.data)
				.split('\n')
				.slice(2)
				.map(line => line.trim())
				.filter(Boolean);
			for (const line of lines) {
				const [devPart, rest] = line.split(':');
				if (!devPart || !rest) continue;
				const dev = devPart.trim();
				const fields = rest
					.trim()
					.split(/\s+/)
					.map(v => Number(v) || 0);
				// /proc/net/dev format: rx bytes is field 0, tx bytes is field 8
				map.set(dev, { rxBytes: fields[0] || 0, txBytes: fields[8] || 0 });
			}
		} catch {}
		return map;
	}

	resolveInterfaceTotals(iface, procNetDevMap) {
		const stats = iface?.statistics || iface?.stats || {};
		const directRx = Number(stats.rx_bytes ?? stats.rxBytes ?? 0) || 0;
		const directTx = Number(stats.tx_bytes ?? stats.txBytes ?? 0) || 0;
		if (directRx > 0 || directTx > 0) {
			return { rxBytes: directRx, txBytes: directTx };
		}

		const candidates = [];
		const addCandidate = value => {
			const v = String(value || '').trim();
			if (v && !candidates.includes(v)) candidates.push(v);
		};

		addCandidate(iface?.l3_device);
		if (!Array.isArray(iface?.device)) addCandidate(iface?.device);
		addCandidate(iface?.interface);
		if (Array.isArray(iface?.device)) {
			for (const d of iface.device) addCandidate(d);
		}

		for (const dev of candidates) {
			const fromProc = procNetDevMap.get(dev);
			if (fromProc) return fromProc;
		}

		return { rxBytes: 0, txBytes: 0 };
	}

	async editInterface(id) {
		try {
			const [status, result] = await this.core.uciGet('network', id);
			if (status !== 0 || !result?.values) throw new Error('Not found');
			const c = result.values;
			document.getElementById('edit-iface-name').value = id;
			document.getElementById('edit-iface-proto').value = c.proto || 'dhcp';
			document.getElementById('edit-iface-ipaddr').value = c.ipaddr || '';
			document.getElementById('edit-iface-netmask').value = c.netmask || '';
			document.getElementById('edit-iface-gateway').value = c.gateway || '';
			document.getElementById('edit-iface-dns').value = Array.isArray(c.dns) ? c.dns.join(' ') : c.dns || '';
			this.core.openModal('interface-modal');
		} catch {
			this.core.showToast('Failed to load interface config', 'error');
		}
	}

	async saveInterface() {
		const name = document.getElementById('edit-iface-name').value;
		const proto = document.getElementById('edit-iface-proto').value;
		const values = { proto };
		if (proto === 'static') {
			const ipaddr = document.getElementById('edit-iface-ipaddr').value;
			const netmask = document.getElementById('edit-iface-netmask').value;
			const gateway = document.getElementById('edit-iface-gateway').value;
			const dns = document.getElementById('edit-iface-dns').value;
			if (ipaddr) values.ipaddr = ipaddr;
			if (netmask) values.netmask = netmask;
			if (gateway) values.gateway = gateway;
			if (dns) values.dns = dns.split(/\s+/);
		}
		try {
			await this.core.uciSet('network', name, values);
			await this.core.uciCommit('network');
			this.core.closeModal('interface-modal');
			this.core.showToast('Interface updated', 'success');
			this.loadInterfaces();
		} catch {
			this.core.showToast('Failed to save interface', 'error');
		}
	}

	async deleteInterface(id) {
		if (!confirm(`Delete interface "${id}"?`)) return;
		try {
			await this.core.uciDelete('network', id);
			await this.core.uciCommit('network');
			this.core.showToast('Interface deleted', 'success');
			this.loadInterfaces();
		} catch {
			this.core.showToast('Failed to delete interface', 'error');
		}
	}

	async restartInterface(id) {
		try {
			const command = `ifdown ${this.shellQuote(id)} 2>/dev/null || true; sleep 1; ifup ${this.shellQuote(id)}`;
			const [status] = await this.core.ubusCall('file', 'exec', {
				command: '/bin/sh',
				params: ['-c', command]
			});
			if (status !== 0) throw new Error('restart failed');
			this.core.showToast(`Interface ${id} restarted`, 'success');
			setTimeout(() => this.loadInterfaces(), 800);
		} catch {
			this.core.showToast(`Failed to restart ${id}`, 'error');
		}
	}

	shellQuote(value) {
		return `'${String(value).replace(/'/g, `'\\''`)}'`;
	}

	async loadWireless() {
		await this.loadWirelessWwanPanel();
		await this.core.loadResource('wireless-table', 7, 'wireless', async () => {
			const [status, result] = await this.core.uciGet('wireless');
			if (status !== 0 || !result?.values) throw new Error('No data');
			const config = result.values;
			const radios = {};
			const ifaces = [];

			for (const [key, val] of Object.entries(config)) {
				if (val['.type'] === 'wifi-device') radios[key] = val;
				if (val['.type'] === 'wifi-iface') ifaces.push({ section: key, ...val });
			}

			const tbody = document.querySelector('#wireless-table tbody');
			if (!tbody) return;
			this.wirelessBySection = new Map();
			if (ifaces.length === 0) {
				this.core.renderEmptyTable(tbody, 7, 'No wireless interfaces found');
				return;
			}
			tbody.innerHTML = ifaces
				.map(iface => {
					const radio = radios[iface.device] || {};
					const disabled = iface.disabled === '1';
					const security = String(iface.encryption || 'none').toUpperCase();
					const password =
						String(iface.encryption || '').toLowerCase() === 'none'
							? 'N/A'
							: String(iface.key || iface.password || '').trim() || 'N/A';
					this.wirelessBySection.set(String(iface.section), {
						section: String(iface.section),
						ssid: String(iface.ssid || ''),
						encryption: String(iface.encryption || 'none'),
						password
					});
					return `<tr>
					<td data-label="Radio">${this.core.escapeHtml(iface.device || 'N/A')}</td>
					<td data-label="SSID">${this.core.escapeHtml(iface.ssid || 'N/A')}</td>
					<td data-label="Password">${this.core.escapeHtml(password)}</td>
					<td data-label="Security">${this.core.escapeHtml(security)}</td>
					<td data-label="Channel">${this.core.escapeHtml(radio.channel || 'auto')}</td>
					<td data-label="Status">${this.renderWirelessStatusBadge(!disabled)}</td>
					<td data-label="Actions">${this.renderWirelessActionButtons(iface.section)}</td>
				</tr>`;
				})
				.join('');
		});
	}

	parseWwanIwinfoDevices(payload) {
		const devices = [];
		if (!payload) return devices;
		if (Array.isArray(payload?.devices)) {
			for (const item of payload.devices) {
				const name = typeof item === 'string' ? item : String(item?.device || item?.ifname || '').trim();
				if (name) devices.push(name);
			}
		} else if (Array.isArray(payload)) {
			for (const item of payload) {
				const name = typeof item === 'string' ? item : String(item?.device || item?.ifname || '').trim();
				if (name) devices.push(name);
			}
		} else if (payload && typeof payload === 'object') {
			for (const [key, value] of Object.entries(payload)) {
				const candidate = String(value?.device || value?.ifname || key || '').trim();
				if (candidate) devices.push(candidate);
			}
		}
		return Array.from(new Set(devices)).sort();
	}

	parseWwanIwinfoDevicesFromCli(output) {
		const devices = [];
		const text = String(output || '');
		for (const line of text.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			const m = trimmed.match(/^([a-zA-Z0-9_.:-]+)\s+/);
			if (!m) continue;
			const name = String(m[1] || '').trim();
			if (!name || name === 'No') continue;
			devices.push(name);
		}
		return Array.from(new Set(devices)).sort();
	}

	async ubusCallWithFallback(object, method, params = {}, timeout = 15000) {
		try {
			const [status, result] = await this.core.ubusCall(object, method, params, { timeout });
			if (status === 0) return result;
		} catch {}
		try {
			const [status, result] = await this.core.ubusCall(
				'file',
				'exec',
				{
					command: 'ubus',
					params: ['call', object, method, JSON.stringify(params || {})]
				},
				{ timeout }
			);
			if (status !== 0 || !result?.stdout) return null;
			const raw = String(result.stdout || '').trim();
			if (!raw) return null;
			return JSON.parse(raw);
		} catch {
			return null;
		}
	}

	async readWirelessScanFromCli(device) {
		if (!device) return [];
		try {
			const [status, result] = await this.core.ubusCall(
				'file',
				'exec',
				{
					command: '/bin/sh',
					params: ['-c', `iwinfo ${this.shellQuote(device)} scan 2>/dev/null || true`]
				},
				{ timeout: 30000 }
			);
			if (status !== 0) return [];
			const raw = String(result?.stdout || '');
			if (!raw.trim()) return [];

			const blocks = raw
				.split(/\n(?=Cell\s+\d+\s+-\s+Address:)/g)
				.map(b => b.trim())
				.filter(Boolean);

			return blocks
				.map(block => {
					const bssid = (block.match(/Address:\s*([0-9A-Fa-f:]{17})/) || [])[1] || '';
					const ssid = (block.match(/ESSID:\s*"([^"]*)"/) || [])[1] || '<hidden>';
					const channel = (block.match(/Channel:\s*([0-9]+)/) || [])[1] || 'N/A';
					const signal = (block.match(/Signal:\s*(-?\d+)\s*dBm/i) || [])[1] || '';
					const mode = (block.match(/Mode:\s*([A-Za-z-]+)/) || [])[1] || '';
					const encryption = (block.match(/Encryption:\s*(.+)/) || [])[1] || 'open';
					const signalLabel = signal ? `${signal} dBm` : 'N/A';
					return {
						ssid: String(ssid || '<hidden>').trim() || '<hidden>',
						bssid: String(bssid || 'N/A').trim().toLowerCase() || 'N/A',
						channel: String(channel || 'N/A').trim() || 'N/A',
						channelNum: Number(channel) || 0,
						signal: signalLabel,
						mode: String(mode || '').trim(),
						rawEncryption: null,
						encryption: String(encryption || 'open').trim(),
						isOpen: /open|none|off/i.test(String(encryption || 'open'))
					};
				})
				.filter(row => row.ssid);
		} catch {
			return [];
		}
	}

	async readWirelessScan(device) {
		const result = await this.ubusCallWithFallback('iwinfo', 'scan', { device }, 25000);
		if (!result) {
			return this.readWirelessScanFromCli(device);
		}
		const rows = Array.isArray(result?.results)
			? result.results
			: Array.isArray(result?.scan)
				? result.scan
				: Array.isArray(result)
					? result
					: [];
		return rows
			.map(item => {
				const ssid = String(item?.ssid || '').trim();
				const bssid = String(item?.bssid || '').trim().toLowerCase();
				const channel = String(item?.channel || item?.channel_number || '').trim() || 'N/A';
				const signal = Number(item?.signal);
				const quality = Number(item?.quality);
				const signalLabel = Number.isFinite(signal)
					? `${signal} dBm`
					: Number.isFinite(quality)
						? String(quality)
						: 'N/A';
				const rawEncryption = item?.encryption;
				const enc = this.formatWwanEncryption(rawEncryption, item?.security || item?.encryption || 'open');
				const mode = String(item?.mode || '').trim();
				return {
					ssid: ssid || '<hidden>',
					bssid: bssid || 'N/A',
					channel,
					channelNum: Number(item?.channel) || 0,
					signal: signalLabel,
					mode,
					rawEncryption,
					encryption: enc,
					isOpen: /open|none|off/i.test(enc)
				};
			})
			.filter(row => row.ssid);
	}

	formatWwanEncryption(rawEncryption, fallback = 'open') {
		if (rawEncryption && typeof rawEncryption === 'object') {
			if (typeof rawEncryption.description === 'string' && rawEncryption.description.trim()) {
				return rawEncryption.description.trim();
			}
			const auth = this.normalizeToList(rawEncryption.authentication).map(v => v.toLowerCase());
			if (auth.includes('sae')) return 'WPA3-SAE';
			if (auth.includes('psk')) return 'WPA-PSK';
			if (Array.isArray(rawEncryption.wep)) return 'WEP';
			return 'Encrypted';
		}
		const text = String(fallback || 'open').trim();
		return text || 'open';
	}

	normalizeToList(value) {
		if (Array.isArray(value)) return value.map(v => String(v || '').trim()).filter(Boolean);
		const raw = String(value || '').trim();
		if (!raw) return [];
		return raw.split(/\s+/).map(v => String(v || '').trim()).filter(Boolean);
	}

	async ensureWwanFirewallZone() {
		const [status, result] = await this.core.uciGet('firewall');
		if (status !== 0 || !result?.values) return;
		const cfg = result.values;
		let wanZoneSection = null;
		for (const [section, values] of Object.entries(cfg)) {
			if (String(values?.['.type'] || '') !== 'zone') continue;
			if (String(values?.name || '') === 'wan') {
				wanZoneSection = section;
				break;
			}
		}
		if (wanZoneSection) {
			const current = this.normalizeToList(cfg[wanZoneSection]?.network);
			if (!current.includes('wwan')) {
				await this.core.uciSet('firewall', wanZoneSection, { network: [...current, 'wwan'] });
			}
			return;
		}
		const [addStatus, addResult] = await this.core.uciAdd('firewall', 'zone', 'wwan');
		if (addStatus !== 0 || !addResult?.section) return;
		await this.core.uciSet('firewall', addResult.section, {
			name: 'wwan',
			network: ['wwan'],
			input: 'REJECT',
			output: 'ACCEPT',
			forward: 'REJECT',
			masq: '1',
			mtu_fix: '1'
		});
	}

	async readWirelessWwanState() {
		const [status, result] = await this.core.uciGet('wireless');
		if (status !== 0 || !result?.values) return { sta: null, radios: [] };
		const cfg = result.values;
		const radios = [];
		let sta = null;
		for (const [section, values] of Object.entries(cfg)) {
			if (String(values?.['.type'] || '') === 'wifi-device') {
				radios.push(section);
			}
			if (String(values?.['.type'] || '') === 'wifi-iface') {
				if (String(values?.mode || '') !== 'sta') continue;
				const nets = this.normalizeToList(values?.network);
				if (!nets.includes('wwan')) continue;
				sta = { section, ...values };
			}
		}
		return { sta, radios };
	}

	async loadWirelessWwanPanel() {
		const currentEl = document.getElementById('wireless-wwan-current');
		const deviceEl = document.getElementById('wireless-wwan-device');
		const connectRadioEl = document.getElementById('wireless-wwan-connect-radio');
		const hintEl = document.getElementById('wireless-wwan-scan-hint');
		const tbody = document.querySelector('#wireless-wwan-scan-table tbody');
		if (!currentEl || !deviceEl || !tbody) return;

		const [wirelessState, iwinfoDevices, iwinfoCli] = await Promise.all([
			this.readWirelessWwanState(),
			this.ubusCallWithFallback('iwinfo', 'devices', {}, 12000),
			this.core.ubusCall(
				'file',
				'exec',
				{
					command: '/bin/sh',
					params: ['-c', 'iwinfo 2>/dev/null || true']
				},
				{ timeout: 12000 }
			)
		]);

		const radios = wirelessState.radios || [];

		const cliRaw = iwinfoCli?.[0] === 0 ? String(iwinfoCli?.[1]?.stdout || '') : '';
		const devices = Array.from(
			new Set([
				...this.parseWwanIwinfoDevices(iwinfoDevices),
				...this.parseWwanIwinfoDevicesFromCli(cliRaw),
				...radios
			])
		).sort();
		deviceEl.innerHTML = devices.length
			? devices.map(d => `<option value="${this.core.escapeHtml(d)}">${this.core.escapeHtml(d)}</option>`).join('')
			: '<option value="">N/A</option>';
		if (connectRadioEl) {
			connectRadioEl.innerHTML = deviceEl.innerHTML;
		}

		if (hintEl) hintEl.classList.toggle('hidden', devices.length > 0);

		if (wirelessState.sta) {
			const sta = wirelessState.sta;
			currentEl.innerHTML = this.core.renderBadge(
				'success',
				`CONNECTED: ${String(sta.ssid || '<hidden>')} via ${String(sta.device || 'unknown')}`
			);
		} else {
			currentEl.innerHTML = this.core.renderBadge('error', 'NOT CONNECTED');
		}

		if (!this.wirelessWwanScanRows.length) {
			tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--steel-muted)">Click SCAN APS to find nearby networks.</td></tr>`;
		}
	}

	renderWirelessWwanScanTable() {
		const tbody = document.querySelector('#wireless-wwan-scan-table tbody');
		if (!tbody) return;
		const rows = this.wirelessWwanScanRows || [];
		if (!rows.length) {
			tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--steel-muted)">No APs found.</td></tr>`;
			return;
		}
		tbody.innerHTML = rows
			.map((row, index) => {
				const ssid = this.core.escapeHtml(String(row.ssid || '<hidden>'));
				const bssid = this.core.escapeHtml(String(row.bssid || 'N/A'));
				const channel = this.core.escapeHtml(String(row.channel || 'N/A'));
				const signal = this.core.escapeHtml(String(row.signal || 'N/A'));
				const encryption = this.core.escapeHtml(String(row.encryption || 'open'));
				return `<tr>
					<td data-label="SSID">${ssid}</td>
					<td data-label="BSSID">${bssid}</td>
					<td data-label="Channel">${channel}</td>
					<td data-label="Signal">${signal}</td>
					<td data-label="Encryption">${encryption}</td>
					<td data-label="Action"><button class="action-btn-sm" data-action="connect" data-id="${index}">CONNECT</button></td>
				</tr>`;
			})
			.join('');
	}

	async scanWirelessWwan() {
		const deviceEl = document.getElementById('wireless-wwan-device');
		const device = String(deviceEl?.value || '').trim();
		if (!device) {
			this.core.showToast('No scan device available', 'error');
			return;
		}
		this.core.showToast(`Scanning APs on ${device}...`, 'info');
		const rows = await this.readWirelessScan(device);
		this.wirelessWwanLastScanDevice = device;
		this.wirelessWwanScanRows = rows;
		this.renderWirelessWwanScanTable();
		this.core.showToast(rows.length ? `Found ${rows.length} APs` : 'No APs found', rows.length ? 'success' : 'error');
	}

	openWirelessWwanConnectModal(id) {
		const idx = Number(id);
		const row = Number.isFinite(idx) ? this.wirelessWwanScanRows[idx] : null;
		if (!row) {
			this.core.showToast('Selected AP not found', 'error');
			return;
		}
		const radio = String(this.wirelessWwanLastScanDevice || document.getElementById('wireless-wwan-device')?.value || '').trim();
		document.getElementById('wireless-wwan-selected-id').value = String(idx);
		const connectRadioEl = document.getElementById('wireless-wwan-connect-radio');
		if (connectRadioEl) connectRadioEl.value = radio;
		document.getElementById('wireless-wwan-connect-ssid').value = String(row.ssid || '').replace(/^<hidden>$/, '');
		document.getElementById('wireless-wwan-connect-bssid').value = String(row.bssid || '').replace(/^N\/A$/, '');
		document.getElementById('wireless-wwan-connect-encryption').value = row.isOpen ? 'none' : 'psk2';
		document.getElementById('wireless-wwan-connect-key').value = '';
		document.getElementById('wireless-wwan-replace-existing').checked = true;
		this.core.openModal('wireless-wwan-connect-modal');
	}

	async connectWirelessWwan() {
		const selectedId = Number(document.getElementById('wireless-wwan-selected-id')?.value || '-1');
		const selected = Number.isFinite(selectedId) ? this.wirelessWwanScanRows[selectedId] || null : null;
		const radio = String(
			document.getElementById('wireless-wwan-connect-radio')?.value ||
			this.wirelessWwanLastScanDevice ||
			document.getElementById('wireless-wwan-device')?.value ||
			''
		).trim();
		const ssid = String(document.getElementById('wireless-wwan-connect-ssid')?.value || '').trim();
		const bssid = String(document.getElementById('wireless-wwan-connect-bssid')?.value || '').trim().toLowerCase();
		const encryptionInput = String(document.getElementById('wireless-wwan-connect-encryption')?.value || 'none').trim();
		const key = String(document.getElementById('wireless-wwan-connect-key')?.value || '');
		const replaceExisting = Boolean(document.getElementById('wireless-wwan-replace-existing')?.checked);

		if (!radio) {
			this.core.showToast('Select a radio for WWAN uplink', 'error');
			return;
		}
		if (!ssid) {
			this.core.showToast('SSID is required', 'error');
			return;
		}
		if (encryptionInput !== 'none' && !key) {
			this.core.showToast('Password is required for secured networks', 'error');
			return;
		}

		try {
			await this.core.uciSet('network', 'wwan', { proto: 'dhcp' });

			const [wStatus, wResult] = await this.core.uciGet('wireless');
			const wirelessCfg = wStatus === 0 && wResult?.values ? wResult.values : {};
			if (replaceExisting) {
				for (const [section, values] of Object.entries(wirelessCfg)) {
					if (String(values?.['.type'] || '') !== 'wifi-iface') continue;
					if (String(values?.mode || '') !== 'sta') continue;
					const nets = this.normalizeToList(values?.network);
					if (!nets.includes('wwan')) continue;
					await this.core.uciDelete('wireless', section);
				}
			}

			let staSection = null;
			for (const [section, values] of Object.entries(wirelessCfg)) {
				if (String(values?.['.type'] || '') !== 'wifi-iface') continue;
				if (String(values?.mode || '') !== 'sta') continue;
				const nets = this.normalizeToList(values?.network);
				if (nets.includes('wwan')) {
					staSection = section;
					break;
				}
			}

			if (!staSection) {
				const [addStatus, addResult] = await this.core.uciAdd('wireless', 'wifi-iface', 'moci_wwan');
				if (addStatus !== 0 || !addResult?.section) throw new Error('Failed to create STA section');
				staSection = addResult.section;
			}

			const encObj = selected && selected.rawEncryption && typeof selected.rawEncryption === 'object' ? selected.rawEncryption : null;
			const auth = encObj ? this.normalizeToList(encObj.authentication).map(v => v.toLowerCase()) : [];
			const wpa = encObj ? this.normalizeToList(encObj.wpa).map(v => Number(v) || 0) : [];
			const isWep = Boolean(encObj && Array.isArray(encObj.wep));
			const isSae = Boolean(encObj && auth.includes('sae'));
			const isPsk = Boolean(encObj && auth.includes('psk'));

			let finalEncryption = encryptionInput;
			const staValues = {
				device: radio,
				network: 'wwan',
				mode: selected?.mode === 'Ad-Hoc' ? 'adhoc' : 'sta',
				ssid,
				disabled: '0'
			};

			if (isSae) {
				finalEncryption = 'sae';
				staValues.key = key;
			} else if (isPsk) {
				finalEncryption = wpa.includes(2) ? 'psk2' : 'psk';
				staValues.key = key;
			} else if (isWep) {
				finalEncryption = 'wep-open';
				staValues.key = '1';
				staValues.key1 = key;
			} else if (encryptionInput === 'none') {
				finalEncryption = 'none';
			}
			staValues.encryption = finalEncryption;

			const effectiveBssid =
				bssid && /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(bssid)
					? bssid
					: String(selected?.bssid || '').match(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/)
						? String(selected.bssid)
						: '';
			if (effectiveBssid) staValues.bssid = effectiveBssid;

			const channelValue = selected?.channelNum && selected.channelNum > 0 ? String(selected.channelNum) : '';
			await this.core.uciSet('wireless', staSection, staValues);
			if (channelValue) {
				await this.core.uciSet('wireless', radio, { channel: channelValue });
			}
			await this.ensureWwanFirewallZone();

			await this.core.uciCommit('network');
			await this.core.uciCommit('wireless');
			await this.core.uciCommit('firewall');

			await this.core.ubusCall('file', 'exec', {
				command: '/bin/sh',
				params: ['-c', 'wifi reload; /etc/init.d/network restart >/dev/null 2>&1 || true; /etc/init.d/firewall restart >/dev/null 2>&1 || true']
			});

			this.core.closeModal('wireless-wwan-connect-modal');
			this.core.showToast(`WWAN uplink connected to ${ssid}`, 'success');
			await this.loadWirelessWwanPanel();
		} catch (err) {
			console.error('Failed to connect WWAN uplink:', err);
			this.core.showToast('Failed to connect WWAN uplink', 'error');
		}
	}

	renderWirelessStatusBadge(enabled) {
		if (!this.core.isFeatureEnabled('colorful_graphs')) {
			return this.core.renderBadge(enabled ? 'success' : 'error', enabled ? 'ENABLED' : 'DISABLED');
		}
		return `<span class="badge ${enabled ? 'badge-interface-up' : 'badge-interface-down'}">${enabled ? 'ENABLED' : 'DISABLED'}</span>`;
	}

	renderWirelessActionButtons(section) {
		const id = this.core.escapeHtml(String(section || ''));
		return `<button class="action-btn-sm" data-action="edit" data-id="${id}">EDIT</button><button class="action-btn-sm" data-action="qr" data-id="${id}">QR</button><button class="action-btn-sm danger" data-action="delete" data-id="${id}">DELETE</button>`;
	}

	escapeWifiQrValue(value) {
		return String(value || '')
			.replace(/\\/g, '\\\\')
			.replace(/;/g, '\\;')
			.replace(/,/g, '\\,')
			.replace(/:/g, '\\:')
			.replace(/"/g, '\\"');
	}

	buildWifiQrPayload(wifi) {
		const ssid = this.escapeWifiQrValue(wifi?.ssid || '');
		const password = this.escapeWifiQrValue(wifi?.password === 'N/A' ? '' : wifi?.password || '');
		const encryption = String(wifi?.encryption || 'none').toLowerCase();
		if (!ssid) return '';
		if (encryption === 'none' || !password) {
			return `WIFI:T:nopass;S:${ssid};H:false;;`;
		}
		return `WIFI:T:WPA;S:${ssid};P:${password};H:false;;`;
	}

	async buildWirelessQrImageSource(payload) {
		if (!payload) return '';
		try {
			const cmd = `if command -v qrencode >/dev/null 2>&1; then printf %s ${this.shellQuote(payload)} | qrencode -o - -t PNG 2>/dev/null | base64 | tr -d '\\n'; fi`;
			const [status, result] = await this.core.ubusCall(
				'file',
				'exec',
				{ command: '/bin/sh', params: ['-c', cmd] },
				{ timeout: 15000 }
			);
			const b64 = status === 0 ? String(result?.stdout || '').trim() : '';
			if (b64) return `data:image/png;base64,${b64}`;
		} catch {}
		return `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(payload)}`;
	}

	async openWirelessQr(section) {
		const row = this.wirelessBySection.get(String(section || ''));
		if (!row) {
			this.core.showToast('Wireless entry not found', 'error');
			return;
		}

		const payload = this.buildWifiQrPayload(row);
		if (!payload) {
			this.core.showToast('SSID is missing for this entry', 'error');
			return;
		}

		const ssidEl = document.getElementById('wireless-qr-ssid');
		const imgEl = document.getElementById('wireless-qr-image');
		const noteEl = document.getElementById('wireless-qr-note');
		if (!ssidEl || !imgEl || !noteEl) return;

		ssidEl.textContent = `SSID: ${row.ssid || 'N/A'}`;
		imgEl.src = '';
		noteEl.textContent = 'Generating QR...';
		this.core.openModal('wireless-qr-modal');

		const qrSrc = await this.buildWirelessQrImageSource(payload);
		imgEl.src = qrSrc;
		noteEl.textContent = qrSrc.startsWith('data:image/')
			? 'Scan with phone camera to join Wi-Fi.'
			: 'Scan with phone camera to join Wi-Fi. (Internet required for QR image service)';
	}

	async editWireless(id) {
		try {
			const [status, result] = await this.core.uciGet('wireless', id);
			if (status !== 0 || !result?.values) throw new Error('Not found');
			const c = result.values;
			document.getElementById('edit-wifi-section').value = id;
			document.getElementById('edit-wifi-radio').value = c.device || '';
			document.getElementById('edit-wifi-ssid').value = c.ssid || '';
			document.getElementById('edit-wifi-encryption').value = c.encryption || 'none';
			document.getElementById('edit-wifi-key').value = c.key || '';
			document.getElementById('edit-wifi-disabled').value = c.disabled || '0';
			document.getElementById('edit-wifi-hidden').value = c.hidden || '0';

			const radioSection = c.device;
			if (radioSection) {
				const [rs, rr] = await this.core.uciGet('wireless', radioSection);
				if (rs === 0 && rr?.values) {
					document.getElementById('edit-wifi-channel').value = rr.values.channel || 'auto';
					document.getElementById('edit-wifi-txpower').value = rr.values.txpower || '';
				}
			}
			this.core.openModal('wireless-modal');
		} catch {
			this.core.showToast('Failed to load wireless config', 'error');
		}
	}

	async saveWireless() {
		const section = document.getElementById('edit-wifi-section').value;
		const radio = document.getElementById('edit-wifi-radio').value;
		const values = {
			ssid: document.getElementById('edit-wifi-ssid').value,
			encryption: document.getElementById('edit-wifi-encryption').value,
			disabled: document.getElementById('edit-wifi-disabled').value,
			hidden: document.getElementById('edit-wifi-hidden').value
		};
		const key = document.getElementById('edit-wifi-key').value;
		if (key && values.encryption !== 'none') values.key = key;

		try {
			await this.core.uciSet('wireless', section, values);
			if (radio) {
				const radioValues = {};
				const channel = document.getElementById('edit-wifi-channel').value;
				const txpower = document.getElementById('edit-wifi-txpower').value;
				if (channel) radioValues.channel = channel;
				if (txpower) radioValues.txpower = txpower;
				if (Object.keys(radioValues).length) {
					await this.core.uciSet('wireless', radio, radioValues);
				}
			}
			await this.core.uciCommit('wireless');
			this.core.closeModal('wireless-modal');
			this.core.showToast('Wireless settings saved', 'success');
			this.loadWireless();
		} catch {
			this.core.showToast('Failed to save wireless config', 'error');
		}
	}

	async deleteWireless(id) {
		if (!confirm('Delete this wireless interface?')) return;
		try {
			await this.core.uciDelete('wireless', id);
			await this.core.uciCommit('wireless');
			this.core.showToast('Wireless interface deleted', 'success');
			this.loadWireless();
		} catch {
			this.core.showToast('Failed to delete wireless interface', 'error');
		}
	}

	async loadFirewall() {
		await this.core.loadResource('firewall-table', 7, 'firewall', async () => {
			const [status, result] = await this.core.uciGet('firewall');
			if (status !== 0 || !result?.values) throw new Error('No data');
			const config = result.values;

			const forwards = Object.entries(config)
				.filter(([, v]) => v['.type'] === 'redirect')
				.map(([k, v]) => ({ section: k, ...v }));

			const rules = Object.entries(config)
				.filter(([, v]) => v['.type'] === 'rule')
				.map(([k, v]) => ({ section: k, ...v }));

			const fwTbody = document.querySelector('#firewall-table tbody');
			if (fwTbody) {
				if (forwards.length === 0) {
					this.core.renderEmptyTable(fwTbody, 7, 'No port forwarding rules');
				} else {
					fwTbody.innerHTML = forwards
						.map(
							f => `<tr>
						<td data-label="Name">${this.core.escapeHtml(f.name || f.section)}</td>
						<td data-label="Protocol">${this.core.escapeHtml(f.proto || 'tcp')}</td>
						<td data-label="External Port">${this.core.escapeHtml(f.src_dport || 'N/A')}</td>
						<td data-label="Internal IP">${this.core.escapeHtml(f.dest_ip || 'N/A')}</td>
						<td data-label="Internal Port">${this.core.escapeHtml(f.dest_port || f.src_dport || 'N/A')}</td>
						<td data-label="Enabled">${this.core.renderStatusBadge(f.enabled !== '0')}</td>
						<td data-label="Actions">${this.core.renderActionButtons(f.section)}</td>
					</tr>`
						)
						.join('');
				}
			}

			const rulesTbody = document.querySelector('#fw-rules-table tbody');
			if (rulesTbody) {
				if (rules.length === 0) {
					this.core.renderEmptyTable(rulesTbody, 8, 'No firewall rules');
				} else {
					rulesTbody.innerHTML = rules
						.map(
							r => `<tr>
						<td data-label="Name">${this.core.escapeHtml(r.name || r.section)}</td>
						<td data-label="Source">${this.core.escapeHtml(r.src || 'Any')}</td>
						<td data-label="Source IP">${this.core.escapeHtml(r.src_ip || 'Any')}</td>
						<td data-label="Destination">${this.core.escapeHtml(r.dest || 'Any')}</td>
						<td data-label="Protocol">${this.core.escapeHtml(r.proto || 'Any')}</td>
						<td data-label="Port">${this.core.escapeHtml(r.dest_port || 'Any')}</td>
						<td data-label="Action">${this.renderFirewallTargetBadge(r.target)}</td>
						<td data-label="Actions">${this.core.renderActionButtons(r.section)}</td>
					</tr>`
						)
						.join('');
				}
			}
		});
	}

	renderFirewallTargetBadge(target) {
		const action = String(target || 'DROP').toUpperCase();
		if (!this.core.isFeatureEnabled('colorful_graphs')) {
			return this.core.renderBadge(action === 'ACCEPT' ? 'success' : 'error', action);
		}
		const cls =
			action === 'ACCEPT'
				? 'badge-fw-target-accept'
				: action === 'REJECT' || action === 'DROP'
					? 'badge-fw-target-block'
					: 'badge-fw-target-other';
		return `<span class="badge ${cls}">${this.core.escapeHtml(action)}</span>`;
	}

	async editForward(id) {
		try {
			const [status, result] = await this.core.uciGet('firewall', id);
			if (status !== 0 || !result?.values) throw new Error('Not found');
			const c = result.values;
			await this.loadForwardDeviceOptions();
			document.getElementById('edit-forward-section').value = id;
			document.getElementById('edit-forward-name').value = c.name || '';
			document.getElementById('edit-forward-proto').value = c.proto || 'tcp';
			document.getElementById('edit-forward-src-dport').value = c.src_dport || '';
			document.getElementById('edit-forward-dest-ip').value = c.dest_ip || '';
			document.getElementById('edit-forward-dest-port').value = c.dest_port || '';
			document.getElementById('edit-forward-enabled').value = c.enabled !== '0' ? '1' : '0';
			this.core.openModal('forward-modal');
		} catch {
			this.core.showToast('Failed to load rule', 'error');
		}
	}

	async loadForwardDeviceOptions() {
		const list = document.getElementById('forward-device-list');
		if (!list) return;

		let leases = [];
		try {
			const [status, result] = await this.core.ubusCall('luci-rpc', 'getDHCPLeases', {});
			if (status === 0 && Array.isArray(result?.dhcp_leases)) {
				leases = result.dhcp_leases;
			}
		} catch {}

		const options = leases
			.map(lease => ({
				ip: String(lease.ipaddr || '').trim(),
				hostname: String(lease.hostname || 'Unknown').trim()
			}))
			.filter(item => item.ip)
			.sort((a, b) => a.hostname.localeCompare(b.hostname));

		list.innerHTML = '';
		for (const option of options) {
			const el = document.createElement('option');
			el.value = option.ip;
			el.label = `${option.hostname} (${option.ip})`;
			list.appendChild(el);
		}
	}

	async saveForward() {
		const section = document.getElementById('edit-forward-section').value;
		const values = {
			name: document.getElementById('edit-forward-name').value,
			proto: document.getElementById('edit-forward-proto').value,
			src_dport: document.getElementById('edit-forward-src-dport').value,
			dest_ip: document.getElementById('edit-forward-dest-ip').value,
			dest_port: document.getElementById('edit-forward-dest-port').value,
			enabled: document.getElementById('edit-forward-enabled').value,
			src: 'wan',
			dest: 'lan',
			target: 'DNAT'
		};
		try {
			if (section) {
				await this.core.uciSet('firewall', section, values);
			} else {
				const [, res] = await this.core.uciAdd('firewall', 'redirect');
				if (!res?.section) throw new Error('Failed to create section');
				await this.core.uciSet('firewall', res.section, values);
			}
			await this.core.uciCommit('firewall');
			this.core.closeModal('forward-modal');
			this.core.showToast('Port forward saved', 'success');
			this.loadFirewall();
		} catch {
			this.core.showToast('Failed to save port forward', 'error');
		}
	}

	async deleteForward(id) {
		if (!confirm('Delete this port forwarding rule?')) return;
		try {
			await this.core.uciDelete('firewall', id);
			await this.core.uciCommit('firewall');
			this.core.showToast('Rule deleted', 'success');
			this.loadFirewall();
		} catch {
			this.core.showToast('Failed to delete rule', 'error');
		}
	}

	async editFirewallRule(id) {
		try {
			const [status, result] = await this.core.uciGet('firewall', id);
			if (status !== 0 || !result?.values) throw new Error('Not found');
			const c = result.values;
			document.getElementById('edit-fw-rule-section').value = id;
			document.getElementById('edit-fw-rule-name').value = c.name || '';
			document.getElementById('edit-fw-rule-target').value = c.target || 'ACCEPT';
			document.getElementById('edit-fw-rule-src').value = c.src || '';
			document.getElementById('edit-fw-rule-dest').value = c.dest || '';
			document.getElementById('edit-fw-rule-proto').value = c.proto || '';
			document.getElementById('edit-fw-rule-dest-port').value = c.dest_port || '';
			document.getElementById('edit-fw-rule-src-ip').value = c.src_ip || '';
			document.getElementById('edit-fw-rule-dest-ip').value = c.dest_ip || '';
			this.core.openModal('fw-rule-modal');
		} catch {
			this.core.showToast('Failed to load rule', 'error');
		}
	}

	async saveFirewallRule() {
		const section = document.getElementById('edit-fw-rule-section').value;
		const values = {
			name: document.getElementById('edit-fw-rule-name').value,
			target: document.getElementById('edit-fw-rule-target').value,
			src: document.getElementById('edit-fw-rule-src').value,
			dest: document.getElementById('edit-fw-rule-dest').value,
			proto: document.getElementById('edit-fw-rule-proto').value,
			dest_port: document.getElementById('edit-fw-rule-dest-port').value,
			src_ip: document.getElementById('edit-fw-rule-src-ip').value,
			dest_ip: document.getElementById('edit-fw-rule-dest-ip').value
		};
		try {
			if (section) {
				await this.core.uciSet('firewall', section, values);
			} else {
				const [, res] = await this.core.uciAdd('firewall', 'rule');
				if (!res?.section) throw new Error('Failed to create section');
				await this.core.uciSet('firewall', res.section, values);
			}
			await this.core.uciCommit('firewall');
			this.core.closeModal('fw-rule-modal');
			this.core.showToast('Firewall rule saved', 'success');
			this.loadFirewall();
		} catch {
			this.core.showToast('Failed to save firewall rule', 'error');
		}
	}

	async deleteFirewallRule(id) {
		if (!confirm('Delete this firewall rule?')) return;
		try {
			await this.core.uciDelete('firewall', id);
			await this.core.uciCommit('firewall');
			this.core.showToast('Rule deleted', 'success');
			this.loadFirewall();
		} catch {
			this.core.showToast('Failed to delete rule', 'error');
		}
	}

	async loadDHCP() {
		await this.core.loadResource('dhcp-leases-table', 4, 'dhcp', async () => {
			let leases = [];
			try {
				const [s, r] = await this.core.ubusCall('luci-rpc', 'getDHCPLeases', {});
				if (s === 0 && r?.dhcp_leases) leases = r.dhcp_leases;
			} catch {}

			const leasesTbody = document.querySelector('#dhcp-leases-table tbody');
			if (leasesTbody) {
				if (leases.length === 0) {
					this.core.renderEmptyTable(leasesTbody, 4, 'No active DHCP leases');
				} else {
					leasesTbody.innerHTML = leases
						.map(
							l => `<tr>
						<td data-label="Hostname">${this.core.escapeHtml(l.hostname || 'Unknown')}</td>
						<td data-label="IP Address">${this.core.escapeHtml(l.ipaddr || 'N/A')}</td>
						<td data-label="MAC Address">${this.core.escapeHtml(l.macaddr || 'N/A')}</td>
						<td data-label="Expires">${l.expires > 0 ? l.expires + 's' : 'Permanent'}</td>
					</tr>`
						)
						.join('');
				}
			}

			const [status, result] = await this.core.uciGet('dhcp');
			if (status !== 0 || !result?.values) return;

			const statics = Object.entries(result.values)
				.filter(([, v]) => v['.type'] === 'host')
				.map(([k, v]) => ({ section: k, ...v }));

			const staticTbody = document.querySelector('#dhcp-static-table tbody');
			if (staticTbody) {
				if (statics.length === 0) {
					this.core.renderEmptyTable(staticTbody, 4, 'No static leases');
				} else {
					staticTbody.innerHTML = statics
						.map(s => {
							const hasStaticIp = Boolean(String(s.ip || '').trim());
							const ipCell = hasStaticIp
								? this.core.escapeHtml(s.ip)
								: `<span title="No static IP assigned; this entry only sets the device hostname." style="text-decoration: underline; text-underline-offset: 2px; cursor: help; color: var(--steel-light);">N/A</span>`;
							return `<tr>
						<td data-label="Hostname">${this.core.escapeHtml(s.name || 'N/A')}</td>
						<td data-label="MAC Address">${this.core.escapeHtml(s.mac || 'N/A')}</td>
						<td data-label="IP Address">${ipCell}</td>
						<td data-label="Actions">${this.core.renderActionButtons(s.section)}</td>
					</tr>`;
						})
						.join('');
				}
			}
		});
	}

	async editStaticLease(id) {
		try {
			const [status, result] = await this.core.uciGet('dhcp', id);
			if (status !== 0 || !result?.values) throw new Error('Not found');
			const c = result.values;
			document.getElementById('edit-static-lease-section').value = id;
			document.getElementById('edit-static-lease-name').value = c.name || '';
			document.getElementById('edit-static-lease-mac').value = c.mac || '';
			document.getElementById('edit-static-lease-ip').value = c.ip || '';
			this.core.openModal('static-lease-modal');
		} catch {
			this.core.showToast('Failed to load static lease', 'error');
		}
	}

	async saveStaticLease() {
		const section = document.getElementById('edit-static-lease-section').value;
		const values = {
			name: document.getElementById('edit-static-lease-name').value,
			mac: document.getElementById('edit-static-lease-mac').value,
			ip: document.getElementById('edit-static-lease-ip').value
		};
		try {
			if (section) {
				await this.core.uciSet('dhcp', section, values);
			} else {
				const [, res] = await this.core.uciAdd('dhcp', 'host');
				if (!res?.section) throw new Error('Failed to create section');
				await this.core.uciSet('dhcp', res.section, values);
			}
			await this.core.uciCommit('dhcp');
			this.core.closeModal('static-lease-modal');
			this.core.showToast('Static lease saved', 'success');
			this.loadDHCP();
		} catch {
			this.core.showToast('Failed to save static lease', 'error');
		}
	}

	async deleteStaticLease(id) {
		if (!confirm('Delete this static lease?')) return;
		try {
			await this.core.uciDelete('dhcp', id);
			await this.core.uciCommit('dhcp');
			this.core.showToast('Static lease deleted', 'success');
			this.loadDHCP();
		} catch {
			this.core.showToast('Failed to delete static lease', 'error');
		}
	}

	async loadDNS() {
		await this.core.loadResource('dns-entries-table', 3, 'dns', async () => {
			const [status, result] = await this.core.uciGet('dhcp');
			if (status === 0 && result?.values) {
				const domains = Object.entries(result.values)
					.filter(([, v]) => v['.type'] === 'domain')
					.map(([k, v]) => ({ section: k, ...v }));

				const dnsTbody = document.querySelector('#dns-entries-table tbody');
				if (dnsTbody) {
					if (domains.length === 0) {
						this.core.renderEmptyTable(dnsTbody, 3, 'No custom DNS entries');
					} else {
						dnsTbody.innerHTML = domains
							.map(
								d => `<tr>
							<td data-label="Hostname">${this.core.escapeHtml(d.name || 'N/A')}</td>
							<td data-label="IP Address">${this.core.escapeHtml(d.ip || 'N/A')}</td>
							<td data-label="Actions">${this.core.renderActionButtons(d.section)}</td>
						</tr>`
							)
							.join('');
					}
				}
			}

			try {
				const [hs, hr] = await this.core.ubusCall('file', 'read', { path: '/etc/hosts' });
				if (hs === 0 && hr?.data) {
					this.hostsRaw = hr.data;
					const entries = this.parseHosts(hr.data);
					const hostsTbody = document.querySelector('#hosts-table tbody');
					if (hostsTbody) {
						if (entries.length === 0) {
							this.core.renderEmptyTable(hostsTbody, 3, 'No hosts entries');
						} else {
							hostsTbody.innerHTML = entries
								.map(
									(e, i) => `<tr>
								<td data-label="IP Address">${this.core.escapeHtml(e.ip)}</td>
								<td data-label="Hostnames">${this.core.escapeHtml(e.names)}</td>
								<td data-label="Actions">${this.core.renderActionButtons(String(i))}</td>
							</tr>`
								)
								.join('');
						}
					}
				}
			} catch {}
		});
	}

	parseHosts(data) {
		return data
			.split('\n')
			.filter(l => l.trim() && !l.trim().startsWith('#'))
			.map(l => {
				const parts = l.trim().split(/\s+/);
				return { ip: parts[0], names: parts.slice(1).join(' ') };
			})
			.filter(e => e.ip && e.names);
	}

	async editDnsEntry(id) {
		try {
			const [status, result] = await this.core.uciGet('dhcp', id);
			if (status !== 0 || !result?.values) throw new Error('Not found');
			const c = result.values;
			document.getElementById('edit-dns-entry-section').value = id;
			document.getElementById('edit-dns-hostname').value = c.name || '';
			document.getElementById('edit-dns-ip').value = c.ip || '';
			this.core.openModal('dns-entry-modal');
		} catch {
			this.core.showToast('Failed to load DNS entry', 'error');
		}
	}

	async saveDnsEntry() {
		const section = document.getElementById('edit-dns-entry-section').value;
		const values = {
			name: document.getElementById('edit-dns-hostname').value,
			ip: document.getElementById('edit-dns-ip').value
		};
		try {
			if (section) {
				await this.core.uciSet('dhcp', section, values);
			} else {
				const [, res] = await this.core.uciAdd('dhcp', 'domain');
				if (!res?.section) throw new Error('Failed to create section');
				await this.core.uciSet('dhcp', res.section, values);
			}
			await this.core.uciCommit('dhcp');
			this.core.closeModal('dns-entry-modal');
			this.core.showToast('DNS entry saved', 'success');
			this.loadDNS();
		} catch {
			this.core.showToast('Failed to save DNS entry', 'error');
		}
	}

	async deleteDnsEntry(id) {
		if (!confirm('Delete this DNS entry?')) return;
		try {
			await this.core.uciDelete('dhcp', id);
			await this.core.uciCommit('dhcp');
			this.core.showToast('DNS entry deleted', 'success');
			this.loadDNS();
		} catch {
			this.core.showToast('Failed to delete DNS entry', 'error');
		}
	}

	editHostEntry(index) {
		const entries = this.parseHosts(this.hostsRaw);
		const entry = entries[parseInt(index)];
		if (!entry) return;
		document.getElementById('edit-host-entry-index').value = index;
		document.getElementById('edit-host-ip').value = entry.ip;
		document.getElementById('edit-host-names').value = entry.names;
		this.core.openModal('host-entry-modal');
	}

	async saveHostEntry() {
		const index = document.getElementById('edit-host-entry-index').value;
		const ip = document.getElementById('edit-host-ip').value.trim();
		const names = document.getElementById('edit-host-names').value.trim();
		if (!ip || !names) {
			this.core.showToast('IP and hostnames are required', 'error');
			return;
		}

		const lines = this.hostsRaw.split('\n');
		const dataIndices = lines.map((l, i) => (l.trim() && !l.trim().startsWith('#') ? i : -1)).filter(i => i >= 0);

		if (index !== '') {
			const origIdx = dataIndices[parseInt(index)];
			if (origIdx !== undefined) lines[origIdx] = `${ip}\t${names}`;
		} else {
			if (lines.length && lines[lines.length - 1] === '') lines.pop();
			lines.push(`${ip}\t${names}`);
		}

		const newContent = lines.join('\n') + (this.hostsRaw.endsWith('\n') ? '' : '\n');
		try {
			await this.core.ubusCall('file', 'write', { path: '/etc/hosts', data: newContent });
			this.core.closeModal('host-entry-modal');
			this.core.showToast('Hosts entry saved', 'success');
			this.loadDNS();
		} catch {
			this.core.showToast('Failed to save hosts entry', 'error');
		}
	}

	async deleteHostEntry(index) {
		if (!confirm('Delete this hosts entry?')) return;
		const lines = this.hostsRaw.split('\n');
		const dataIndices = lines.map((l, i) => (l.trim() && !l.trim().startsWith('#') ? i : -1)).filter(i => i >= 0);
		const origIdx = dataIndices[parseInt(index)];
		if (origIdx !== undefined) lines.splice(origIdx, 1);
		const newContent = lines.join('\n') + (this.hostsRaw.endsWith('\n') ? '' : '\n');
		try {
			await this.core.ubusCall('file', 'write', { path: '/etc/hosts', data: newContent });
			this.core.showToast('Hosts entry deleted', 'success');
			this.loadDNS();
		} catch {
			this.core.showToast('Failed to delete hosts entry', 'error');
		}
	}

	async loadQuarantine() {
		await this.core.loadResource('quarantine-table', 4, 'quarantine', async () => {
			const intervalInput = document.getElementById('quarantine-interval');
			const serviceEl = document.getElementById('quarantine-service-status');
			const bootEl = document.getElementById('quarantine-boot-status');
			const featureEl = document.getElementById('quarantine-feature-status');
			const tbody = document.querySelector('#quarantine-table tbody');
			if (!intervalInput || !serviceEl || !bootEl || !featureEl || !tbody) return;

			let quarantineEnabled = false;
			let featureEnabled = this.core.isFeatureEnabled('quarantine');

			try {
				const [status, result] = await this.core.uciGet('moci', 'quarantine');
				if (status === 0 && result?.values) {
					const interval = Number(result.values.interval || 15);
					intervalInput.value = String(Number.isFinite(interval) ? Math.max(10, Math.min(3600, interval)) : 15);
					quarantineEnabled = String(result.values.enabled ?? '0') === '1';
				} else {
					intervalInput.value = '15';
				}
			} catch {
				intervalInput.value = '15';
			}

			try {
				const [status, result] = await this.core.uciGet('moci', 'features');
				if (status === 0 && result?.values) {
					featureEnabled = String(result.values.quarantine ?? '1') === '1';
				}
			} catch {}

			featureEl.innerHTML = featureEnabled && quarantineEnabled
				? this.core.renderBadge('success', 'ENABLED')
				: this.core.renderBadge('error', 'DISABLED');

			if (!featureEnabled || !quarantineEnabled) {
				serviceEl.innerHTML = this.core.renderBadge('error', 'DISABLED');
			} else {
				try {
					const [s, r] = await this.core.ubusCall('file', 'exec', {
						command: '/bin/sh',
						params: ['-c', 'pgrep -f moci-device-quarantine >/dev/null && echo RUNNING || echo STOPPED']
					});
					const running = s === 0 && String(r?.stdout || '').trim() === 'RUNNING';
					serviceEl.innerHTML = running
						? this.core.renderBadge('success', 'RUNNING')
						: this.core.renderBadge('error', 'STOPPED');
				} catch {
					serviceEl.innerHTML = this.core.renderBadge('error', 'UNKNOWN');
				}
			}

			try {
				const [s, r] = await this.core.ubusCall('file', 'exec', {
					command: '/bin/sh',
					params: ['-c', '/etc/init.d/moci-device-quarantine enabled >/dev/null 2>&1 && echo ENABLED || echo DISABLED']
				});
				const enabled = s === 0 && String(r?.stdout || '').trim() === 'ENABLED';
				bootEl.innerHTML = enabled
					? this.core.renderBadge('success', 'ENABLED')
					: this.core.renderBadge('error', 'DISABLED');
			} catch {
				bootEl.innerHTML = this.core.renderBadge('error', 'UNKNOWN');
			}

				const rows = await this.readQuarantineRules();
				const activeRows = rows.filter(row => Boolean(row?.enabled));
				if (activeRows.length === 0) {
					this.core.renderEmptyTable(tbody, 6, 'No quarantined devices');
					return;
				}

			tbody.innerHTML = activeRows
				.map(row => {
					const statusBadge = row.enabled
						? this.core.renderBadge('error', 'BLOCKED')
						: this.core.renderBadge('success', 'RELEASED');
						const releaseId = encodeURIComponent(row.base || '');
						return `<tr>
							<td>${this.core.escapeHtml(row.base || row.name || 'N/A')}</td>
							<td>${this.core.escapeHtml(row.hostname || 'Unknown')}</td>
							<td>${this.core.escapeHtml(row.ip || 'N/A')}</td>
							<td>${this.core.escapeHtml(row.mac || 'N/A')}</td>
							<td>${statusBadge}</td>
							<td><button class="action-btn-sm" data-action="release" data-id="${releaseId}">RELEASE</button></td>
						</tr>`;
					})
				.join('');
		});
	}

	async readQuarantineRules() {
		const rows = [];
		try {
			const leaseByMac = new Map();
			try {
				const [ls, lr] = await this.core.ubusCall('luci-rpc', 'getDHCPLeases', {});
				if (ls === 0 && Array.isArray(lr?.dhcp_leases)) {
					for (const lease of lr.dhcp_leases) {
						const mac = String(lease?.macaddr || '')
							.trim()
							.toLowerCase();
						if (!mac) continue;
						leaseByMac.set(mac, {
							ip: String(lease?.ipaddr || '').trim(),
							hostname: String(lease?.hostname || '').trim()
						});
					}
				}
			} catch {}

			let rulePrefix = 'moci_quarantine_';
			try {
				const [qs, qr] = await this.core.uciGet('moci', 'quarantine');
				if (qs === 0 && qr?.values?.rule_prefix) {
					const candidate = String(qr.values.rule_prefix || '').trim();
					if (candidate) rulePrefix = candidate;
				}
			} catch {}

			const [status, result] = await this.core.uciGet('firewall');
			if (status !== 0 || !result?.values) return rows;

			const grouped = new Map();
			for (const [section, cfg] of Object.entries(result.values)) {
				if (String(cfg?.['.type'] || '') !== 'rule') continue;
				const name = String(cfg?.name || '').trim();
				if (!name.startsWith(rulePrefix)) continue;
				const base = name.replace(/_(lan|wan)$/i, '');
				const entry = grouped.get(base) || {
					base,
					name,
					mac: String(cfg?.src_mac || ''),
					srcIp: String(cfg?.src_ip || ''),
					hostname: '',
					ip: '',
					enabled: false,
					sections: []
				};
				entry.sections.push(section);
				entry.enabled = entry.enabled || String(cfg?.enabled ?? '1') !== '0';
				if (!entry.mac) entry.mac = String(cfg?.src_mac || '');
				if (!entry.srcIp) entry.srcIp = String(cfg?.src_ip || '');
				const macKey = String(entry.mac || '')
					.trim()
					.toLowerCase();
				const lease = macKey ? leaseByMac.get(macKey) : null;
				if (lease) {
					if (!entry.ip && lease.ip) entry.ip = lease.ip;
					if (!entry.hostname && lease.hostname && lease.hostname !== '*') entry.hostname = lease.hostname;
				}
				if (!entry.ip && entry.srcIp) entry.ip = entry.srcIp;
				if (!entry.hostname) {
					let hostGuess = String(base || '');
					if (hostGuess.startsWith(rulePrefix)) hostGuess = hostGuess.slice(rulePrefix.length);
					hostGuess = hostGuess.replace(/_(lan|wan)$/i, '').replace(/_/g, ' ').trim();
					entry.hostname = hostGuess || 'Unknown';
				}
				grouped.set(base, entry);
			}

			rows.push(...Array.from(grouped.values()).sort((a, b) => a.base.localeCompare(b.base)));
		} catch {}
		return rows;
	}

	async saveQuarantineSettings(enableFlag) {
		const interval = this.getQuarantineIntervalValue();
		if (interval == null) return;
		const enabled = Boolean(enableFlag) ? '1' : '0';

		try {
			await this.core.uciSet('moci', 'quarantine', {
				enabled,
				interval: String(interval)
			});
			await this.core.uciCommit('moci');

			await this.core.ubusCall('file', 'exec', {
				command: '/bin/sh',
				params: [
					'-c',
					enableFlag
						? '/etc/init.d/moci-device-quarantine enable 2>/dev/null || true; /etc/init.d/moci-device-quarantine restart 2>/dev/null || /etc/init.d/moci-device-quarantine start 2>/dev/null || true'
						: '/etc/init.d/moci-device-quarantine stop 2>/dev/null || true'
				]
			});

			this.core.showToast(enableFlag ? 'Quarantine enabled' : 'Quarantine disabled', 'success');
			await this.loadQuarantine();
		} catch {
			this.core.showToast('Failed to save quarantine settings', 'error');
		}
	}

	getQuarantineIntervalValue() {
		const intervalInput = document.getElementById('quarantine-interval');
		const interval = Number(intervalInput?.value || 15);
		if (!Number.isFinite(interval) || interval < 10 || interval > 3600) {
			this.core.showToast('Interval must be between 10 and 3600 seconds', 'error');
			return null;
		}
		return Math.round(interval);
	}

	async saveQuarantineInterval() {
		const interval = this.getQuarantineIntervalValue();
		if (interval == null) return;
		try {
			const [status, result] = await this.core.uciGet('moci', 'quarantine');
			const currentEnabled =
				status === 0 && result?.values ? (String(result.values.enabled ?? '0') === '1' ? '1' : '0') : '0';
			await this.core.uciSet('moci', 'quarantine', {
				enabled: currentEnabled,
				interval: String(interval)
			});
			await this.core.uciCommit('moci');
			if (currentEnabled === '1') {
				await this.core.ubusCall('file', 'exec', {
					command: '/bin/sh',
					params: ['-c', '/etc/init.d/moci-device-quarantine restart 2>/dev/null || true']
				});
			}
			this.core.showToast('Quarantine settings saved', 'success');
			await this.loadQuarantine();
		} catch {
			this.core.showToast('Failed to save quarantine settings', 'error');
		}
	}

	async runQuarantineDiscovery() {
		try {
			await this.core.ubusCall(
				'file',
				'exec',
				{
					command: '/usr/bin/moci-device-quarantine',
					params: ['--once']
				},
				{ timeout: 20000 }
			);
			this.core.showToast('Quarantine discovery completed', 'success');
			await this.loadQuarantine();
		} catch {
			this.core.showToast('Failed to run quarantine discovery', 'error');
		}
	}

	async releaseQuarantinedDevice(encodedBase) {
		const base = decodeURIComponent(String(encodedBase || ''));
		if (!base) return;
		if (!confirm('Release this device from quarantine?')) return;

		try {
			const [status, result] = await this.core.uciGet('firewall');
			if (status !== 0 || !result?.values) throw new Error('Unable to read firewall config');

			for (const [section, cfg] of Object.entries(result.values)) {
				if (String(cfg?.['.type'] || '') !== 'rule') continue;
				const name = String(cfg?.name || '').trim();
				if (name === `${base}_lan` || name === `${base}_wan` || name === base) {
					await this.core.uciDelete('firewall', section);
				}
			}
			await this.core.uciCommit('firewall');
			await this.core.ubusCall('file', 'exec', {
				command: '/bin/sh',
				params: ['-c', '/etc/init.d/firewall reload 2>/dev/null || /etc/init.d/firewall restart 2>/dev/null || true']
			});
			this.core.showToast('Device released from quarantine', 'success');
			await new Promise(resolve => setTimeout(resolve, 250));
			await this.loadQuarantine();
		} catch {
			this.core.showToast('Failed to release quarantined device', 'error');
		}
	}

	setAdblockClassicSettingValue(key, value, options = {}) {
		const normalized = String(value || '0') === '1' ? '1' : '0';
		if (key === 'enabled') {
			const input = document.getElementById('adblock-classic-enabled');
			if (input) input.value = normalized;
		} else if (key === 'safesearch') {
			const input = document.getElementById('adblock-classic-safesearch');
			if (input) input.value = normalized;
		}
		if (!options.syncOnly) this.syncAdblockClassicButtons();
	}

	syncAdblockClassicButtons() {
		const enabledValue = String(document.getElementById('adblock-classic-enabled')?.value || '0') === '1';
		const safeSearchValue = String(document.getElementById('adblock-classic-safesearch')?.value || '0') === '1';
		this.syncAdblockTogglePair('adblock-classic-enabled-on-btn', 'adblock-classic-enabled-off-btn', enabledValue);
		this.syncAdblockTogglePair(
			'adblock-classic-safesearch-on-btn',
			'adblock-classic-safesearch-off-btn',
			safeSearchValue
		);
	}

	async runAdblockClassicServiceAction(action) {
		try {
			await this.core.ubusCall('file', 'exec', {
				command: '/etc/init.d/adblock',
				params: [action]
			});
			this.core.showToast(`AdBlock ${action} command executed`, 'success');
			await this.loadAdblockClassic();
		} catch {
			this.core.showToast(`Failed to ${action} AdBlock`, 'error');
		}
	}

	logAdblockClassicDebug(message) {
		const ts = new Date().toLocaleTimeString([], { hour12: false });
		this.adblockClassicDebugLog.push(`[${ts}] ${String(message || '')}`);
		if (this.adblockClassicDebugLog.length > this.adblockClassicDebugLimit) {
			this.adblockClassicDebugLog.splice(0, this.adblockClassicDebugLog.length - this.adblockClassicDebugLimit);
		}
		this.renderAdblockClassicDebugLog();
	}

	clearAdblockClassicDebugLog() {
		this.adblockClassicDebugLog = [];
		this.renderAdblockClassicDebugLog();
	}

	renderAdblockClassicDebugLog() {
		const el = document.getElementById('adblock-classic-debug-log');
		if (!el) return;
		el.textContent = this.adblockClassicDebugLog.length > 0 ? this.adblockClassicDebugLog.join('\n') : 'No debug entries yet';
	}

	getAdblockClassicSelectedFeeds() {
		const select = document.getElementById('adblock-classic-feed-select');
		if (!select) return [];
		return Array.from(select.selectedOptions || [])
			.map(opt => String(opt.value || '').trim())
			.filter(Boolean);
	}

	syncAdblockClassicFeedSummary() {
		const summaryEl = document.getElementById('adblock-classic-feed-selected');
		if (!summaryEl) return;
		const selected = this.getAdblockClassicSelectedFeeds();
		if (selected.length === 0) {
			summaryEl.textContent = 'No sources selected';
			return;
		}
		const shown = selected.slice(0, 6).join(', ');
		const suffix = selected.length > 6 ? ` ... (+${selected.length - 6} more)` : '';
		summaryEl.textContent = `${selected.length} selected: ${shown}${suffix}`;
	}

	parseAdblockClassicSourcesFromText(text) {
		const map = new Map();
		for (const rawLine of String(text || '').split('\n')) {
			const line = String(rawLine || '').trim();
			if (!line || line.startsWith('#')) continue;

			let id = '';
			let label = '';

			let m = line.match(/^config\s+source\s+'?([A-Za-z0-9_.-]+)'?/i);
			if (m) {
				id = String(m[1] || '').trim();
				label = id;
			}
			if (!id) {
				m = line.match(/adb_src_([A-Za-z0-9_.-]+)\s*=/i);
				if (m) {
					id = String(m[1] || '').trim();
					label = id;
				}
			}
			if (!id) {
				m = line.match(/^([A-Za-z0-9_.-]+)\s*[:=]\s*(.+)$/);
				if (m) {
					id = String(m[1] || '').trim();
					label = `${id} (${String(m[2] || '').trim()})`;
				}
			}
			if (!id) {
				m = line.match(/^([A-Za-z0-9_.-]+)\b/);
				if (m) {
					id = String(m[1] || '').trim();
					label = id;
				}
			}
			if (!id) continue;
			if (!map.has(id)) map.set(id, label || id);
		}
		return map;
	}

	async loadAdblockClassicSourceOptions(selectedFeeds = []) {
		const select = document.getElementById('adblock-classic-feed-select');
		if (!select) return;

		const selectedSet = new Set((Array.isArray(selectedFeeds) ? selectedFeeds : []).map(v => String(v || '').trim()).filter(Boolean));
		const sourceMap = new Map();
		for (const id of selectedSet) sourceMap.set(id, id);

		const sourceFiles = [
			'/etc/adblock/adblock.sources',
			'/usr/share/adblock/adblock.sources',
			'/usr/lib/adblock/adblock.sources'
		];
		for (const path of sourceFiles) {
			try {
				const [status, result] = await this.core.ubusCall('file', 'read', { path });
				if (status !== 0 || !result?.data) continue;
				const parsed = this.parseAdblockClassicSourcesFromText(String(result.data || ''));
				for (const [id, label] of parsed.entries()) {
					if (!sourceMap.has(id)) sourceMap.set(id, label || id);
				}
			} catch {}
		}

		try {
			const [status, result] = await this.core.ubusCall('file', 'exec', {
				command: '/bin/sh',
				params: ['-c', 'uci -q show adblock 2>/dev/null | sed -n "s/^adblock\\..*\\.adb_src_\\([^.=]*\\)=.*/\\1/p"']
			});
			if (status === 0 && result?.stdout) {
				for (const raw of String(result.stdout || '').split('\n')) {
					const id = String(raw || '').trim();
					if (!id) continue;
					if (!sourceMap.has(id)) sourceMap.set(id, id);
				}
			}
		} catch {}

		const options = Array.from(sourceMap.entries()).sort((a, b) => String(a[0] || '').localeCompare(String(b[0] || '')));
		select.innerHTML = options.length
			? options
					.map(([id, label]) => {
						const selected = selectedSet.has(id) ? ' selected' : '';
						return `<option value="${this.core.escapeHtml(id)}"${selected}>${this.core.escapeHtml(label || id)}</option>`;
					})
					.join('')
			: '<option value="" disabled>No source catalog found</option>';
		this.syncAdblockClassicFeedSummary();
	}

	async loadAdblockClassic() {
		const serviceStatusEl = document.getElementById('adblock-classic-service-status');
		const configStatusEl = document.getElementById('adblock-classic-config-status');
		const installHintEl = document.getElementById('adblock-classic-install-hint');
		const dnsEl = document.getElementById('adblock-classic-dns');
		const triggerEl = document.getElementById('adblock-classic-trigger');

		if (!this.core.isFeatureEnabled('adblock')) {
			if (serviceStatusEl) serviceStatusEl.innerHTML = this.core.renderBadge('warning', 'DISABLED');
			if (configStatusEl) configStatusEl.innerHTML = this.core.renderBadge('warning', 'DISABLED');
			this.logAdblockClassicDebug('AdBlock feature is disabled in moci.features.adblock');
			return;
		}

		this.core.showSkeleton('adblock-classic-config-card');
		this.syncAdblockClassicSettingsPanel();
		this.renderAdblockClassicDebugLog();
		this.logAdblockClassicDebug('Loading AdBlock classic configuration and report');
		try {
			if (serviceStatusEl) serviceStatusEl.innerHTML = this.core.renderBadge('warning', 'CHECKING');
			if (configStatusEl) configStatusEl.innerHTML = this.core.renderBadge('warning', 'CHECKING');

			let config = null;
			try {
				const [status, result] = await this.core.uciGet('adblock');
				if (status === 0 && result?.values) config = result;
			} catch {}
			if (!config) {
				try {
					const [status, result] = await this.core.ubusCall('file', 'exec', {
						command: '/bin/sh',
						params: ['-c', 'uci -q show adblock 2>/dev/null || true']
					});
					if (status === 0 && result?.stdout) {
						const parsed = this.parseUciShowToConfig(String(result.stdout || ''), 'adblock');
						if (parsed) config = { values: parsed };
					}
				} catch {}
			}

			let sectionName = 'global';
			let sectionCfg = null;
			if (config?.values) {
				for (const [section, cfg] of Object.entries(config.values)) {
					if (String(cfg?.['.type'] || '') === 'adblock' || section === 'global') {
						sectionName = section;
						sectionCfg = cfg;
						break;
					}
				}
			}
			this.adblockClassicSection = sectionName;

			if (sectionCfg) {
				this.setAdblockClassicSettingValue('enabled', this.isEnabledValue(sectionCfg.adb_enabled ?? '0') ? '1' : '0', {
					syncOnly: true
				});
				this.setAdblockClassicSettingValue(
					'safesearch',
					this.isEnabledValue(sectionCfg.adb_safesearch ?? '0') ? '1' : '0',
					{ syncOnly: true }
				);
				if (dnsEl) dnsEl.value = String(sectionCfg.adb_dns || '');
				if (triggerEl) triggerEl.value = String(sectionCfg.adb_trigger || '');
				const feeds = Array.isArray(sectionCfg.adb_feed)
					? sectionCfg.adb_feed
					: String(sectionCfg.adb_feed || '')
							.split(/\s+/)
							.filter(Boolean);
				await this.loadAdblockClassicSourceOptions(feeds);
				if (configStatusEl) configStatusEl.innerHTML = this.core.renderBadge('success', 'CONFIG READY');
				if (installHintEl) installHintEl.classList.add('hidden');
				this.logAdblockClassicDebug(`Config section '${sectionName}' loaded`);
			} else {
				this.setAdblockClassicSettingValue('enabled', '0', { syncOnly: true });
				this.setAdblockClassicSettingValue('safesearch', '0', { syncOnly: true });
				if (dnsEl) dnsEl.value = '';
				if (triggerEl) triggerEl.value = '';
				await this.loadAdblockClassicSourceOptions([]);
				if (configStatusEl) {
					configStatusEl.innerHTML = this.core.renderBadge('error', 'CONFIG MISSING');
				}
				if (installHintEl) installHintEl.classList.remove('hidden');
				this.logAdblockClassicDebug('Config section missing (uci adblock/global not found)');
			}
			this.syncAdblockClassicButtons();
			await this.loadAdblockClassicReportSettings();

			if (serviceStatusEl) {
				try {
					// Prefer ubus service runtime state (matches SYSTEM -> STARTUP and LuCI behavior).
					const [svcStatus, svcResult] = await this.core.ubusCall('service', 'list', { name: 'adblock' });
					const svcInfo = svcStatus === 0 && svcResult ? svcResult.adblock : null;
					const runtimeRunning = Boolean(svcInfo?.instances && Object.keys(svcInfo.instances).length > 0);
					if (runtimeRunning) {
						serviceStatusEl.innerHTML = this.core.renderBadge('success', 'RUNNING');
					}

					// Fallback for platforms where adblock may not expose runtime instances.
					if (!runtimeRunning) {
						const [runStatus, runResult] = await this.core.ubusCall('file', 'exec', {
							command: '/etc/init.d/adblock',
							params: ['running']
						});
						const running = runStatus === 0 && Number(runResult?.code ?? 1) === 0;
						if (running) {
							serviceStatusEl.innerHTML = this.core.renderBadge('success', 'RUNNING');
						}
					}

					if (!runtimeRunning && !String(serviceStatusEl.innerHTML || '').includes('RUNNING')) {
						const configEnabled =
							sectionCfg && this.isEnabledValue(sectionCfg.adb_enabled ?? sectionCfg.enabled ?? '0');
						serviceStatusEl.innerHTML = this.core.renderBadge(
							configEnabled ? 'success' : 'error',
							configEnabled ? 'ENABLED' : 'DISABLED'
						);
					}
					this.logAdblockClassicDebug(`Service status resolved: ${String(serviceStatusEl.textContent || '').trim() || 'unknown'}`);
				} catch {
					serviceStatusEl.innerHTML = this.core.renderBadge('error', 'UNKNOWN');
					this.logAdblockClassicDebug('Failed to resolve adblock service status');
				}
			}
			await this.loadAdblockClassicReport(false);
		} catch (err) {
			console.error('Failed to load classic AdBlock config:', err);
			this.logAdblockClassicDebug(`Error loading classic config: ${err?.message || err}`);
			if (serviceStatusEl) serviceStatusEl.innerHTML = this.core.renderBadge('error', 'ERROR');
			if (configStatusEl) configStatusEl.innerHTML = this.core.renderBadge('error', 'ERROR');
			this.renderAdblockClassicTopStats([]);
			this.renderAdblockClassicLatestDns([]);
		} finally {
			this.core.hideSkeleton('adblock-classic-config-card');
		}
	}

	splitAdblockReportColumns(line) {
		const text = String(line || '').trim();
		if (!text) return [];
		if (text.includes('\t')) {
			return text
				.split('\t')
				.map(v => String(v || '').trim())
				.filter(Boolean);
		}
		return text
			.split(/\s{2,}/)
			.map(v => String(v || '').trim())
			.filter(Boolean);
	}

	parseAdblockClassicReport(raw) {
		const lines = String(raw || '')
			.split('\n')
			.map(v => String(v || '').replace(/\r/g, ''))
			.filter(v => v.trim().length > 0);
		const lower = lines.map(v => v.toLowerCase());

		const topClients = [];
		const topDomains = [];
		const topBlocked = [];
		const dnsRows = [];

		const topIdx = lower.findIndex(v => v.includes('top statistics'));
		if (topIdx >= 0) {
			let i = topIdx + 1;
			while (i < lines.length) {
				const l = lower[i];
				if (l.includes('latest dns requests')) break;
				if (l.startsWith('count') && l.includes('clients')) {
					i += 1;
					continue;
				}
				const cols = this.splitAdblockReportColumns(lines[i]);
				if (cols.length >= 6) {
					if (cols[0] || cols[1]) topClients.push({ count: cols[0] || '', value: cols[1] || '' });
					if (cols[2] || cols[3]) topDomains.push({ count: cols[2] || '', value: cols[3] || '' });
					if (cols[4] || cols[5]) topBlocked.push({ count: cols[4] || '', value: cols[5] || '' });
				}
				i += 1;
			}
		}

		const dnsIdx = lower.findIndex(v => v.includes('latest dns requests'));
		if (dnsIdx >= 0) {
			let i = dnsIdx + 1;
			while (i < lines.length) {
				const l = lower[i];
				if (l.startsWith('date') && l.includes('time') && l.includes('domain')) {
					i += 1;
					continue;
				}
				if (l.startsWith('adblock ') || l.startsWith('powered by ')) break;
				const cols = this.splitAdblockReportColumns(lines[i]);
				if (cols.length >= 8) {
					dnsRows.push({
						date: cols[0] || '',
						time: cols[1] || '',
						client: cols[2] || '',
						iface: cols[3] || '',
						type: cols[4] || '',
						domain: cols[5] || '',
						answer: cols[6] || '',
						action: cols[7] || ''
					});
				}
				i += 1;
			}
		}

		return { topClients, topDomains, topBlocked, dnsRows };
	}

	parseAdblockClassicJsonReport(raw) {
		let data;
		try {
			data = JSON.parse(String(raw || '').trim());
		} catch {
			return { topClients: [], topDomains: [], topBlocked: [], dnsRows: [] };
		}
		if (!data || typeof data !== 'object') return { topClients: [], topDomains: [], topBlocked: [], dnsRows: [] };

		const asArray = value => (Array.isArray(value) ? value : []);
		const normalizeTopEntries = value => {
			if (Array.isArray(value)) {
				return value.map(item => {
					if (item && typeof item === 'object') {
						return {
							name: String(
								item.client ?? item.domain ?? item.address ?? item.name ?? item.value ?? item.addr ?? ''
							),
							count: Number(item.count ?? item.hits ?? item.total ?? 0) || 0
						};
					}
					return { name: String(item || ''), count: 0 };
				});
			}
			if (value && typeof value === 'object') {
				return Object.entries(value).map(([k, v]) => ({
					name: String(k || ''),
					count: Number(v ?? 0) || 0
				}));
			}
			return [];
		};
		const pickArray = (obj, keys) => {
			for (const key of keys) {
				if (Array.isArray(obj?.[key])) return obj[key];
			}
			return [];
		};
		const pickTopEntries = (containers, keys) => {
			for (const container of containers) {
				if (!container || typeof container !== 'object') continue;
				for (const key of keys) {
					if (Object.prototype.hasOwnProperty.call(container, key)) {
						const rows = normalizeTopEntries(container[key]);
						if (rows.length) return rows;
					}
				}
			}
			return [];
		};

		const topSection =
			data.top_statistics || data.top || data.statistics || data.stats || data.report?.top_statistics || null;
		const topContainers = [topSection, data, data.report].filter(Boolean);
		const clients =
			pickTopEntries(topContainers, ['clients', 'top_clients', 'client', 'src', 'sources', 'top_client']) || [];
		const domains =
			pickTopEntries(topContainers, ['domains', 'top_domains', 'domain', 'top_domain']) || [];
		const blocked =
			pickTopEntries(topContainers, ['blocked_domains', 'blocked', 'top_blocked', 'deny', 'blocked_domain']) || [];

		const normalizeTopRow = item => ({
			count: String(item?.count ?? item?.hits ?? item?.total ?? ''),
			value: String(item?.client ?? item?.domain ?? item?.address ?? item?.name ?? item?.value ?? item?.addr ?? '')
		});
		const topClients = clients.map(normalizeTopRow);
		const topDomains = domains.map(normalizeTopRow);
		const topBlocked = blocked.map(normalizeTopRow);

		const dnsCandidates = [
			...asArray(data.latest_dns_requests),
			...asArray(data.latest_requests),
			...asArray(data.requests),
			...asArray(data.dns_requests),
			...asArray(data.report?.latest_dns_requests),
			...asArray(data.report?.requests)
		];
		const dnsRows = dnsCandidates.map(item => {
			const ts = String(item.datetime || item.timestamp || item.ts || '').trim();
			let date = String(item.date || '').trim();
			let time = String(item.time || '').trim();
			if ((!date || !time) && ts) {
				const parts = ts.replace('T', ' ').split(' ');
				if (!date && parts[0]) date = parts[0];
				if (!time && parts[1]) time = parts[1].replace('Z', '');
			}
			return {
				date,
				time,
				client: String(item.client || item.src || item.source || item.ip || '').trim(),
				iface: String(item.interface || item.iface || item.ifname || '').trim(),
				type: String(item.type || item.query_type || item.qtype || '').trim(),
				domain: String(item.domain || item.query || item.qname || '').trim(),
				answer: String(item.answer || item.rc || item.rcode || item.result || item.reply || '').trim(),
				action: String(item.action || item.list_action || item.policy || '').trim()
			};
		});

		return { topClients, topDomains, topBlocked, dnsRows };
	}

	async loadAdblockClassicReportSettings() {
		let maxTop = 10;
		let maxResults = 50;
		try {
			const [status, result] = await this.core.uciGet('moci', 'adblock_report');
			if (status === 0 && result?.values) {
				maxTop = Number(result.values.max_top || maxTop);
				maxResults = Number(result.values.max_results || maxResults);
			}
		} catch {}
		if (!Number.isFinite(maxTop) || maxTop < 1) maxTop = 10;
		if (!Number.isFinite(maxResults) || maxResults < 1) maxResults = 50;
		this.adblockClassicReportMaxTop = Math.min(Math.max(Math.round(maxTop), 1), 500);
		this.adblockClassicReportMaxResults = Math.min(Math.max(Math.round(maxResults), 1), 5000);

		const maxTopEl = document.getElementById('adblock-classic-max-top');
		const maxResultsEl = document.getElementById('adblock-classic-max-results');
		if (maxTopEl) maxTopEl.value = String(this.adblockClassicReportMaxTop);
		if (maxResultsEl) maxResultsEl.value = String(this.adblockClassicReportMaxResults);
	}

	async saveAdblockClassicReportSettings() {
		const maxTopEl = document.getElementById('adblock-classic-max-top');
		const maxResultsEl = document.getElementById('adblock-classic-max-results');
		let maxTop = Number(maxTopEl?.value || 10);
		let maxResults = Number(maxResultsEl?.value || 50);

		if (!Number.isFinite(maxTop) || maxTop < 1) maxTop = 10;
		if (!Number.isFinite(maxResults) || maxResults < 1) maxResults = 50;
		maxTop = Math.min(Math.max(Math.round(maxTop), 1), 500);
		maxResults = Math.min(Math.max(Math.round(maxResults), 1), 5000);

		try {
			const [sectionStatus] = await this.core.uciGet('moci', 'adblock_report');
			if (sectionStatus !== 0) {
				await this.core.uciAdd('moci', 'adblock_report', 'adblock_report');
			}
			await this.core.uciSet('moci', 'adblock_report', {
				max_top: String(maxTop),
				max_results: String(maxResults)
			});
			await this.core.uciCommit('moci');
			this.adblockClassicReportMaxTop = maxTop;
			this.adblockClassicReportMaxResults = maxResults;
			if (maxTopEl) maxTopEl.value = String(maxTop);
			if (maxResultsEl) maxResultsEl.value = String(maxResults);
			this.core.showToast('AdBlock report settings saved', 'success');
			await this.loadAdblockClassicReport(true);
		} catch {
			this.core.showToast('Failed to save AdBlock report settings', 'error');
		}
	}

	renderAdblockClassicTopStats(topClients, topDomains, topBlocked) {
		const tbody = document.querySelector('#adblock-classic-topstats-table tbody');
		if (!tbody) return;
		const limit = this.adblockClassicReportMaxTop || 10;
		const clients = (Array.isArray(topClients) ? topClients : []).slice(0, limit);
		const domains = (Array.isArray(topDomains) ? topDomains : []).slice(0, limit);
		const blocked = (Array.isArray(topBlocked) ? topBlocked : []).slice(0, limit);

		const maxRows = Math.max(clients.length, domains.length, blocked.length);
		if (maxRows === 0) {
			this.core.renderEmptyTable(tbody, 6, 'No top statistics available');
			return;
		}

		const rows = [];
		for (let i = 0; i < maxRows; i += 1) {
			const c = clients[i] || {};
			const d = domains[i] || {};
			const b = blocked[i] || {};
			rows.push(`<tr>
				<td data-label="Client Count">${this.core.escapeHtml(c.count || '')}</td>
				<td data-label="Client">${this.core.escapeHtml(c.value || '')}</td>
				<td data-label="Domain Count">${this.core.escapeHtml(d.count || '')}</td>
				<td data-label="Domain">${this.core.escapeHtml(d.value || '')}</td>
				<td data-label="Blocked Count">${this.core.escapeHtml(b.count || '')}</td>
				<td data-label="Blocked Domain">${this.core.escapeHtml(b.value || '')}</td>
			</tr>`
			);
		}
		tbody.innerHTML = rows.join('');
	}

	renderAdblockClassicLatestDns(rows) {
		const tbody = document.querySelector('#adblock-classic-latestdns-table tbody');
		if (!tbody) return;
		const limit = this.adblockClassicReportMaxResults || 50;
		const data = (Array.isArray(rows) ? rows : []).slice(0, limit);
		if (data.length === 0) {
			this.core.renderEmptyTable(tbody, 6, 'No DNS request rows available');
			return;
		}
		tbody.innerHTML = data
			.map(row => {
				const answer = String(row.answer || '').trim().toUpperCase();
				const derivedAction = answer === 'NX' ? 'Allow' : answer === 'OK' ? 'Block' : '';
				const actionLabel = String(row.action || '').trim() || derivedAction || '-';
				const answerBadge =
					answer === 'NX'
						? this.core.renderBadge('error', 'NX')
						: answer === 'OK'
							? this.core.renderBadge('success', 'OK')
							: this.core.renderBadge('info', answer || 'N/A');
				const actionBtnClass = /^allow/i.test(actionLabel) ? 'action-btn-sm success' : 'action-btn-sm danger';
				const actionButton =
					actionLabel === '-'
						? '-'
						: `<button class="${actionBtnClass}" type="button" disabled style="font-size:11px;padding:4px 8px;line-height:1.2;opacity:0.95;cursor:default">${this.core.escapeHtml(actionLabel)}</button>`;
				return `<tr>
				<td data-label="Date">${this.core.escapeHtml(row.date || '')}</td>
				<td data-label="Time">${this.core.escapeHtml(row.time || '')}</td>
				<td data-label="Client">${this.core.escapeHtml(row.client || '')}</td>
				<td data-label="Domain">${this.core.escapeHtml(row.domain || '')}</td>
				<td data-label="Answer">${answerBadge}</td>
				<td data-label="Action">${actionButton}</td>
			</tr>`
			})
			.join('');
	}

	async loadAdblockClassicReport(forceGenerate = false) {
		const statusEl = document.getElementById('adblock-classic-report-status');
		if (statusEl) {
			statusEl.innerHTML = this.core.renderBadge('warning', forceGenerate ? 'GENERATING REPORT' : 'LOADING');
		}
		this.logAdblockClassicDebug(forceGenerate ? 'Report refresh requested (generate + load)' : 'Report load requested');
		if (forceGenerate) {
			const maxTop = Math.min(Math.max(Number(this.adblockClassicReportMaxTop) || 10, 1), 500);
			const maxResults = Math.min(Math.max(Number(this.adblockClassicReportMaxResults) || 50, 1), 5000);
			this.logAdblockClassicDebug(`Executing report generation (max_top=${maxTop}, max_results=${maxResults})`);
			try {
				await this.core.ubusCall(
					'file',
					'exec',
					{
						command: '/bin/sh',
						params: [
							'-c',
							`/etc/init.d/adblock report gen ${maxTop} ${maxResults} >/dev/null 2>&1 || /etc/init.d/adblock report gen >/dev/null 2>&1 || true`
						]
					},
					{ timeout: 30000 }
				);
			} catch {}
		}

		try {
			const report = await this.readAdblockClassicReportFile();
			const reportRaw = String(report?.raw || '');
			this.logAdblockClassicDebug(`Report source: ${report?.path || 'none'}`);
			this.logAdblockClassicDebug(`Report payload length=${reportRaw.length}`);
			if (!reportRaw.trim()) {
				if (statusEl) statusEl.innerHTML = this.core.renderBadge('error', 'REPORT MISSING');
				this.logAdblockClassicDebug('Report file missing or empty (checked /tmp/adblock-Report and /tmp/adblock-report)');
				this.renderAdblockClassicTopStats([], [], []);
				this.renderAdblockClassicLatestDns([]);
				return;
			}

			const parsed = reportRaw.trim().startsWith('{')
				? this.parseAdblockClassicJsonReport(reportRaw)
				: this.parseAdblockClassicReport(reportRaw);
			const dnsRows = Array.isArray(parsed.dnsRows) ? parsed.dnsRows : [];
			this.renderAdblockClassicTopStats(parsed.topClients, parsed.topDomains, parsed.topBlocked);
			this.renderAdblockClassicLatestDns(dnsRows);
			this.logAdblockClassicDebug(
				`Parsed report rows: clients=${parsed.topClients?.length || 0}, domains=${parsed.topDomains?.length || 0}, blocked=${parsed.topBlocked?.length || 0}, dns=${dnsRows?.length || 0}`
			);
			if (statusEl) {
				const totalTopRows =
					(parsed.topClients?.length || 0) + (parsed.topDomains?.length || 0) + (parsed.topBlocked?.length || 0);
				statusEl.innerHTML = this.core.renderBadge(
					'success',
					`READY · ${totalTopRows} top rows · ${dnsRows.length} dns rows`
				);
			}
		} catch (err) {
			this.logAdblockClassicDebug(`Failed to load report: ${err?.message || err}`);
			if (statusEl) statusEl.innerHTML = this.core.renderBadge('error', 'FAILED TO LOAD REPORT');
			this.renderAdblockClassicTopStats([], [], []);
			this.renderAdblockClassicLatestDns([]);
		}
	}

	async readAdblockClassicReportFile() {
		const paths = [
			'/tmp/adblock-Report/adb_report.json',
			'/tmp/adblock-Report/adb_report.jsn',
			'/tmp/adblock-report/adb_report.json',
			'/tmp/adblock-report/adb_report.jsn',
			'/tmp/adblock-Report',
			'/tmp/adblock-report'
		];

		for (const path of paths) {
			try {
				const [status, result] = await this.core.ubusCall('file', 'read', { path });
				if (status !== 0 || !result?.data) continue;
				const raw = String(result.data || '');
				if (!raw.trim()) continue;
				return { path, raw };
			} catch {}
		}

		const cmd =
			'for f in ' +
			'/tmp/adblock-Report/adb_report.json ' +
			'/tmp/adblock-Report/adb_report.jsn ' +
			'/tmp/adblock-report/adb_report.json ' +
			'/tmp/adblock-report/adb_report.jsn ' +
			'/tmp/adblock-Report ' +
			'/tmp/adblock-report; ' +
			'do if [ -s "$f" ] && [ ! -d "$f" ]; then echo "__PATH__:$f"; cat "$f"; break; fi; done';
		try {
			const [status, result] = await this.core.ubusCall(
				'file',
				'exec',
				{
					command: '/bin/sh',
					params: ['-c', cmd]
				},
				{ timeout: 20000 }
			);
			if (status !== 0) return { path: '', raw: '' };
			const raw = String(result?.stdout || '');
			if (!raw.trim()) return { path: '', raw: '' };
			const lines = raw.split('\n');
			let path = '';
			if (lines[0] && lines[0].startsWith('__PATH__:')) {
				path = lines[0].replace('__PATH__:', '').trim();
				lines.shift();
			}
			return { path, raw: lines.join('\n') };
		} catch {
			return { path: '', raw: '' };
		}
	}

	async saveAdblockClassicSettings() {
		const enabled = String(document.getElementById('adblock-classic-enabled')?.value || '0') === '1' ? '1' : '0';
		const safesearch = String(document.getElementById('adblock-classic-safesearch')?.value || '0') === '1' ? '1' : '0';
		const dns = String(document.getElementById('adblock-classic-dns')?.value || '').trim();
		const trigger = String(document.getElementById('adblock-classic-trigger')?.value || '').trim();
		const feeds = Array.from(new Set(this.getAdblockClassicSelectedFeeds()));

		try {
			let section = this.adblockClassicSection || 'global';
			const [status, result] = await this.core.uciGet('adblock', section);
			if (status !== 0 || !result?.values) {
				const [addStatus, addResult] = await this.core.uciAdd('adblock', 'adblock', 'global');
				if (addStatus !== 0 || !addResult?.section) throw new Error('Unable to create adblock section');
				section = addResult.section;
				this.adblockClassicSection = section;
			}

			const values = {
				adb_enabled: enabled,
				adb_safesearch: safesearch,
				adb_dns: dns || '',
				adb_feed: feeds
			};
			await this.core.uciSet('adblock', section, values);
			if (trigger) {
				await this.core.uciSet('adblock', section, { adb_trigger: trigger });
			} else {
				await this.core.uciDelete('adblock', section, 'adb_trigger').catch(() => {});
			}

			await this.core.uciCommit('adblock');
			await this.runAdblockClassicServiceAction('restart');
			this.core.showToast('AdBlock settings saved', 'success');
			await this.loadAdblockClassic();
		} catch {
			this.core.showToast('Failed to save AdBlock settings', 'error');
		}
	}

	async loadAdblock() {
		await this.core.loadResource('adblock-targets-table', 4, 'adblock_fast', async () => {
			this.syncAdblockSettingsPanel();
			const installHintEl = document.getElementById('adblock-fast-install-hint');
			const tbody = document.querySelector('#adblock-targets-table tbody');
			if (!tbody) return;

			const config = await this.readAdblockFastConfig();
			if (!config || !config.values) {
				this.setAdblockSettingValue('enabled', '0', { syncOnly: true });
				this.setAdblockSettingValue('config_update', '0', { syncOnly: true });
				this.core.renderEmptyTable(
					tbody,
					4,
					'Adblock-Fast config not found. Install adblock-fast/luci-app-adblock-fast first.'
				);
				if (installHintEl) installHintEl.classList.remove('hidden');
				return;
			}
			if (installHintEl) installHintEl.classList.add('hidden');

			let mainSection = null;
			const rows = [];
			for (const [section, cfg] of Object.entries(config.values)) {
				const type = String(cfg?.['.type'] || '');
				if ((type === 'adblock-fast' || section === 'config') && !mainSection) {
					mainSection = { id: section, values: cfg };
				} else if (type === 'file_url' || type === 'file' || type === 'source') {
					const hasEnabled = Object.prototype.hasOwnProperty.call(cfg || {}, 'enabled');
					const hasDisabled = Object.prototype.hasOwnProperty.call(cfg || {}, 'disabled');
					const hasStatus = Object.prototype.hasOwnProperty.call(cfg || {}, 'status');
					let enabled = true;
					if (hasEnabled) {
						enabled = this.isEnabledValue(cfg.enabled);
					} else if (hasDisabled) {
						enabled = !this.isEnabledValue(cfg.disabled);
					} else if (hasStatus) {
						enabled = this.isEnabledValue(cfg.status);
					}
					rows.push({
						id: section,
						name: String(cfg.name || cfg.label || cfg.title || section),
						url: String(cfg.url || cfg.uri || cfg.source || cfg.file || ''),
						enabled
					});
				}
			}

			this.setAdblockSettingValue(
				'enabled',
				this.isEnabledValue(mainSection?.values?.enabled ?? '0') ? '1' : '0',
				{ syncOnly: true }
			);
			this.setAdblockSettingValue(
				'config_update',
				this.isEnabledValue(mainSection?.values?.config_update_enabled ?? '0') ? '1' : '0',
				{ syncOnly: true }
			);

			if (rows.length === 0) {
				this.core.renderEmptyTable(tbody, 4, 'No target lists configured');
				return;
			}

			rows.sort((a, b) => {
				if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
				return String(a.name || '').localeCompare(String(b.name || ''));
			});

			tbody.innerHTML = rows
				.map(
					row => `<tr>
				<td data-label="Name">${this.core.escapeHtml(row.name)}</td>
				<td data-label="URL">${this.core.escapeHtml(row.url || 'N/A')}</td>
				<td data-label="Status">${this.renderAdblockStatusBadge(row.enabled)}</td>
				<td data-label="Actions"><div class="action-buttons">
					<button class="action-btn-sm" data-action="toggle" data-id="${this.core.escapeHtml(row.id)}">${row.enabled ? 'DISABLE' : 'ENABLE'}</button>
					<button class="action-btn-sm danger" data-action="delete" data-id="${this.core.escapeHtml(row.id)}">DELETE</button>
				</div></td>
			</tr>`
				)
				.join('');
		});
	}

	renderAdblockStatusBadge(enabled) {
		const isEnabled = Boolean(enabled);
		if (!this.core.isFeatureEnabled('colorful_graphs')) {
			return this.core.renderBadge(isEnabled ? 'success' : 'error', isEnabled ? 'ENABLED' : 'DISABLED');
		}
		const cls = isEnabled ? 'badge-interface-up' : 'badge-adblock-disabled-soft';
		return `<span class="badge ${cls}">${isEnabled ? 'ENABLED' : 'DISABLED'}</span>`;
	}

	async readAdblockFastConfig() {
		try {
			const [status, result] = await this.core.uciGet('adblock-fast');
			if (status === 0 && result?.values) return result;
		} catch {}
		try {
			const [status, result] = await this.core.ubusCall('file', 'exec', {
				command: '/bin/sh',
				params: ['-c', 'uci -q show adblock-fast 2>/dev/null || true']
			});
			if (status !== 0 || !result?.stdout) return null;
			return { values: this.parseUciShowToConfig(String(result.stdout || ''), 'adblock-fast') || null };
		} catch {
			return null;
		}
	}

	parseUciShowToConfig(output, packageName = 'adblock-fast') {
		const cfg = {};
		const lines = String(output || '')
			.split('\n')
			.map(line => line.trim())
			.filter(Boolean);

		for (const line of lines) {
			const escaped = packageName.replace('-', '\\-');
			const m = line.match(new RegExp(`^${escaped}\\.([^.]+)\\.([^=]+)=(.*)$`));
			if (!m) continue;
			const section = m[1];
			const key = m[2];
			const value = this.stripOuterQuotes(m[3]);
			if (!cfg[section]) cfg[section] = {};
			if (key === '') continue;
			if (Object.prototype.hasOwnProperty.call(cfg[section], key)) {
				if (!Array.isArray(cfg[section][key])) cfg[section][key] = [cfg[section][key]];
				cfg[section][key].push(value);
			} else {
				cfg[section][key] = value;
			}
		}
		return Object.keys(cfg).length > 0 ? cfg : null;
	}

	stripOuterQuotes(value) {
		const raw = String(value ?? '').trim();
		if (
			(raw.startsWith("'") && raw.endsWith("'")) ||
			(raw.startsWith('"') && raw.endsWith('"'))
		) {
			return raw.slice(1, -1);
		}
		return raw;
	}

	isEnabledValue(value) {
		const v = this.stripOuterQuotes(value).toLowerCase();
		return v === '1' || v === 'true' || v === 'on' || v === 'enabled' || v === 'yes';
	}

	async saveAdblockSettings() {
		const enabled = String(document.getElementById('adblock-enabled')?.value || '0') === '1' ? '1' : '0';
		const configUpdate = String(document.getElementById('adblock-config-update')?.value || '0') === '1' ? '1' : '0';

		try {
			let section = 'config';
			const [status, result] = await this.core.uciGet('adblock-fast', 'config');
			if (status !== 0 || !result?.values) {
				const [addStatus, addResult] = await this.core.uciAdd('adblock-fast', 'adblock-fast', 'config');
				if (addStatus !== 0 || !addResult?.section) throw new Error('Unable to create adblock-fast section');
				section = addResult.section;
			}

			await this.core.uciSet('adblock-fast', section, {
				enabled,
				config_update_enabled: configUpdate
			});
			await this.core.uciCommit('adblock-fast');
			await this.reloadAdblockService();
			this.core.showToast('Adblock-Fast settings saved', 'success');
			await this.loadAdblock();
		} catch {
			this.core.showToast('Failed to save Adblock-Fast settings', 'error');
		}
	}

	async addAdblockTargetList() {
		const name = String(document.getElementById('adblock-new-list-name')?.value || '').trim();
		const url = String(document.getElementById('adblock-new-list-url')?.value || '').trim();
		const enabled = String(document.getElementById('adblock-new-list-enabled')?.value || '1') === '1' ? '1' : '0';

		if (!name) {
			this.core.showToast('Target list name is required', 'error');
			return;
		}
		if (url && !/^https?:\/\/\S+/i.test(url)) {
			this.core.showToast('Enter a valid target list URL', 'error');
			return;
		}

		try {
			const [status, result] = await this.core.uciAdd('adblock-fast', 'file_url');
			if (status !== 0 || !result?.section) throw new Error('Unable to create adblock-fast target list');
			await this.core.uciSet('adblock-fast', result.section, {
				name,
				url,
				enabled
			});
			await this.core.uciCommit('adblock-fast');
			await this.reloadAdblockService();
			this.core.showToast('Target list added', 'success');
			this.resetAdblockListForm();
			this.core.closeModal('adblock-list-modal');
			await this.loadAdblock();
		} catch {
			this.core.showToast('Failed to add target list', 'error');
		}
	}

	resetAdblockListForm() {
		const nameEl = document.getElementById('adblock-new-list-name');
		const urlEl = document.getElementById('adblock-new-list-url');
		const enabledEl = document.getElementById('adblock-new-list-enabled');
		if (nameEl) nameEl.value = '';
		if (urlEl) urlEl.value = '';
		if (enabledEl) enabledEl.value = '1';
	}

	async deleteAdblockTargetList(section) {
		if (!section) return;
		if (!confirm('Delete this target list?')) return;
		try {
			await this.core.uciDelete('adblock-fast', String(section));
			await this.core.uciCommit('adblock-fast');
			await this.reloadAdblockService();
			this.core.showToast('Target list deleted', 'success');
			await this.loadAdblock();
		} catch {
			this.core.showToast('Failed to delete target list', 'error');
		}
	}

	async toggleAdblockTargetList(section) {
		if (!section) return;
		try {
			const [status, result] = await this.core.uciGet('adblock-fast', String(section));
			if (status !== 0 || !result?.values) throw new Error('Target list section not found');
			let current = '1';
			if (Object.prototype.hasOwnProperty.call(result.values, 'enabled')) {
				current = this.isEnabledValue(result.values.enabled) ? '1' : '0';
			} else if (Object.prototype.hasOwnProperty.call(result.values, 'disabled')) {
				current = this.isEnabledValue(result.values.disabled) ? '0' : '1';
			} else if (Object.prototype.hasOwnProperty.call(result.values, 'status')) {
				current = this.isEnabledValue(result.values.status) ? '1' : '0';
			}
			const next = current === '1' ? '0' : '1';
			await this.core.uciSet('adblock-fast', String(section), { enabled: next });
			await this.core.uciCommit('adblock-fast');
			await this.reloadAdblockService();
			this.core.showToast(`Target list ${next === '1' ? 'enabled' : 'disabled'}`, 'success');
			await this.loadAdblock();
		} catch {
			this.core.showToast('Failed to toggle target list', 'error');
		}
	}

	async reloadAdblockService() {
		await this.core.ubusCall('file', 'exec', {
			command: '/bin/sh',
			params: [
				'-c',
				'/etc/init.d/adblock-fast reload 2>/dev/null || ' +
					'/etc/init.d/adblock-fast restart 2>/dev/null || ' +
					'/etc/init.d/adblock-fast start 2>/dev/null || true'
			]
		});
	}

	async loadPBR() {
		await this.core.loadResource('pbr-policies-table', 10, null, async () => {
			this.syncPbrSettingsPanel();
			this.syncAllPbrSectionPanels();
			await this.populatePbrInterfaceOptions();
			const policyTbody = document.querySelector('#pbr-policies-table tbody');
			const dnsTbody = document.querySelector('#pbr-dns-policies-table tbody');
			const includeTbody = document.querySelector('#pbr-includes-table tbody');
			if (!policyTbody || !dnsTbody || !includeTbody) return;

			const config = await this.readPbrConfig();
			if (!config || !config.values) {
				document.getElementById('pbr-enabled').value = '0';
				document.getElementById('pbr-strict-enforcement').value = '0';
				const missingMsg = 'PBR config not found. Install pbr/luci-app-pbr first.';
				this.core.renderEmptyTable(policyTbody, 10, missingMsg);
				this.core.renderEmptyTable(dnsTbody, 5, missingMsg);
				this.core.renderEmptyTable(includeTbody, 2, missingMsg);
				this.setPbrStatusBadges('MISSING', 'MISSING');
				return;
			}

			const policyRows = [];
			const dnsRows = [];
			const includeRows = [];
			let mainSection = null;

			for (const [section, cfg] of Object.entries(config.values)) {
				const type = String(cfg?.['.type'] || '');
				if ((type === 'pbr' || section === 'config') && !mainSection) {
					mainSection = { id: section, values: cfg };
					continue;
				}
				if (type === 'policy') {
					policyRows.push({
						id: section,
						name: String(cfg.name || section),
						src_addr: String(cfg.src_addr || ''),
						src_port: String(cfg.src_port || ''),
						dest_addr: String(cfg.dest_addr || ''),
						dest_port: String(cfg.dest_port || ''),
						proto: String(cfg.proto || 'all'),
						chain: String(cfg.chain || 'prerouting'),
						interface: String(cfg.interface || 'wan'),
						enabled: this.isEnabledValue(cfg.enabled ?? '1')
					});
				}
				if (type === 'dns_policy') {
					dnsRows.push({
						id: section,
						name: String(cfg.name || section),
						src_addr: String(cfg.src_addr || ''),
						dest_dns: String(cfg.dest_dns || ''),
						enabled: this.isEnabledValue(cfg.enabled ?? '1')
					});
				}
				if (type === 'include') {
					includeRows.push({
						id: section,
						path: String(cfg.path || '')
					});
				}
			}

			document.getElementById('pbr-enabled').value = this.isEnabledValue(mainSection?.values?.enabled ?? '0')
				? '1'
				: '0';
			document.getElementById('pbr-strict-enforcement').value = this.isEnabledValue(
				mainSection?.values?.strict_enforcement ?? '0'
			)
				? '1'
				: '0';

			if (policyRows.length === 0) {
				this.core.renderEmptyTable(policyTbody, 10, 'No policies configured');
			} else {
				policyTbody.innerHTML = policyRows
					.map(
						row => `<tr>
					<td data-label="Name">${this.core.escapeHtml(row.name)}</td>
					<td data-label="Local Addr/Dev">${this.core.escapeHtml(row.src_addr || 'Any')}</td>
					<td data-label="Local Ports">${this.core.escapeHtml(row.src_port || '')}</td>
					<td data-label="Remote Addr/Domains">${this.core.escapeHtml(row.dest_addr || 'Any')}</td>
					<td data-label="Remote Ports">${this.core.escapeHtml(row.dest_port || '')}</td>
					<td data-label="Protocol">${this.core.escapeHtml(row.proto || 'all')}</td>
					<td data-label="Chain">${this.core.escapeHtml(row.chain || 'prerouting')}</td>
					<td data-label="Interface">${this.core.escapeHtml(row.interface || 'wan')}</td>
					<td data-label="Status"><button class="action-btn-sm status-indicator-btn ${row.enabled ? 'success' : 'danger'}" type="button" data-action="toggle" data-id="${this.core.escapeHtml(row.id)}">${row.enabled ? 'ENABLED' : 'DISABLED'}</button></td>
					<td data-label="Actions">${this.core.renderActionButtons(row.id)}</td>
				</tr>`
					)
					.join('');
			}

			if (dnsRows.length === 0) {
				this.core.renderEmptyTable(dnsTbody, 5, 'No DNS policies configured');
			} else {
				dnsTbody.innerHTML = dnsRows
					.map(
						row => `<tr>
					<td data-label="Name">${this.core.escapeHtml(row.name)}</td>
					<td data-label="Source">${this.core.escapeHtml(row.src_addr || 'N/A')}</td>
					<td data-label="Dest DNS">${this.core.escapeHtml(row.dest_dns || 'N/A')}</td>
					<td data-label="Status"><button class="action-btn-sm status-indicator-btn ${row.enabled ? 'success' : 'danger'}" type="button" data-action="toggle" data-id="${this.core.escapeHtml(row.id)}">${row.enabled ? 'ENABLED' : 'DISABLED'}</button></td>
					<td data-label="Actions">${this.core.renderActionButtons(row.id)}</td>
				</tr>`
					)
					.join('');
			}

			if (includeRows.length === 0) {
				this.core.renderEmptyTable(includeTbody, 2, 'No custom user files configured');
			} else {
				includeTbody.innerHTML = includeRows
					.map(
						row => `<tr>
					<td data-label="Path">${this.core.escapeHtml(row.path || 'N/A')}</td>
					<td data-label="Actions"><div class="action-buttons">
						<button class="action-btn-sm" data-action="edit" data-id="${this.core.escapeHtml(row.id)}">EDIT</button>
						<button class="action-btn-sm danger" data-action="delete" data-id="${this.core.escapeHtml(row.id)}">DELETE</button>
					</div></td>
				</tr>`
					)
					.join('');
			}

			await this.refreshPbrServiceStatus();
		});
	}

	async readPbrConfig() {
		try {
			const [status, result] = await this.core.uciGet('pbr');
			if (status === 0 && result?.values) return result;
		} catch {}
		try {
			const [status, result] = await this.core.ubusCall('file', 'exec', {
				command: '/bin/sh',
				params: ['-c', 'uci -q show pbr 2>/dev/null || true']
			});
			if (status !== 0 || !result?.stdout) return null;
			return { values: this.parseUciShowToConfig(String(result.stdout || ''), 'pbr') || null };
		} catch {
			return null;
		}
	}

	setPbrStatusBadges(serviceState, bootState) {
		const serviceEl = document.getElementById('pbr-service-status');
		const bootEl = document.getElementById('pbr-boot-status');
		if (serviceEl) {
			serviceEl.innerHTML =
				serviceState === 'RUNNING'
					? this.core.renderBadge('success', 'RUNNING')
					: serviceState === 'STOPPED'
						? this.core.renderBadge('error', 'STOPPED')
						: this.core.renderBadge('warning', serviceState || 'UNKNOWN');
		}
		if (bootEl) {
			bootEl.innerHTML =
				bootState === 'ENABLED'
					? this.core.renderBadge('success', 'ENABLED')
					: bootState === 'DISABLED'
						? this.core.renderBadge('error', 'DISABLED')
						: this.core.renderBadge('warning', bootState || 'UNKNOWN');
		}
	}

	async refreshPbrServiceStatus() {
		const [status, result] = await this.core.ubusCall('file', 'exec', {
			command: '/bin/sh',
			params: [
				'-c',
				`if [ ! -x /etc/init.d/pbr ]; then echo "SERVICE=MISSING"; echo "BOOT=MISSING"; exit 0; fi
/etc/init.d/pbr status >/dev/null 2>&1 && echo "SERVICE=RUNNING" || echo "SERVICE=STOPPED"
/etc/init.d/pbr enabled >/dev/null 2>&1 && echo "BOOT=ENABLED" || echo "BOOT=DISABLED"`
			]
		});

		if (status !== 0) {
			this.setPbrStatusBadges('UNKNOWN', 'UNKNOWN');
			return;
		}

		const out = String(result?.stdout || '');
		const serviceState = out.match(/SERVICE=([A-Z]+)/)?.[1] || 'UNKNOWN';
		const bootState = out.match(/BOOT=([A-Z]+)/)?.[1] || 'UNKNOWN';
		this.setPbrStatusBadges(serviceState, bootState);
	}

	async ensurePbrConfigSection() {
		let section = 'config';
		const [status, result] = await this.core.uciGet('pbr', section);
		if (status === 0 && result?.values) return section;
		const [addStatus, addResult] = await this.core.uciAdd('pbr', 'pbr', 'config');
		if (addStatus !== 0 || !addResult?.section) throw new Error('Unable to create pbr config section');
		section = addResult.section;
		return section;
	}

	async savePbrSettings() {
		const enabled = String(document.getElementById('pbr-enabled')?.value || '0') === '1' ? '1' : '0';
		const strictEnforcement =
			String(document.getElementById('pbr-strict-enforcement')?.value || '0') === '1' ? '1' : '0';
		try {
			const section = await this.ensurePbrConfigSection();
			await this.core.uciSet('pbr', section, {
				enabled,
				strict_enforcement: strictEnforcement
			});
			await this.core.uciCommit('pbr');
			await this.runPbrServiceAction('restart', false);
			this.core.showToast('PBR settings saved', 'success');
			await this.loadPBR();
		} catch {
			this.core.showToast('Failed to save PBR settings', 'error');
		}
	}

	async runPbrServiceAction(action, showToast = true) {
		if (!action) return;
		try {
			const [status] = await this.core.ubusCall('file', 'exec', {
				command: '/etc/init.d/pbr',
				params: [String(action)]
			});
			if (status !== 0) throw new Error('service action failed');
			if (showToast) this.core.showToast(`PBR ${action} completed`, 'success');
			await this.refreshPbrServiceStatus();
		} catch {
			if (showToast) this.core.showToast(`Failed to ${action} PBR service`, 'error');
		}
	}

	async addPbrPolicy() {
		const addModal = document.getElementById('pbr-policy-add-modal');
		const addModalOpen = !!addModal && !addModal.classList.contains('hidden');
		if (!addModalOpen) {
			this.core.resetModal('pbr-policy-add-modal');
			await this.populatePbrInterfaceOptions();
			this.resetPbrPolicyAddForm();
			this.core.openModal('pbr-policy-add-modal');
			return;
		}

		const values = this.readPbrPolicyFormValues(false);
		if (!values.name) {
			this.core.showToast('Policy name is required', 'error');
			return;
		}

		try {
			const [status, result] = await this.core.uciAdd('pbr', 'policy');
			if (status !== 0 || !result?.section) throw new Error('Unable to create policy');
			await this.core.uciSet('pbr', result.section, values);
			await this.core.uciCommit('pbr');
			await this.runPbrServiceAction('restart', false);
			this.core.closeModal('pbr-policy-add-modal');
			this.resetPbrPolicyAddForm();
			this.core.showToast('PBR policy added', 'success');
			await this.loadPBR();
		} catch {
			this.core.showToast('Failed to add PBR policy', 'error');
		}
	}

	async editPbrPolicy(section) {
		if (!section) return;
		try {
			const [status, result] = await this.core.uciGet('pbr', String(section));
			if (status !== 0 || !result?.values) throw new Error('Policy not found');
			const cfg = result.values;
			const selectedInterface = String(cfg.interface || 'wan');
			await this.populatePbrInterfaceOptions(selectedInterface);
			document.getElementById('edit-pbr-policy-section').value = String(section);
			document.getElementById('edit-pbr-policy-enabled').value = this.isEnabledValue(cfg.enabled ?? '1') ? '1' : '0';
			document.getElementById('edit-pbr-policy-name').value = String(cfg.name || '');
			document.getElementById('edit-pbr-policy-src-addr').value = String(cfg.src_addr || '');
			document.getElementById('edit-pbr-policy-src-port').value = String(cfg.src_port || '');
			document.getElementById('edit-pbr-policy-dest-addr').value = String(cfg.dest_addr || '');
			document.getElementById('edit-pbr-policy-dest-port').value = String(cfg.dest_port || '');
			document.getElementById('edit-pbr-policy-proto').value = String(cfg.proto || 'all');
			document.getElementById('edit-pbr-policy-chain').value = String(cfg.chain || 'prerouting');
			document.getElementById('edit-pbr-policy-interface').value = selectedInterface;
			this.core.openModal('pbr-policy-modal');
		} catch {
			this.core.showToast('Failed to load PBR policy', 'error');
		}
	}

	async savePbrPolicy() {
		const section = String(document.getElementById('edit-pbr-policy-section')?.value || '').trim();
		const values = this.readPbrPolicyFormValues(true);
		if (!section || !values.name) {
			this.core.showToast('Policy name is required', 'error');
			return;
		}

		try {
			await this.core.uciSet('pbr', section, values);
			await this.core.uciCommit('pbr');
			await this.runPbrServiceAction('restart', false);
			this.core.closeModal('pbr-policy-modal');
			this.core.showToast('PBR policy updated', 'success');
			await this.loadPBR();
		} catch {
			this.core.showToast('Failed to update PBR policy', 'error');
		}
	}

	async deletePbrPolicy(section) {
		if (!section) return;
		if (!confirm('Delete this policy?')) return;
		try {
			await this.core.uciDelete('pbr', String(section));
			await this.core.uciCommit('pbr');
			await this.runPbrServiceAction('restart', false);
			this.core.showToast('PBR policy deleted', 'success');
			await this.loadPBR();
		} catch {
			this.core.showToast('Failed to delete PBR policy', 'error');
		}
	}

	async togglePbrPolicy(section) {
		if (!section) return;
		try {
			const [status, result] = await this.core.uciGet('pbr', String(section));
			if (status !== 0 || !result?.values) throw new Error('Policy section not found');
			const current = this.isEnabledValue(result.values.enabled ?? '1') ? '1' : '0';
			const next = current === '1' ? '0' : '1';
			await this.core.uciSet('pbr', String(section), { enabled: next });
			await this.core.uciCommit('pbr');
			await this.runPbrServiceAction('restart', false);
			this.core.showToast(`Policy ${next === '1' ? 'enabled' : 'disabled'}`, 'success');
			await this.loadPBR();
		} catch {
			this.core.showToast('Failed to toggle policy status', 'error');
		}
	}

	readPbrPolicyFormValues(editMode = false) {
		const get = id => String(document.getElementById(id)?.value || '').trim();
		const prefix = editMode ? 'edit-' : '';
		const values = {
			enabled: editMode ? get(`${prefix}pbr-policy-enabled`) || '1' : '1',
			name: get(`${prefix}pbr-policy-name`),
			src_addr: get(`${prefix}pbr-policy-src-addr`),
			src_port: get(`${prefix}pbr-policy-src-port`),
			dest_addr: get(`${prefix}pbr-policy-dest-addr`),
			dest_port: get(`${prefix}pbr-policy-dest-port`),
			proto: get(`${prefix}pbr-policy-proto`) || 'all',
			chain: get(`${prefix}pbr-policy-chain`) || 'prerouting',
			interface: get(`${prefix}pbr-policy-interface`) || 'wan'
		};
		return values;
	}

	resetPbrPolicyAddForm() {
		const resetValue = (id, value) => {
			const el = document.getElementById(id);
			if (el) el.value = value;
		};
		resetValue('pbr-policy-name', '');
		resetValue('pbr-policy-src-addr', '');
		resetValue('pbr-policy-src-port', '');
		resetValue('pbr-policy-dest-addr', '');
		resetValue('pbr-policy-dest-port', '');
		resetValue('pbr-policy-proto', 'all');
		resetValue('pbr-policy-chain', 'prerouting');
		resetValue('pbr-policy-interface', 'wan');
	}

	async populatePbrInterfaceOptions(editSelected = '') {
		const addSelect = document.getElementById('pbr-policy-interface');
		const editSelect = document.getElementById('edit-pbr-policy-interface');
		if (!addSelect && !editSelect) return;

		let names = [];
		try {
			const [, dump] = await this.core.ubusCall('network.interface', 'dump', {});
			const rows = Array.isArray(dump?.interface) ? dump.interface : [];
			const set = new Set();
			for (const row of rows) {
				const n = String(row?.interface || '').trim();
				if (!n || n === 'loopback') continue;
				set.add(n);
			}
			names = Array.from(set);
		} catch {}

		if (names.length === 0) {
			try {
				const [status, result] = await this.core.uciGet('network');
				if (status === 0 && result?.values) {
					const set = new Set();
					for (const [section, cfg] of Object.entries(result.values)) {
						if (String(cfg?.['.type'] || '') === 'interface' && section !== 'loopback') set.add(section);
					}
					names = Array.from(set);
				}
			} catch {}
		}

		if (!names.includes('wan')) names.unshift('wan');
		names = Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));

		const render = (selectEl, preferred) => {
			if (!selectEl) return;
			const current = String(selectEl.value || '').trim();
			const selected = String(preferred || current || 'wan').trim();
			const list = [...names];
			if (selected && !list.includes(selected)) list.push(selected);
			selectEl.innerHTML = list
				.map(name => `<option value="${this.core.escapeHtml(name)}">${this.core.escapeHtml(name)}</option>`)
				.join('');
			selectEl.value = selected || (list.includes('wan') ? 'wan' : list[0] || '');
		};

		render(addSelect, String(addSelect?.value || 'wan'));
		render(editSelect, editSelected);
	}

	async addPbrDnsPolicy() {
		const addModal = document.getElementById('pbr-dns-policy-add-modal');
		const addModalOpen = !!addModal && !addModal.classList.contains('hidden');
		if (!addModalOpen) {
			this.core.resetModal('pbr-dns-policy-add-modal');
			this.resetPbrDnsPolicyAddForm();
			await this.loadPbrDnsSourceDeviceOptions();
			this.core.openModal('pbr-dns-policy-add-modal');
			return;
		}

		const name = String(document.getElementById('pbr-dns-name')?.value || '').trim();
		const srcAddr = String(document.getElementById('pbr-dns-src-addr')?.value || '').trim();
		const destDns = String(document.getElementById('pbr-dns-dest-dns')?.value || '').trim();

		if (!name || !srcAddr || !destDns) {
			this.core.showToast('Name, source and DNS resolver are required', 'error');
			return;
		}

		try {
			const [status, result] = await this.core.uciAdd('pbr', 'dns_policy');
			if (status !== 0 || !result?.section) throw new Error('Unable to create dns policy');
			await this.core.uciSet('pbr', result.section, {
				name,
				src_addr: srcAddr,
				dest_dns: destDns,
				enabled: '1'
			});
			await this.core.uciCommit('pbr');
			await this.runPbrServiceAction('restart', false);
			this.core.closeModal('pbr-dns-policy-add-modal');
			document.getElementById('pbr-dns-name').value = '';
			document.getElementById('pbr-dns-src-addr').value = '';
			document.getElementById('pbr-dns-dest-dns').value = '';
			this.core.showToast('DNS policy added', 'success');
			await this.loadPBR();
		} catch {
			this.core.showToast('Failed to add DNS policy', 'error');
		}
	}

	async loadPbrDnsSourceDeviceOptions() {
		const select = document.getElementById('pbr-dns-src-addr');
		if (!select) return;

		let leases = [];
		try {
			const [status, result] = await this.core.ubusCall('luci-rpc', 'getDHCPLeases', {});
			if (status === 0 && Array.isArray(result?.dhcp_leases)) {
				leases = result.dhcp_leases;
			}
		} catch {}

		const options = leases
			.map(lease => ({
				mac: String(lease.macaddr || '').trim().toLowerCase(),
				ip: String(lease.ipaddr || '').trim(),
				hostname: String(lease.hostname || '').trim() || 'Unknown'
			}))
			.filter(item => item.mac)
			.sort((a, b) => a.hostname.localeCompare(b.hostname));

		const prior = String(select.value || '').trim().toLowerCase();
		select.innerHTML = '<option value="">Select device (MAC source)</option>';
		for (const item of options) {
			const option = document.createElement('option');
			option.value = item.mac;
			option.textContent = `${item.hostname} (${item.ip || item.mac})`;
			select.appendChild(option);
		}
		if (prior && options.some(item => item.mac === prior)) {
			select.value = prior;
		}
	}

	async editPbrDnsPolicy(section) {
		if (!section) return;
		try {
			const [status, result] = await this.core.uciGet('pbr', String(section));
			if (status !== 0 || !result?.values) throw new Error('Policy not found');
			const cfg = result.values;
			document.getElementById('edit-pbr-dns-policy-section').value = String(section);
			document.getElementById('edit-pbr-dns-name').value = String(cfg.name || '');
			document.getElementById('edit-pbr-dns-src-addr').value = String(cfg.src_addr || '');
			document.getElementById('edit-pbr-dns-dest-dns').value = String(cfg.dest_dns || '');
			document.getElementById('edit-pbr-dns-enabled').value = this.isEnabledValue(cfg.enabled ?? '1') ? '1' : '0';
			this.core.openModal('pbr-dns-policy-modal');
		} catch {
			this.core.showToast('Failed to load DNS policy', 'error');
		}
	}

	async savePbrDnsPolicy() {
		const section = String(document.getElementById('edit-pbr-dns-policy-section')?.value || '').trim();
		const name = String(document.getElementById('edit-pbr-dns-name')?.value || '').trim();
		const srcAddr = String(document.getElementById('edit-pbr-dns-src-addr')?.value || '').trim();
		const destDns = String(document.getElementById('edit-pbr-dns-dest-dns')?.value || '').trim();
		const enabled = String(document.getElementById('edit-pbr-dns-enabled')?.value || '1') === '1' ? '1' : '0';

		if (!section || !name || !srcAddr || !destDns) {
			this.core.showToast('Name, source and DNS resolver are required', 'error');
			return;
		}

		try {
			await this.core.uciSet('pbr', section, {
				name,
				src_addr: srcAddr,
				dest_dns: destDns,
				enabled
			});
			await this.core.uciCommit('pbr');
			await this.runPbrServiceAction('restart', false);
			this.core.closeModal('pbr-dns-policy-modal');
			this.core.showToast('DNS policy updated', 'success');
			await this.loadPBR();
		} catch {
			this.core.showToast('Failed to update DNS policy', 'error');
		}
	}

	async deletePbrDnsPolicy(section) {
		if (!section) return;
		if (!confirm('Delete this DNS policy?')) return;
		try {
			await this.core.uciDelete('pbr', String(section));
			await this.core.uciCommit('pbr');
			await this.runPbrServiceAction('restart', false);
			this.core.showToast('DNS policy deleted', 'success');
			await this.loadPBR();
		} catch {
			this.core.showToast('Failed to delete DNS policy', 'error');
		}
	}

	async togglePbrDnsPolicy(section) {
		if (!section) return;
		try {
			const [status, result] = await this.core.uciGet('pbr', String(section));
			if (status !== 0 || !result?.values) throw new Error('DNS policy section not found');
			const current = this.isEnabledValue(result.values.enabled ?? '1') ? '1' : '0';
			const next = current === '1' ? '0' : '1';
			await this.core.uciSet('pbr', String(section), { enabled: next });
			await this.core.uciCommit('pbr');
			await this.runPbrServiceAction('restart', false);
			this.core.showToast(`DNS policy ${next === '1' ? 'enabled' : 'disabled'}`, 'success');
			await this.loadPBR();
		} catch {
			this.core.showToast('Failed to toggle DNS policy status', 'error');
		}
	}

	async editPbrInclude(section) {
		if (!section) return;
		try {
			const [status, result] = await this.core.uciGet('pbr', String(section));
			if (status !== 0 || !result?.values) throw new Error('Include section not found');
			const cfg = result.values;
			document.getElementById('edit-pbr-include-section').value = String(section);
			document.getElementById('edit-pbr-include-path').value = String(cfg.path || '');
			this.core.openModal('pbr-include-modal');
		} catch {
			this.core.showToast('Failed to load list entry', 'error');
		}
	}

	async savePbrInclude() {
		const section = String(document.getElementById('edit-pbr-include-section')?.value || '').trim();
		const path = String(document.getElementById('edit-pbr-include-path')?.value || '').trim();

		if (!section || !path) {
			this.core.showToast('File path is required', 'error');
			return;
		}

		try {
			await this.core.uciSet('pbr', section, { path, enabled: '1' });
			await this.core.uciCommit('pbr');
			await this.runPbrServiceAction('restart', false);
			this.core.closeModal('pbr-include-modal');
			this.core.showToast('List entry updated', 'success');
			await this.loadPBR();
		} catch {
			this.core.showToast('Failed to update list entry', 'error');
		}
	}

	async addPbrInclude() {
		const addModal = document.getElementById('pbr-include-add-modal');
		const addModalOpen = !!addModal && !addModal.classList.contains('hidden');
		if (!addModalOpen) {
			this.core.resetModal('pbr-include-add-modal');
			this.resetPbrIncludeAddForm();
			this.core.openModal('pbr-include-add-modal');
			return;
		}

		const path = String(document.getElementById('pbr-include-path')?.value || '').trim();

		if (!path) {
			this.core.showToast('Custom user file path is required', 'error');
			return;
		}

		try {
			const [status, result] = await this.core.uciAdd('pbr', 'include');
			if (status !== 0 || !result?.section) throw new Error('Unable to create include section');
			await this.core.uciSet('pbr', result.section, {
				path,
				enabled: '1'
			});
			await this.core.uciCommit('pbr');
			await this.runPbrServiceAction('restart', false);
			this.core.closeModal('pbr-include-add-modal');
			document.getElementById('pbr-include-path').value = '';
			this.core.showToast('Custom user file added', 'success');
			await this.loadPBR();
		} catch {
			this.core.showToast('Failed to add custom user file', 'error');
		}
	}

	resetPbrDnsPolicyAddForm() {
		const resetValue = (id, value) => {
			const el = document.getElementById(id);
			if (el) el.value = value;
		};
		resetValue('pbr-dns-name', '');
		resetValue('pbr-dns-src-addr', '');
		resetValue('pbr-dns-dest-dns', '');
	}

	resetPbrIncludeAddForm() {
		const el = document.getElementById('pbr-include-path');
		if (el) el.value = '';
	}

	async deletePbrInclude(section) {
		if (!section) return;
		if (!confirm('Delete this custom user file include?')) return;
		try {
			await this.core.uciDelete('pbr', String(section));
			await this.core.uciCommit('pbr');
			await this.runPbrServiceAction('restart', false);
			this.core.showToast('Custom user file removed', 'success');
			await this.loadPBR();
		} catch {
			this.core.showToast('Failed to delete custom user file', 'error');
		}
	}

	async loadDDNS() {
		await this.core.loadResource('ddns-table', 6, 'ddns', async () => {
			const [status, result] = await this.core.uciGet('ddns');
			if (status !== 0 || !result?.values) throw new Error('No data');
			const services = Object.entries(result.values)
				.filter(([, v]) => v['.type'] === 'service')
				.map(([k, v]) => ({ section: k, ...v }));
			const runtimeBySection = await this.fetchDdnsRuntimeMap(services);

			const tbody = document.querySelector('#ddns-table tbody');
			if (!tbody) return;
			if (services.length === 0) {
				this.core.renderEmptyTable(tbody, 6, 'No DDNS services configured');
				return;
			}
			tbody.innerHTML = services
				.map(s => {
					const enabled = String(s.enabled || '0') === '1';
					const runtime = runtimeBySection.get(String(s.section)) || { state: 'UNKNOWN', ip: '' };
					return `<tr>
				<td data-label="Name">${this.core.escapeHtml(s.section)}</td>
				<td data-label="Domain">${this.core.escapeHtml(s.lookup_host || s.domain || 'N/A')}</td>
				<td data-label="Service">${this.core.escapeHtml(s.service_name || 'Custom')}</td>
				<td data-label="IP">${this.core.escapeHtml(runtime.ip || 'N/A')}</td>
				<td data-label="Status"><button class="action-btn-sm status-indicator-btn ${enabled ? 'success' : 'danger'}" type="button" data-action="toggle" data-id="${this.core.escapeHtml(s.section)}">${enabled ? 'ENABLED' : 'DISABLED'}</button></td>
				<td data-label="Actions">${this.core.renderActionButtons(s.section)}</td>
			</tr>`;
				})
				.join('');
		});
	}

	async fetchDdnsRuntimeMap(services) {
		const map = new Map();
		if (!Array.isArray(services) || services.length === 0) return map;

		const rows = await Promise.all(
			services.map(async service => {
				const section = String(service?.section || '').trim();
				if (!section) return null;
				const runtime = await this.fetchDdnsRuntime(section);
				return [section, runtime];
			})
		);

		for (const row of rows) {
			if (!row) continue;
			map.set(row[0], row[1]);
		}

		return map;
	}

	async fetchDdnsRuntime(section) {
		try {
			const safeSection = this.shellQuote(section);
			const command = `section=${safeSection}
status_out="$(/etc/init.d/ddns status "$section" 2>/dev/null || true)"
state="UNKNOWN"
if printf "%s\\n" "$status_out" | grep -qiE 'running|updating|pid'; then
	state="RUNNING"
elif printf "%s\\n" "$status_out" | grep -qiE 'stopped|not running|disabled|inactive'; then
	state="STOPPED"
fi
ip="$(printf "%s\\n" "$status_out" | grep -Eo '([0-9]{1,3}\\.){3}[0-9]{1,3}' | head -n 1)"
if [ -z "$ip" ]; then
	for f in "/var/run/ddns/${section}.ip" "/var/run/ddns/${section}.dat" "/var/run/ddns/${section}.update" "/tmp/ddns/${section}.ip"; do
		[ -r "$f" ] || continue
		ip="$(grep -Eo '([0-9]{1,3}\\.){3}[0-9]{1,3}' "$f" | head -n 1)"
		[ -n "$ip" ] && break
	done
fi
printf 'STATE=%s\\nIP=%s\\n' "$state" "$ip"`;
			const [status, result] = await this.core.ubusCall('file', 'exec', {
				command: '/bin/sh',
				params: ['-c', command]
			});
			if (status !== 0) return { state: 'UNKNOWN', ip: '' };
			const stdout = String(result?.stdout || '');
			const state = (stdout.match(/STATE=([A-Z_]+)/)?.[1] || 'UNKNOWN').trim();
			const ip = (stdout.match(/IP=([^\n]*)/)?.[1] || '').trim();
			return { state, ip };
		} catch {
			return { state: 'UNKNOWN', ip: '' };
		}
	}

	async toggleDDNS(id) {
		if (!id) return;
		try {
			const [status, result] = await this.core.uciGet('ddns', id);
			if (status !== 0 || !result?.values) throw new Error('DDNS section not found');
			const currentEnabled = String(result.values.enabled || '0') === '1';
			const nextEnabled = currentEnabled ? '0' : '1';
			await this.core.uciSet('ddns', id, { enabled: nextEnabled });
			await this.core.uciCommit('ddns');
			await this.core.ubusCall('file', 'exec', {
				command: '/etc/init.d/ddns',
				params: ['restart']
			});
			this.core.showToast(`DDNS ${nextEnabled === '1' ? 'enabled' : 'disabled'}`, 'success');
			await this.loadDDNS();
		} catch {
			this.core.showToast('Failed to update DDNS status', 'error');
		}
	}

	async editDDNS(id) {
		try {
			const [status, result] = await this.core.uciGet('ddns', id);
			if (status !== 0 || !result?.values) throw new Error('Not found');
			const c = result.values;
			document.getElementById('edit-ddns-section').value = id;
			document.getElementById('edit-ddns-name').value = id;
			document.getElementById('edit-ddns-service').value = c.service_name || 'cloudflare.com-v4';
			document.getElementById('edit-ddns-hostname').value = c.lookup_host || c.domain || '';
			document.getElementById('edit-ddns-username').value = c.username || '';
			document.getElementById('edit-ddns-password').value = c.password || '';
			document.getElementById('edit-ddns-check-interval').value = c.check_interval || '10';
			document.getElementById('edit-ddns-enabled').value = c.enabled || '0';
			this.core.openModal('ddns-modal');
		} catch {
			this.core.showToast('Failed to load DDNS service', 'error');
		}
	}

	async saveDDNS() {
		const section = document.getElementById('edit-ddns-section').value;
		const name = document.getElementById('edit-ddns-name').value;
		const values = {
			service_name: document.getElementById('edit-ddns-service').value,
			lookup_host: document.getElementById('edit-ddns-hostname').value,
			domain: document.getElementById('edit-ddns-hostname').value,
			username: document.getElementById('edit-ddns-username').value,
			password: document.getElementById('edit-ddns-password').value,
			check_interval: document.getElementById('edit-ddns-check-interval').value,
			enabled: document.getElementById('edit-ddns-enabled').value,
			ip_source: 'network',
			ip_network: 'wan',
			interface: 'wan',
			use_https: '1'
		};
		try {
			if (section) {
				await this.core.uciSet('ddns', section, values);
			} else {
				const sectionName = name || null;
				const [, res] = await this.core.uciAdd('ddns', 'service', sectionName);
				if (!res?.section) throw new Error('Failed to create section');
				await this.core.uciSet('ddns', res.section, values);
			}
			await this.core.uciCommit('ddns');
			this.core.closeModal('ddns-modal');
			this.core.showToast('DDNS service saved', 'success');
			this.loadDDNS();
		} catch {
			this.core.showToast('Failed to save DDNS service', 'error');
		}
	}

	async deleteDDNS(id) {
		if (!confirm('Delete this DDNS service?')) return;
		try {
			await this.core.uciDelete('ddns', id);
			await this.core.uciCommit('ddns');
			this.core.showToast('DDNS service deleted', 'success');
			this.loadDDNS();
		} catch {
			this.core.showToast('Failed to delete DDNS service', 'error');
		}
	}

	async loadQoS() {
		await this.core.loadResource('qos-rules-table', 6, 'qos', async () => {
			const [status, result] = await this.core.uciGet('qos');
			if (status !== 0 || !result?.values) throw new Error('No data');
			const config = result.values;

			const iface = Object.entries(config).find(([, v]) => v['.type'] === 'interface');
			if (iface) {
				const el = id => document.getElementById(id);
				el('qos-enabled').value = iface[1].enabled || '0';
				el('qos-download').value = iface[1].download || '';
				el('qos-upload').value = iface[1].upload || '';
			}

			const rules = Object.entries(config)
				.filter(([, v]) => v['.type'] === 'classify')
				.map(([k, v]) => ({ section: k, ...v }));

			const tbody = document.querySelector('#qos-rules-table tbody');
			if (!tbody) return;
			if (rules.length === 0) {
				this.core.renderEmptyTable(tbody, 6, 'No QoS rules');
				return;
			}
			tbody.innerHTML = rules
				.map(
					r => `<tr>
				<td data-label="Name">${this.core.escapeHtml(r.section)}</td>
				<td data-label="Priority">${this.core.escapeHtml(r.target || 'Normal')}</td>
				<td data-label="Protocol">${this.core.escapeHtml(r.proto || 'Any')}</td>
				<td data-label="Ports">${this.core.escapeHtml(r.ports || 'Any')}</td>
				<td data-label="Source Host">${this.core.escapeHtml(r.srchost || 'Any')}</td>
				<td data-label="Actions">${this.core.renderActionButtons(r.section)}</td>
			</tr>`
				)
				.join('');
		});
	}

	async saveQoSConfig() {
		try {
			const [status, result] = await this.core.uciGet('qos');
			if (status !== 0 || !result?.values) throw new Error('No QoS config');
			const iface = Object.entries(result.values).find(([, v]) => v['.type'] === 'interface');
			if (!iface) throw new Error('No QoS interface');
			await this.core.uciSet('qos', iface[0], {
				enabled: document.getElementById('qos-enabled').value,
				download: document.getElementById('qos-download').value,
				upload: document.getElementById('qos-upload').value
			});
			await this.core.uciCommit('qos');
			this.core.showToast('QoS configuration saved', 'success');
		} catch {
			this.core.showToast('Failed to save QoS config', 'error');
		}
	}

	async editQoSRule(id) {
		try {
			const [status, result] = await this.core.uciGet('qos', id);
			if (status !== 0 || !result?.values) throw new Error('Not found');
			const c = result.values;
			document.getElementById('edit-qos-rule-section').value = id;
			document.getElementById('edit-qos-rule-name').value = id;
			document.getElementById('edit-qos-rule-priority').value = c.target || 'Normal';
			document.getElementById('edit-qos-rule-proto').value = c.proto || '';
			document.getElementById('edit-qos-rule-ports').value = c.ports || '';
			document.getElementById('edit-qos-rule-srchost').value = c.srchost || '';
			this.core.openModal('qos-rule-modal');
		} catch {
			this.core.showToast('Failed to load QoS rule', 'error');
		}
	}

	async saveQoSRule() {
		const section = document.getElementById('edit-qos-rule-section').value;
		const values = {
			target: document.getElementById('edit-qos-rule-priority').value,
			proto: document.getElementById('edit-qos-rule-proto').value,
			ports: document.getElementById('edit-qos-rule-ports').value,
			srchost: document.getElementById('edit-qos-rule-srchost').value
		};
		try {
			if (section) {
				await this.core.uciSet('qos', section, values);
			} else {
				const [, res] = await this.core.uciAdd('qos', 'classify');
				if (!res?.section) throw new Error('Failed to create section');
				await this.core.uciSet('qos', res.section, values);
			}
			await this.core.uciCommit('qos');
			this.core.closeModal('qos-rule-modal');
			this.core.showToast('QoS rule saved', 'success');
			this.loadQoS();
		} catch {
			this.core.showToast('Failed to save QoS rule', 'error');
		}
	}

	async deleteQoSRule(id) {
		if (!confirm('Delete this QoS rule?')) return;
		try {
			await this.core.uciDelete('qos', id);
			await this.core.uciCommit('qos');
			this.core.showToast('QoS rule deleted', 'success');
			this.loadQoS();
		} catch {
			this.core.showToast('Failed to delete QoS rule', 'error');
		}
	}

	canShowQosifyTab() {
		return this.core.isFeatureEnabled('qosify') && this.qosifyInstalled === true;
	}

	applyQosifyTabVisibility() {
		const btn = document.querySelector('#network-page .tab-btn[data-tab="qosify"]');
		const content = document.getElementById('tab-qosify');
		const visible = this.canShowQosifyTab();
		if (btn) btn.classList.toggle('hidden', !visible);
		if (content) content.classList.toggle('hidden', !visible);
	}

	async refreshQosifyAvailability() {
		try {
			const [status, result] = await this.core.ubusCall('file', 'exec', {
				command: '/bin/sh',
				params: ['-c', '[ -x /etc/init.d/qosify ] && echo INSTALLED || echo MISSING']
			});
			if (status === 0) {
				this.qosifyInstalled = String(result?.stdout || '').trim() === 'INSTALLED';
			} else {
				this.qosifyInstalled = false;
			}
		} catch {
			this.qosifyInstalled = false;
		}
		this.applyQosifyTabVisibility();
	}

	async readQoSifyConfig() {
		try {
			const [status, result] = await this.core.uciGet('qosify');
			if (status === 0 && result?.values) return result;
		} catch {}
		try {
			const [status, result] = await this.core.ubusCall('file', 'exec', {
				command: '/bin/sh',
				params: ['-c', 'uci -q show qosify 2>/dev/null || true']
			});
			if (status !== 0 || !result?.stdout) return null;
			return { values: this.parseUciShowToConfig(String(result.stdout || ''), 'qosify') || null };
		} catch {
			return null;
		}
	}

	setQoSifyStatusBadges(serviceState, bootState) {
		const serviceEl = document.getElementById('qosify-service-status');
		const bootEl = document.getElementById('qosify-boot-status');
		if (serviceEl) {
			serviceEl.innerHTML =
				serviceState === 'RUNNING'
					? this.core.renderBadge('success', 'RUNNING')
					: serviceState === 'STOPPED'
						? this.core.renderBadge('error', 'STOPPED')
						: this.core.renderBadge('warning', serviceState || 'UNKNOWN');
		}
		if (bootEl) {
			bootEl.innerHTML =
				bootState === 'ENABLED'
					? this.core.renderBadge('success', 'ENABLED')
					: bootState === 'DISABLED'
						? this.core.renderBadge('error', 'DISABLED')
						: this.core.renderBadge('warning', bootState || 'UNKNOWN');
		}
	}

	async refreshQoSifyServiceStatus() {
		const [status, result] = await this.core.ubusCall('file', 'exec', {
			command: '/bin/sh',
			params: [
				'-c',
				`if [ ! -x /etc/init.d/qosify ]; then echo "SERVICE=MISSING"; echo "BOOT=MISSING"; exit 0; fi
/etc/init.d/qosify status >/dev/null 2>&1 && echo "SERVICE=RUNNING" || echo "SERVICE=STOPPED"
/etc/init.d/qosify enabled >/dev/null 2>&1 && echo "BOOT=ENABLED" || echo "BOOT=DISABLED"`
			]
		});

		if (status !== 0) {
			this.setQoSifyStatusBadges('UNKNOWN', 'UNKNOWN');
			return;
		}
		const out = String(result?.stdout || '');
		const serviceState = out.match(/SERVICE=([A-Z]+)/)?.[1] || 'UNKNOWN';
		const bootState = out.match(/BOOT=([A-Z]+)/)?.[1] || 'UNKNOWN';
		this.setQoSifyStatusBadges(serviceState, bootState);
	}

	async loadQoSify() {
		await this.refreshQosifyAvailability();
		if (!this.canShowQosifyTab()) return;
		const installHintEl = document.getElementById('qosify-install-hint');
		const enabledEl = document.getElementById('qosify-enabled');
		const ifaceEl = document.getElementById('qosify-interface');
		const downloadEl = document.getElementById('qosify-download');
		const uploadEl = document.getElementById('qosify-upload');
		if (!enabledEl || !ifaceEl || !downloadEl || !uploadEl) return;

		try {
			const config = await this.readQoSifyConfig();
			let sectionCfg = null;
			if (config?.values) {
				for (const cfg of Object.values(config.values)) {
					const type = String(cfg?.['.type'] || '');
					if (type === 'qosify' || type === 'defaults') {
						sectionCfg = cfg;
						break;
					}
				}
				if (!sectionCfg) {
					const first = Object.values(config.values)[0];
					if (first && typeof first === 'object') sectionCfg = first;
				}
			}

			if (!sectionCfg) {
				enabledEl.value = '0';
				ifaceEl.value = '';
				downloadEl.value = '';
				uploadEl.value = '';
				if (installHintEl) installHintEl.classList.remove('hidden');
			} else {
				enabledEl.value = this.isEnabledValue(sectionCfg.enabled ?? '0') ? '1' : '0';
				ifaceEl.value = String(sectionCfg.interface || '');
				downloadEl.value = String(sectionCfg.download || '');
				uploadEl.value = String(sectionCfg.upload || '');
				if (installHintEl) installHintEl.classList.add('hidden');
			}
		} catch {
			enabledEl.value = '0';
			ifaceEl.value = '';
			downloadEl.value = '';
			uploadEl.value = '';
			if (installHintEl) installHintEl.classList.remove('hidden');
		}

		await this.refreshQoSifyServiceStatus();
	}

	async ensureQoSifyConfigSection() {
		const [status, result] = await this.core.uciGet('qosify');
		if (status === 0 && result?.values) {
			for (const [section, cfg] of Object.entries(result.values)) {
				const type = String(cfg?.['.type'] || '');
				if (type === 'qosify' || type === 'defaults') return section;
			}
			const firstSection = Object.keys(result.values)[0];
			if (firstSection) return firstSection;
		}
		const [addStatus, addResult] = await this.core.uciAdd('qosify', 'qosify', 'qosify');
		if (addStatus !== 0 || !addResult?.section) throw new Error('Unable to create qosify config section');
		return addResult.section;
	}

	async saveQoSifyConfig() {
		const enabled = String(document.getElementById('qosify-enabled')?.value || '0') === '1' ? '1' : '0';
		const iface = String(document.getElementById('qosify-interface')?.value || '').trim();
		const download = String(document.getElementById('qosify-download')?.value || '').trim();
		const upload = String(document.getElementById('qosify-upload')?.value || '').trim();
		try {
			const section = await this.ensureQoSifyConfigSection();
			await this.core.uciSet('qosify', section, {
				enabled,
				interface: iface,
				download,
				upload
			});
			await this.core.uciCommit('qosify');
			this.core.showToast('QoSify configuration saved', 'success');
			await this.loadQoSify();
		} catch {
			this.core.showToast('Failed to save QoSify configuration', 'error');
		}
	}

	async runQoSifyServiceAction(action) {
		if (!action) return;
		try {
			const [status] = await this.core.ubusCall('file', 'exec', {
				command: '/etc/init.d/qosify',
				params: [String(action)]
			});
			if (status !== 0) throw new Error('service action failed');
			this.core.showToast(`QoSify ${action} completed`, 'success');
			await this.refreshQoSifyServiceStatus();
		} catch {
			this.core.showToast(`Failed to ${action} QoSify service`, 'error');
		}
	}

	async loadVPN() {
		await this.core.loadResource('wg-peers-table', 6, 'wireguard', async () => {
			const [status, result] = await this.core.uciGet('network');
			if (status !== 0 || !result?.values) throw new Error('No data');
			const config = result.values;

			const wgIface = Object.entries(config).find(([, v]) => v.proto === 'wireguard');
			if (wgIface) {
				const [, c] = wgIface;
				document.getElementById('wg-enabled').value = c.disabled === '1' ? '0' : '1';
				document.getElementById('wg-interface').value = wgIface[0];
				document.getElementById('wg-port').value = c.listen_port || '51820';
				document.getElementById('wg-private-key').value = c.private_key || '';
				document.getElementById('wg-address').value = Array.isArray(c.addresses)
					? c.addresses[0] || ''
					: c.addresses || '';
			}

			const peers = Object.entries(config)
				.filter(([, v]) => v['.type']?.startsWith('wireguard_'))
				.map(([k, v]) => ({ section: k, ...v }));

			const tbody = document.querySelector('#wg-peers-table tbody');
			if (!tbody) return;
			if (peers.length === 0) {
				this.core.renderEmptyTable(tbody, 6, 'No WireGuard peers configured');
				return;
			}
			tbody.innerHTML = peers
				.map(p => {
					const pubKey = p.public_key ? this.core.escapeHtml(p.public_key.substring(0, 20)) + '...' : 'N/A';
					const endpoint =
						p.endpoint_host && p.endpoint_port
							? `${this.core.escapeHtml(p.endpoint_host)}:${this.core.escapeHtml(String(p.endpoint_port))}`
							: 'N/A';
					return `<tr>
					<td data-label="Name">${this.core.escapeHtml(p.description || p.section)}</td>
					<td data-label="Public Key">${pubKey}</td>
					<td data-label="Allowed IPs">${this.core.escapeHtml(Array.isArray(p.allowed_ips) ? p.allowed_ips.join(', ') : p.allowed_ips || 'N/A')}</td>
					<td data-label="Endpoint">${endpoint}</td>
					<td data-label="Status">${this.core.renderBadge('success', 'CONFIGURED')}</td>
					<td data-label="Actions">${this.core.renderActionButtons(p.section)}</td>
				</tr>`;
				})
				.join('');
		});
	}

	async saveWgConfig() {
		try {
			const ifaceName = document.getElementById('wg-interface').value || 'wg0';
			const values = {
				proto: 'wireguard',
				listen_port: document.getElementById('wg-port').value,
				private_key: document.getElementById('wg-private-key').value,
				addresses: [document.getElementById('wg-address').value]
			};
			const disabled = document.getElementById('wg-enabled').value === '0';
			if (disabled) values.disabled = '1';
			else values.disabled = '0';

			await this.core.uciSet('network', ifaceName, values);
			await this.core.uciCommit('network');
			this.core.showToast('WireGuard configuration saved', 'success');
		} catch {
			this.core.showToast('Failed to save WireGuard config', 'error');
		}
	}

	async generateWgKeys() {
		let wroteKeyFile = false;
		try {
			const [s, r] = await this.core.ubusCall('file', 'exec', {
				command: '/usr/bin/wg',
				params: ['genkey']
			});
			if (s !== 0 || !r?.stdout) throw new Error('Key generation failed');
			const privateKey = r.stdout.trim();
			if (!/^[A-Za-z0-9+/]{43}=$/.test(privateKey)) {
				throw new Error('Invalid key format');
			}
			document.getElementById('wg-private-key').value = privateKey;

			await this.core.ubusCall('file', 'write', {
				path: '/tmp/.wg_priv.key',
				data: privateKey + '\n'
			});
			wroteKeyFile = true;

			const [s2, r2] = await this.core.ubusCall('file', 'exec', {
				command: '/bin/sh',
				params: ['-c', 'cat /tmp/.wg_priv.key | /usr/bin/wg pubkey']
			});
			if (s2 === 0 && r2?.stdout) {
				document.getElementById('wg-public-key').value = r2.stdout.trim();
			}
			this.core.showToast('Keys generated', 'success');
		} catch {
			this.core.showToast('Failed to generate keys', 'error');
		} finally {
			if (wroteKeyFile) {
				try {
					await this.core.ubusCall('file', 'exec', {
						command: '/bin/rm',
						params: ['-f', '/tmp/.wg_priv.key']
					});
				} catch {}
			}
		}
	}

	parseWgProfileConfig(raw) {
		const text = String(raw || '').replace(/\r/g, '');
		const lines = text.split('\n');
		let section = '';
		const iface = {};
		const peer = {};
		for (const lineRaw of lines) {
			const line = String(lineRaw || '').trim();
			if (!line || line.startsWith('#') || line.startsWith(';')) continue;
			if (line.startsWith('[') && line.endsWith(']')) {
				section = line.slice(1, -1).trim().toLowerCase();
				continue;
			}
			const eqIdx = line.indexOf('=');
			if (eqIdx < 0) continue;
			const key = line.slice(0, eqIdx).trim();
			const value = line.slice(eqIdx + 1).trim();
			if (!key) continue;

			if (section === 'interface') {
				if (key === 'Address') iface.address = value;
				else if (key === 'PrivateKey') iface.privateKey = value;
				else if (key === 'DNS') iface.dns = value;
			} else if (section === 'peer') {
				if (key === 'PublicKey') peer.publicKey = value;
				else if (key === 'AllowedIPs') peer.allowedIps = value;
				else if (key === 'Endpoint') peer.endpoint = value;
				else if (key === 'PersistentKeepalive') peer.keepalive = value;
				else if (key === 'PresharedKey') peer.presharedKey = value;
			}
		}

		const endpoint = String(peer.endpoint || '').trim();
		let endpointHost = '';
		let endpointPort = '';
		if (endpoint) {
			const m = endpoint.match(/^\[([^\]]+)\]:(\d+)$/) || endpoint.match(/^([^:]+):(\d+)$/);
			if (m) {
				endpointHost = String(m[1] || '').trim();
				endpointPort = String(m[2] || '').trim();
			}
		}

		const splitList = value =>
			String(value || '')
				.split(',')
				.map(v => String(v || '').trim())
				.filter(Boolean);

		const addresses = splitList(iface.address);
		const dns = splitList(iface.dns);
		const allowedIps = splitList(peer.allowedIps);

		if (allowedIps.length === 0) allowedIps.push('0.0.0.0/0');
		if (!allowedIps.includes('0.0.0.0/0')) allowedIps.unshift('0.0.0.0/0');

		return {
			addresses,
			privateKey: String(iface.privateKey || '').trim(),
			dns,
			publicKey: String(peer.publicKey || '').trim(),
			allowedIps,
			endpointHost,
			endpointPort,
			keepalive: String(peer.keepalive || '').trim(),
			presharedKey: String(peer.presharedKey || '').trim()
		};
	}

	async ensureWgClientFirewall() {
		const [status, result] = await this.core.uciGet('firewall');
		const values = status === 0 && result?.values ? result.values : {};

		let zoneSection = '';
		let lanZoneName = 'lan';
		let forwardExists = false;

		for (const [section, cfg] of Object.entries(values)) {
			if (String(cfg?.['.type'] || '') === 'zone') {
				const name = String(cfg.name || '').trim();
				const networks = Array.isArray(cfg.network)
					? cfg.network.map(v => String(v || '').trim())
					: String(cfg.network || '')
							.split(/\s+/)
							.map(v => String(v || '').trim())
							.filter(Boolean);
				if (name === 'wgclient' || networks.includes('wgclient')) zoneSection = section;
				if (name === 'lan') lanZoneName = 'lan';
			}
			if (String(cfg?.['.type'] || '') === 'forwarding') {
				const src = String(cfg.src || '').trim();
				const dest = String(cfg.dest || '').trim();
				if (src === 'lan' && dest === 'wgclient') forwardExists = true;
			}
		}

		const zoneValues = {
			name: 'wgclient',
			network: ['wgclient'],
			input: 'REJECT',
			output: 'ACCEPT',
			forward: 'REJECT',
			masq: '1',
			mtu_fix: '1'
		};
		if (zoneSection) {
			await this.core.uciSet('firewall', zoneSection, zoneValues);
		} else {
			const [, addRes] = await this.core.uciAdd('firewall', 'zone');
			if (addRes?.section) await this.core.uciSet('firewall', addRes.section, zoneValues);
		}

		if (!forwardExists) {
			const [, fwdRes] = await this.core.uciAdd('firewall', 'forwarding');
			if (fwdRes?.section) {
				await this.core.uciSet('firewall', fwdRes.section, {
					src: lanZoneName || 'lan',
					dest: 'wgclient'
				});
			}
		}
	}

	async importWgProfile() {
		const raw = String(document.getElementById('wg-import-config')?.value || '');
		const parsed = this.parseWgProfileConfig(raw);

		if (!parsed.privateKey || !parsed.publicKey || !parsed.endpointHost || !parsed.endpointPort) {
			this.core.showToast('Invalid profile: missing private/public key or endpoint', 'error');
			return;
		}
		if (!Array.isArray(parsed.addresses) || parsed.addresses.length === 0) {
			this.core.showToast('Invalid profile: missing interface Address', 'error');
			return;
		}

		try {
			const ifaceName = 'wgclient';
			const [n0Status, n0Result] = await this.core.uciGet('network');
			let hasIface = false;
			if (n0Status === 0 && n0Result?.values) {
				const cfg = n0Result.values[ifaceName];
				hasIface = String(cfg?.['.type'] || '') === 'interface';
			}
			if (!hasIface) {
				const [addStatus] = await this.core.uciAdd('network', 'interface', ifaceName);
				if (addStatus !== 0) {
					await this.core.ubusCall('uci', 'set', {
						config: 'network',
						section: ifaceName,
						type: 'interface',
						values: {}
					});
				}
			}
			await this.core.uciSet('network', ifaceName, {
				proto: 'wireguard',
				private_key: parsed.privateKey,
				addresses: parsed.addresses,
				dns: parsed.dns,
				peerdns: parsed.dns.length > 0 ? '0' : '1',
				auto: '1',
				disabled: '0'
			});

			const [nStatus, nResult] = await this.core.uciGet('network');
			let peerSection = '';
			if (nStatus === 0 && nResult?.values) {
				for (const [section, cfg] of Object.entries(nResult.values)) {
					if (String(cfg?.['.type'] || '') !== `wireguard_${ifaceName}`) continue;
					if (String(cfg.public_key || '').trim() === parsed.publicKey) {
						peerSection = section;
						break;
					}
				}
			}
			if (!peerSection) {
				const [, addRes] = await this.core.uciAdd('network', `wireguard_${ifaceName}`);
				peerSection = String(addRes?.section || '').trim();
			}
			if (!peerSection) throw new Error('Failed to create WireGuard peer');

			await this.core.uciSet('network', peerSection, {
				public_key: parsed.publicKey,
				allowed_ips: parsed.allowedIps,
				endpoint_host: parsed.endpointHost,
				endpoint_port: parsed.endpointPort,
				route_allowed_ips: '1',
				persistent_keepalive: parsed.keepalive || '25',
				preshared_key: parsed.presharedKey || ''
			});

			await this.core.uciCommit('network');

			const [verifyStatus, verifyResult] = await this.core.uciGet('network', ifaceName);
			if (verifyStatus !== 0 || String(verifyResult?.values?.['.type'] || '') !== 'interface') {
				throw new Error('WireGuard interface was not created');
			}

			await this.ensureWgClientFirewall();
			await this.core.uciCommit('firewall');
			try {
				await this.exec('/etc/init.d/network', ['restart']);
			} catch {}
			try {
				await this.exec('/etc/init.d/firewall', ['restart']);
			} catch {}

			const wgIfaceEl = document.getElementById('wg-interface');
			const wgEnabledEl = document.getElementById('wg-enabled');
			const wgPrivateKeyEl = document.getElementById('wg-private-key');
			const wgAddressEl = document.getElementById('wg-address');
			if (wgIfaceEl) wgIfaceEl.value = ifaceName;
			if (wgEnabledEl) wgEnabledEl.value = '1';
			if (wgPrivateKeyEl) wgPrivateKeyEl.value = parsed.privateKey;
			if (wgAddressEl) wgAddressEl.value = parsed.addresses[0] || '';

			this.core.closeModal('wg-import-modal');
			this.core.showToast('WireGuard VPN profile imported', 'success');
			await this.loadVPN();
		} catch (err) {
			console.error('Failed to import WireGuard profile:', err);
			this.core.showToast('Failed to import WireGuard profile', 'error');
		}
	}

	async editWgPeer(id) {
		try {
			const [status, result] = await this.core.uciGet('network', id);
			if (status !== 0 || !result?.values) throw new Error('Not found');
			const c = result.values;
			document.getElementById('edit-wg-peer-section').value = id;
			document.getElementById('edit-wg-peer-name').value = c.description || '';
			document.getElementById('edit-wg-peer-public-key').value = c.public_key || '';
			document.getElementById('edit-wg-peer-allowed-ips').value = Array.isArray(c.allowed_ips)
				? c.allowed_ips.join(', ')
				: c.allowed_ips || '';
			document.getElementById('edit-wg-peer-keepalive').value = c.persistent_keepalive || '';
			document.getElementById('edit-wg-peer-preshared-key').value = c.preshared_key || '';
			this.core.openModal('wg-peer-modal');
		} catch {
			this.core.showToast('Failed to load peer config', 'error');
		}
	}

	async saveWgPeer() {
		const section = document.getElementById('edit-wg-peer-section').value;
		const ifaceName = document.getElementById('wg-interface').value || 'wg0';
		const values = {
			description: document.getElementById('edit-wg-peer-name').value,
			public_key: document.getElementById('edit-wg-peer-public-key').value,
			allowed_ips: document
				.getElementById('edit-wg-peer-allowed-ips')
				.value.split(/[,\s]+/)
				.filter(Boolean),
			persistent_keepalive: document.getElementById('edit-wg-peer-keepalive').value,
			preshared_key: document.getElementById('edit-wg-peer-preshared-key').value
		};
		try {
			if (section) {
				await this.core.uciSet('network', section, values);
			} else {
				const [, res] = await this.core.uciAdd('network', `wireguard_${ifaceName}`);
				if (!res?.section) throw new Error('Failed to create section');
				await this.core.uciSet('network', res.section, values);
			}
			await this.core.uciCommit('network');
			this.core.closeModal('wg-peer-modal');
			this.core.showToast('WireGuard peer saved', 'success');
			this.loadVPN();
		} catch {
			this.core.showToast('Failed to save WireGuard peer', 'error');
		}
	}

	async deleteWgPeer(id) {
		if (!confirm('Delete this WireGuard peer?')) return;
		try {
			await this.core.uciDelete('network', id);
			await this.core.uciCommit('network');
			this.core.showToast('Peer deleted', 'success');
			this.loadVPN();
		} catch {
			this.core.showToast('Failed to delete peer', 'error');
		}
	}

	async loadDiagnostics() {
		if (!this.core.isFeatureEnabled('diagnostics')) return;
		await this.loadWoLDeviceOptions();
	}

	async loadWoLDeviceOptions() {
		const list = document.getElementById('wol-device-list');
		const hint = document.getElementById('wol-hint');
		if (!list) return;

		let leases = [];
		try {
			const [status, result] = await this.core.ubusCall('luci-rpc', 'getDHCPLeases', {});
			if (status === 0 && Array.isArray(result?.dhcp_leases)) {
				leases = result.dhcp_leases;
			}
		} catch {}

		const options = leases
			.filter(lease => lease?.macaddr)
			.map(lease => {
				const hostname = String(lease.hostname || 'Unknown');
				const ipaddr = String(lease.ipaddr || 'N/A');
				const macaddr = String(lease.macaddr || '').toLowerCase();
				return {
					value: macaddr,
					label: `${hostname} (${ipaddr})`
				};
			})
			.sort((a, b) => a.label.localeCompare(b.label));

		list.innerHTML = '';
		for (const option of options) {
			const el = document.createElement('option');
			el.value = option.value;
			el.label = option.label;
			list.appendChild(el);
		}

		if (hint) {
			if (options.length > 0) {
				hint.textContent = `Loaded ${options.length} DHCP lease device(s). Pick from suggestions or enter a MAC manually.`;
			} else {
				hint.textContent = 'No DHCP lease devices found. Enter a MAC address manually.';
			}
		}
	}

	async loadConnections() {
		this.startConnectionsAutoRefresh();
		this.updateConnectionsDnsToggleButton();
		await this.core.loadResource('network-active-connections-table', 5, null, async () => {
			await this.renderConnectionsTable();
		});
	}

	async renderConnectionsTable() {
		const tbody = document.querySelector('#network-active-connections-table tbody');
		if (!tbody) return;

		let connections = await this.fetchConnections();
		if (!Array.isArray(connections)) connections = [];
		const leaseByIp = await this.fetchConnectionLeaseHostByIpMap();
		if (this.connectionsDnsLookupEnabled) {
			await this.resolveDestinationHostnames(connections);
		}

		if (connections.length === 0) {
			this.core.renderEmptyTable(tbody, 5, 'No active conntrack connections');
			return;
		}

		tbody.innerHTML = connections
			.map(conn => {
				const source = this.formatConnectionSource(conn, leaseByIp);
				const destination = this.formatConnectionDestination(conn);
				const protocol = (conn.protocol || 'N/A').toUpperCase();
				const status = conn.state || 'ACTIVE';
				const transfer = this.formatConntrackTransfer(conn);
				return `<tr>
			<td data-label="Protocol">${this.core.escapeHtml(protocol)}</td>
			<td data-label="Source">${this.core.escapeHtml(source)}</td>
			<td data-label="Destination">${this.core.escapeHtml(destination)}</td>
			<td data-label="Transfer">${this.core.escapeHtml(transfer)}</td>
			<td data-label="Status">${this.renderConntrackStateBadge(status)}</td>
		</tr>`;
			})
			.join('');
	}

	startConnectionsAutoRefresh() {
		if (this.connectionsRefreshTimer) return;
		this.connectionsRefreshTimer = setInterval(async () => {
			if (document.hidden) return;
			if (!this.core.currentRoute || !this.core.currentRoute.startsWith('/network/connections')) return;
			if (this.isRefreshingConnections) return;
			this.isRefreshingConnections = true;
			try {
				await this.renderConnectionsTable();
			} finally {
				this.isRefreshingConnections = false;
			}
		}, 5000);
	}

	async refreshConnectionsManually() {
		if (this.isRefreshingConnections) return;
		this.isRefreshingConnections = true;
		try {
			await this.renderConnectionsTable();
		} finally {
			this.isRefreshingConnections = false;
		}
	}

	stopConnectionsAutoRefresh() {
		if (!this.connectionsRefreshTimer) return;
		clearInterval(this.connectionsRefreshTimer);
		this.connectionsRefreshTimer = null;
	}

	async fetchConnections() {
		try {
			const [status, result] = await this.core.ubusCall('file', 'exec', {
				command: '/bin/sh',
				params: [
					'-c',
					'if command -v conntrack >/dev/null 2>&1; then (conntrack -L -o extended 2>/dev/null || conntrack -L 2>/dev/null) | head -n 500; ' +
						'elif [ -r /proc/net/nf_conntrack ]; then head -n 500 /proc/net/nf_conntrack 2>/dev/null; ' +
						'elif [ -r /proc/net/ip_conntrack ]; then head -n 500 /proc/net/ip_conntrack 2>/dev/null; ' +
						'fi'
				]
			});
			if (status !== 0 || !result?.stdout) return [];
			return this.parseConntrackRows(String(result.stdout || ''));
		} catch {
			return [];
		}
	}

	parseConntrackRows(raw) {
		return String(raw || '')
			.split('\n')
			.map(line => line.trim())
			.filter(Boolean)
			.map(line => this.parseConntrackLine(line))
			.filter(Boolean);
	}

	parseConntrackLine(line) {
		const text = String(line || '').trim();
		if (!text) return null;

		const tokens = text.split(/\s+/);
		let protocol = '';
		for (const token of tokens) {
			if (/^(tcp|udp|icmp|icmpv6|sctp|gre|dccp)$/i.test(token)) {
				protocol = token.toLowerCase();
				break;
			}
		}

		const stateMatch = text.match(
			/\b(ESTABLISHED|SYN_SENT|SYN_RECV|FIN_WAIT|TIME_WAIT|CLOSE|CLOSE_WAIT|LAST_ACK|LISTEN|CLOSING|UNREPLIED|ASSURED)\b/i
		);
		const srcMatches = [...text.matchAll(/\bsrc=([^\s]+)/g)];
		const dstMatches = [...text.matchAll(/\bdst=([^\s]+)/g)];
		const sportMatches = [...text.matchAll(/\bsport=([^\s]+)/g)];
		const dportMatches = [...text.matchAll(/\bdport=([^\s]+)/g)];

		const src = srcMatches[0]?.[1] || '';
		const dst = dstMatches[0]?.[1] || '';
		const sport = sportMatches[0]?.[1] || '';
		const dport = dportMatches[0]?.[1] || '';
		const bytes = [...text.matchAll(/\bbytes=(\d+)/g)].reduce((sum, m) => sum + (Number(m[1]) || 0), 0);
		const packets = [...text.matchAll(/\bpackets=(\d+)/g)].reduce((sum, m) => sum + (Number(m[1]) || 0), 0);

		return {
			source: src ? this.formatConntrackEndpoint(src, sport) : 'N/A',
			destination: dst ? this.formatConntrackEndpoint(dst, dport) : 'N/A',
			sourceIp: src || '',
			sourcePort: sport || '',
			destinationIp: dst || '',
			destinationPort: dport || '',
			protocol: protocol || 'unknown',
			state: stateMatch ? stateMatch[1].toUpperCase() : 'ACTIVE',
			transferBytes: bytes,
			transferPackets: packets
		};
	}

	formatConntrackEndpoint(ip, port) {
		const addr = this.isLikelyIpv6(ip) && !String(ip).startsWith('[') ? `[${ip}]` : String(ip || '');
		return port ? `${addr}:${port}` : addr;
	}

	isLikelyIpv4(ip) {
		const text = String(ip || '').trim();
		if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) return false;
		return text.split('.').every(part => {
			const n = Number(part);
			return Number.isInteger(n) && n >= 0 && n <= 255;
		});
	}

	isLikelyIpv6(ip) {
		const text = String(ip || '').trim();
		return text.includes(':');
	}

	isLikelyIpAddress(ip) {
		return this.isLikelyIpv4(ip) || this.isLikelyIpv6(ip);
	}

	async fetchConnectionLeaseHostByIpMap() {
		const now = Date.now();
		if (now - this.connectionsLeaseCacheAt < 30000) {
			return this.connectionsLeaseHostByIpCache;
		}

		const map = new Map();
		try {
			const [status, result] = await this.core.ubusCall('luci-rpc', 'getDHCPLeases', {});
			if (status === 0 && Array.isArray(result?.dhcp_leases)) {
				for (const lease of result.dhcp_leases) {
					const ip = String(lease?.ipaddr || '').trim();
					const hostname = String(lease?.hostname || '').trim();
					if (!ip || !hostname || hostname === '*') continue;
					map.set(ip, hostname);
				}
			}
		} catch {}

		this.connectionsLeaseHostByIpCache = map;
		this.connectionsLeaseCacheAt = now;
		return map;
	}

	formatConnectionSource(conn, leaseByIp) {
		const ip = String(conn?.sourceIp || '').trim();
		const port = String(conn?.sourcePort || '').trim();
		if (!ip) return conn?.source || 'N/A';
		const hostname = leaseByIp?.get(ip);
		if (!hostname) return conn?.source || this.formatConntrackEndpoint(ip, port);
		return `${hostname} (${this.formatConntrackEndpoint(ip, port)})`;
	}

	formatConnectionDestination(conn) {
		const ip = String(conn?.destinationIp || '').trim();
		const port = String(conn?.destinationPort || '').trim();
		const endpoint = ip ? this.formatConntrackEndpoint(ip, port) : conn?.destination || 'N/A';
		if (!ip) return endpoint;
		const resolved = this.connectionsDestinationDnsCache.get(ip);
		if (resolved) return `${resolved} (${endpoint})`;
		return endpoint;
	}

	async resolveDestinationHostnames(connections) {
		const unresolvedIps = [
			...new Set(
				(connections || [])
					.map(conn => String(conn?.destinationIp || '').trim())
					.filter(ip => ip && this.isLikelyIpAddress(ip) && !this.connectionsDestinationDnsCache.has(ip))
			)
		];
		if (unresolvedIps.length === 0) return;

		const batch = unresolvedIps.slice(0, 12);
		const byIp = await this.reverseLookupIps(batch);
		for (const ip of batch) {
			const name = String(byIp.get(ip) || '').trim();
			this.connectionsDestinationDnsCache.set(ip, name);
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

	updateConnectionsDnsToggleButton() {
		const btn = document.getElementById('network-connections-dns-toggle-btn');
		if (!btn) return;
		btn.textContent = this.connectionsDnsLookupEnabled ? 'DNS LOOKUP: ON' : 'DNS LOOKUP: OFF';
		btn.classList.toggle('success', this.connectionsDnsLookupEnabled);
	}

	async toggleConnectionsDnsLookup() {
		this.connectionsDnsLookupEnabled = !this.connectionsDnsLookupEnabled;
		localStorage.setItem('network_connections_dns_lookup', this.connectionsDnsLookupEnabled ? '1' : '0');
		this.updateConnectionsDnsToggleButton();
		await this.refreshConnectionsManually();
	}

	formatConntrackTransfer(conn) {
		const bytes = Number(conn?.transferBytes || 0);
		const packets = Number(conn?.transferPackets || 0);
		return `${this.core.formatBytes(bytes)} (${packets} Pkts.)`;
	}

	renderConntrackStateBadge(state) {
		const s = String(state || 'ACTIVE').toUpperCase();
		if (!this.core.isFeatureEnabled('colorful_graphs')) {
			if (s === 'ESTABLISHED' || s === 'ASSURED') return this.core.renderBadge('success', s);
			if (s === 'UNREPLIED' || s === 'SYN_SENT' || s === 'SYN_RECV') return this.core.renderBadge('warning', s);
			return this.core.renderBadge('info', s);
		}

		if (s === 'ESTABLISHED' || s === 'ASSURED') {
			return `<span class="badge badge-conntrack-good">${this.core.escapeHtml(s)}</span>`;
		}

		if (s === 'UNREPLIED' || s === 'SYN_SENT' || s === 'SYN_RECV' || s === 'TIME_WAIT') {
			return `<span class="badge badge-conntrack-warn">${this.core.escapeHtml(s)}</span>`;
		}

		if (s === 'CLOSE' || s === 'CLOSE_WAIT' || s === 'FIN_WAIT' || s === 'LAST_ACK' || s === 'CLOSING') {
			return `<span class="badge badge-conntrack-bad">${this.core.escapeHtml(s)}</span>`;
		}

		return `<span class="badge badge-conntrack-info">${this.core.escapeHtml(s)}</span>`;
	}

	async runDiagnostic(type) {
		const hostInput = document.getElementById(`${type}-host`);
		const output = document.getElementById(`${type}-output`);
		if (!hostInput || !output) return;

		const host = hostInput.value.trim();
		if (!host) {
			this.core.showToast('Enter a hostname or IP address', 'error');
			return;
		}

		if (!/^[a-zA-Z0-9._:-]+$/.test(host)) {
			this.core.showToast('Invalid hostname', 'error');
			return;
		}

		output.innerHTML = '<div class="log-line">Running...</div>';

		const commands = {
			ping: { command: '/bin/ping', params: ['-c', '5', '-W', '3', host], timeout: 30000 },
			traceroute: {
				command: '/bin/sh',
				params: [
					'-c',
					'if command -v traceroute >/dev/null 2>&1; then traceroute -w 2 -m 15 "$1"; ' +
						'elif command -v traceroute-nanog >/dev/null 2>&1; then traceroute-nanog -w 2 -m 15 "$1"; ' +
						'elif command -v busybox >/dev/null 2>&1; then busybox traceroute -w 2 -m 15 "$1"; ' +
						'else echo "traceroute command not found"; exit 127; fi',
					'sh',
					host
				],
				timeout: 45000
			},
			nslookup: {
				command: '/bin/sh',
				params: [
					'-c',
					'if command -v nslookup >/dev/null 2>&1; then nslookup "$1"; ' +
						'elif command -v busybox >/dev/null 2>&1; then busybox nslookup "$1"; ' +
						'else echo "nslookup command not found"; exit 127; fi',
					'sh',
					host
				],
				timeout: 30000
			}
		};

		try {
			const cmd = commands[type];
			const [s, r] = await this.core.ubusCall('file', 'exec', { command: cmd.command, params: cmd.params }, {
				timeout: cmd.timeout || 30000
			});
			if (s !== 0) throw new Error('Command failed');
			const text = (r.stdout || '') + (r.stderr || '');
			output.innerHTML = text
				.split('\n')
				.filter(l => l.trim())
				.map(l => `<div class="log-line">${this.core.escapeHtml(l)}</div>`)
				.join('');
		} catch {
			output.innerHTML = '<div class="log-line error">Command failed or timed out</div>';
		}
	}

	async runWoL() {
		const macInput = document.getElementById('wol-mac');
		const output = document.getElementById('wol-output');
		if (!macInput || !output) return;

		const mac = macInput.value.trim();
		if (!mac || !/^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(mac)) {
			this.core.showToast('Enter a valid MAC address', 'error');
			return;
		}

		output.innerHTML = '<div class="log-line">Sending WoL packet...</div>';

		try {
			const [s, r] = await this.core.ubusCall('file', 'exec', {
				command: '/usr/bin/etherwake',
				params: ['-b', mac]
			});
			if (s !== 0) throw new Error('Failed');
			const text = r.stdout || r.stderr || 'WoL packet sent successfully';
			output.innerHTML = `<div class="log-line">${this.core.escapeHtml(text.trim() || 'WoL packet sent successfully')}</div>`;
			this.core.showToast('WoL packet sent', 'success');
		} catch {
			output.innerHTML = '<div class="log-line error">Failed to send WoL packet</div>';
		}
	}
}
