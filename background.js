// Configuration - Change BASE_URL here when switching environments
// For localhost: 'http://localhost/Posting_extension'
// For production: 'https://tehub.in'
const CONFIG = {
    BASE_URL: 'https://tehub.in',
    get API_URL() { return `${this.BASE_URL}/admin/api.php`; },
    get UNBLUR_QUEUE_API() { return `${this.BASE_URL}/admin/unblur_queue_api.php`; }
};

// Keep track of controlled tabs
let controlledTabs = [];
let isAutoRunning = false;
let pollIntervalId = null;

// Listen for tab creation
chrome.tabs.onCreated.addListener(function (tab) {
    // Optional: You can add logic here to automatically add tabs to controlled list
});

// Listen for tab removal
chrome.tabs.onRemoved.addListener(function (tabId) {
    controlledTabs = controlledTabs.filter(id => id !== tabId);
});

// Clean up when extension is installed/updated
chrome.runtime.onInstalled.addListener(function () {
    chrome.storage.local.set({
        urls: [],
        buttonSelector: 'Ask an expert',
        buttonIndex: 0
    });
});

// Listen for messages from popup and web pages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'startAutoRun') {
        startAutoRun(request.url, request.count);
        sendResponse({ success: true });
    } else if (request.action === 'restartSubscription') {
        restartSubscription();
        sendResponse({ success: true });
    }
    return true;
});

// Listen for messages from external websites (your admin dashboard)
chrome.runtime.onMessageExternal.addListener((request, sender, sendResponse) => {
    console.log('External message received from:', sender.url);
    console.log('Request:', request);

    if (request.action === 'startAutoRun') {
        if (request.url && request.count) {
            startAutoRun(request.url, request.count);
            sendResponse({ success: true, message: 'Auto Run started' });
        } else {
            sendResponse({ success: false, message: 'Missing url or count parameter' });
        }
    } else if (request.action === 'restartSubscription') {
        restartSubscription();
        sendResponse({ success: true, message: 'Restart Subscription started' });
    } else if (request.action === 'post') {
        // Map 'post' command to startAutoRun logic as requested
        console.log(`Starting Post Sequence: URL=${request.url}, Count=${request.count}`);
        startAutoRun(request.url, request.count || 5);
        sendResponse({ success: true, message: 'Post/AutoRun started' });
    } else if (request.action === 'ping') {
        // Health check
        sendResponse({ success: true, message: 'Extension is active', running: isAutoRunning });
    } else if (request.action === 'getStorage') {
        // Debug: Return storage data
        chrome.storage.local.get(null, (data) => {
            sendResponse({ success: true, data: data });
        });
        return true; // Keep channel open for async response
    } else if (request.action === 'forcePoll') {
        // Debug: Force a poll
        pollCommands().then(() => {
            sendResponse({ success: true, message: 'Poll executed' });
        });
        return true; // Keep channel open for async response
    } else if (request.action === 'openBrowser') {
        // Open a URL in new tab
        const url = request.url || 'https://www.google.com';
        chrome.tabs.create({ url: url, active: true });
        sendResponse({ success: true, message: 'Browser opened with URL: ' + url });
    } else if (request.action === 'closeAllTabs') {
        // Close all tabs except pinned ones
        closeAllTabs();
        sendResponse({ success: true, message: 'Closing all tabs' });
    } else if (request.action === 'closeBrowser') {
        // Close the browser window
        closeBrowserWindow();
        sendResponse({ success: true, message: 'Closing browser' });
    } else {
        sendResponse({ success: false, message: 'Unknown action' });
    }

    return true;
});

