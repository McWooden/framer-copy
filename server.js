const express = require('express');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const BrowserCapture = require('./src/browser');
const ResourceDownloader = require('./src/downloader');
const UrlRewriter = require('./src/rewriter');
const PageCrawler = require('./src/crawler');
const SiteTidier = require('./src/tidier');
const SiteRestructurer = require('./src/restructurer');

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
    .then(async () => {
      // Store job for download
      jobs.set(jobId, { outputDir, hostname, createdAt: Date.now() });

      // Auto-generate REFACTOR_PROMPT.md silently
      try {
        const restructurer = new SiteRestructurer(outputDir, { log: () => {} });
        await restructurer.generateAndSavePrompt();
      } catch { /* non-fatal */ }

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
// API: Tidy an existing cloned site (SSE)
// ─────────────────────────────────────────────
app.post('/api/tidy/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  const opts = req.body || {};

  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (!fs.existsSync(job.outputDir)) return res.status(404).json({ error: 'Clone output not found.' });

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const tidier = new SiteTidier(job.outputDir, {
    mergeCSS: opts.mergeCSS !== false,
    removeUnused: opts.removeUnused !== false,
    renameFiles: opts.renameFiles !== false,
    stripFramerRuntime: opts.stripFramerRuntime !== false,
    log: send,
  });

  tidier.tidy()
    .then((result) => {
      send('tidy-summary', result);
      send('complete', { message: 'Tidy complete!' });
      res.end();
    })
    .catch((err) => {
      send('error', { message: err.message });
      res.end();
    });
});

// API: Convert to Next.js Latest (SSE)
// lang: 'ts' | 'js'
// ─────────────────────────────────────────────
app.post('/api/restructure/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  const { lang = 'ts' } = req.body; // 'ts' or 'js'

  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (!fs.existsSync(job.outputDir)) return res.status(404).json({ error: 'Clone output not found.' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const targetDir = job.outputDir + `_nextjs-${lang}_${Date.now()}`;
  const restructurer = new SiteRestructurer(job.outputDir, { lang, log: send });

  restructurer.restructure(targetDir)
    .then((result) => {
      // Register as a new downloadable job
      const newJobId = `job_${Date.now()}`;
      jobs.set(newJobId, {
        outputDir: targetDir,
        hostname: `${job.hostname}-nextjs`,
        createdAt: Date.now(),
      });
      send('restructure-done', { ...result, downloadJobId: newJobId, lang });
      send('complete', { message: 'Next.js project ready!' });
      res.end();
    })
    .catch(err => {
      send('error', { message: err.message });
      res.end();
    });
});

// Helper: get directory size recursively
function getDirSize(dirPath) {
  let size = 0;
  if (!fs.existsSync(dirPath)) return 0;
  try {
    const files = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const file of files) {
      const filePath = path.join(dirPath, file.name);
      if (file.isDirectory()) {
        size += getDirSize(filePath);
      } else {
        const stats = fs.statSync(filePath);
        size += stats.size;
      }
    }
  } catch (e) {}
  return size;
}

// Helper: format bytes
function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

// ─────────────────────────────────────────────
// API: Get job status & metadata (e.g. size)
// ─────────────────────────────────────────────
app.get('/api/job-status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  if (!fs.existsSync(job.outputDir)) {
    return res.status(404).json({ error: 'Clone output not found' });
  }
  const sizeBytes = getDirSize(job.outputDir);
  res.json({
    jobId,
    hostname: job.hostname,
    size: formatBytes(sizeBytes),
    sizeBytes
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

    // Rewrite JS — fixes Framer Motion animations by patching:
    //   • webpack/vite public path variables
    //   • dynamic import() chunk URLs
    //   • CDN image/font string literals baked into bundles
    send('status', { message: 'Patching JS bundles for animations...', phase: 'rewrite', progress: 80 });

    const jsFiles = Array.from(urlMap.entries()).filter(([_, lp]) => lp.startsWith('js/'));
    let jsPatched = 0;
    for (const [origUrl, localPath] of jsFiles) {
      const fullPath = path.join(outputDir, localPath);
      if (fs.existsSync(fullPath)) {
        try {
          let js = fs.readFileSync(fullPath, 'utf-8');
          const patched = rewriter.rewriteJs(js, localPath);
          if (patched !== js) {
            fs.writeFileSync(fullPath, patched, 'utf-8');
            jsPatched++;
          }
        } catch {
          // skip binary or unreadable files
        }
      }
    }

    send('status', {
      message: `URL rewriting complete — patched ${jsFiles.length} JS files (${jsPatched} modified)`,
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
