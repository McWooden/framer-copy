const cheerio = require('cheerio');
const path = require('path');
const { URL } = require('url');
const { relativePath } = require('./utils');

/**
 * Rewriter module — rewrites all URLs in HTML and CSS files
 * to point to locally downloaded resources.
 */
class UrlRewriter {
  /**
   * @param {Map} urlMap - Map of original URL → local file path
   * @param {string} baseUrl - The original website URL
   * @param {object} options
   */
  constructor(urlMap, baseUrl, options = {}) {
    this.urlMap = urlMap;
    this.baseUrl = baseUrl;
    this.stripJs = options.noJs || false;
    this.stripTracking = options.stripTracking !== false; // default true
  }

  /**
   * Rewrite all URLs in an HTML string
   * @param {string} html - The HTML content
   * @param {string} localHtmlPath - The local path of this HTML file (relative to output)
   * @returns {string} Rewritten HTML
   */
  rewriteHtml(html, localHtmlPath) {
    const $ = cheerio.load(html, { decodeEntities: false });

    // === Rewrite <link> tags (stylesheets, icons, etc.) ===
    $('link[href]').each((_, el) => {
      const $el = $(el);
      const href = $el.attr('href');
      const newHref = this.resolveAndMap(href, localHtmlPath);
      if (newHref) {
        $el.attr('href', newHref);
      }
    });

    // === Rewrite <script> tags ===
    $('script[src]').each((_, el) => {
      const $el = $(el);

      // Optionally strip all JS
      if (this.stripJs) {
        $el.remove();
        return;
      }

      // Strip tracking scripts
      const src = $el.attr('src');
      if (this.stripTracking && this.isTrackingScript(src)) {
        $el.remove();
        return;
      }

      const newSrc = this.resolveAndMap(src, localHtmlPath);
      if (newSrc) {
        $el.attr('src', newSrc);
      }
    });

    // === Rewrite <img> tags ===
    $('img[src]').each((_, el) => {
      const $el = $(el);
      const src = $el.attr('src');
      if (src && !src.startsWith('data:')) {
        const newSrc = this.resolveAndMap(src, localHtmlPath);
        if (newSrc) $el.attr('src', newSrc);
      }

      // Handle srcset
      const srcset = $el.attr('srcset');
      if (srcset) {
        $el.attr('srcset', this.rewriteSrcset(srcset, localHtmlPath));
      }
    });

    // === Rewrite <source> tags (video/audio) ===
    $('source[src]').each((_, el) => {
      const $el = $(el);
      const src = $el.attr('src');
      if (src) {
        const newSrc = this.resolveAndMap(src, localHtmlPath);
        if (newSrc) $el.attr('src', newSrc);
      }

      const srcset = $el.attr('srcset');
      if (srcset) {
        $el.attr('srcset', this.rewriteSrcset(srcset, localHtmlPath));
      }
    });

    // === Rewrite <video> and <audio> tags ===
    $('video[src], audio[src]').each((_, el) => {
      const $el = $(el);
      const src = $el.attr('src');
      if (src) {
        const newSrc = this.resolveAndMap(src, localHtmlPath);
        if (newSrc) $el.attr('src', newSrc);
      }

      // Handle poster attribute on video
      const poster = $el.attr('poster');
      if (poster) {
        const newPoster = this.resolveAndMap(poster, localHtmlPath);
        if (newPoster) $el.attr('poster', newPoster);
      }
    });

    // === Rewrite <a> tags for internal links ===
    $('a[href]').each((_, el) => {
      const $el = $(el);
      const href = $el.attr('href');

      // Rewrite internal links to local pages
      if (href && !href.startsWith('#') && !href.startsWith('mailto:') && !href.startsWith('tel:')) {
        try {
          const fullUrl = new URL(href, this.baseUrl);
          const baseHost = new URL(this.baseUrl).hostname;

          if (fullUrl.hostname === baseHost) {
            // Internal link — convert to local path
            let localPage = fullUrl.pathname;
            if (localPage === '/' || localPage === '') {
              localPage = 'index.html';
            } else {
              localPage = localPage.replace(/^\//, '').replace(/\/$/, '') + '/index.html';
            }
            const rel = relativePath(localHtmlPath, localPage);
            $el.attr('href', rel);
          }
        } catch {
          // Not a valid URL, leave as-is
        }
      }
    });

    // === Rewrite background-image in inline styles ===
    $('[style]').each((_, el) => {
      const $el = $(el);
      const style = $el.attr('style');
      if (style && style.includes('url(')) {
        $el.attr('style', this.rewriteCssUrls(style, localHtmlPath));
      }
    });

    // === Rewrite data-framer-* attributes that contain URLs ===
    $('[data-framer-page-optimized-at]').each((_, el) => {
      // Remove Framer optimization markers
    });

    // === Rewrite <style> blocks ===
    $('style').each((_, el) => {
      const $el = $(el);
      const css = $el.html();
      if (css) {
        $el.html(this.rewriteCssUrls(css, localHtmlPath));
      }
    });

    // === Rewrite meta tags with image URLs ===
    $('meta[content]').each((_, el) => {
      const $el = $(el);
      const content = $el.attr('content');
      const property = $el.attr('property') || $el.attr('name') || '';

      if (property.includes('image') || property.includes('og:image')) {
        const newContent = this.resolveAndMap(content, localHtmlPath);
        if (newContent) $el.attr('content', newContent);
      }
    });

    // Strip Framer runtime scripts if no-js mode
    if (this.stripJs) {
      $('script').remove();
      // Add a note
      $('body').append('<!-- Scripts removed by Framer Cloner (--no-js mode) -->');
    }

    return $.html();
  }

  /**
   * Rewrite all url() references in a CSS string
   */
  rewriteCssUrls(css, localFilePath) {
    // Match url() patterns — handles url("..."), url('...'), and url(...)
    return css.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/g, (match, quote, urlStr) => {
      // Skip data URIs and fragments
      if (urlStr.startsWith('data:') || urlStr.startsWith('#')) {
        return match;
      }

      const resolved = this.resolveAndMap(urlStr.trim(), localFilePath);
      if (resolved) {
        return `url(${quote}${resolved}${quote})`;
      }
      return match;
    });
  }

