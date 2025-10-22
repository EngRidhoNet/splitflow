// filename: background.js
const LICENSE_ENDPOINT = "https://your-project-ref.functions.supabase.co/license-verify";

let licenseCache = { plan: 'free', valid: false, ts: 0 };
let embedCache = {}; // origin -> {blocked: boolean, ts: timestamp}

const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Detect if running on macOS
const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

// Mac-specific: Account for menu bar and dock
const MAC_MENUBAR_HEIGHT = 25;
const MAC_DOCK_HEIGHT = 70; // approximate, can be adjusted

// Check license from endpoint
async function checkLicense(userId) {
    const now = Date.now();
    if (licenseCache.ts && (now - licenseCache.ts) < CACHE_DURATION) {
        return licenseCache;
    }

    try {
        const response = await fetch(LICENSE_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId })
        });

        if (response.ok) {
            const data = await response.json();
            licenseCache = {
                plan: data.plan || 'free',
                valid: data.valid || false,
                ts: now
            };
        } else {
            licenseCache = { plan: 'free', valid: false, ts: now };
        }
    } catch (error) {
        console.warn('License check failed, defaulting to free:', error);
        licenseCache = { plan: 'free', valid: false, ts: now };
    }

    return licenseCache;
}

// Get available screen bounds (accounting for Mac menu bar and dock)
async function getAvailableScreenBounds() {
    const currentWindow = await chrome.windows.getCurrent();

    // Get screen dimensions
    let left = currentWindow.left || 0;
    let top = currentWindow.top || 0;
    let width = currentWindow.width || 1920;
    let height = currentWindow.height || 1080;

    // On Mac, adjust for menu bar and dock
    if (isMac) {
        // Menu bar is at top
        top = MAC_MENUBAR_HEIGHT;

        // Reduce height to account for menu bar and dock
        height = height - MAC_MENUBAR_HEIGHT - MAC_DOCK_HEIGHT;

        // Try to get actual screen dimensions from display
        try {
            const displays = await chrome.system.display.getInfo();
            if (displays && displays.length > 0) {
                const primaryDisplay = displays[0];
                width = primaryDisplay.workArea.width;
                height = primaryDisplay.workArea.height;
                left = primaryDisplay.workArea.left;
                top = primaryDisplay.workArea.top;
            }
        } catch (e) {
            // system.display API not available, use calculated values
            console.log('Using calculated screen bounds');
        }
    }

    return { left, top, width, height };
}

// Calculate layout positions
function screenLayouts(bounds, kind) {
    const { left, top, width, height } = bounds;
    const halfW = Math.floor(width / 2);
    const halfH = Math.floor(height / 2);

    switch (kind) {
        case '2h':
            return [
                { left, top, width: halfW, height },
                { left: left + halfW, top, width: halfW, height }
            ];
        case '2v':
            return [
                { left, top, width, height: halfH },
                { left, top: top + halfH, width, height: halfH }
            ];
        case '4':
            return [
                { left, top, width: halfW, height: halfH },
                { left: left + halfW, top, width: halfW, height: halfH },
                { left, top: top + halfH, width: halfW, height: halfH },
                { left: left + halfW, top: top + halfH, width: halfW, height: halfH }
            ];
        case '3v': // Mac bonus: 3 vertical panels
            const thirdH = Math.floor(height / 3);
            return [
                { left, top, width, height: thirdH },
                { left, top: top + thirdH, width, height: thirdH },
                { left, top: top + (thirdH * 2), width, height: thirdH }
            ];
        case '3h': // Mac bonus: 3 horizontal panels
            const thirdW = Math.floor(width / 3);
            return [
                { left, top, width: thirdW, height },
                { left: left + thirdW, top, width: thirdW, height },
                { left: left + (thirdW * 2), top, width: thirdW, height }
            ];
        default:
            return [];
    }
}

// Main tiling function
async function tileWithTabs(layoutKind, tabIds, userId) {
    // Validate Pro requirement for 4+ panels
    if (['4', '3v', '3h'].includes(layoutKind)) {
        const license = await checkLicense(userId);
        if (license.plan !== 'pro' && license.plan !== 'team') {
            chrome.notifications.create({
                type: 'basic',
                iconUrl: 'icons/icon128.png',
                title: 'SplitFlow for Mac - Pro Required',
                message: `Layout ${layoutKind.toUpperCase()} membutuhkan lisensi Pro. Upgrade sekarang!`
            });
            return;
        }
    }

    try {
        // Get available screen bounds (Mac-aware)
        const bounds = await getAvailableScreenBounds();

        // Calculate layouts
        const layouts = screenLayouts(bounds, layoutKind);
        const numPanels = layouts.length;

        // Prepare tab assignments
        const assignments = [];
        for (let i = 0; i < numPanels; i++) {
            assignments.push(tabIds[i] || null);
        }

        // Get current window to close later if needed
        const currentWindow = await chrome.windows.getCurrent();

        // Create windows and move tabs
        for (let i = 0; i < numPanels; i++) {
            const layout = layouts[i];
            const tabId = assignments[i];

            if (tabId) {
                // Move existing tab to new window
                await chrome.windows.create({
                    tabId: tabId,
                    left: layout.left,
                    top: layout.top,
                    width: layout.width,
                    height: layout.height,
                    state: 'normal',
                    focused: i === 0 // Focus first window
                });
            } else {
                // Create new window with new tab
                await chrome.windows.create({
                    url: 'chrome://newtab',
                    left: layout.left,
                    top: layout.top,
                    width: layout.width,
                    height: layout.height,
                    state: 'normal',
                    focused: false
                });
            }
        }

        // Close original window if it's empty
        const tabs = await chrome.tabs.query({ windowId: currentWindow.id });
        if (tabs.length === 0) {
            await chrome.windows.remove(currentWindow.id);
        }

    } catch (error) {
        console.error('Tiling error:', error);
        chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: 'SplitFlow for Mac - Error',
            message: 'Terjadi kesalahan saat membuat layout.'
        });
    }
}

