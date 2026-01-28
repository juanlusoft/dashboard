/**
 * HomePiNAS - Network View
 * Network interfaces and DDNS management
 */

import { state, API_BASE } from '../state.js';
import { authFetch } from '../utils/api.js';
import { registerView } from '../router.js';

// Local state for DHCP overrides (to track user changes before saving)
const localDhcpState = {};

/**
 * Render the Network Manager view
 */
export async function renderNetworkManager() {
    const dashboardContent = document.getElementById('dashboard-content');
    if (!dashboardContent) return;

    try {
        const res = await fetch(`${API_BASE}/network/interfaces`);
        if (!res.ok) throw new Error('Failed to fetch interfaces');
        state.network.interfaces = await res.json();
    } catch (e) {
        console.error('Network fetch error:', e);
        dashboardContent.innerHTML = '<div class="glass-card"><h3>Error loading network data</h3></div>';
        return;
    }

    const container = document.createElement('div');
    container.className = 'network-grid';

    // 1. Interfaces Section
    const ifaceSection = document.createElement('div');
    const ifaceTitle = document.createElement('h3');
    ifaceTitle.textContent = 'CM5 Network Adapters';
    ifaceTitle.style.marginBottom = '20px';
    ifaceSection.appendChild(ifaceTitle);

    // Grid container for interface cards
    const interfacesGrid = document.createElement('div');
    interfacesGrid.className = 'interfaces-grid';

    state.network.interfaces.forEach(iface => {
        const card = document.createElement('div');
        card.className = 'glass-card interface-card';
        card.dataset.interfaceId = iface.id;

        const isConnected = iface.status === 'connected';
        // Use local state if available, otherwise use server state
        const isDhcp = localDhcpState[iface.id] !== undefined ? localDhcpState[iface.id] : iface.dhcp;

        // Create header
        const header = document.createElement('div');
        header.className = 'interface-header';

        const headerInfo = document.createElement('div');
        const h4 = document.createElement('h4');
        h4.textContent = `${iface.name || 'Unknown'} (${iface.id || 'N/A'})`;
        const statusSpan = document.createElement('span');
        statusSpan.style.cssText = `font-size: 0.8rem; color: ${isConnected ? '#10b981' : '#94a3b8'}`;
        statusSpan.textContent = (iface.status || 'unknown').toUpperCase();
        headerInfo.appendChild(h4);
        headerInfo.appendChild(statusSpan);

        const checkboxItem = document.createElement('div');
        checkboxItem.className = 'checkbox-item';

        const dhcpCheckbox = document.createElement('input');
        dhcpCheckbox.type = 'checkbox';
        dhcpCheckbox.id = `dhcp-${iface.id}`;
        dhcpCheckbox.checked = isDhcp;
        dhcpCheckbox.addEventListener('change', (e) => toggleDHCP(iface.id, e.target.checked, iface));

        const dhcpLabel = document.createElement('label');
        dhcpLabel.htmlFor = `dhcp-${iface.id}`;
        dhcpLabel.textContent = 'DHCP';

        checkboxItem.appendChild(dhcpCheckbox);
        checkboxItem.appendChild(dhcpLabel);

        header.appendChild(headerInfo);
        header.appendChild(checkboxItem);

        // Create form
        const netForm = document.createElement('div');
        netForm.className = 'net-form';
        netForm.id = `netform-${iface.id}`;

        renderNetForm(netForm, iface, isDhcp);

        card.appendChild(header);
        card.appendChild(netForm);
        interfacesGrid.appendChild(card);
    });

    ifaceSection.appendChild(interfacesGrid);

    // 2. DDNS Section
    const ddnsSection = document.createElement('div');
    const ddnsTitle = document.createElement('h3');
    ddnsTitle.style.cssText = 'margin-top: 40px; margin-bottom: 20px;';
    ddnsTitle.textContent = 'Remote Access (DDNS)';
    ddnsSection.appendChild(ddnsTitle);

    const ddnsGrid = document.createElement('div');
    ddnsGrid.className = 'ddns-grid';

    (state.network.ddns || []).forEach(service => {
        const card = document.createElement('div');
        card.className = 'glass-card ddns-card';

        const isOnline = service.status === 'online';

        // Header
        const ddnsHeader = document.createElement('div');
        ddnsHeader.className = 'ddns-header';

        const logo = document.createElement('div');
        logo.className = 'ddns-logo';
        logo.style.background = isOnline ? '#10b981' : '#ef4444';
        logo.textContent = (service.name || 'U').charAt(0);

        const headerInfo = document.createElement('div');
        const serviceH4 = document.createElement('h4');
        serviceH4.textContent = service.name || 'Unknown';
        const statusInfo = document.createElement('span');
        statusInfo.style.fontSize = '0.75rem';
        statusInfo.innerHTML = `<span class="status-dot ${isOnline ? 'status-check-online' : 'status-check-offline'}"></span>${(service.status || 'unknown').toUpperCase()}`;
        headerInfo.appendChild(serviceH4);
        headerInfo.appendChild(statusInfo);

        ddnsHeader.appendChild(logo);
        ddnsHeader.appendChild(headerInfo);

        // Domain row
        const domainRow = document.createElement('div');
        domainRow.className = 'status-row-net';
        const domainLabel = document.createElement('span');
        domainLabel.textContent = 'Domain';
        const domainValue = document.createElement('span');
        domainValue.style.color = 'white';
        domainValue.textContent = service.domain || 'N/A';
        domainRow.appendChild(domainLabel);
        domainRow.appendChild(domainValue);

        // IP row
        const ipRow = document.createElement('div');
        ipRow.className = 'status-row-net';
        const ipLabel = document.createElement('span');
        ipLabel.textContent = 'Gateway IP';
        const ipValue = document.createElement('span');
        ipValue.style.cssText = 'color: #10b981; font-weight: 600;';
        ipValue.textContent = isOnline ? (state.publicIP || '---') : '---';
        ipRow.appendChild(ipLabel);
        ipRow.appendChild(ipValue);

        card.appendChild(ddnsHeader);
        card.appendChild(domainRow);
        card.appendChild(ipRow);
        ddnsGrid.appendChild(card);
    });

    // Add service button
    const addCard = document.createElement('div');
    addCard.className = 'btn-add-ddns';
    addCard.addEventListener('click', openDDNSModal);

    const plusIcon = document.createElement('span');
    plusIcon.className = 'plus-icon';
    plusIcon.textContent = '+';
    const addText = document.createElement('span');
    addText.style.cssText = 'font-size: 0.9rem; font-weight: 600;';
    addText.textContent = 'Add Service';

    addCard.appendChild(plusIcon);
    addCard.appendChild(addText);
    ddnsGrid.appendChild(addCard);

    ddnsSection.appendChild(ddnsGrid);
    container.appendChild(ifaceSection);
    container.appendChild(ddnsSection);
    dashboardContent.appendChild(container);
}

