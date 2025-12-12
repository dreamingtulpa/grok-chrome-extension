try {
    importScripts('jszip.min.js');
} catch (e) {
    console.error("BG ERROR: JSZip not found.", e);
}

// Settings
const CONCURRENCY_LIMIT = 4; // Downloads 4 files at once. Higher might block your internet.
const RETRY_ATTEMPTS = 3;    // Tries 3 times if a file fails
const FETCH_TIMEOUT = 30000; // 30 seconds timeout per file

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "downloadFiles") {
        processBatches(message.urls, sender.tab.id);
        sendResponse({ status: "starting" });
    }
    return true;
});

function extractFileInfo(url) {
    const cleanedUrl = url.split('?')[0];
    const isImage = cleanedUrl.endsWith('.png');
    const extension = isImage ? '.png' : '.mp4';
    let uuid = isImage ? cleanedUrl.split('/').pop().replace('.png', '') : cleanedUrl.split('/').slice(-2, -1)[0];
    return { filename: `${uuid}${extension}`, downloadUrl: `${cleanedUrl}?cache=1&dl=1` };
}

// Wrapper to allow awaiting a Chrome download
function downloadFile(options) {
    return new Promise((resolve, reject) => {
        chrome.downloads.download(options, (id) => {
            if (chrome.runtime.lastError) resolve(null); // Resolve null on error to not break flow
            else resolve(id);
        });
    });
}

// Fetch with Retry and Timeout logic
async function fetchWithRetry(url, attempt = 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.arrayBuffer();

    } catch (error) {
        clearTimeout(timeoutId);
        if (attempt < RETRY_ATTEMPTS) {
            // Wait 1 second before retrying
            await new Promise(r => setTimeout(r, 1000));
            return fetchWithRetry(url, attempt + 1);
        } else {
            throw error;
        }
    }
}

async function processBatches(allUrls, tabId) {
    const update = (text) => chrome.tabs.sendMessage(tabId, { action: "updateStatus", status: text });

    const settings = await chrome.storage.local.get(['batchSize']);
    const batchSize = parseInt(settings.batchSize) || 25;

    const totalFiles = allUrls.length;
    const totalBatches = Math.ceil(totalFiles / batchSize);
    const timestamp = Date.now();

    update(`Preparing ${totalFiles} files in ${totalBatches} batches...`);

    for (let i = 0; i < totalBatches; i++) {
        const start = i * batchSize;
        const end = Math.min(start + batchSize, totalFiles);
        const batchUrls = allUrls.slice(start, end);

        update(`Batch ${i + 1}/${totalBatches}: Processing...`);

        try {
            await createZipAndDownloadBatch(batchUrls, tabId, i + 1, totalBatches, timestamp);
        } catch (err) {
            console.error(err);
            update(`Error in Batch ${i + 1}. Continuing...`);
        }

        // Pause to let memory clear
        if (i < totalBatches - 1) await new Promise(r => setTimeout(r, 2000));
    }

    update("All batches complete!");
    setTimeout(() => update(""), 5000);
}

async function createZipAndDownloadBatch(urls, tabId, batchNum, totalBatches, timestamp) {
    const update = (text) => chrome.tabs.sendMessage(tabId, { action: "updateStatus", status: text });

    if (!self.JSZip) throw new Error("JSZip library failed.");

    let zip = new JSZip();
    let completed = 0;
    let failed = 0;

    // Concurrency Queue Logic
    // We map every URL to a promise, but we limit how many run at once
    async function worker(url) {
        const { filename, downloadUrl } = extractFileInfo(url);
        try {
            const data = await fetchWithRetry(downloadUrl);
            if (data && data.byteLength > 0) {
                zip.file(filename, data);
            } else {
                failed++;
            }
        } catch (e) {
            console.error(`Failed to DL ${filename}:`, e);
            failed++;
        } finally {
            completed++;
            update(`Batch ${batchNum}/${totalBatches}: ${completed}/${urls.length} (${failed > 0 ? failed + ' failed' : ''})`);
        }
    }

    // Run workers with concurrency limit
    const queue = [...urls];
    const workers = [];

    for (let i = 0; i < CONCURRENCY_LIMIT; i++) {
        workers.push((async () => {
            while (queue.length > 0) {
                const url = queue.shift();
                if (url) await worker(url);
            }
        })());
    }

    await Promise.all(workers);

    if (Object.keys(zip.files).length === 0) {
        console.warn(`Batch ${batchNum} empty.`);
        return;
    }

    update(`Batch ${batchNum}/${totalBatches}: Zipping...`);

    const base64 = await zip.generateAsync({
        type: "base64",
        compression: "STORE"
    });

    const dataUrl = `data:application/zip;base64,${base64}`;
    zip = null; // Free memory

    const zipFilename = totalBatches > 1
        ? `grok_media_${timestamp}_part_${batchNum}_of_${totalBatches}.zip`
        : `grok_media_${timestamp}.zip`;

    update(`Batch ${batchNum}/${totalBatches}: Saving...`);

    await downloadFile({
        url: dataUrl,
        filename: zipFilename,
        saveAs: false
    });
}