// Auto Run workflow in background
async function startAutoRun(url, count) {
    if (isAutoRunning) {
        console.log('Auto Run already in progress');
        return;
    }

    isAutoRunning = true;
    const MAX_TABS = 10;

    // Keep SW alive
    const keepAlive = setInterval(() => {
        chrome.runtime.getPlatformInfo(() => { });
    }, 2000);

    const updateStatus = (message, step, total) => {
        // Send status to all controlled tabs
        controlledTabs.forEach(tabId => {
            chrome.tabs.sendMessage(tabId, {
                action: 'updateStatus',
                message: message,
                step: step,
                total: total
            }).catch(() => { });
        });
    };

    const wait = (seconds) => {
        return new Promise(resolve => {
            let remaining = seconds;
            const interval = setInterval(() => {
                updateStatus(`⏳ Waiting ${remaining} seconds...`, 0, 0);
                remaining--;
                if (remaining < 0) {
                    clearInterval(interval);
                    resolve();
                }
            }, 1000);
        });
    };

    const clickButtonInTabs = (selector) => {
        return new Promise((resolve) => {
            const buttonIndex = 0;
            let completed = 0;
            let successCount = 0;
            let failCount = 0;
            const totalTabs = controlledTabs.length;

            if (totalTabs === 0) {
                resolve({ success: 0, failed: 0, total: 0 });
                return;
            }

            controlledTabs.forEach(tabId => {
                // Try Content Script First
                chrome.tabs.sendMessage(tabId, {
                    action: 'clickButton',
                    selector: selector,
                    index: buttonIndex
                }, function (response) {
                    if (chrome.runtime.lastError || !response || !response.success) {
                        // Fallback: Inject Script with aggressive finding
                        chrome.scripting.executeScript({
                            target: { tabId: tabId },
                            func: (sel) => {
                                const btn = Array.from(document.querySelectorAll('button, a, span, div'))
                                    .find(el => {
                                        const t = (el.innerText || '').toLowerCase();
                                        const s = sel.toLowerCase();
                                        // Specific checks
                                        if (s === 'ask an expert') return t.includes('ask') && t.includes('expert');
                                        if (s === 'post') return t.includes('post') && t.includes('question');
                                        return t.includes(s) || (el.getAttribute('aria-label') || '').toLowerCase().includes(s);
                                    });

                                if (btn) {
                                    btn.click();
                                    return true;
                                }
                                return false;
                            },
                            args: [selector]
                        }).then((res) => {
                            if (res && res[0] && res[0].result) successCount++; else failCount++;
                            completed++;
                            if (completed >= totalTabs) resolve({ success: successCount, failed: failCount, total: totalTabs });
                        }).catch(() => {
                            failCount++;
                            completed++;
                            if (completed >= totalTabs) resolve({ success: successCount, failed: failCount, total: totalTabs });
                        });
                    } else {
                        successCount++;
                        completed++;
                        if (completed >= totalTabs) resolve({ success: successCount, failed: failCount, total: totalTabs });
                    }
                });
            });
        });
    };

    try {
        // Step 1: Open tabs
        updateStatus('📂 Opening tabs...', 1, 7);
        controlledTabs = []; // Reset controlled tabs for this run

        const tabsToOpen = Math.min(Math.max(count, 1), MAX_TABS);
        const openPromises = [];

        for (let i = 0; i < tabsToOpen; i++) {
            const promise = new Promise((resolve) => {
                chrome.tabs.create({ url: url, active: false }, function (tab) {
                    controlledTabs.push(tab.id);
                    resolve();
                });
            });
            openPromises.push(promise);
        }

        await Promise.all(openPromises);
        chrome.storage.local.set({ controlledTabs: controlledTabs });

        // Step 2: Wait 5 seconds for initial page load
        updateStatus('⏳ Waiting for page to load (5s)...', 2, 7);
        await wait(5);

        // Step 3: Reload all tabs
        updateStatus('🔄 Reloading pages...', 3, 7);
        for (const tabId of controlledTabs) {
            try {
                await chrome.tabs.reload(tabId);
            } catch (e) {
                console.log('Tab reload error:', e);
            }
        }

        // Wait 8 seconds after reload for page to fully load
        updateStatus('⏳ Waiting after reload (8s)...', 3, 7);
        await wait(8);

        // Step 4: Click "Ask an expert"
        updateStatus('🔘 Clicking Ask an expert...', 4, 7);
        const step1Result = await clickButtonInTabs('Ask an expert');
        updateStatus(`✅ Step 1: ${step1Result.success}/${step1Result.total} clicked`, 4, 7);
        await wait(2);

        // Step 5: Wait 8 seconds
        updateStatus('⏳ Waiting 8s...', 5, 8);
        await wait(8);

        // Step 6: Click Submit
        updateStatus('➡️ Clicking Submit...', 6, 9);
        await clickButtonInTabs('Chat Submit');

        // Step 7: Wait 25 seconds after submit
        updateStatus('⏳ Waiting 25 seconds...', 7, 9);
        await wait(25);

        // Step 8: Extract questions left from page
        updateStatus('📊 Checking questions left...', 8, 9);
        let questionsLeft = null;
        if (controlledTabs.length > 0) {
            try {
                const result = await chrome.scripting.executeScript({
                    target: { tabId: controlledTabs[0] },
                    func: () => {
                        // Look for text like "You have X expert questions left"
                        const pageText = document.body.innerText;
                        const match = pageText.match(/You have (\d+) expert questions? left/i);
                        if (match) {
                            return parseInt(match[1]);
                        }
                        // Also try other patterns
                        const match2 = pageText.match(/(\d+) expert questions? (left|remaining)/i);
                        if (match2) {
                            return parseInt(match2[1]);
                        }
                        return null;
                    }
                });

                if (result && result[0] && result[0].result !== null) {
                    questionsLeft = result[0].result;
                    console.log('Questions left extracted:', questionsLeft);

                    // Send to server
                    await fetch(CONFIG.API_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: `action=updateQuestionsLeft&instance_id=${instanceId}&questions_left=${questionsLeft}`
                    });
                    updateStatus(`📊 Questions left: ${questionsLeft}`, 8, 9);
                    await wait(2);
                }
            } catch (e) {
                console.log('Could not extract questions left:', e);
            }
        }

        // Step 9: Close all tabs
        updateStatus('🗑️ Closing tabs...', 9, 9);
        for (const tabId of controlledTabs) {
            try {
                await chrome.tabs.remove(tabId);
            } catch (e) {
                console.log('Tab close error:', e);
            }
        }

        // Clear controlled tabs
        controlledTabs = [];
        chrome.storage.local.set({ controlledTabs: [] });

        updateStatus('✅ Completed!' + (questionsLeft !== null ? ` (${questionsLeft} questions left)` : ''), 9, 9);

    } catch (error) {
        updateStatus('❌ Error: ' + error.message, 0, 0);
        console.error('AutoRun Error:', error);
    } finally {
        isAutoRunning = false;
        clearInterval(keepAlive);
    }
}

