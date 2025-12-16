class GrokDownloader {
    constructor() {
        this.activeItemId = null;
        this.selectedUrls = new Set();
        this.isDownloading = false;
        this.itemCounter = 0;
        this.isXKeyDown = false;

        this._bound = false;
        this._intervalId = null;
        this._observer = null;

        this.init();
    }

    init() {
        // Boot immediately and also when navigating within SPA/back-forward cache.
        const bootNow = () => this.boot();

        window.addEventListener('pageshow', bootNow, true);
        window.addEventListener('popstate', bootNow, true);
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) bootNow();
        }, true);

        // Monkeypatch history methods (common for SPAs that don't emit popstate on pushState)
        this.patchHistoryOnce();

        // Keep trying for a while; on SPA view swaps, DOM can appear late.
        this.scheduleBootRetries();

        // And observe DOM changes continually (cheap) so we can inject as soon as prompt appears.
        this.startObserver();
    }

    patchHistoryOnce() {
        if (window.__supergrok_history_patched) return;
        window.__supergrok_history_patched = true;

        const fire = () => window.dispatchEvent(new Event('supergrok:navigation'));

        const origPushState = history.pushState;
        history.pushState = function (...args) {
            const ret = origPushState.apply(this, args);
            fire();
            return ret;
        };

        const origReplaceState = history.replaceState;
        history.replaceState = function (...args) {
            const ret = origReplaceState.apply(this, args);
            fire();
            return ret;
        };

        window.addEventListener('supergrok:navigation', () => {
            this.scheduleBootRetries();
        }, true);
    }

    scheduleBootRetries() {
        // Run a burst of retries; each call cancels previous burst.
        if (this._bootRetryTimer) clearInterval(this._bootRetryTimer);

        let tries = 0;
        this._bootRetryTimer = setInterval(() => {
            tries++;
            this.boot();
            if (tries > 60) { // ~15s
                clearInterval(this._bootRetryTimer);
                this._bootRetryTimer = null;
            }
        }, 250);

        // Also run immediately
        this.boot();
    }

    startObserver() {
        if (this._observer) return;

        this._observer = new MutationObserver(() => {
            // If we are on the right page but missing toolbar, attempt injection.
            if (this.isOnFavoritesPage() && !document.getElementById('grok-toolbar-wrapper')) {
                this.boot();
            }
        });

        this._observer.observe(document.documentElement, { childList: true, subtree: true });
    }

    isOnFavoritesPage() {
        return location.pathname.startsWith('/imagine/favorites');
    }

    findPromptForm() {
        // Prefer the composer wrapper you provided
        const composer = document.querySelector('div.absolute.left-0.bottom-0.w-full.p-3');
        const formInComposer = composer?.querySelector('form');
        if (formInComposer) return formInComposer;

        // Fallbacks
        const byQueryBar = document.querySelector('form .query-bar')?.closest('form');
        if (byQueryBar) return byQueryBar;

        const byMaxWidth = document.querySelector('form.max-w-breakout');
        if (byMaxWidth) return byMaxWidth;

        const byEditor = document.querySelector('form .tiptap[contenteditable="true"]')?.closest('form');
        if (byEditor) return byEditor;

        return null;
    }

    boot() {
        if (!this.isOnFavoritesPage()) return;

        const promptForm = this.findPromptForm();
        if (!promptForm) return;

        this.injectStyles();
        this.injectToolbar(promptForm);

        // If injection failed for some reason, don't proceed.
        if (!document.getElementById('grok-toolbar-wrapper')) return;

        this.addEventListeners();
        this.startPeriodicChecks();
        this.injectSelectButtons();
        this.applyVisuals();
    }

    injectStyles() {
        if (document.getElementById('grok-downloader-styles')) return;
        const style = document.createElement('style');
        style.id = 'grok-downloader-styles';
        style.textContent = `
            #grok-toolbar-wrapper { display: flex; flex-direction: column; align-items: center; width: 100%; max-width: var(--breakout-width, 1024px); }
            #grok-toolbar { display: none; background-color: #1a1a1a; border: 1px solid #333; border-radius: 12px; padding: 8px; gap: 8px; margin-bottom: 8px; align-items: center; justify-content: space-between; width: auto; }
            #grok-toolbar.visible { display: flex; }
            .grok-toolbar-btn { height: 40px; white-space: nowrap; cursor: pointer; font-weight: 600; border-radius: 9999px; font-size: 14px; transition: all 0.2s; padding: 0 16px; }
            #grok-dl-btn { background: #22c55e; color: white; border: none; }
            #grok-deselect-btn { background: none; color: #9ca3af; border: 1px solid #374151; }
            .grok-select-btn { position: absolute; top: 8px; right: 8px; z-index: 100; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: all 0.2s; opacity: 0; }
            .group\\/media-post-masonry-card:hover .grok-select-btn, .grok-item-selected .grok-select-btn { opacity: 1; }
        `;
        document.head.appendChild(style);
    }

    injectToolbar(promptForm) {
        if (!promptForm) return;

        // If wrapper exists and contains promptForm already, we're done.
        const existingWrapper = document.getElementById('grok-toolbar-wrapper');
        if (existingWrapper) {
            // Ensure wrapper sits right before promptForm and promptForm is inside it.
            if (!existingWrapper.contains(promptForm)) {
                promptForm.parentNode?.insertBefore(existingWrapper, promptForm);
                existingWrapper.appendChild(promptForm);
            }
            return;
        }

        const wrapper = document.createElement('div');
        wrapper.id = 'grok-toolbar-wrapper';

        const toolbar = document.createElement('div');
        toolbar.id = 'grok-toolbar';
        toolbar.innerHTML = `
            <div style="display: flex; align-items: center; gap: 12px;">
              <span id="grok-selection-count" style="font-size: 14px; color: #a0a0a0; margin-left: 8px;"></span>
              <span id="grok-status" style="font-size: 12px; color: #FFD700; min-height: 1.2em;"></span>
            </div>
            <div style="display: flex; align-items: center; gap: 8px;">
              <button id="grok-deselect-btn" class="grok-toolbar-btn">Deselect All</button>
              <button id="grok-dl-btn" class="grok-toolbar-btn">Download ZIP</button>
            </div>
        `;

        // Important: insert wrapper ABOVE the form, then move form into wrapper.
        promptForm.parentNode.insertBefore(wrapper, promptForm);
        wrapper.appendChild(toolbar);
        wrapper.appendChild(promptForm);
    }

    applyVisuals() {
        document.querySelectorAll('.grok-downloader-marker').forEach(marker => marker.remove());
        this.scanAndSortItems().forEach(item => {
            const info = this.getItemInfo(item);
            if (info.url && this.selectedUrls.has(info.url)) this.addMarker(item, 'rgba(239, 239, 68, 0.3)', '98');
            if (item.dataset.grokId === this.activeItemId) this.addMarker(item, 'transparent', '99', '4px solid #3b82f6');
        });
        this.updateToolbar();
    }

    addMarker(item, bgColor, zIndex, border = 'none') {
        const marker = document.createElement('div');
        marker.className = 'grok-downloader-marker';
        marker.style.cssText = `position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: ${bgColor}; border: ${border}; border-radius: 16px; box-sizing: border-box; z-index: ${zIndex}; pointer-events: none;`;
        item.appendChild(marker);
    }

    scanAndSortItems() {
        const cards = Array.from(document.querySelectorAll('.group\\/media-post-masonry-card'));
        cards.forEach(card => {
            if (!card.dataset.grokId) card.dataset.grokId = `grok-card-${this.itemCounter++}`;
        });

        const itemsWithPos = cards.map(card => ({
            el: card,
            top: parseFloat(card.closest('div[role="listitem"]')?.style.top) || 0,
            left: parseFloat(card.closest('div[role="listitem"]')?.style.left) || 0
        }));

        itemsWithPos.sort((a, b) => (Math.abs(a.top - b.top) > 20 ? a.top - b.top : a.left - b.left));
        return itemsWithPos.map(item => item.el);
    }

    getItemInfo(itemEl) {
        const video = itemEl?.querySelector('video');
        if (video?.src) return { type: 'video', url: video.src.split('?')[0] };

        const img = itemEl?.querySelector('img');
        if (img?.src?.includes('imagine-public')) return { type: 'image', url: img.src.split('?')[0] };

        return { type: 'none', url: null };
    }

    updateToolbar() {
        const toolbar = document.getElementById('grok-toolbar');
        if (!toolbar) return;

        toolbar.classList.toggle('visible', this.selectedUrls.size > 0);

        const countEl = toolbar.querySelector('#grok-selection-count');
        if (countEl) countEl.innerText = `${this.selectedUrls.size} item${this.selectedUrls.size === 1 ? '' : 's'} selected`;

        const dlBtn = toolbar.querySelector('#grok-dl-btn');
        if (dlBtn) {
            dlBtn.disabled = this.isDownloading || this.selectedUrls.size === 0;
            dlBtn.style.opacity = dlBtn.disabled ? '0.5' : '1';
        }
    }

    injectSelectButtons() {
        this.scanAndSortItems().forEach(item => {
            const info = this.getItemInfo(item);
            let button = item.querySelector('.grok-select-btn');

            if (!button && info.type !== 'none') {
                button = document.createElement('div');
                button.className = 'grok-select-btn';
                button.onclick = (e) => { e.preventDefault(); e.stopPropagation(); this.toggleSelection(item); };
                item.appendChild(button);
            }

            if (button) {
                const isSelected = info.url && this.selectedUrls.has(info.url);
                button.innerHTML = isSelected
                    ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`
                    : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`;
                button.style.background = isSelected ? `rgba(239, 68, 68, 0.7)` : `rgba(0,0,0,0.6)`;
                item.classList.toggle('grok-item-selected', isSelected);
            }
        });
    }

    toggleSelection(item, forceSelect = null) {
        const info = this.getItemInfo(item);
        if (!info.url) return;

        if (forceSelect === true) this.selectedUrls.add(info.url);
        else if (forceSelect === false) this.selectedUrls.delete(info.url);
        else this.selectedUrls.has(info.url) ? this.selectedUrls.delete(info.url) : this.selectedUrls.add(info.url);

        this.applyVisuals();
        this.injectSelectButtons();
    }

    deselectAll() {
        this.selectedUrls.clear();
        this.applyVisuals();
        this.injectSelectButtons();
    }

    addEventListeners() {
        if (this._bound) return;
        this._bound = true;

        window.addEventListener('keydown', (e) => {
            if (e.key.toLowerCase() === 'x' && !e.repeat) this.isXKeyDown = true;
        }, true);

        window.addEventListener('keyup', (e) => {
            if (e.key.toLowerCase() === 'x') this.isXKeyDown = false;
        }, true);

        window.addEventListener('keydown', (e) => {
            if (e.target.isContentEditable || ['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
            const key = e.key.toLowerCase();

            if (['j', 'k', 'x', 'escape'].includes(key)) {
                e.preventDefault();
                e.stopPropagation();

                if (key === 'escape') return document.activeElement?.blur();

                const items = this.scanAndSortItems();
                if (!items.length) return;

                let currentIndex = items.findIndex(item => item.dataset.grokId === this.activeItemId);

                let needsReset = currentIndex === -1;
                if (!needsReset) {
                    const rect = items[currentIndex].getBoundingClientRect();
                    if (rect.bottom < 0 || rect.top > window.innerHeight) needsReset = true;
                }

                if (needsReset) {
                    const firstInView = items.findIndex(item => {
                        const r = item.getBoundingClientRect();
                        return r.top > 50 && r.top < window.innerHeight;
                    });

                    if (firstInView !== -1) {
                        if (key === 'j') currentIndex = firstInView - 1;
                        else if (key === 'k') currentIndex = firstInView;
                        else if (key === 'x') currentIndex = firstInView;
                    } else {
                        currentIndex = -1;
                    }
                }

                if (key === 'j' || key === 'k') {
                    const nextIndex = key === 'j'
                        ? Math.min(currentIndex + 1, items.length - 1)
                        : Math.max(currentIndex - 1, 0);

                    const newItem = items[nextIndex];
                    if (newItem) {
                        this.activeItemId = newItem.dataset.grokId;
                        newItem.scrollIntoView({ behavior: 'smooth', block: 'center' });

                        if (this.isXKeyDown) this.toggleSelection(newItem, true);
                        setTimeout(() => this.applyVisuals(), 50);
                    }
                } else if (key === 'x' && !e.repeat) {
                    const targetIndex = currentIndex === -1 ? 0 : currentIndex;
                    if (items[targetIndex]) {
                        this.activeItemId = items[targetIndex].dataset.grokId;
                        this.toggleSelection(items[targetIndex]);
                    }
                }
            }
        }, true);

        document.body.addEventListener('click', (e) => {
            if (e.target.id === 'grok-dl-btn') {
                this.isDownloading = true;
                this.applyVisuals();
                chrome.runtime.sendMessage({ action: "downloadFiles", urls: Array.from(this.selectedUrls) });
            } else if (e.target.id === 'grok-deselect-btn') {
                this.deselectAll();
            }
        }, true);

        chrome.runtime.onMessage.addListener((message) => {
            if (message.action === "updateStatus") {
                const statusEl = document.getElementById('grok-status');
                if (statusEl) statusEl.innerText = message.status;

                if (!message.status.includes("...") && !message.status.includes("Preparing")) {
                    this.isDownloading = false;
                    this.applyVisuals();
                }
            }
        });
    }

    startPeriodicChecks() {
        if (this._intervalId) return;
        this._intervalId = setInterval(() => {
            if (!this.isOnFavoritesPage()) return;

            // If SPA removed our toolbar, re-inject.
            if (!document.getElementById('grok-toolbar-wrapper')) {
                const promptForm = this.findPromptForm();
                if (promptForm) this.injectToolbar(promptForm);
            }

            this.injectSelectButtons();
            this.applyVisuals();
        }, 1000);
    }
}

(() => {
    if (window.__supergrokProInstance) return;
    window.__supergrokProInstance = new GrokDownloader();
})();
