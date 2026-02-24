const scanBtn = document.getElementById('scanBtn');
const results = document.getElementById('results');
const emptyState = document.getElementById('emptyState');
const deviceList = document.getElementById('deviceList');
const count = document.getElementById('count');
const statusBar = document.getElementById('statusBar');

async function startScan() {
  scanBtn.disabled = true;
  scanBtn.innerHTML = '<div class="spinner"></div> Escaneando...';
  results.style.display = 'none';
  emptyState.style.display = 'none';
  statusBar.textContent = 'Escaneando red local...';

  try {
    const devices = await window.finder.scanNetwork();

    if (devices.length > 0) {
      renderDevices(devices);
      results.style.display = 'block';
      statusBar.textContent = `Encontrados ${devices.length} dispositivo(s)`;
    } else {
      emptyState.style.display = 'block';
      statusBar.textContent = 'No se encontraron dispositivos';
    }
  } catch (err) {
    statusBar.textContent = 'Error al escanear: ' + err.message;
    emptyState.style.display = 'block';
  }

  scanBtn.disabled = false;
  scanBtn.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="11" cy="11" r="8"/>
      <path d="M21 21l-4.35-4.35"/>
    </svg>
    Buscar dispositivos
  `;
}

function renderDevices(devices) {
  count.textContent = devices.length;
  deviceList.innerHTML = devices.map(device => `
    <div class="device-card" data-ip="${escapeHtml(device.ip)}">
      <div class="device-icon">
        <svg viewBox="0 0 24 24">
          <path d="M4 6a2 2 0 012-2h12a2 2 0 012 2v4a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM4 14a2 2 0 012-2h12a2 2 0 012 2v4a2 2 0 01-2 2H6a2 2 0 01-2-2v-4z"/>
          <circle cx="8" cy="8" r="1" fill="currentColor"/>
          <circle cx="8" cy="16" r="1" fill="currentColor"/>
        </svg>
      </div>
      <div class="device-info">
        <div class="device-name">${escapeHtml(device.name)}</div>
        <div class="device-ip">${escapeHtml(device.ip)}</div>
        ${device.version ? `<div class="device-version">v${escapeHtml(device.version)}</div>` : ''}
      </div>
      <div class="device-arrow">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M9 18l6-6-6-6"/>
        </svg>
      </div>
    </div>
  `).join('');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Event delegation for device cards
deviceList.addEventListener('click', (event) => {
  const card = event.target.closest('.device-card');
  if (card && card.dataset.ip) {
    window.finder.openNAS(`https://${card.dataset.ip}`);
  }
});

// Scan button event listener
scanBtn.addEventListener('click', startScan);