// Multi-URL Auto Run - Opens ALL URLs at once (each URL gets 'count' tabs)
async function startMultiAutoRun(urls, count) {
    if (isAutoRunning) {
        console.log('Auto Run already in progress');
        return;
    }

    isAutoRunning = true;
    const MAX_TABS_PER_URL = 10;
    const tabsPerUrl = Math.min(Math.max(count, 1), MAX_TABS_PER_URL);

    // Keep SW alive
    const keepAlive = setInterval(() => {
        chrome.runtime.getPlatformInfo(() => { });
    }, 2000);

    const updateStatus = (message, step, total) => {
        controlledTabs.forEach(tabId => {
            chrome.tabs.sendMessage(tabId, {
                action: 'updateStatus',
                message: message,
                step: step,
                total: total
            }).catch(() => { });
        });
    };

    const wait = (seconds) => {
        return new Promise(resolve => {
            let remaining = seconds;
            const interval = setInterval(() => {
                updateStatus(`⏳ Waiting ${remaining} seconds...`, 0, 0);
                remaining--;
                if (remaining < 0) {
                    clearInterval(interval);
                    resolve();
                }
            }, 1000);
        });
    };

    const clickButtonInTabs = (selector) => {
        return new Promise((resolve) => {
            let completed = 0;
            let successCount = 0;
            let failCount = 0;
            const totalTabs = controlledTabs.length;

            if (totalTabs === 0) {
                resolve({ success: 0, failed: 0, total: 0 });
                return;
            }

            controlledTabs.forEach(tabId => {
                chrome.tabs.sendMessage(tabId, {
                    action: 'clickButton',
                    selector: selector,
                    index: 0
                }, function (response) {
                    if (chrome.runtime.lastError || !response || !response.success) {
                        chrome.scripting.executeScript({
                            target: { tabId: tabId },
                            func: (sel) => {
                                const btn = Array.from(document.querySelectorAll('button, a, span, div'))
                                    .find(el => {
                                        const t = (el.innerText || '').toLowerCase();
                                        const s = sel.toLowerCase();
                                        if (s === 'ask an expert') return t.includes('ask') && t.includes('expert');
                                        if (s === 'post') return t.includes('post') && t.includes('question');
                                        return t.includes(s);
                                    });
                                if (btn) { btn.click(); return true; }
                                return false;
                            },
                            args: [selector]
                        }).then((res) => {
                            if (res && res[0] && res[0].result) successCount++; else failCount++;
                            completed++;
                            if (completed >= totalTabs) resolve({ success: successCount, failed: failCount, total: totalTabs });
                        }).catch(() => {
                            failCount++;
                            completed++;
                            if (completed >= totalTabs) resolve({ success: successCount, failed: failCount, total: totalTabs });
                        });
                    } else {
                        successCount++;
                        completed++;
                        if (completed >= totalTabs) resolve({ success: successCount, failed: failCount, total: totalTabs });
                    }
                });
            });
        });
    };

    try {
        console.log(`🚀 Starting Multi-URL AutoRun: ${urls.length} URLs × ${tabsPerUrl} tabs each`);
        
        // Step 1: Open ALL tabs for ALL URLs at once
        updateStatus(`📂 Opening ${urls.length * tabsPerUrl} tabs...`, 1, 7);
        controlledTabs = [];

        const openPromises = [];
        for (const url of urls) {
            for (let i = 0; i < tabsPerUrl; i++) {
                const promise = new Promise((resolve) => {
                    chrome.tabs.create({ url: url, active: false }, function (tab) {
                        controlledTabs.push(tab.id);
                        resolve();
                    });
                });
                openPromises.push(promise);
            }
        }

        await Promise.all(openPromises);
        console.log(`✅ Opened ${controlledTabs.length} tabs`);
        chrome.storage.local.set({ controlledTabs: controlledTabs });

        // Step 2: Wait for initial page load
        updateStatus('⏳ Waiting for pages to load (5s)...', 2, 7);
        await wait(5);

        // Step 3: Reload all tabs
        updateStatus('🔄 Reloading all pages...', 3, 7);
        for (const tabId of controlledTabs) {
            try {
                await chrome.tabs.reload(tabId);
            } catch (e) {
                console.log('Tab reload error:', e);
            }
        }

        updateStatus('⏳ Waiting after reload (8s)...', 3, 7);
        await wait(8);

        // Step 4: Click "Ask an expert" on all tabs
        updateStatus('🔘 Clicking Ask an expert on all tabs...', 4, 7);
        const step1Result = await clickButtonInTabs('Ask an expert');
        updateStatus(`✅ Step 1: ${step1Result.success}/${step1Result.total} clicked`, 4, 7);
        await wait(2);

        // Step 5: Wait
        updateStatus('⏳ Waiting 8s...', 5, 8);
        await wait(8);

        // Step 6: Click Submit on all tabs
        updateStatus('➡️ Clicking Submit on all tabs...', 6, 9);
        await clickButtonInTabs('Chat Submit');

        // Step 7: Wait after submit
        updateStatus('⏳ Waiting 25 seconds...', 7, 9);
        await wait(25);

        // Step 8: Extract questions left
        updateStatus('📊 Checking questions left...', 8, 9);
        let questionsLeft = null;
        if (controlledTabs.length > 0) {
            try {
                const result = await chrome.scripting.executeScript({
                    target: { tabId: controlledTabs[0] },
                    func: () => {
                        const pageText = document.body.innerText;
                        const match = pageText.match(/You have (\d+) expert questions? left/i);
                        if (match) return parseInt(match[1]);
                        const match2 = pageText.match(/(\d+) expert questions? (left|remaining)/i);
                        if (match2) return parseInt(match2[1]);
                        return null;
                    }
                });

                if (result && result[0] && result[0].result !== null) {
                    questionsLeft = result[0].result;
                    console.log('Questions left:', questionsLeft);
                    
                    const data = await chrome.storage.local.get(['instanceId']);
                    if (data.instanceId) {
                        await fetch(CONFIG.API_URL, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                            body: `action=updateQuestionsLeft&instance_id=${data.instanceId}&questions_left=${questionsLeft}`
                        });
                    }
                    updateStatus(`📊 Questions left: ${questionsLeft}`, 8, 9);
                    await wait(2);
                }
            } catch (e) {
                console.log('Could not extract questions left:', e);
            }
        }

        // Step 9: Close all tabs
        updateStatus('🗑️ Closing tabs...', 9, 9);
        for (const tabId of controlledTabs) {
            try {
                await chrome.tabs.remove(tabId);
            } catch (e) {
                console.log('Tab close error:', e);
            }
        }

        controlledTabs = [];
        chrome.storage.local.set({ controlledTabs: [] });

        updateStatus(`✅ Completed ${urls.length} URLs!` + (questionsLeft !== null ? ` (${questionsLeft} questions left)` : ''), 9, 9);

    } catch (error) {
        updateStatus('❌ Error: ' + error.message, 0, 0);
        console.error('Multi AutoRun Error:', error);
    } finally {
        isAutoRunning = false;
        clearInterval(keepAlive);
    }
}