// Merge all windows
async function mergeAllWindows() {
    try {
        const allWindows = await chrome.windows.getAll({ populate: true });
        if (allWindows.length <= 1) return;

        // Get or create target window
        let targetWindow = allWindows.find(w => w.focused);
        if (!targetWindow) targetWindow = allWindows[0];

        // Collect all tabs from other windows
        for (const win of allWindows) {
            if (win.id === targetWindow.id) continue;

            for (const tab of win.tabs) {
                await chrome.tabs.move(tab.id, { windowId: targetWindow.id, index: -1 });
            }
        }

        // Close other windows
        for (const win of allWindows) {
            if (win.id === targetWindow.id) continue;
            try {
                await chrome.windows.remove(win.id);
            } catch (e) {
                // Window might already be closed
            }
        }

        // Maximize target window (Mac-aware)
        if (isMac) {
            // On Mac, use fullscreen state for better experience
            await chrome.windows.update(targetWindow.id, { state: 'fullscreen' });
        } else {
            await chrome.windows.update(targetWindow.id, { state: 'maximized' });
        }

    } catch (error) {
        console.error('Merge error:', error);
    }
}

// Toggle fullscreen for current window (Mac feature)
async function toggleFullscreen() {
    try {
        const currentWindow = await chrome.windows.getCurrent();
        const newState = currentWindow.state === 'fullscreen' ? 'normal' : 'fullscreen';
        await chrome.windows.update(currentWindow.id, { state: newState });
    } catch (error) {
        console.error('Toggle fullscreen error:', error);
    }
}

// Check if URL is embeddable
async function checkEmbeddable(url) {
    try {
        const urlObj = new URL(url);
        const origin = urlObj.origin;
        const now = Date.now();

        // Check cache
        if (embedCache[origin] && (now - embedCache[origin].ts) < CACHE_DURATION) {
            return !embedCache[origin].blocked;
        }

        // Default to blocked for special schemes
        if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') ||
            url.startsWith('about:') || url.startsWith('file://')) {
            embedCache[origin] = { blocked: true, ts: now };
            return false;
        }

        // Assume embeddable by default (will be updated by webRequest listener)
        embedCache[origin] = { blocked: false, ts: now };
        return true;

    } catch (error) {
        return false;
    }
}

// Listen for header responses to detect X-Frame-Options and CSP
chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
        try {
            const url = new URL(details.url);
            const origin = url.origin;
            let blocked = false;

            for (const header of details.responseHeaders || []) {
                const name = header.name.toLowerCase();
                const value = (header.value || '').toLowerCase();

                // Check X-Frame-Options
                if (name === 'x-frame-options') {
                    if (value.includes('deny') || value.includes('sameorigin')) {
                        blocked = true;
                        break;
                    }
                }

                // Check Content-Security-Policy frame-ancestors
                if (name === 'content-security-policy') {
                    if (value.includes('frame-ancestors')) {
                        const frameAncestors = value.match(/frame-ancestors[^;]+/);
                        if (frameAncestors && !frameAncestors[0].includes('*')) {
                            blocked = true;
                            break;
                        }
                    }
                }
            }

            embedCache[origin] = { blocked, ts: Date.now() };
        } catch (error) {
            // Ignore parse errors
        }
    },
    { urls: ["<all_urls>"] },
    ["responseHeaders"]
);

// Message handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'tile') {
        tileWithTabs(message.layout, message.tabIds, message.userId)
            .then(() => sendResponse({ success: true }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }

    if (message.action === 'merge') {
        mergeAllWindows()
            .then(() => sendResponse({ success: true }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }

    if (message.action === 'checkLicense') {
        checkLicense(message.userId)
            .then(license => sendResponse(license))
            .catch(() => sendResponse({ plan: 'free', valid: false }));
        return true;
    }

    if (message.action === 'checkEmbeddable') {
        checkEmbeddable(message.url)
            .then(embeddable => sendResponse({ embeddable }))
            .catch(() => sendResponse({ embeddable: false }));
        return true;
    }

    if (message.action === 'openSplit') {
        const url1 = encodeURIComponent(message.url1);
        const url2 = encodeURIComponent(message.url2);
        chrome.tabs.create({ url: `split.html?u1=${url1}&u2=${url2}` })
            .then(() => sendResponse({ success: true }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }

    if (message.action === 'getPlatform') {
        sendResponse({ isMac: isMac });
        return true;
    }
});

// Command shortcuts
chrome.commands.onCommand.addListener(async (command) => {
    const { userId } = await chrome.storage.sync.get('userId');

    if (command === 'split-2h') {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        const tabIds = tabs.slice(0, 2).map(t => t.id);
        await tileWithTabs('2h', tabIds, userId || '');
    }

    if (command === 'split-2v') {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        const tabIds = tabs.slice(0, 2).map(t => t.id);
        await tileWithTabs('2v', tabIds, userId || '');
    }

    if (command === 'split-4') {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        const tabIds = tabs.slice(0, 4).map(t => t.id);
        await tileWithTabs('4', tabIds, userId || '');
    }

    if (command === 'merge-all') {
        await mergeAllWindows();
    }

    if (command === 'split-fullscreen') {
        await toggleFullscreen();
    }
});