// Render the network form based on DHCP state
function renderNetForm(netForm, iface, isDhcp) {
    netForm.innerHTML = '';

    if (isDhcp) {
        const inputGroup = document.createElement('div');
        inputGroup.className = 'input-group';
        inputGroup.style.gridColumn = '1 / -1';

        const ipInput = document.createElement('input');
        ipInput.type = 'text';
        ipInput.value = iface.ip || '';
        ipInput.disabled = true;
        ipInput.placeholder = ' ';

        const label = document.createElement('label');
        label.textContent = 'Hardware Assigned IP';

        inputGroup.appendChild(ipInput);
        inputGroup.appendChild(label);
        netForm.appendChild(inputGroup);
    } else {
        // IP Input
        const ipGroup = document.createElement('div');
        ipGroup.className = 'input-group';
        const ipInput = document.createElement('input');
        ipInput.type = 'text';
        ipInput.id = `ip-${iface.id}`;
        ipInput.value = iface.ip || '';
        ipInput.placeholder = ' ';
        const ipLabel = document.createElement('label');
        ipLabel.textContent = 'IP Address';
        ipGroup.appendChild(ipInput);
        ipGroup.appendChild(ipLabel);

        // Subnet Input
        const subnetGroup = document.createElement('div');
        subnetGroup.className = 'input-group';
        const subnetInput = document.createElement('input');
        subnetInput.type = 'text';
        subnetInput.id = `subnet-${iface.id}`;
        subnetInput.value = iface.subnet || '';
        subnetInput.placeholder = ' ';
        const subnetLabel = document.createElement('label');
        subnetLabel.textContent = 'Subnet Mask';
        subnetGroup.appendChild(subnetInput);
        subnetGroup.appendChild(subnetLabel);

        netForm.appendChild(ipGroup);
        netForm.appendChild(subnetGroup);
    }

    // Save button
    const btnContainer = document.createElement('div');
    btnContainer.style.cssText = 'display: flex; align-items: flex-end; padding-top: 10px; grid-column: 1 / -1;';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn-primary';
    saveBtn.style.cssText = 'padding: 10px; width: 100%;';
    saveBtn.textContent = 'Save to Node';
    saveBtn.addEventListener('click', () => applyNetwork(iface.id));

    btnContainer.appendChild(saveBtn);
    netForm.appendChild(btnContainer);
}

// Toggle DHCP - update local state and re-render form only
function toggleDHCP(interfaceId, isChecked, iface) {
    localDhcpState[interfaceId] = isChecked;
    const netForm = document.getElementById(`netform-${interfaceId}`);
    if (netForm) {
        renderNetForm(netForm, iface, isChecked);
    }
}

// Apply network configuration
async function applyNetwork(interfaceId) {
    const dhcpCheckbox = document.getElementById(`dhcp-${interfaceId}`);
    const isDhcp = dhcpCheckbox ? dhcpCheckbox.checked : false;

    let config = { dhcp: isDhcp };

    if (!isDhcp) {
        const ipInput = document.getElementById(`ip-${interfaceId}`);
        const subnetInput = document.getElementById(`subnet-${interfaceId}`);

        if (ipInput) config.ip = ipInput.value.trim();
        if (subnetInput) config.subnet = subnetInput.value.trim();

        // Basic validation
        const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

        if (config.ip && !ipRegex.test(config.ip)) {
            alert('Invalid IP address format');
            return;
        }

        if (config.subnet && !ipRegex.test(config.subnet)) {
            alert('Invalid subnet mask format');
            return;
        }
    }

    try {
        const res = await authFetch(`${API_BASE}/network/configure`, {
            method: 'POST',
            body: JSON.stringify({ id: interfaceId, config })
        });

        const data = await res.json();

        if (!res.ok) {
            throw new Error(data.error || 'Network configuration failed');
        }

        alert(data.message || 'Configuration saved');
    } catch (e) {
        console.error('Network config error:', e);
        alert(e.message || 'Failed to apply network configuration');
    }
}

// Open DDNS modal
function openDDNSModal() {
    const ddnsModal = document.getElementById('ddns-modal');
    if (ddnsModal) {
        ddnsModal.style.display = 'flex';
    }
}

// Close DDNS modal
export function closeDDNSModal() {
    const ddnsModal = document.getElementById('ddns-modal');
    if (ddnsModal) {
        ddnsModal.style.display = 'none';
    }
}

// Register this view with the router
registerView('network', renderNetworkManager);