// Restart Subscription / Resubscribe workflow
async function restartSubscription(subscribeUrl) {
    if (isAutoRunning) {
        console.log('Already running, skipping resubscribe');
        return;
    }

    isAutoRunning = true;
    let currentTabId = null;
    console.log('🔄 Starting Resubscribe workflow...');

    // Keep SW alive
    const keepAlive = setInterval(() => {
        chrome.runtime.getPlatformInfo(() => { });
    }, 2000);

    const wait = (seconds) => new Promise(resolve => setTimeout(resolve, seconds * 1000));

    // Status update function for single tab
    const updateStatusSingle = (message, step, total) => {
        console.log(`[Step ${step}/${total}] ${message}`);
        if (currentTabId) {
            chrome.tabs.sendMessage(currentTabId, {
                action: 'updateStatus',
                message: message,
                step: step,
                total: total
            }).catch(() => { });
        }
    };

    // Wait for page to fully load
    const waitForPageLoad = (tabId) => {
        return new Promise((resolve) => {
            const checkComplete = () => {
                chrome.tabs.get(tabId, (tab) => {
                    if (tab && tab.status === 'complete') {
                        resolve();
                    } else {
                        setTimeout(checkComplete, 500);
                    }
                });
            };
            checkComplete();
        });
    };

    // Click button helper function
    const clickButton = async (tabId, selector) => {
        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId: tabId },
                func: (sel) => {
                    // Log all buttons for debugging
                    const allButtons = document.querySelectorAll('button, a[role="button"], [data-test]');
                    console.log('Available buttons on page:');
                    allButtons.forEach((btn, i) => {
                        console.log(`  ${i}: text="${btn.innerText?.trim()}", data-test="${btn.getAttribute('data-test')}", aria-label="${btn.getAttribute('aria-label')}"`);
                    });

                    // Try by data-test attribute
                    let btn = document.querySelector(`[data-test="${sel}"]`);
                    if (btn) {
                        console.log('Found by data-test:', sel);
                        btn.click();
                        return true;
                    }

                    // Try by aria-label
                    btn = document.querySelector(`[aria-label="${sel}"]`);
                    if (btn) {
                        console.log('Found by aria-label:', sel);
                        btn.click();
                        return true;
                    }

                    // Try by text content (case insensitive)
                    const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
                    const textBtn = buttons.find(b => {
                        const text = (b.innerText || b.textContent || '').toLowerCase();
                        return text.includes(sel.toLowerCase());
                    });
                    if (textBtn) {
                        console.log('Found by text:', sel, textBtn.innerText);
                        textBtn.click();
                        return true;
                    }

                    console.log('Button not found:', sel);
                    return false;
                },
                args: [selector]
            });
            return results && results[0] && results[0].result;
        } catch (e) {
            console.error('Click error:', e);
            return false;
        }
    };

    try {
        // Step 1: Navigate to orders page
        updateStatusSingle('🌐 Opening Chegg orders page...', 1, 6);
        const tab = await chrome.tabs.create({
            url: 'https://www.chegg.com/my/orders',
            active: true
        });
        currentTabId = tab.id;

        // Wait for page to fully load
        updateStatusSingle('⏳ Waiting for page to load...', 1, 6);
        await waitForPageLoad(currentTabId);

        // Additional wait for dynamic content
        await wait(10);

        // Step 2: Click Cancel subscription button (CHEGG_STUDY)
        updateStatusSingle('🔘 Step 2: Looking for Cancel button...', 2, 6);

        // Wait a bit more for dynamic content to load
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Try multiple strategies with delays
        let step2Success = await clickButton(currentTabId, 'subscription-cancel-CHEGG_STUDY-button');
        console.log('Step 2 - Attempt 1 (data-test):', step2Success);

        if (!step2Success) {
            updateStatusSingle('⚠️ Trying aria-label...', 2, 6);
            await new Promise(resolve => setTimeout(resolve, 3000));
            step2Success = await clickButton(currentTabId, 'Cancel subscription - Chegg Study');
            console.log('Step 2 - Attempt 2 (aria-label):', step2Success);
        }

        if (!step2Success) {
            updateStatusSingle('⚠️ Trying simple text search...', 2, 6);
            await new Promise(resolve => setTimeout(resolve, 3000));
            step2Success = await clickButton(currentTabId, 'Cancel subscription');
            console.log('Step 2 - Attempt 3 (text):', step2Success);
        }

        if (!step2Success) {
            updateStatusSingle('⚠️ Checking all buttons on page...', 2, 6);
            await new Promise(resolve => setTimeout(resolve, 3000));
            // This will log all visible buttons to console
            step2Success = await clickButton(currentTabId, 'cancel');
            console.log('Step 2 - Attempt 4 (cancel):', step2Success);
        }

        if (step2Success) {
            updateStatusSingle('✅ Cancel button clicked!', 2, 6);
        } else {
            updateStatusSingle('❌ Could not find Cancel button. Check console for button list.', 2, 6);
            // Don't throw error, continue to see what buttons are available
            console.error('FAILED: Could not find Cancel button. Check the console logs above for available buttons.');
        }

        await wait(10);

        // Step 3: Confirm cancellation
        updateStatusSingle('✅ Confirming cancellation...', 3, 6);
        let step3Success = await clickButton(currentTabId, 'cancelation-section-cancel-action-cancel-button');

        if (!step3Success) {
            updateStatusSingle('⚠️ Trying alternative confirmation...', 3, 6);
            await new Promise(resolve => setTimeout(resolve, 2000));
            step3Success = await clickButton(currentTabId, 'Cancel subscription ');
        }

        if (!step3Success) {
            updateStatusSingle('❌ Could not find confirmation button. Please check the page.', 3, 6);
            throw new Error('Confirmation button not found');
        }

        await wait(10);

        // Step 4: Navigate to account page
        updateStatusSingle('🔄 Opening account page...', 4, 6);
        await chrome.tabs.update(currentTabId, { url: 'https://www.chegg.com/my/account' });

        // Wait for page to fully load
        updateStatusSingle('⏳ Waiting for page to load...', 4, 6);
        await waitForPageLoad(currentTabId);

        // Additional wait for dynamic content
        await wait(10);

        // Step 5: Click Resubscribe button (BUNDLE)
        updateStatusSingle('🔘 Clicking Resubscribe...', 5, 6);
        let step5Success = await clickButton(currentTabId, 'subscription-resubscribe-BUNDLE-secondary-button');

        if (!step5Success) {
            updateStatusSingle('⚠️ Trying aria-label Resubscribe...', 5, 6);
            await new Promise(resolve => setTimeout(resolve, 2000));
            step5Success = await clickButton(currentTabId, 'Resubscribe Chegg Study Pack');
        }

        if (!step5Success) {
            updateStatusSingle('⚠️ Trying text-based Resubscribe...', 5, 6);
            await new Promise(resolve => setTimeout(resolve, 2000));
            step5Success = await clickButton(currentTabId, 'Resubscribe');
        }

        if (!step5Success) {
            updateStatusSingle('❌ Could not find Resubscribe button. Please check the page.', 5, 6);
            throw new Error('Resubscribe button not found');
        }

        await wait(10);

        // Step 6: Click Auto-renew button
        updateStatusSingle('✅ Enabling Auto-renew...', 6, 6);
        let step6Success = await clickButton(currentTabId, 'CTA_BUTTON');

        if (!step6Success) {
            updateStatusSingle('⚠️ Trying text-based Auto-renew...', 6, 6);
            await new Promise(resolve => setTimeout(resolve, 2000));
            step6Success = await clickButton(currentTabId, 'Auto-renew');
        }

        if (!step6Success) {
            updateStatusSingle('⚠️ Auto-renew button not found, but process may be complete.', 6, 6);
        }

        // Done
        updateStatusSingle('✅ Subscription restart completed successfully!', 6, 6);
        setTimeout(() => {
            if (currentTabId) {
                chrome.tabs.sendMessage(currentTabId, { action: 'hideStatus' }).catch(() => { });
            }
        }, 5000);

    } catch (error) {
        updateStatusSingle('❌ Error: ' + error.message, 0, 0);
        console.error('❌ Resubscribe Error:', error);
    } finally {
        isAutoRunning = false;
        clearInterval(keepAlive);
    }
}

