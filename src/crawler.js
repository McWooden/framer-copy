const { URL } = require('url');
const https = require('https');
const http = require('http');
const { isSameOrigin, isPageUrl, normalizeUrl, shouldSkipUrl } = require('./utils');

/**
 * Crawler module — discovers internal pages on a Framer site
 * and queues them for processing.
 */
class PageCrawler {
  constructor(baseUrl, options = {}) {
    this.baseUrl = baseUrl;
    this.baseHost = new URL(baseUrl).hostname;
    this.maxPages = options.pages || 1; // max number of pages to crawl
    this.crawlAll = options.all || false; // crawl every discoverable page
    this.visitedPages = new Set();
    this.pageQueue = [];
  }

  /**
   * Try to fetch and parse sitemap.xml to discover all pages upfront.
   * Framer sites typically have a sitemap at /sitemap.xml
   * @returns {string[]} Array of page URLs found in sitemap
   */
  async discoverFromSitemap() {
    const sitemapUrls = [
      new URL('/sitemap.xml', this.baseUrl).href,
      new URL('/sitemap_index.xml', this.baseUrl).href,
    ];

    const discoveredPages = [];

    for (const sitemapUrl of sitemapUrls) {
      try {
        const xml = await this.fetchText(sitemapUrl);
        if (!xml || !xml.includes('<urlset') && !xml.includes('<sitemapindex')) {
          continue;
        }

        // Parse <loc> tags from sitemap
        const locRegex = /<loc>\s*(.*?)\s*<\/loc>/gi;
        let match;
        while ((match = locRegex.exec(xml)) !== null) {
          const pageUrl = match[1].trim();
          try {
            const parsed = new URL(pageUrl);
            // Only include same-host pages
            if (parsed.hostname === this.baseHost) {
              const normalized = this.normalizePageUrl(parsed);
              if (!discoveredPages.includes(normalized)) {
                discoveredPages.push(normalized);
              }
            }
          } catch {
            // skip invalid URLs
          }
        }

        // If it's a sitemap index, fetch child sitemaps
        if (xml.includes('<sitemapindex')) {
          const sitemapLocRegex = /<loc>\s*(.*?)\s*<\/loc>/gi;
          let sitemapMatch;
          while ((sitemapMatch = sitemapLocRegex.exec(xml)) !== null) {
            const childUrl = sitemapMatch[1].trim();
            if (childUrl.includes('sitemap') && childUrl.endsWith('.xml')) {
              try {
                const childXml = await this.fetchText(childUrl);
                const childLocRegex = /<loc>\s*(.*?)\s*<\/loc>/gi;
                let childMatch;
                while ((childMatch = childLocRegex.exec(childXml)) !== null) {
                  const pageUrl = childMatch[1].trim();
                  try {
                    const parsed = new URL(pageUrl);
                    if (parsed.hostname === this.baseHost) {
                      const normalized = this.normalizePageUrl(parsed);
                      if (!discoveredPages.includes(normalized)) {
                        discoveredPages.push(normalized);
                      }
                    }
                  } catch {}
                }
              } catch {}
            }
          }
        }

        if (discoveredPages.length > 0) break; // found pages, stop trying sitemaps
      } catch {
        // sitemap not found, continue
      }
    }

    return discoveredPages;
  }

  /**
   * Add discovered links from a page
   * @param {string[]} links - Array of absolute URLs found on the page
   * @param {number} currentDepth - Current crawl depth
   * @returns {string[]} New page URLs to crawl
   */
  addLinks(links, currentDepth) {
    const maxAllowed = this.crawlAll ? 500 : this.maxPages;
    if (this.visitedPages.size >= maxAllowed) return [];

    const newPages = [];

    for (const link of links) {
      if (this.visitedPages.size + newPages.length >= maxAllowed) break;

      try {
        const url = new URL(link);

        // Only follow same-host links
        if (url.hostname !== this.baseHost) continue;

        // Skip non-page resources
        if (!isPageUrl(link)) continue;

        // Skip tracking URLs
        if (shouldSkipUrl(link)) continue;

        // Normalize
        const normalized = this.normalizePageUrl(url);

        // Skip already visited
        if (this.visitedPages.has(normalized)) continue;

        // Skip if already in newPages
        if (newPages.includes(normalized)) continue;

        // Skip anchors on the same page
        if (url.hash && this.visitedPages.has(normalized.split('#')[0])) continue;

        newPages.push(normalized);
      } catch {
        // Invalid URL, skip
      }
    }

    return newPages;
  }

  /**
   * Mark a page as visited
   */
  markVisited(url) {
    const normalized = this.normalizePageUrl(new URL(url));
    this.visitedPages.add(normalized);
  }

  /**
   * Check if a page has been visited
   */
  isVisited(url) {
    try {
      const normalized = this.normalizePageUrl(new URL(url));
      return this.visitedPages.has(normalized);
    } catch {
      return false;
    }
  }

  /**
   * Normalize a page URL by removing hash, query params, and trailing slashes
   */
  normalizePageUrl(url) {
    const normalized = `${url.protocol}//${url.hostname}${url.pathname}`;
    return normalized.replace(/\/$/, '');
  }

  /**
   * Get the local file path for a page URL
   */
  getLocalPath(pageUrl) {
    try {
      const url = new URL(pageUrl);
      let pathname = url.pathname;

      // Remove trailing slash
      pathname = pathname.replace(/\/$/, '');

      // Root page
      if (!pathname || pathname === '') {
        return 'index.html';
      }

      // Remove leading slash
      pathname = pathname.replace(/^\//, '');

      // Convert path segments to directory structure
      if (!pathname.endsWith('.html') && !pathname.endsWith('.htm')) {
        pathname = pathname + '/index.html';
      }

      return pathname;
    } catch {
      return 'index.html';
    }
  }

  /**
   * Get all discovered pages
   */
  getVisitedPages() {
    return Array.from(this.visitedPages);
  }

  /**
   * Fetch text content from a URL
   */
  fetchText(url) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const client = parsedUrl.protocol === 'https:' ? https : http;

      const req = client.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        timeout: 10000,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          this.fetchText(new URL(res.headers.location, url).href).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
        res.on('error', reject);
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
  }
}

module.exports = PageCrawler;