  /**
   * Rewrite @import statements in CSS
   */
  rewriteCssImports(css, localFilePath) {
    // Match @import url("...") and @import "..."
    return css.replace(/@import\s+(?:url\(\s*(['"]?)([^)'"]+)\1\s*\)|(['"])([^'"]+)\3)/g,
      (match, q1, url1, q2, url2) => {
        const url = url1 || url2;
        const quote = q1 || q2 || '"';
        const resolved = this.resolveAndMap(url.trim(), localFilePath);
        if (resolved) {
          return `@import url(${quote}${resolved}${quote})`;
        }
        return match;
      }
    );
  }

  /**
   * Full CSS rewrite — handles both url() and @import
   */
  rewriteCss(css, localFilePath) {
    let result = this.rewriteCssImports(css, localFilePath);
    result = this.rewriteCssUrls(result, localFilePath);
    return result;
  }

  /**
   * Rewrite srcset attribute
   */
  rewriteSrcset(srcset, localFilePath) {
    return srcset.split(',').map(entry => {
      const parts = entry.trim().split(/\s+/);
      if (parts.length >= 1) {
        const resolved = this.resolveAndMap(parts[0], localFilePath);
        if (resolved) {
          parts[0] = resolved;
        }
      }
      return parts.join(' ');
    }).join(', ');
  }

  /**
   * Resolve a URL against the base URL and find its local mapping
   */
  resolveAndMap(urlStr, localFilePath) {
    if (!urlStr) return null;

    // Skip data URIs, blobs, and fragments
    if (urlStr.startsWith('data:') || urlStr.startsWith('blob:') || urlStr.startsWith('#')) {
      return null;
    }

    try {
      // Resolve to absolute URL
      const absoluteUrl = new URL(urlStr, this.baseUrl).href;

      // Look up in our URL map
      if (this.urlMap.has(absoluteUrl)) {
        const localResourcePath = this.urlMap.get(absoluteUrl);
        return relativePath(localFilePath, localResourcePath);
      }

      // Try without trailing slash
      const withoutSlash = absoluteUrl.replace(/\/$/, '');
      if (this.urlMap.has(withoutSlash)) {
        const localResourcePath = this.urlMap.get(withoutSlash);
        return relativePath(localFilePath, localResourcePath);
      }

      // Try with protocol variations
      const httpVariant = absoluteUrl.replace('https://', 'http://');
      if (this.urlMap.has(httpVariant)) {
        const localResourcePath = this.urlMap.get(httpVariant);
        return relativePath(localFilePath, localResourcePath);
      }
    } catch {
      // Invalid URL, skip
    }

    return null;
  }

  /**
   * Check if a script URL is a tracking/analytics script
   */
  isTrackingScript(src) {
    if (!src) return false;
    const trackingDomains = [
      'google-analytics.com',
      'googletagmanager.com',
      'facebook.net',
      'hotjar.com',
      'intercom.io',
      'segment.com',
      'mixpanel.com',
      'amplitude.com',
      'sentry.io',
    ];
    return trackingDomains.some(d => src.includes(d));
  }
}

module.exports = UrlRewriter;