// Close all tabs (except pinned)
async function closeAllTabs() {
    try {
        const tabs = await chrome.tabs.query({ currentWindow: true, pinned: false });
        const tabIds = tabs.map(tab => tab.id);

        if (tabIds.length > 0) {
            // Keep at least one tab (create blank tab first)
            await chrome.tabs.create({ url: 'about:blank', active: true });
            await chrome.tabs.remove(tabIds);
            console.log(`✅ Closed ${tabIds.length} tabs`);
        }
        return true;
    } catch (e) {
        console.error('Error closing tabs:', e);
        return false;
    }
}

// Close browser window
async function closeBrowserWindow() {
    try {
        const currentWindow = await chrome.windows.getCurrent();
        await chrome.windows.remove(currentWindow.id);
        console.log('✅ Browser window closed');
        return true;
    } catch (e) {
        console.error('Error closing browser:', e);
        return false;
    }
}

// Open browser with URL
async function openBrowserWithUrl(url) {
    try {
        const targetUrl = url || 'https://www.google.com';
        await chrome.tabs.create({ url: targetUrl, active: true });
        console.log('✅ Opened URL:', targetUrl);
        return true;
    } catch (e) {
        console.error('Error opening URL:', e);
        return false;
    }
}

// Polling for commands from Server
async function pollCommands() {
    try {
        // If busy, skip this poll
        if (isAutoRunning) return;

        const data = await chrome.storage.local.get(['instanceId', 'accessToken']);

        // Try instance_id first, fallback to extension_id
        let url = '';
        if (data.instanceId) {
            url = `${CONFIG.API_URL}?action=getPendingCommands&instance_id=${data.instanceId}`;
        } else {
            // Fallback to extension_id
            const extensionId = chrome.runtime.id;
            url = `${CONFIG.API_URL}?action=getPendingCommands&extension_id=${extensionId}`;
        }

        const response = await fetch(url);
        const result = await response.json();

        console.log('Poll result:', result); // Debug logging

        if (result.success && result.commands && result.commands.length > 0) {
            console.log(`Found ${result.commands.length} pending commands`);

            // Process ONE command at a time
            const cmd = result.commands[0];

            // Update status to processing
            await updateCommandStatus(cmd.id, 'processing', 'Started');

            try {
                if (cmd.action === 'post') {
                    const params = JSON.parse(cmd.parameters || '{}');
                    console.log('Executing Poll Command:', params);

                    // Check if multiple URLs are provided
                    if (params.urls && Array.isArray(params.urls) && params.urls.length > 0) {
                        // Multiple URLs - open all at once
                        console.log(`Opening ${params.urls.length} URLs simultaneously`);
                        await startMultiAutoRun(params.urls, params.count);
                    } else if (params.url) {
                        // Single URL (backwards compatibility)
                        await startAutoRun(params.url, params.count);
                    }

                    // Update status to success
                    await updateCommandStatus(cmd.id, 'success', 'Completed successfully');
                } else if (cmd.action === 'resubscribe') {
                    const params = JSON.parse(cmd.parameters || '{}');
                    console.log('Executing Resubscribe Command:', params);

                    // Execute resubscribe workflow
                    await restartSubscription(params.url);

                    // Update status to success
                    await updateCommandStatus(cmd.id, 'success', 'Resubscribe completed');
                } else if (cmd.action === 'unblur') {
                    const params = JSON.parse(cmd.parameters || '{}');
                    console.log('Executing Unblur Command:', params);

                    // Execute unblur workflow
                    const answerData = await performUnblur(cmd.id, params.url);

                    // Update status to success with the answer data
                    const responseStr = JSON.stringify(answerData);
                    await updateCommandStatus(cmd.id, 'success', responseStr);

                    // Also notify the queue system if queue_id is present
                    if (params.queue_id) {
                        try {
                            await fetch(CONFIG.UNBLUR_QUEUE_API, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                                body: `action=completeUnblur&queue_id=${params.queue_id}&status=completed&result=${encodeURIComponent(responseStr)}`
                            });
                            console.log('✅ Queue system notified of completion');
                        } catch (queueErr) {
                            console.error('Failed to notify queue system:', queueErr);
                        }
                    }

                } else if (cmd.action === 'openBrowser') {
                    const params = JSON.parse(cmd.parameters || '{}');
                    const url = params.url || 'https://www.google.com';
                    console.log('Opening browser with URL:', url);
                    await chrome.tabs.create({ url: url, active: true });
                    await updateCommandStatus(cmd.id, 'success', 'Browser opened: ' + url);
                } else if (cmd.action === 'closeAllTabs') {
                    console.log('Closing all tabs...');
                    await closeAllTabs();
                    await updateCommandStatus(cmd.id, 'success', 'All tabs closed');
                } else if (cmd.action === 'closeBrowser') {
                    console.log('Closing browser window...');
                    await updateCommandStatus(cmd.id, 'success', 'Browser closing');
                    await closeBrowserWindow();
                } else if (cmd.action === 'logout') {
                    console.log('Logout command received - clearing access token...');
                    await chrome.storage.local.remove(['accessToken', 'profileName']);
                    await updateCommandStatus(cmd.id, 'success', 'Logged out');
                    // Stop polling and close browser
                    if (pollIntervalId) {
                        clearInterval(pollIntervalId);
                        pollIntervalId = null;
                    }
                    await closeBrowserWindow();
                } else if (cmd.action === 'ping') {
                    await updateCommandStatus(cmd.id, 'success', 'Pong');
                } else {
                    await updateCommandStatus(cmd.id, 'success', 'Completed');
                }
            } catch (err) {
                console.error('Command execution failed:', err);
                await updateCommandStatus(cmd.id, 'failed', err.message);

                // If this was an unblur command, also notify the queue system
                if (cmd.action === 'unblur') {
                    try {
                        const params = JSON.parse(cmd.parameters || '{}');
                        if (params.queue_id) {
                            await fetch(CONFIG.UNBLUR_QUEUE_API, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                                body: `action=completeUnblur&queue_id=${params.queue_id}&status=failed&result=${encodeURIComponent(err.message)}`
                            });
                        }
                    } catch (queueErr) {
                        console.error('Failed to notify queue of failure:', queueErr);
                    }
                }
            }
        }
    } catch (e) {
        console.error('Poll error:', e); // Better error logging
    }
}

