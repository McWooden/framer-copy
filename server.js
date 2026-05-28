const express = require('express');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const BrowserCapture = require('./src/browser');
const ResourceDownloader = require('./src/downloader');
const UrlRewriter = require('./src/rewriter');
const PageCrawler = require('./src/crawler');

const app = express();
const PORT = 3456;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Store active jobs
const jobs = new Map();

// ─────────────────────────────────────────────
// API: Discover pages from sitemap
// ─────────────────────────────────────────────
app.post('/api/discover', async (req, res) => {
  let { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  url = url.replace(/\/$/, '');

  try {
    const crawler = new PageCrawler(url, { all: true });
    const pages = await crawler.discoverFromSitemap();

    // Always include the root URL
    const rootNormalized = url.replace(/\/$/, '');
    if (!pages.includes(rootNormalized)) {
      pages.unshift(rootNormalized);
    }

    res.json({ pages, total: pages.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// API: Clone pages (SSE for real-time progress)
// ─────────────────────────────────────────────
app.post('/api/clone', (req, res) => {
  let { url, pages, noJs, wait } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  if (!pages || pages.length === 0) return res.status(400).json({ error: 'At least one page is required' });

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  url = url.replace(/\/$/, '');

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Generate a unique job ID
  const jobId = `job_${Date.now()}`;
  const hostname = new URL(url).hostname.replace(/[^a-zA-Z0-9.-]/g, '_');
  const outputDir = path.join(__dirname, 'clones', `${hostname}_${jobId}`);

  send('status', { message: 'Starting clone...', phase: 'init', jobId });

  // Run clone in background
  runClone({ url, pages, noJs: noJs || false, wait: wait || 3000, outputDir, jobId, send })
    .then(() => {
      // Store job for download
      jobs.set(jobId, { outputDir, hostname, createdAt: Date.now() });
      send('complete', { jobId, message: 'Clone complete! Ready to download.' });
      res.end();
    })
    .catch((err) => {
      send('error', { message: err.message });
      res.end();
    });

  req.on('close', () => {
    // Client disconnected — cleanup if needed
  });
});

// ─────────────────────────────────────────────
// API: Download cloned site as ZIP
// ─────────────────────────────────────────────
app.get('/api/download/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found. It may have expired.' });
  }

  if (!fs.existsSync(job.outputDir)) {
    return res.status(404).json({ error: 'Clone output not found.' });
  }

  const zipFilename = `${job.hostname}-clone.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

  const archive = archiver('zip', { zlib: { level: 6 } });

  archive.on('error', (err) => {
    res.status(500).send({ error: err.message });
  });

  archive.pipe(res);
  archive.directory(job.outputDir, job.hostname);
  archive.finalize();
});

// ─────────────────────────────────────────────
// Clone Runner
// ─────────────────────────────────────────────
async function runClone({ url, pages, noJs, wait, outputDir, jobId, send }) {
  // Create output directory
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const crawler = new PageCrawler(url, { all: true });
  const allResources = new Map();
  const pageResults = new Map();
  const totalPages = pages.length;

  // ─── Phase 1: Browser Capture ──────────────
  send('status', { message: 'Launching browser...', phase: 'capture', progress: 0 });

  const browser = new BrowserCapture({ wait });

  try {
    await browser.launch();

    for (let i = 0; i < pages.length; i++) {
      const pageUrl = pages[i];
      const pageLocalPath = crawler.getLocalPath(pageUrl);
      const pct = Math.round(((i + 1) / totalPages) * 100);

      send('status', {
        message: `Capturing page ${i + 1}/${totalPages}: ${pageUrl}`,
        phase: 'capture',
        progress: pct,
        current: i + 1,
        total: totalPages,
      });

      try {
        const result = await browser.capture(pageUrl);

        for (const [resUrl, info] of result.resources) {
          if (!allResources.has(resUrl)) {
            allResources.set(resUrl, info);
          }
        }

        pageResults.set(pageUrl, {
          html: result.html,
          localPath: pageLocalPath,
          links: result.links,
          injectedStyles: result.injectedStyles,
        });
      } catch (err) {
        send('warning', { message: `Failed to capture ${pageUrl}: ${err.message}` });
      }
    }

    send('status', {
      message: `Captured ${pageResults.size} page(s), found ${allResources.size} resources`,
      phase: 'capture',
      progress: 100,
    });

    // ─── Phase 2: Download Resources ──────────
    send('status', { message: 'Downloading resources...', phase: 'download', progress: 0 });

    const downloader = new ResourceDownloader(outputDir, { concurrency: 8, retries: 3 });

    // Patch the downloader to send progress
    const totalResources = allResources.size;
    let downloadedCount = 0;
    const origDownloadResource = downloader.downloadResource.bind(downloader);
    downloader.downloadResource = async function (...args) {
      const result = await origDownloadResource(...args);
      downloadedCount++;
      const pct = Math.round((downloadedCount / totalResources) * 100);
      send('status', {
        message: `Downloading resources: ${downloadedCount}/${totalResources}`,
        phase: 'download',
        progress: pct,
        current: downloadedCount,
        total: totalResources,
      });
      return result;
    };

    const urlMap = await downloader.downloadAll(allResources, url);

    send('status', {
      message: `Downloaded ${urlMap.size} resources (${downloader.formatBytes(downloader.downloadedBytes)})`,
      phase: 'download',
      progress: 100,
      size: downloader.formatBytes(downloader.downloadedBytes),
    });

    // ─── Phase 3: Rewrite URLs ────────────────
    send('status', { message: 'Rewriting URLs...', phase: 'rewrite', progress: 0 });

    const rewriter = new UrlRewriter(urlMap, url, { noJs, stripTracking: true });

    let rewriteCount = 0;
    const totalRewrite = pageResults.size;

    for (const [pageUrl, pageData] of pageResults) {
      const rewrittenHtml = rewriter.rewriteHtml(pageData.html, pageData.localPath);

      const fullPath = path.join(outputDir, pageData.localPath);
      const parentDir = path.dirname(fullPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      fs.writeFileSync(fullPath, rewrittenHtml, 'utf-8');
      rewriteCount++;

      send('status', {
        message: `Rewriting: ${pageData.localPath}`,
        phase: 'rewrite',
        progress: Math.round((rewriteCount / totalRewrite) * 100),
      });
    }

    // Rewrite CSS
    const cssFiles = Array.from(urlMap.entries()).filter(([_, lp]) => lp.startsWith('css/'));
    for (const [origUrl, localPath] of cssFiles) {
      const fullPath = path.join(outputDir, localPath);
      if (fs.existsSync(fullPath)) {
        let css = fs.readFileSync(fullPath, 'utf-8');
        css = rewriter.rewriteCss(css, localPath);
        fs.writeFileSync(fullPath, css, 'utf-8');
      }
    }

    send('status', {
      message: 'URL rewriting complete',
      phase: 'rewrite',
      progress: 100,
    });

    // ─── Summary ──────────────────────────────
    send('summary', {
      pages: pageResults.size,
      resources: urlMap.size,
      totalFiles: urlMap.size + pageResults.size,
      size: downloader.formatBytes(downloader.downloadedBytes),
      pageList: Array.from(pageResults.entries()).map(([pageUrl, data]) => ({
        url: pageUrl,
        localPath: data.localPath,
      })),
    });

  } finally {
    await browser.close();
  }
}

// ─────────────────────────────────────────────
// Cleanup old clones (older than 1 hour)
// ─────────────────────────────────────────────
setInterval(() => {
  const oneHour = 60 * 60 * 1000;
  for (const [jobId, job] of jobs) {
    if (Date.now() - job.createdAt > oneHour) {
      try {
        fs.rmSync(job.outputDir, { recursive: true, force: true });
      } catch {}
      jobs.delete(jobId);
    }
  }
}, 10 * 60 * 1000);

// ─────────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║    🌐  Framer Website Cloner  v1.0.0    ║');
  console.log('  ║    Web Interface                         ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
  console.log(`  ➜  Open in browser: http://localhost:${PORT}`);
  console.log('');
});
