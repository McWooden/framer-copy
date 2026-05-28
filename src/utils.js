const path = require('path');
const { URL } = require('url');
const mime = require('mime-types');

/**
 * Normalize a URL by removing hash fragments and trailing slashes
 */
function normalizeUrl(urlStr, baseUrl) {
  try {
    const url = new URL(urlStr, baseUrl);
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Determine the resource category based on MIME type or file extension
 */
function categorizeResource(urlStr, contentType) {
  const ext = getExtensionFromUrl(urlStr);
  const mimeType = contentType || mime.lookup(ext) || '';

  if (mimeType.includes('text/css') || ext === '.css') return 'css';
  if (mimeType.includes('javascript') || ext === '.js' || ext === '.mjs') return 'js';
  if (mimeType.includes('font') || ['.woff', '.woff2', '.ttf', '.otf', '.eot'].includes(ext)) return 'fonts';
  if (mimeType.includes('image') || ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.avif'].includes(ext)) return 'images';
  if (mimeType.includes('video') || ['.mp4', '.webm', '.ogg', '.mov'].includes(ext)) return 'assets';
  if (mimeType.includes('audio') || ['.mp3', '.wav', '.flac'].includes(ext)) return 'assets';
  if (mimeType.includes('application/json') || ext === '.json') return 'assets';

  // Framer-specific: many resources come without clear extensions
  if (mimeType.includes('text/css')) return 'css';
  if (mimeType.includes('javascript')) return 'js';
  if (mimeType.includes('image')) return 'images';

  return 'assets';
}

/**
 * Extract file extension from a URL
 */
function getExtensionFromUrl(urlStr) {
  try {
    const url = new URL(urlStr, 'https://placeholder.com');
    const pathname = url.pathname;
    const ext = path.extname(pathname);
    return ext.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Infer file extension from content-type header
 */
function getExtensionFromContentType(contentType) {
  if (!contentType) return '';
  const mimeBase = contentType.split(';')[0].trim();
  const ext = mime.extension(mimeBase);
  return ext ? `.${ext}` : '';
}

/**
 * Generate a safe filename from a URL
 */
function urlToFilename(urlStr, contentType) {
  try {
    const url = new URL(urlStr);
    let pathname = url.pathname;

    // Remove leading slash
    pathname = pathname.replace(/^\//, '');

    // If pathname is empty or just a slash, use 'index'
    if (!pathname || pathname === '/') {
      pathname = 'index';
    }

    // Replace problematic characters
    let filename = pathname
      .replace(/\//g, '_')
      .replace(/[<>:"|?*\\]/g, '_')
      .replace(/_{2,}/g, '_');

    // Ensure it has an extension
    const ext = path.extname(filename);
    if (!ext) {
      const inferredExt = getExtensionFromContentType(contentType);
      if (inferredExt) {
        filename += inferredExt;
      }
    }

    // Truncate very long filenames
    if (filename.length > 200) {
      const fileExt = path.extname(filename);
      const base = filename.substring(0, 180);
      filename = base + fileExt;
    }

    return filename;
  } catch {
    return `resource_${Date.now()}`;
  }
}

/**
 * Generate a unique filename by appending a counter if the name already exists
 */
function uniqueFilename(existingNames, desiredName) {
  if (!existingNames.has(desiredName)) {
    existingNames.add(desiredName);
    return desiredName;
  }

  const ext = path.extname(desiredName);
  const base = path.basename(desiredName, ext);
  let counter = 1;

  while (existingNames.has(`${base}_${counter}${ext}`)) {
    counter++;
  }

  const unique = `${base}_${counter}${ext}`;
  existingNames.add(unique);
  return unique;
}

/**
 * Check if a URL is from the same origin
 */
function isSameOrigin(urlStr, baseUrl) {
  try {
    const url = new URL(urlStr, baseUrl);
    const base = new URL(baseUrl);
    return url.hostname === base.hostname;
  } catch {
    return false;
  }
}

/**
 * Check if a URL is a page (HTML) vs a resource
 */
function isPageUrl(urlStr) {
  const ext = getExtensionFromUrl(urlStr);
  // No extension or .html/.htm are pages
  if (!ext || ext === '.html' || ext === '.htm') return true;
  return false;
}

/**
 * Convert a page URL to a local file path
 */
function pageUrlToLocalPath(urlStr, baseUrl) {
  try {
    const url = new URL(urlStr, baseUrl);
    let pathname = url.pathname;

    // Remove trailing slash
    pathname = pathname.replace(/\/$/, '');

    if (!pathname || pathname === '') {
      return 'index.html';
    }

    // Remove leading slash
    pathname = pathname.replace(/^\//, '');

    // If it doesn't end in .html, treat as directory → add /index.html
    if (!pathname.endsWith('.html') && !pathname.endsWith('.htm')) {
      pathname = pathname + '/index.html';
    }

    return pathname;
  } catch {
    return 'index.html';
  }
}

/**
 * Calculate relative path from one file to another
 */
function relativePath(fromFile, toFile) {
  const fromDir = path.dirname(fromFile);
  let rel = path.relative(fromDir, toFile);
  // Always use forward slashes
  rel = rel.replace(/\\/g, '/');
  // Ensure it starts with ./ if not going up
  if (!rel.startsWith('.') && !rel.startsWith('/')) {
    rel = './' + rel;
  }
  return rel;
}

/**
 * Detect known Framer CDN domains
 */
function isFramerCdnUrl(urlStr) {
  const framerDomains = [
    'framerusercontent.com',
    'framer.com',
    'framer.website',
    'framerstatic.com',
    'events.framer.com',
    'framerassets.com',
  ];
  try {
    const url = new URL(urlStr);
    return framerDomains.some(d => url.hostname.includes(d));
  } catch {
    return false;
  }
}

/**
 * Check if a URL should be skipped (analytics, tracking, etc.)
 */
function shouldSkipUrl(urlStr) {
  const skipPatterns = [
    'google-analytics.com',
    'googletagmanager.com',
    'facebook.net',
    'hotjar.com',
    'intercom.io',
    'segment.com',
    'mixpanel.com',
    'amplitude.com',
    'sentry.io',
    'events.framer.com',
  ];
  try {
    const url = new URL(urlStr);
    return skipPatterns.some(p => url.hostname.includes(p));
  } catch {
    return false;
  }
}

module.exports = {
  normalizeUrl,
  categorizeResource,
  getExtensionFromUrl,
  getExtensionFromContentType,
  urlToFilename,
  uniqueFilename,
  isSameOrigin,
  isPageUrl,
  pageUrlToLocalPath,
  relativePath,
  isFramerCdnUrl,
  shouldSkipUrl,
};