// Unblur Workflow with retry logic for slow browsers
async function performUnblur(commandId, url) {
    let tabId = null;
    const MAX_RETRIES = 3;
    const WAIT_BETWEEN_RETRIES = 5000; // 5 seconds between retries

    try {
        await updateCommandStatus(commandId, 'processing', 'Opening URL...');

        // 1. Open URL
        const tab = await chrome.tabs.create({ url: url, active: true });
        tabId = tab.id;

        // 2. Wait for page to fully load (check status)
        await updateCommandStatus(commandId, 'processing', 'Waiting for page to load...');

        // Wait for tab to complete loading
        await new Promise((resolve) => {
            const checkLoad = () => {
                chrome.tabs.get(tabId, (tab) => {
                    if (tab && tab.status === 'complete') {
                        resolve();
                    } else {
                        setTimeout(checkLoad, 500);
                    }
                });
            };
            // Start checking after 2 seconds
            setTimeout(checkLoad, 2000);
            // Max wait 20 seconds
            setTimeout(resolve, 20000);
        });

        // Additional wait for dynamic content (slow browsers)
        await new Promise(resolve => setTimeout(resolve, 8000));

        await updateCommandStatus(commandId, 'processing', 'Extracting Data...');

        // 3. Try to extract data with retries
        let extractedData = null;
        let lastError = null;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            console.log(`Unblur attempt ${attempt}/${MAX_RETRIES}`);
            await updateCommandStatus(commandId, 'processing', `Extracting Data (attempt ${attempt}/${MAX_RETRIES})...`);

            try {
                const result = await chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    func: async () => {
                        try {
                            const currentUrl = window.location.href;
                            let questionId = null;

                            // Helper to search object for key
                            const findKey = (obj, key) => {
                                if (!obj || typeof obj !== 'object') return null;
                                if (obj[key]) return obj[key];
                                for (let k in obj) {
                                    if (obj[k] && typeof obj[k] === 'object') {
                                        const found = findKey(obj[k], key);
                                        if (found) return found;
                                    }
                                }
                                return null;
                            };

                            // Strategy 1: Check standard global data objects (Next.js / Chegg)
                            if (window.__NEXT_DATA__) {
                                try {
                                    const props = window.__NEXT_DATA__.props?.pageProps;
                                    if (props) {
                                        if (props.questionUuid) questionId = props.questionUuid;
                                        else if (props.question?.uuid) questionId = props.question.uuid;
                                        else if (props.contentUuid) questionId = props.contentUuid;

                                        if (!questionId) {
                                            questionId = findKey(props, 'questionUuid') || findKey(props, 'contentUuid');
                                        }
                                    }
                                } catch (err) {
                                    console.log("Error parsing NEXT_DATA:", err);
                                }
                            }

                            // Strategy 2: URL Regex (Question UUID)
                            if (!questionId) {
                                const urlRegex = /(?:-q|question\/)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
                                const urlMatch = currentUrl.match(urlRegex);
                                if (urlMatch) questionId = urlMatch[1];
                            }

                            // Strategy 3: HTML Regex Fallback
                            if (!questionId) {
                                const html = document.body.innerHTML;
                                const patterns = [
                                    /"questionUuid"\s*:\s*"([0-9a-f-]{36})"/i,
                                    /"contentUuid"\s*:\s*"([0-9a-f-]{36})"/i,
                                    /"uuid"\s*:\s*"([0-9a-f-]{36})"/i
                                ];

                                for (let p of patterns) {
                                    const match = html.match(p);
                                    if (match) {
                                        questionId = match[1];
                                        break;
                                    }
                                }
                            }

                            if (!questionId) {
                                return {
                                    error: "Could not identify a valid Question UUID. Page may not be fully loaded.",
                                    retry: true,
                                    _debug_url: currentUrl
                                };
                            }

                            console.log("Extracted UUID:", questionId);

                            // Prepare GraphQL Fetch
                            const graphqlUrl = "https://gateway.chegg.com/one-graph/graphql";
                            const payload = {
                                "operationName": "QnaById",
                                "variables": { "id": questionId },
                                "extensions": {
                                    "persistedQuery": {
                                        "version": 1,
                                        "sha256Hash": "bb6c7023b5bfb7b147725978ec7de015ae02d4de62ac8e17490782af338ce884"
                                    }
                                }
                            };

                            const response = await fetch(graphqlUrl, {
                                "headers": {
                                    "accept": "application/json",
                                    "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
                                    "apollographql-client-name": "chegg-web",
                                    "apollographql-client-version": "main-0b3da3e1-2210795236",
                                    "authorization": "Basic TnNZS3dJMGxMdVhBQWQwenFTMHFlak5UVXAwb1l1WDY6R09JZVdFRnVvNndRRFZ4Ug==",
                                    "content-type": "application/json"
                                },
                                "body": JSON.stringify(payload),
                                "method": "POST",
                                "credentials": "include"
                            });

                            const data = await response.json();

                            // Check if we got valid data
                            if (data.errors) {
                                return {
                                    error: data.errors[0]?.message || "GraphQL error",
                                    retry: true,
                                    _debug_uuid: questionId,
                                    _debug_url: currentUrl
                                };
                            }

                            return {
                                success: true,
                                _debug_uuid: questionId,
                                _debug_url: currentUrl,
                                ...data
                            };

                        } catch (e) {
                            return { error: e.toString(), retry: true };
                        }
                    },
                    world: 'MAIN'
                });

                if (result && result[0] && result[0].result) {
                    const data = result[0].result;

                    // Check if we need to retry
                    if (data.error && data.retry && attempt < MAX_RETRIES) {
                        console.log(`Attempt ${attempt} failed: ${data.error}, retrying...`);
                        lastError = data.error;
                        await new Promise(resolve => setTimeout(resolve, WAIT_BETWEEN_RETRIES));
                        continue;
                    }

                    if (data.error && !data.success) {
                        throw new Error(data.error);
                    }

                    extractedData = data;
                    break;
                }
            } catch (scriptErr) {
                console.error(`Attempt ${attempt} script error:`, scriptErr);
                lastError = scriptErr.message;
                if (attempt < MAX_RETRIES) {
                    await new Promise(resolve => setTimeout(resolve, WAIT_BETWEEN_RETRIES));
                }
            }
        }

        if (!extractedData) {
            throw new Error(lastError || "Failed to extract data after all retries");
        }

        // CONVERSION LOGIC
        try {
            const rawText = extractedData?.data?.questionByUuid?.displayAnswers?.sqnaAnswers?.answerData?.[0]?.bodyV2?.text;

            if (rawText) {
                console.log("Raw text found, parsing...");
                const innerJson = JSON.parse(rawText);

                if (innerJson) {
                    console.log("Converting JSON...");
                    const converted = convertCheggJson(innerJson, {
                        includeExplanations: true,
                        numberSteps: true
                    });
                    extractedData.converted_result = converted;
                    console.log("Conversion successful");
                }
            } else {
                console.log("No raw text found in response path");
            }
        } catch (e) {
            console.error("Conversion failed:", e);
            extractedData.conversion_error = e.toString();
        }

        // Auto-close tab after successful GraphQL response
        if (extractedData && !extractedData.error && tabId) {
            setTimeout(async () => {
                try {
                    await chrome.tabs.remove(tabId);
                    console.log('✅ Chegg tab closed automatically after GraphQL response');
                } catch (closeErr) {
                    console.log('Tab already closed or error:', closeErr.message);
                }
            }, 1500);
        }

        return extractedData;

    } catch (e) {
        console.error("Unblur Error:", e);
        // Try to close tab on error too
        if (tabId) {
            try {
                await chrome.tabs.remove(tabId);
            } catch (closeErr) { }
        }
        throw e;
    }
}

