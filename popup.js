document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('batchSize');
    const status = document.getElementById('status');

    // Load saved setting
    chrome.storage.local.get(['batchSize'], (result) => {
        if (result.batchSize) {
            input.value = result.batchSize;
        }
    });

    // Save on change
    input.addEventListener('change', () => {
        const val = parseInt(input.value);

        // Basic validation
        if (val < 1) input.value = 1;
        if (val > 500) input.value = 500;

        chrome.storage.local.set({ batchSize: input.value }, () => {
            status.textContent = "Saved!";
            setTimeout(() => { status.textContent = ""; }, 2000);
        });
    });
});
