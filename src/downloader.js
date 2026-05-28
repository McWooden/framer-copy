const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const cliProgress = require('cli-progress');
const { categorizeResource, urlToFilename, uniqueFilename, getExtensionFromContentType } = require('./utils');

/**
 * Downloader module — downloads all discovered resources
 * and organizes them into categorized directories.
 */
class ResourceDownloader {
  constructor(outputDir, options = {}) {
    this.outputDir = outputDir;
    this.maxRetries = options.retries || 3;
    this.concurrency = options.concurrency || 8;
    this.usedFilenames = new Set();
    // Maps original URL → local file path (relative to output dir)
    this.urlToLocalPath = new Map();
    this.downloadedBytes = 0;
  }

  /**
   * Download all resources from the provided map
   * @param {Map} resources - Map of URL → { type, contentType }
   * @param {string} baseUrl - The original site URL
   */
  async downloadAll(resources, baseUrl) {
    // Filter out HTML pages and tracking URLs (we handle pages separately)
    const toDownload = [];
    for (const [url, info] of resources) {
      if (info.type === 'html') continue;
      toDownload.push({ url, ...info });
    }

    if (toDownload.length === 0) {
      console.log('  No resources to download.');
      return this.urlToLocalPath;
    }

    console.log(`  Downloading ${toDownload.length} resources...`);

    // Create subdirectories
    const dirs = ['css', 'js', 'images', 'fonts', 'assets'];
    for (const dir of dirs) {
      const fullPath = path.join(this.outputDir, dir);
      if (!fs.existsSync(fullPath)) {
        fs.mkdirSync(fullPath, { recursive: true });
      }
    }

    // Progress bar
    const progressBar = new cliProgress.SingleBar({
      format: '  Downloading |{bar}| {percentage}% | {value}/{total} files | {size}',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true,
    });

    progressBar.start(toDownload.length, 0, { size: '0 KB' });

    // Download in batches for concurrency control
    let completed = 0;
    const batches = this.chunk(toDownload, this.concurrency);

    for (const batch of batches) {
      const promises = batch.map(async (resource) => {
        try {
          await this.downloadResource(resource);
        } catch (err) {
          // Silently skip failed resources
        }
        completed++;
        progressBar.update(completed, {
          size: this.formatBytes(this.downloadedBytes),
        });
      });
      await Promise.all(promises);
    }

    progressBar.stop();
    console.log(`  Downloaded ${this.urlToLocalPath.size} resources (${this.formatBytes(this.downloadedBytes)})`);

    return this.urlToLocalPath;
  }

  /**
   * Download a single resource with retries
   */
  async downloadResource(resource, retryCount = 0) {
    const { url, contentType } = resource;

    try {
      const { data, finalContentType } = await this.fetchBuffer(url);
      const effectiveContentType = finalContentType || contentType || '';

      // Determine category and filename
      const category = categorizeResource(url, effectiveContentType);
      let filename = urlToFilename(url, effectiveContentType);

      // Ensure correct extension based on actual content type
      const ext = path.extname(filename);
      if (!ext && effectiveContentType) {
        const inferredExt = getExtensionFromContentType(effectiveContentType);
        if (inferredExt) filename += inferredExt;
      }

      // Make filename unique
      filename = uniqueFilename(this.usedFilenames, filename);

      // Build local path
      const localPath = path.join(category, filename);
      const fullPath = path.join(this.outputDir, localPath);

      // Ensure parent directory exists
      const parentDir = path.dirname(fullPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      // Write file
      fs.writeFileSync(fullPath, data);
      this.downloadedBytes += data.length;

      // Store mapping
      this.urlToLocalPath.set(url, localPath);
    } catch (err) {
      if (retryCount < this.maxRetries) {
        await this.sleep(1000 * (retryCount + 1));
        return this.downloadResource(resource, retryCount + 1);
      }
      throw err;
    }
  }

  /**
   * Fetch a URL and return the response as a Buffer
   */
  fetchBuffer(url) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const client = parsedUrl.protocol === 'https:' ? https : http;

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Accept-Encoding': 'identity',
        },
        timeout: 30000,
      };

      const req = client.request(options, (res) => {
        // Handle redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, url).href;
          this.fetchBuffer(redirectUrl).then(resolve).catch(reject);
          return;
        }

        if (res.statusCode < 200 || res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            data: Buffer.concat(chunks),
            finalContentType: res.headers['content-type'] || '',
          });
        });
        res.on('error', reject);
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Timeout fetching ${url}`));
      });

      req.end();
    });
  }

  /**
   * Split an array into chunks of a given size
   */
  chunk(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = ResourceDownloader;