async function updateCommandStatus(commandId, status, responseMsg) {
    try {
        await fetch(CONFIG.API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `action=updateCommandStatus&command_id=${commandId}&status=${status}&response=${encodeURIComponent(responseMsg)}`
        });
    } catch (e) {
        console.error('Failed to update status:', e);
    }
}

// Ensure instance_id exists on startup
async function ensureInstanceId() {
    const data = await chrome.storage.local.get(['instanceId']);
    if (!data.instanceId) {
        const instanceId = 'inst_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
        await chrome.storage.local.set({ instanceId });
        console.log('✅ Generated new instance_id:', instanceId);
    } else {
        console.log('✅ Using existing instance_id:', data.instanceId);
    }
}

// Auto-register profile without token
async function autoRegisterProfile() {
    try {
        const data = await chrome.storage.local.get(['instanceId', 'profileId', 'autoRegistered']);

        // If already registered, just send heartbeat
        if (data.profileId && data.autoRegistered) {
            await sendHeartbeat();
            return;
        }

        const extensionId = chrome.runtime.id;
        const instanceId = data.instanceId;

        // Get actual Chrome profile name from user data directory
        let profileName = 'Unknown Profile';
        try {
            // Try to get profile info from chrome.management
            const info = await chrome.management.getSelf();
            // Extract profile from installType or use a better method

            // Better method: Check the user data directory path
            // Chrome stores profile info in the path, we can infer it
            const userAgent = navigator.userAgent;
            const match = userAgent.match(/Chrome\/[\d.]+/);

            // Use a more reliable method: check window title or storage
            // For now, use a combination of instanceId for uniqueness
            profileName = `Profile-${instanceId.substring(5, 11)}`;

            // Try to get from local storage if previously set
            const stored = await chrome.storage.local.get(['chromeProfileName']);
            if (stored.chromeProfileName) {
                profileName = stored.chromeProfileName;
            }
        } catch (e) {
            console.log('Could not detect profile name, using generated:', e);
        }

        console.log('🔄 Auto-registering profile...');

        const response = await fetch(CONFIG.API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `action=autoRegister&extension_id=${extensionId}&instance_id=${instanceId}&profile_name=${encodeURIComponent(profileName)}`
        });

        const result = await response.json();

        if (result.success) {
            console.log('✅ Auto-registered successfully! Profile ID:', result.id);
            await chrome.storage.local.set({
                profileId: result.id,
                profileName: profileName,
                autoRegistered: true
            });
            await sendHeartbeat();
        } else {
            console.log('⚠️ Auto-register response:', result.message);
        }
    } catch (e) {
        console.error('❌ Auto-register failed:', e.message);
    }
}

