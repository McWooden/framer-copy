// ═══════════════════════════════════════════
// Framer Website Cloner — Frontend Logic
// ═══════════════════════════════════════════

(function () {
  'use strict';

  // ─── State ───────────────────────────────
  const state = {
    pages: [],
    isDiscovering: false,
    isProcessing: false,
    currentJobId: null,      // The baseline clone (might be tidied)
    downloadJobId: null,     // The job ID for the main download button
    convertedJobs: {},       // Cache for alternate formats: { 'normal': jobId, 'nextjs-js': jobId, 'nextjs-ts': jobId }
    cloneSummary: null,      // Cached summary statistics
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
  const emptyState = $('#emptyState');
  const pageListWrapper = $('#pageListWrapper');
  const pageCountNum = $('#pageCountNum');
  const processBtn = $('#processBtn');
  const processBtnText = $('#processBtnText');
  
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
  const mainDownloadBtn = $('#mainDownloadBtn');
  const resetBtn = $('#resetBtn');
  const toastContainer = $('#toastContainer');

  // Redesigned elements
  const showOtherFormatsBtn = $('#showOtherFormatsBtn');
  const otherFormatsDrawer = $('#otherFormatsDrawer');
  const downloadOtherStaticBtn = $('#downloadOtherStaticBtn');
  const downloadOtherNextJsBtn = $('#downloadOtherNextJsBtn');
  const downloadOtherNextTsBtn = $('#downloadOtherNextTsBtn');
  const otherFormatsProgressArea = $('#otherFormatsProgressArea');
  const otherPhase = $('#otherPhase');
  const otherBar = $('#otherBar');
  const otherLog = $('#otherLog');

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

  // ─── Structure Selection Grid ────────────
  const structureCards = $$('.structure-card');
  structureCards.forEach(card => {
    card.addEventListener('click', () => {
      structureCards.forEach(c => c.classList.remove('structure-card--active'));
      card.classList.add('structure-card--active');
      const radio = card.querySelector('input[type="radio"]');
      if (radio) radio.checked = true;
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

    try {
      new URL(url);
    } catch {
      try {
        url = 'https://' + url;
        new URL(url);
      } catch {
        showToast('Invalid URL', 'error');
        return;
      }
    }

    if (state.pages.includes(url)) {
      showToast('Page already in list', 'info');
      return;
    }

    state.pages.push(url);
    renderPageList();
  }

  function removePage(index) {
    state.pages.splice(index, 1);
    renderPageList();
  }

  function renderPageList() {
    if (state.pages.length === 0) {
      emptyState.style.display = 'block';
      pageListWrapper.style.display = 'none';
      pageCountNum.textContent = '0';
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

      if (!resp.ok) throw new Error(data.error || 'Discovery failed');

      if (data.pages.length === 0) {
        showToast('No pages found in sitemap. Try adding URLs manually.', 'info');
        return;
      }

      let added = 0;
      for (const page of data.pages) {
        const normalized = page.replace(/\/$/, '');
        if (!state.pages.includes(normalized)) {
          state.pages.push(normalized);
          added++;
        }
      }

      renderPageList();
      showToast(`Discovered ${added} page(s) from sitemap!`, 'success');
      
      // Auto open details drawer if pages are discovered
      $('#pagesCard').open = true;
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      state.isDiscovering = false;
      discoverBtn.disabled = false;
      discoverBtnText.innerHTML = '🔍 Discover Pages';
    }
  }

  // ─── Helper to fetch job size metadata ────
  async function updateSizeMetadata(jobId) {
    try {
      const res = await fetch(`/api/job-status/${jobId}`);
      if (res.ok) {
        const data = await res.json();
        statSize.textContent = data.size;
      }
    } catch (err) {
      console.error('Failed to load size metadata', err);
    }
  }

  // ─── Sequential Processing Pipeline ──────
  async function processProject() {
    const siteUrl = siteUrlInput.value.trim();
    if (!siteUrl && state.pages.length === 0) {
      showToast('Please enter a Website URL', 'error');
      siteUrlInput.focus();
      return;
    }

    // If queue is empty, auto-add input site URL
    if (state.pages.length === 0) {
      addPage(siteUrl);
    }

    const structure = document.querySelector('input[name="folderStructure"]:checked').value;
    const needTidy = $('#optNeedTidy').checked;
    const noJs = $('#optNoJs').checked;

    state.isProcessing = true;
    toggleInputs(true);

    progressPanel.classList.add('active');
    resultPanel.classList.remove('active');
    otherFormatsDrawer.style.display = 'none';
    progressLog.innerHTML = '';
    progressBar.style.width = '0%';
    progressBar.classList.remove('indeterminate');

    try {
      // ── Stage 1: Clone ──
      appendLog('🌐 Initializing clone process...', 'info');
      const cloneResponse = await fetch('/api/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: state.pages[0], pages: state.pages, noJs }),
      });

      await handleSSE(cloneResponse, progressPhase, progressBar, progressLog, (event, data) => {
        if (event === 'summary') state.cloneSummary = data;
        if (event === 'complete') state.currentJobId = data.jobId;
      });

      if (!state.currentJobId) throw new Error('Clone completed but Job ID was not received.');

      state.convertedJobs = { 'normal': state.currentJobId };

      // ── Stage 2: Tidy (Optional) ──
      if (needTidy) {
        appendLog('🧹 Starting file tidy process...', 'info');
        progressBar.style.width = '0%';
        const tidyResponse = await fetch(`/api/tidy/${state.currentJobId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mergeCSS: true,
            removeUnused: true,
            renameFiles: true,
            stripFramerRuntime: true,
          }),
        });

        await handleSSE(tidyResponse, progressPhase, progressBar, progressLog);
      }

      // ── Stage 3: Restructure (Optional) ──
      if (structure === 'nextjs-js' || structure === 'nextjs-ts') {
        const lang = structure === 'nextjs-ts' ? 'ts' : 'js';
        appendLog(`⚛️ Converting static clone to Next.js (${lang.toUpperCase()})...`, 'info');
        progressBar.style.width = '0%';

        const convertResponse = await fetch(`/api/restructure/${state.currentJobId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lang }),
        });

        await handleSSE(convertResponse, progressPhase, progressBar, progressLog, (event, data) => {
          if (event === 'restructure-done') {
            state.downloadJobId = data.downloadJobId;
            state.convertedJobs[structure] = data.downloadJobId;
          }
        });
      } else {
        state.downloadJobId = state.currentJobId;
      }

      // ── Finish ──
      appendLog('✨ All stages complete!', 'success');
      showToast('Processing complete!', 'success');

      // Fetch size metadata
      await updateSizeMetadata(state.downloadJobId);

      // Render summary info
      if (state.cloneSummary) {
        statPages.textContent = state.cloneSummary.pages;
        statResources.textContent = state.cloneSummary.resources;
        resultPageList.innerHTML = state.cloneSummary.pageList
          .map((p) => {
            const displayUrl = p.url.replace(/^https?:\/\//, '');
            return `
              <li class="page-item">
                <span class="page-item__icon">✅</span>
                <span class="page-item__url" title="${escapeHtml(p.url)}">${escapeHtml(displayUrl)}</span>
                <span style="color: var(--text-muted); font-size: 0.72rem; white-space: nowrap;">→ ${escapeHtml(p.localPath)}</span>
              </li>
            `;
          })
          .join('');
      }

      progressPanel.classList.remove('active');
      resultPanel.classList.add('active');

      setTimeout(() => {
        resultPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 300);

    } catch (err) {
      showToast('Processing failed: ' + err.message, 'error');
      appendLog('✖ Error: ' + err.message, 'error');
    } finally {
      state.isProcessing = false;
      toggleInputs(false);
    }
  }

  // ─── SSE Stream Reader ───────────────────
  async function handleSSE(response, labelEl, barEl, logEl, onEvent) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      let eventType = null;
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith('data: ') && eventType) {
          try {
            const data = JSON.parse(line.slice(6));
            
            // Handle common status events
            if (eventType === 'status') {
              labelEl.textContent = data.message || 'Processing...';
              if (data.progress !== undefined) {
                barEl.style.width = data.progress + '%';
              }
              appendLogElement(logEl, data.message);
            } else if (eventType === 'warning') {
              appendLogElement(logEl, '⚠ ' + data.message, 'warning');
            } else if (eventType === 'error') {
              appendLogElement(logEl, '✖ ' + data.message, 'error');
              throw new Error(data.message);
            }

            if (onEvent) onEvent(eventType, data);
          } catch (e) {
            if (eventType === 'error') throw e;
          }
          eventType = null;
        }
      }
    }
  }

  function appendLog(message, type = '') {
    appendLogElement(progressLog, message, type);
  }

  function appendLogElement(logEl, message, type = '') {
    const line = document.createElement('div');
    line.className = `log-line${type ? ` log-line--${type}` : ''}`;
    line.textContent = message;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function toggleInputs(disable) {
    siteUrlInput.disabled = disable;
    discoverBtn.disabled = disable;
    manualUrlInput.disabled = disable;
    addUrlBtn.disabled = disable;
    processBtn.disabled = disable;
    
    $$('input[name="folderStructure"]').forEach(radio => radio.disabled = disable);
    $$('.structure-card').forEach(card => card.style.pointerEvents = disable ? 'none' : 'auto');
    $('#optNeedTidy').disabled = disable;
    $('#optNoJs').disabled = disable;

    if (disable) {
      processBtnText.innerHTML = '<span class="spinner spinner--sm"></span> Processing...';
    } else {
      processBtnText.textContent = '🚀 Process Cloner';
    }
  }

  // ─── Download File ZIP ───────────────────
  function triggerDownload(jobId) {
    if (!jobId) {
      showToast('No project available for download.', 'error');
      return;
    }
    const link = document.createElement('a');
    link.href = `/api/download/${jobId}`;
    link.download = '';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast('Download started!', 'success');
  }

  // ─── On-demand Conversion for Other Formats 
  async function downloadOtherFormat(structure) {
    if (!state.currentJobId) {
      showToast('No active project session.', 'error');
      return;
    }

    // If it's normal folder
    if (structure === 'normal') {
      triggerDownload(state.currentJobId);
      return;
    }

    // Check cache
    if (state.convertedJobs[structure]) {
      triggerDownload(state.convertedJobs[structure]);
      return;
    }

    // Otherwise, convert on-demand
    otherFormatsProgressArea.style.display = 'block';
    otherLog.innerHTML = '';
    otherBar.style.width = '0%';
    
    const lang = structure === 'nextjs-ts' ? 'ts' : 'js';
    otherPhase.textContent = `Converting to Next.js (${lang.toUpperCase()})...`;

    try {
      const resp = await fetch(`/api/restructure/${state.currentJobId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lang }),
      });

      await handleSSE(resp, otherPhase, otherBar, otherLog, (event, data) => {
        if (event === 'restructure-done') {
          state.convertedJobs[structure] = data.downloadJobId;
        }
      });

      otherFormatsProgressArea.style.display = 'none';
      triggerDownload(state.convertedJobs[structure]);
    } catch (err) {
      showToast('Conversion failed: ' + err.message, 'error');
      appendLogElement(otherLog, '✖ Error: ' + err.message, 'error');
    }
  }

  // ─── Reset Application ───────────────────
  function resetApp() {
    state.pages = [];
    state.currentJobId = null;
    state.downloadJobId = null;
    state.convertedJobs = {};
    state.cloneSummary = null;

    siteUrlInput.value = '';
    manualUrlInput.value = '';
    $('#optNeedTidy').checked = true;
    $('#optNoJs').checked = false;

    // Reset structure selection to normal
    structureCards.forEach(c => c.classList.remove('structure-card--active'));
    $('#structNormalLabel').classList.add('structure-card--active');
    document.querySelector('input[name="folderStructure"][value="normal"]').checked = true;

    renderPageList();
    toggleInputs(false);

    progressPanel.classList.remove('active');
    resultPanel.classList.remove('active');
    otherFormatsDrawer.style.display = 'none';

    window.scrollTo({ top: 0, behavior: 'smooth' });
    siteUrlInput.focus();
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

  processBtn.addEventListener('click', processProject);
  
  mainDownloadBtn.addEventListener('click', () => {
    triggerDownload(state.downloadJobId);
  });

  showOtherFormatsBtn.addEventListener('click', () => {
    if (otherFormatsDrawer.style.display === 'none') {
      otherFormatsDrawer.style.display = 'block';
      otherFormatsDrawer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      otherFormatsDrawer.style.display = 'none';
    }
  });

  downloadOtherStaticBtn.addEventListener('click', () => downloadOtherFormat('normal'));
  downloadOtherNextJsBtn.addEventListener('click', () => downloadOtherFormat('nextjs-js'));
  downloadOtherNextTsBtn.addEventListener('click', () => downloadOtherFormat('nextjs-ts'));

  resetBtn.addEventListener('click', resetApp);

  // ─── Init ────────────────────────────────
  renderPageList();
  siteUrlInput.focus();
})();
