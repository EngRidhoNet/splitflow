// filename: popup.js (lanjutan)
let selectedLayout = '2h';
let currentPlan = 'free';
let tabs = [];
let slotAssignments = {}; // tabId -> slotNumber
let isMac = false;

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    // Check platform
    const platformInfo = await chrome.runtime.sendMessage({ action: 'getPlatform' });
    isMac = platformInfo.isMac;

    // Load user ID
    const { userId } = await chrome.storage.sync.get('userId');
    if (userId) {
        document.getElementById('userIdInput').value = userId;
    }

    // Check license
    await updateLicenseStatus(userId || '');

    // Load tabs
    await loadTabs();

    // Setup event listeners
    setupEventListeners();
});

// Update license status
async function updateLicenseStatus(userId) {
    try {
        const license = await chrome.runtime.sendMessage({
            action: 'checkLicense',
            userId
        });

        currentPlan = license.plan || 'free';
        const statusEl = document.getElementById('planStatus');

        if (currentPlan === 'pro' || currentPlan === 'team') {
            statusEl.textContent = `Pro (${currentPlan})`;
            statusEl.classList.add('pro');

            // Enable Pro layouts
            document.getElementById('layout4').classList.remove('disabled');
            document.getElementById('layout3h').classList.remove('disabled');
            document.getElementById('layout3v').classList.remove('disabled');
        } else {
            statusEl.textContent = 'Gratis';
            statusEl.classList.remove('pro');

            // Disable Pro layouts
            document.getElementById('layout4').classList.add('disabled');
            document.getElementById('layout3h').classList.add('disabled');
            document.getElementById('layout3v').classList.add('disabled');
        }
    } catch (error) {
        console.error('License check failed:', error);
    }
}

// Load current window tabs
async function loadTabs() {
    tabs = await chrome.tabs.query({ currentWindow: true });
    const tabList = document.getElementById('tabList');
    tabList.innerHTML = '';

    tabs.forEach((tab, index) => {
        const tabItem = document.createElement('div');
        tabItem.className = 'tab-item';

        const favicon = document.createElement('img');
        favicon.className = 'tab-favicon';
        favicon.src = tab.favIconUrl || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="%23ddd"/></svg>';
        favicon.onerror = () => {
            favicon.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="%23ddd"/></svg>';
        };

        const title = document.createElement('div');
        title.className = 'tab-title';
        title.textContent = tab.title || tab.url;
        title.title = tab.title || tab.url;

        const slotSelector = document.createElement('div');
        slotSelector.className = 'slot-selector';

        // Determine max slots based on selected layout
        let maxSlots = 2;
        if (selectedLayout === '4') maxSlots = 4;
        if (selectedLayout === '3h' || selectedLayout === '3v') maxSlots = 3;

        // Create slot buttons
        for (let slot = 1; slot <= 6; slot++) {
            // Only show relevant slots
            if (slot > maxSlots && slot <= 4) continue;

            const slotRadio = document.createElement('label');
            slotRadio.className = 'slot-radio';
            slotRadio.dataset.slot = slot;

            // Disable slots based on plan
            const isPro = currentPlan === 'pro' || currentPlan === 'team';
            if ((slot > 2) && !isPro) {
                slotRadio.classList.add('pro-only');
            }

            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = `slot-${tab.id}`;
            radio.value = slot;

            // Auto-select first tab for slot 1
            if (index === 0 && slot === 1) {
                radio.checked = true;
                slotRadio.classList.add('selected');
                slotAssignments[tab.id] = slot;
            }

            radio.addEventListener('change', () => {
                if (radio.checked) {
                    // Clear this slot from other tabs
                    Object.keys(slotAssignments).forEach(tabId => {
                        if (slotAssignments[tabId] === slot && tabId !== String(tab.id)) {
                            delete slotAssignments[tabId];
                        }
                    });
                    slotAssignments[tab.id] = slot;

                    // Update visual selection
                    document.querySelectorAll(`[name="slot-${tab.id}"]`).forEach(r => {
                        r.parentElement.classList.remove('selected');
                    });
                    slotRadio.classList.add('selected');
                }
            });

            slotRadio.appendChild(radio);
            slotRadio.appendChild(document.createTextNode(slot));
            slotSelector.appendChild(slotRadio);
        }

        tabItem.appendChild(favicon);
        tabItem.appendChild(title);
        tabItem.appendChild(slotSelector);
        tabList.appendChild(tabItem);
    });
}

// Setup event listeners
function setupEventListeners() {
    // Layout selection
    document.querySelectorAll('.layout-option').forEach(option => {
        option.addEventListener('click', async () => {
            const layout = option.dataset.layout;

            // Prevent selecting Pro layouts on free plan
            const proLayouts = ['4', '3h', '3v'];
            if (proLayouts.includes(layout) && currentPlan !== 'pro' && currentPlan !== 'team') {
                return;
            }

            document.querySelectorAll('.layout-option').forEach(opt => {
                opt.classList.remove('selected');
            });
            option.classList.add('selected');
            selectedLayout = layout;

            // Reload tabs to update slot selectors
            await loadTabs();
        });
    });

    // Default select 2h
    document.querySelector('[data-layout="2h"]').classList.add('selected');

    // Save user ID
    document.getElementById('saveUserId').addEventListener('click', async () => {
        const userId = document.getElementById('userIdInput').value.trim();
        await chrome.storage.sync.set({ userId });
        await updateLicenseStatus(userId);
        await loadTabs();

        // Show confirmation with Mac-style notification
        const statusEl = document.getElementById('planStatus');
        const originalText = statusEl.textContent;
        statusEl.textContent = '✓ Tersimpan';
        setTimeout(() => {
            statusEl.textContent = originalText;
        }, 2000);
    });

    // Split button
    document.getElementById('splitBtn').addEventListener('click', async () => {
        const { userId } = await chrome.storage.sync.get('userId');

        // Get assigned tabs by slot
        const tabsBySlot = {};
        Object.entries(slotAssignments).forEach(([tabId, slot]) => {
            tabsBySlot[slot] = parseInt(tabId);
        });

        // Build tabIds array for tiling
        let numSlots = 2;
        if (selectedLayout === '4') numSlots = 4;
        if (selectedLayout === '3h' || selectedLayout === '3v') numSlots = 3;

        const tabIds = [];
        for (let i = 1; i <= numSlots; i++) {
            if (tabsBySlot[i]) {
                tabIds.push(tabsBySlot[i]);
            }
        }

        // Ensure we have at least some tabs
        if (tabIds.length === 0) {
            alert('Pilih minimal 1 tab untuk di-split');
            return;
        }

        // Send tile request
        const response = await chrome.runtime.sendMessage({
            action: 'tile',
            layout: selectedLayout,
            tabIds: tabIds,
            userId: userId || ''
        });

        if (response.success) {
            window.close();
        }
    });

    // Merge button
    document.getElementById('mergeBtn').addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ action: 'merge' });
        window.close();
    });

    // Handle Enter key in User ID input
    document.getElementById('userIdInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            document.getElementById('saveUserId').click();
        }
    });
}