// Send heartbeat to keep profile active
async function sendHeartbeat() {
    try {
        const data = await chrome.storage.local.get(['instanceId']);
        const extensionId = chrome.runtime.id;
        const instanceId = data.instanceId || '';
        const url = CONFIG.API_URL;

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `action=heartbeat&extension_id=${extensionId}&instance_id=${instanceId}&is_running=${isAutoRunning ? 'yes' : 'no'}`
        });

        const result = await response.json();
        if (result.success) {
            console.log('💓 Heartbeat sent successfully');
        }
    } catch (e) {
        console.error('❌ Heartbeat failed:', e.message);
    }
}

// Log startup
console.log('🚀 Multi-Tab Controller Extension Started');
console.log('📍 Extension ID:', chrome.runtime.id);

// Initialize on startup
async function initialize() {
    await ensureInstanceId();

    // Auto-register after 2 seconds
    setTimeout(autoRegisterProfile, 2000);

    // Send heartbeat every 5 seconds (keeps profile active)
    setInterval(autoRegisterProfile, 5000);

    // Start polling every 5 seconds
    pollIntervalId = setInterval(pollCommands, 5000);

    // Also poll immediately after short delay
    setTimeout(() => {
        console.log('🔄 Starting command polling...');
        pollCommands();
    }, 3000);
}

initialize();

/**
 * CORE LOGIC: Pass through the original data unchanged.
 * The source data from Chegg's API is already in the correct format.
 * We don't need to add "Step X:" prefixes, generate new IDs, or add wasRenamed properties.
 */
function convertCheggJson(source, options) {
    // Validate source exists
    if (!source) {
        console.warn("convertCheggJson: No source data provided");
        return source;
    }

    // The original Chegg data is already in the correct format!
    // Just return a deep clone to avoid mutating the original.
    return JSON.parse(JSON.stringify(source));
}

