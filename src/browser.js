const puppeteer = require('puppeteer');
const { normalizeUrl, shouldSkipUrl } = require('./utils');

/**
 * Browser module — renders a Framer page with Puppeteer
 * and captures the fully rendered DOM + all network resources.
 */
class BrowserCapture {
  constructor(options = {}) {
    this.extraWait = options.wait || 3000;
    this.browser = null;
    this.interceptedResources = new Map(); // url → { type, contentType }
  }

  /**
   * Launch the headless browser
   */
  async launch() {
    console.log('  Launching headless browser...');
    this.browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
    });
  }

  /**
   * Navigate to a URL, intercept all network requests, and return the fully rendered HTML
   * along with a list of all loaded resources.
   */
  async capture(url) {
    if (!this.browser) await this.launch();

    const page = await this.browser.newPage();

    // Set a realistic viewport
    await page.setViewport({ width: 1920, height: 1080 });

    // Set a realistic user agent
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Track intercepted resources
    const resources = new Map();

    // Listen to all network responses
    page.on('response', async (response) => {
      const resUrl = response.url();
      const status = response.status();
      const contentType = response.headers()['content-type'] || '';

      // Skip failed requests and data URIs
      if (status < 200 || status >= 400) return;
      if (resUrl.startsWith('data:')) return;
      if (shouldSkipUrl(resUrl)) return;

      // Determine resource type from content-type
      let type = 'other';
      if (contentType.includes('text/css')) type = 'css';
      else if (contentType.includes('javascript')) type = 'js';
      else if (contentType.includes('font')) type = 'font';
      else if (contentType.includes('image')) type = 'image';
      else if (contentType.includes('video') || contentType.includes('audio')) type = 'media';
      else if (contentType.includes('text/html')) type = 'html';
      else if (contentType.includes('application/json')) type = 'json';

      resources.set(resUrl, { type, contentType, status });
    });

    console.log(`  Navigating to: ${url}`);

    try {
      await page.goto(url, {
        waitUntil: 'networkidle0',
        timeout: 60000,
      });
    } catch (err) {
      // networkidle0 can timeout on sites with persistent connections
      // Fall back to networkidle2
      console.log('  Network idle timeout, retrying with relaxed settings...');
      await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: 60000,
      });
    }

    // Extra wait for lazy-loaded content, animations, and CSS-in-JS injection
    console.log(`  Waiting ${this.extraWait}ms for dynamic content...`);
    await this.sleep(this.extraWait);

    // Scroll to bottom to trigger lazy loading
    await this.autoScroll(page);

    // Wait a bit more after scrolling
    await this.sleep(1500);

    // Scroll back to top
    await page.evaluate(() => window.scrollTo(0, 0));
    await this.sleep(500);

    // Extract the fully rendered HTML (includes CSS-in-JS injected <style> blocks)
    const renderedHtml = await page.content();

    // Extract all computed stylesheets that were injected via JS
    const injectedStyles = await page.evaluate(() => {
      const styles = [];
      for (const sheet of document.styleSheets) {
        try {
          // Only get styles from <style> tags (CSS-in-JS injections)
          if (sheet.ownerNode && sheet.ownerNode.tagName === 'STYLE') {
            const rules = [];
            for (const rule of sheet.cssRules) {
              rules.push(rule.cssText);
            }
            styles.push(rules.join('\n'));
          }
        } catch (e) {
          // Cross-origin stylesheets will throw
        }
      }
      return styles;
    });

    // Extract all internal links for crawling
    const links = await page.evaluate(() => {
      const anchors = document.querySelectorAll('a[href]');
      return Array.from(anchors).map(a => a.href);
    });

    await page.close();

    return {
      html: renderedHtml,
      resources,
      injectedStyles,
      links,
    };
  }

  /**
   * Auto-scroll to the bottom of the page to trigger lazy loading
   */
  async autoScroll(page) {
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        const distance = 400;
        const timer = setInterval(() => {
          const scrollHeight = document.body.scrollHeight;
          window.scrollBy(0, distance);
          totalHeight += distance;

          if (totalHeight >= scrollHeight) {
            clearInterval(timer);
            resolve();
          }
        }, 100);

        // Safety timeout
        setTimeout(() => {
          clearInterval(timer);
          resolve();
        }, 10000);
      });
    });
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

module.exports = BrowserCapture;
