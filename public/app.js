// ═══════════════════════════════════════════
// Framer Website Cloner — Frontend Logic
// ═══════════════════════════════════════════

(function () {
  'use strict';

  // ─── State ───────────────────────────────
  const state = {
    pages: [],
    isDiscovering: false,
    isCloning: false,
    currentJobId: null,
  };

  // ─── DOM Elements ────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const siteUrlInput = $('#siteUrl');
  const manualUrlInput = $('#manualUrl');
  const discoverBtn = $('#discoverBtn');
  const discoverBtnText = $('#discoverBtnText');
  const addUrlBtn = $('#addUrlBtn');
  const pageList = $('#pageList');
  const pageListWrapper = $('#pageListWrapper');
  const emptyState = $('#emptyState');
  const pageCountNum = $('#pageCountNum');
  const cloneBtn = $('#cloneBtn');
  const cloneBtnText = $('#cloneBtnText');
  const progressPanel = $('#progressPanel');
  const progressPhase = $('#progressPhase');
  const progressDetail = $('#progressDetail');
  const progressBar = $('#progressBar');
  const progressLog = $('#progressLog');
  const resultPanel = $('#resultPanel');
  const statPages = $('#statPages');
  const statResources = $('#statResources');
  const statSize = $('#statSize');
  const resultPageList = $('#resultPageList');
  const downloadBtn = $('#downloadBtn');
  const resetBtn = $('#resetBtn');
  const toastContainer = $('#toastContainer');

  // ─── Mouse tracking for glow effect ──────
  document.addEventListener('mousemove', (e) => {
    document.querySelectorAll('.card').forEach((card) => {
      const rect = card.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;
      card.style.setProperty('--mouse-x', x + '%');
      card.style.setProperty('--mouse-y', y + '%');
    });
  });

  // ─── Toast Notifications ─────────────────
  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;

    const icons = { success: '✓', error: '✖', info: 'ℹ' };
    toast.innerHTML = `<span>${icons[type] || '•'}</span> ${escapeHtml(message)}`;

    toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(20px)';
      toast.style.transition = 'all 300ms ease';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ─── Page List Management ────────────────
  function addPage(url) {
    url = url.trim().replace(/\/$/, '');
    if (!url) return;

    // Basic validation
    try {
      new URL(url);
    } catch {
      // Try adding https
      try {
        url = 'https://' + url;
        new URL(url);
      } catch {
        showToast('Invalid URL', 'error');
        return;
      }
    }

    // Check duplicates
    if (state.pages.includes(url)) {
      showToast('Page already in list', 'info');
      return;
    }

    state.pages.push(url);
    renderPageList();
    updateCloneButton();
  }

  function removePage(index) {
    state.pages.splice(index, 1);
    renderPageList();
    updateCloneButton();
  }

  function clearPages() {
    state.pages = [];
    renderPageList();
    updateCloneButton();
  }

  function renderPageList() {
    if (state.pages.length === 0) {
      emptyState.style.display = 'block';
      pageListWrapper.style.display = 'none';
      return;
    }

    emptyState.style.display = 'none';
    pageListWrapper.style.display = 'block';
    pageCountNum.textContent = state.pages.length;

    pageList.innerHTML = state.pages
      .map((url, i) => {
        const displayUrl = url.replace(/^https?:\/\//, '');
        return `
          <li class="page-item">
            <span class="page-item__icon">📄</span>
            <span class="page-item__url" title="${escapeHtml(url)}">${escapeHtml(displayUrl)}</span>
            <button class="page-item__remove" onclick="window.__removePage(${i})" title="Remove">✕</button>
          </li>
        `;
      })
      .join('');
  }

  function updateCloneButton() {
    cloneBtn.disabled = state.pages.length === 0 || state.isCloning;
  }

  // Expose removePage globally for inline onclick
  window.__removePage = removePage;

  // ─── Discover Pages ──────────────────────
  async function discoverPages() {
    const siteUrl = siteUrlInput.value.trim();
    if (!siteUrl) {
      showToast('Please enter a website URL', 'error');
      siteUrlInput.focus();
      return;
    }

    state.isDiscovering = true;
    discoverBtn.disabled = true;
    discoverBtnText.innerHTML = '<span class="spinner spinner--sm"></span> Discovering...';

    try {
      const resp = await fetch('/api/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: siteUrl }),
      });

      const data = await resp.json();

      if (!resp.ok) {
        throw new Error(data.error || 'Discovery failed');
      }

      if (data.pages.length === 0) {
        showToast('No pages found in sitemap. Try adding URLs manually.', 'info');
        return;
      }

      // Add all discovered pages (avoiding duplicates)
      let added = 0;
      for (const page of data.pages) {
        const normalized = page.replace(/\/$/, '');
        if (!state.pages.includes(normalized)) {
          state.pages.push(normalized);
          added++;
        }
      }

      renderPageList();
      updateCloneButton();
      showToast(`Discovered ${added} page(s) from sitemap!`, 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      state.isDiscovering = false;
      discoverBtn.disabled = false;
      discoverBtnText.innerHTML = '🔍 Discover All Pages';
    }
  }

  // ─── Clone Site ──────────────────────────
  async function startClone() {
    if (state.pages.length === 0) return;

    const siteUrl = siteUrlInput.value.trim() || state.pages[0];
    const noJs = $('#optNoJs').checked;

    state.isCloning = true;
    cloneBtn.disabled = true;
    cloneBtnText.innerHTML = '<span class="spinner spinner--sm"></span> Cloning...';

    // Show progress panel
    progressPanel.classList.add('active');
    resultPanel.classList.remove('active');
    progressLog.innerHTML = '';
    progressBar.style.width = '0%';
    progressBar.classList.remove('indeterminate');

    try {
      const resp = await fetch('/api/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: siteUrl,
          pages: state.pages,
          noJs,
        }),
      });

      // Read SSE stream
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete line in buffer

        let eventType = null;
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ') && eventType) {
            try {
              const data = JSON.parse(line.slice(6));
              handleSSEEvent(eventType, data);
            } catch {}
            eventType = null;
          }
        }
      }
    } catch (err) {
      showToast('Clone failed: ' + err.message, 'error');
      appendLog('Error: ' + err.message, 'error');
    } finally {
      state.isCloning = false;
      cloneBtn.disabled = false;
      cloneBtnText.innerHTML = '🚀 Start Cloning';
    }
  }

  // ─── SSE Event Handler ───────────────────
  function handleSSEEvent(event, data) {
    switch (event) {
      case 'status':
        updateProgress(data);
        break;

      case 'warning':
        appendLog('⚠ ' + data.message, 'warning');
        break;

      case 'error':
        appendLog('✖ ' + data.message, 'error');
        showToast(data.message, 'error');
        break;

      case 'summary':
        showSummary(data);
        break;

      case 'complete':
        state.currentJobId = data.jobId;
        progressPanel.classList.remove('active');
        showToast('Clone complete!', 'success');
        break;
    }
  }

  function updateProgress(data) {
    // Update phase label
    const phaseLabels = {
      init: '🔧 Initializing...',
      capture: '📸 Capturing Pages',
      download: '📥 Downloading Resources',
      rewrite: '✏️ Rewriting URLs',
    };

    progressPhase.textContent = phaseLabels[data.phase] || data.phase;

    // Update progress bar
    if (data.progress !== undefined) {
      progressBar.classList.remove('indeterminate');
      progressBar.style.width = data.progress + '%';
    }

    // Update detail text
    if (data.current && data.total) {
      progressDetail.textContent = `${data.current} / ${data.total}`;
    } else if (data.size) {
      progressDetail.textContent = data.size;
    } else {
      progressDetail.textContent = data.progress !== undefined ? data.progress + '%' : '';
    }

    // Append to log
    appendLog(data.message);
  }

  function appendLog(message, type = '') {
    const line = document.createElement('div');
    line.className = `log-line${type ? ` log-line--${type}` : ''}`;
    line.textContent = message;
    progressLog.appendChild(line);
    progressLog.scrollTop = progressLog.scrollHeight;
  }

  // ─── Show Results ────────────────────────
  function showSummary(data) {
    statPages.textContent = data.pages;
    statResources.textContent = data.resources;
    statSize.textContent = data.size;

    // Render page list
    resultPageList.innerHTML = data.pageList
      .map((p) => {
        const displayUrl = p.url.replace(/^https?:\/\//, '');
        return `
          <li class="page-item">
            <span class="page-item__icon">✅</span>
            <span class="page-item__url" title="${escapeHtml(p.url)}">${escapeHtml(displayUrl)}</span>
            <span style="color: var(--text-muted); font-size: 0.75rem; white-space: nowrap;">→ ${escapeHtml(p.localPath)}</span>
          </li>
        `;
      })
      .join('');

    resultPanel.classList.add('active');

    // Scroll to result
    setTimeout(() => {
      resultPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 300);
  }

  // ─── Download ZIP ────────────────────────
  function downloadZip() {
    if (!state.currentJobId) {
      showToast('No clone to download', 'error');
      return;
    }

    const link = document.createElement('a');
    link.href = `/api/download/${state.currentJobId}`;
    link.download = '';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    showToast('Download started!', 'success');
  }

  // ─── Reset ───────────────────────────────
  function resetApp() {
    state.pages = [];
    state.currentJobId = null;
    siteUrlInput.value = '';
    manualUrlInput.value = '';

    renderPageList();
    updateCloneButton();

    progressPanel.classList.remove('active');
    resultPanel.classList.remove('active');

    // Scroll to top
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ─── Event Listeners ─────────────────────
  discoverBtn.addEventListener('click', discoverPages);

  addUrlBtn.addEventListener('click', () => {
    addPage(manualUrlInput.value);
    manualUrlInput.value = '';
    manualUrlInput.focus();
  });

  manualUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      addPage(manualUrlInput.value);
      manualUrlInput.value = '';
    }
  });

  siteUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      discoverPages();
    }
  });

  cloneBtn.addEventListener('click', startClone);
  downloadBtn.addEventListener('click', downloadZip);
  resetBtn.addEventListener('click', resetApp);

  // ─── Init ────────────────────────────────
  renderPageList();
  updateCloneButton();
  siteUrlInput.focus();
})();
