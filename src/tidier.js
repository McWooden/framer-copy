const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

/**
 * Tidier module — cleans up a cloned Framer site:
 *  1. Finds all HTML pages and collects actually-referenced files
 *  2. Removes unreferenced JS/CSS/asset files
 *  3. Merges all CSS into one stylesheet
 *  4. Renames hash-suffixed files to clean names
 *  5. Strips Framer analytics & runtime bloat scripts
 */
class SiteTidier {
  constructor(outputDir, options = {}) {
    this.outputDir = outputDir;
    this.options = {
      mergeCSS: options.mergeCSS !== false,      // default: on
      removeUnused: options.removeUnused !== false, // default: on
      renameFiles: options.renameFiles !== false,  // default: on
      stripFramerRuntime: options.stripFramerRuntime !== false, // default: on
    };

    this.log = options.log || (() => {});
    this.stats = {
      removedFiles: 0,
      savedBytes: 0,
      cssFilesMerged: 0,
      renamedFiles: 0,
    };
  }

  /**
   * Run all tidy operations
   */
  async tidy() {
    this.log('status', { message: 'Scanning HTML pages...', phase: 'tidy', progress: 0 });

    // Step 1: Find all HTML pages
    const htmlFiles = this.findFiles(this.outputDir, '.html');
    this.log('status', { message: `Found ${htmlFiles.length} HTML page(s)`, phase: 'tidy', progress: 5 });

    // Step 2: Collect all referenced resources from HTML
    const referenced = await this.collectReferences(htmlFiles);
    this.log('status', {
      message: `Found ${referenced.size} referenced files`,
      phase: 'tidy', progress: 15
    });

    // Step 3: Remove unreferenced files
    if (this.options.removeUnused) {
      this.log('status', { message: 'Removing unused files...', phase: 'tidy', progress: 20 });
      await this.removeUnused(referenced);
      this.log('status', {
        message: `Removed ${this.stats.removedFiles} unused file(s) (${this.formatBytes(this.stats.savedBytes)})`,
        phase: 'tidy', progress: 40
      });
    }

    // Step 4: Merge CSS
    if (this.options.mergeCSS) {
      this.log('status', { message: 'Merging CSS files...', phase: 'tidy', progress: 45 });
      await this.mergeCSS(htmlFiles);
      this.log('status', {
        message: `Merged ${this.stats.cssFilesMerged} CSS file(s) into styles.css`,
        phase: 'tidy', progress: 65
      });
    }

    // Step 5: Strip Framer runtime bloat from HTML
    if (this.options.stripFramerRuntime) {
      this.log('status', { message: 'Stripping Framer runtime bloat...', phase: 'tidy', progress: 70 });
      await this.stripFramerBloat(htmlFiles);
      this.log('status', { message: 'Stripped Framer runtime scripts', phase: 'tidy', progress: 80 });
    }

    // Step 6: Rename hash-named files
    if (this.options.renameFiles) {
      this.log('status', { message: 'Renaming hashed files...', phase: 'tidy', progress: 85 });
      await this.renameHashedFiles(htmlFiles);
      this.log('status', {
        message: `Renamed ${this.stats.renamedFiles} file(s)`,
        phase: 'tidy', progress: 95
      });
    }

    // Done
    const finalHtmlFiles = this.findFiles(this.outputDir, '.html');
    const finalAllFiles = this.findAllFiles(this.outputDir);

    this.log('status', { message: 'Tidy complete!', phase: 'tidy', progress: 100 });

    return {
      ...this.stats,
      totalFilesAfter: finalAllFiles.length,
      htmlPages: finalHtmlFiles.length,
    };
  }

  // ─────────────────────────────────────────────
  // Step 1: Find all HTML files recursively
  // ─────────────────────────────────────────────
  findFiles(dir, ext) {
    const results = [];
    if (!fs.existsSync(dir)) return results;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...this.findFiles(fullPath, ext));
      } else if (entry.isFile() && entry.name.endsWith(ext)) {
        results.push(fullPath);
      }
    }
    return results;
  }

  findAllFiles(dir) {
    const results = [];
    if (!fs.existsSync(dir)) return results;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...this.findAllFiles(fullPath));
      } else {
        results.push(fullPath);
      }
    }
    return results;
  }

  // ─────────────────────────────────────────────
  // Step 2: Collect all referenced files from HTML
  // ─────────────────────────────────────────────
  async collectReferences(htmlFiles) {
    const referenced = new Set();

    // Always keep HTML files themselves
    for (const htmlFile of htmlFiles) {
      referenced.add(htmlFile);
    }

    for (const htmlFile of htmlFiles) {
      const html = fs.readFileSync(htmlFile, 'utf-8');
      const $ = cheerio.load(html, { decodeEntities: false });
      const htmlDir = path.dirname(htmlFile);

      const resolve = (relPath) => {
        if (!relPath || relPath.startsWith('http') || relPath.startsWith('data:') || relPath.startsWith('#')) return;
        // Strip query strings and hashes
        const cleanPath = relPath.split('?')[0].split('#')[0];
        const abs = path.resolve(htmlDir, cleanPath);
        if (fs.existsSync(abs)) referenced.add(abs);
      };

      $('link[href]').each((_, el) => resolve($(el).attr('href')));
      $('script[src]').each((_, el) => resolve($(el).attr('src')));
      $('img[src]').each((_, el) => resolve($(el).attr('src')));
      $('source[src]').each((_, el) => resolve($(el).attr('src')));
      $('video[src]').each((_, el) => resolve($(el).attr('src')));
      $('video[poster]').each((_, el) => resolve($(el).attr('poster')));

      // srcset
      $('[srcset]').each((_, el) => {
        const srcset = $(el).attr('srcset');
        if (srcset) {
          srcset.split(',').forEach(entry => {
            const parts = entry.trim().split(/\s+/);
            if (parts[0]) resolve(parts[0]);
          });
        }
      });

      // Inline style url() references
      $('[style]').each((_, el) => {
        const style = $(el).attr('style') || '';
        const urlMatches = style.matchAll(/url\(['"]?([^'"()]+)['"]?\)/g);
        for (const match of urlMatches) resolve(match[1]);
      });
    }

    // Also scan CSS files for url() references (fonts, bg images)
    const cssFiles = this.findFiles(this.outputDir, '.css');
    for (const cssFile of cssFiles) {
      if (!referenced.has(cssFile)) continue;
      const css = fs.readFileSync(cssFile, 'utf-8');
      const cssDir = path.dirname(cssFile);
      const urlMatches = css.matchAll(/url\(['"]?([^'"()]+)['"]?\)/g);
      for (const match of urlMatches) {
        const relPath = match[1].split('?')[0].split('#')[0];
        if (relPath.startsWith('data:') || relPath.startsWith('http')) continue;
        const abs = path.resolve(cssDir, relPath);
        if (fs.existsSync(abs)) referenced.add(abs);
      }
    }

    return referenced;
  }

  // ─────────────────────────────────────────────
  // Step 3: Remove unreferenced files
  // ─────────────────────────────────────────────
  async removeUnused(referenced) {
    const allFiles = this.findAllFiles(this.outputDir);

    for (const file of allFiles) {
      // Never remove HTML files
      if (file.endsWith('.html')) continue;

      if (!referenced.has(file)) {
        try {
          const stat = fs.statSync(file);
          this.stats.savedBytes += stat.size;
          fs.unlinkSync(file);
          this.stats.removedFiles++;
        } catch {
          // file already gone
        }
      }
    }

    // Clean up empty directories
    this.removeEmptyDirs(this.outputDir);
  }

  removeEmptyDirs(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        this.removeEmptyDirs(fullPath);
        if (fs.readdirSync(fullPath).length === 0) {
          fs.rmdirSync(fullPath);
        }
      }
    }
  }

  // ─────────────────────────────────────────────
  // Step 4: Merge all CSS files into one styles.css
  // ─────────────────────────────────────────────
  async mergeCSS(htmlFiles) {
    for (const htmlFile of htmlFiles) {
      const html = fs.readFileSync(htmlFile, 'utf-8');
      const $ = cheerio.load(html, { decodeEntities: false });
      const htmlDir = path.dirname(htmlFile);

      const cssLinks = [];
      $('link[rel="stylesheet"]').each((_, el) => {
        const href = $(el).attr('href');
        if (!href || href.startsWith('http')) return;

        const cleanHref = href.split('?')[0];
        const absPath = path.resolve(htmlDir, cleanHref);

        if (fs.existsSync(absPath) && absPath.endsWith('.css')) {
          cssLinks.push({ el, href, absPath });
        }
      });

      if (cssLinks.length <= 1) continue; // Nothing to merge

      // Read and concatenate all CSS, fixing relative URLs within each
      let merged = '';
      for (const { absPath, href } of cssLinks) {
        let css = fs.readFileSync(absPath, 'utf-8');
        const cssDir = path.dirname(absPath);

        // Rebase url() references to be relative to htmlDir
        css = css.replace(/url\(['"]?([^'"()]+)['"]?\)/g, (match, urlStr) => {
          if (urlStr.startsWith('data:') || urlStr.startsWith('http') || urlStr.startsWith('/')) return match;
          const absUrl = path.resolve(cssDir, urlStr);
          const relFromHtml = path.relative(htmlDir, absUrl).replace(/\\/g, '/');
          return `url('${relFromHtml}')`;
        });

        merged += `/* === ${path.basename(absPath)} === */\n${css}\n\n`;
        this.stats.cssFilesMerged++;
      }

      // Write merged CSS next to the HTML file
      const mergedPath = path.join(htmlDir, 'styles.css');
      fs.writeFileSync(mergedPath, merged, 'utf-8');

      // Remove all old <link> tags and add one merged one
      cssLinks.forEach(({ el }) => $(el).remove());

      // Insert merged stylesheet link in <head>
      $('head').prepend('<link rel="stylesheet" href="styles.css">');

      // Delete individual old CSS files (only those in css/ subdir to be safe)
      for (const { absPath } of cssLinks) {
        if (absPath.includes(`${path.sep}css${path.sep}`) ||
            absPath.includes(`${path.sep}css/`)) {
          try { fs.unlinkSync(absPath); } catch {}
        }
      }

      fs.writeFileSync(htmlFile, $.html(), 'utf-8');
    }
  }

  // ─────────────────────────────────────────────
  // Step 5: Strip Framer runtime bloat
  // ─────────────────────────────────────────────
  async stripFramerBloat(htmlFiles) {
    const bloatPatterns = [
      // Tracking & analytics
      'google-analytics.com',
      'googletagmanager.com',
      'facebook.net',
      'hotjar.com',
      'segment.com',
      'mixpanel.com',
      'intercom.io',
      'sentry.io',
      // Framer-specific runtime
      'events.framer.com',
      'framer.com/m/framer/',   // Framer module loader
    ];

    // Inline script markers to strip
    const inlineScriptPatterns = [
      /framer\.events/,
      /FramerAnalytics/,
      /framer\.com\/analytics/,
      /__framer__/,
      /window\.__FRAMER_SITE_INFO__/,
    ];

    for (const htmlFile of htmlFiles) {
      const html = fs.readFileSync(htmlFile, 'utf-8');
      const $ = cheerio.load(html, { decodeEntities: false });
      let modified = false;

      // Remove external tracking scripts
      $('script[src]').each((_, el) => {
        const src = $(el).attr('src') || '';
        if (bloatPatterns.some(p => src.includes(p))) {
          $(el).remove();
          modified = true;
        }
      });

      // Remove inline Framer tracking scripts
      $('script:not([src])').each((_, el) => {
        const content = $(el).html() || '';
        if (inlineScriptPatterns.some(p => p.test(content))) {
          $(el).remove();
          modified = true;
        }
      });

      // Remove Framer-specific noscript tags
      $('noscript').each((_, el) => {
        const content = $(el).html() || '';
        if (content.includes('framer')) {
          $(el).remove();
          modified = true;
        }
      });

      // Remove <link rel="preload"> for external resources (framer CDN)
      $('link[rel="preload"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        if (href.startsWith('https://') && bloatPatterns.some(p => href.includes(p))) {
          $(el).remove();
          modified = true;
        }
      });

      if (modified) {
        fs.writeFileSync(htmlFile, $.html(), 'utf-8');
      }
    }
  }

  // ─────────────────────────────────────────────
  // Step 6: Rename hash-suffixed files
  // ─────────────────────────────────────────────
  async renameHashedFiles(htmlFiles) {
    // Find files with hash patterns: chunk-abc1234f.js, styles.a1b2c3.css, etc.
    const hashPattern = /[-.]([a-f0-9]{6,12})(\.(?:js|css|woff2?|ttf|png|jpg|webp|svg))$/i;
    const counters = { js: 0, css: 0, fonts: 0, images: 0 };
    const renameMap = new Map(); // oldPath → newPath

    const subDirs = ['js', 'css', 'fonts', 'images', 'assets'];
    for (const sub of subDirs) {
      const subDir = path.join(this.outputDir, sub);
      if (!fs.existsSync(subDir)) continue;

      const files = fs.readdirSync(subDir);
      for (const file of files) {
        if (!hashPattern.test(file)) continue;

        const ext = path.extname(file);
        const category = sub === 'js' ? 'js' : sub === 'css' ? 'css' : sub === 'fonts' ? 'fonts' : 'img';
        counters[sub] = (counters[sub] || 0) + 1;

        // Build a clean name
        let cleanName = file
          .replace(hashPattern, ext)                 // remove hash
          .replace(/[_-]{2,}/g, '-')                 // clean double dashes
          .replace(/^[-.]/, '');                     // clean leading dash

        // Ensure unique
        let targetPath = path.join(subDir, cleanName);
        let suffix = 1;
        while (
          fs.existsSync(targetPath) &&
          targetPath !== path.join(subDir, file)
        ) {
          const base = path.basename(cleanName, ext);
          cleanName = `${base}-${suffix}${ext}`;
          targetPath = path.join(subDir, cleanName);
          suffix++;
        }

        const oldPath = path.join(subDir, file);
        if (oldPath !== targetPath) {
          renameMap.set(oldPath, targetPath);
          this.stats.renamedFiles++;
        }
      }
    }

    if (renameMap.size === 0) return;

    // Build a relative-path replacement map for HTML/CSS patching
    const relRenameMap = new Map();
    for (const [oldAbs, newAbs] of renameMap) {
      const oldRel = path.relative(this.outputDir, oldAbs).replace(/\\/g, '/');
      const newRel = path.relative(this.outputDir, newAbs).replace(/\\/g, '/');
      relRenameMap.set(oldRel, newRel);
      // Also map just basenames (for CSS url() references)
      relRenameMap.set(path.basename(oldAbs), path.basename(newAbs));
    }

    // Patch all HTML files
    for (const htmlFile of htmlFiles) {
      let html = fs.readFileSync(htmlFile, 'utf-8');
      let modified = false;
      for (const [oldRel, newRel] of relRenameMap) {
        if (html.includes(oldRel)) {
          html = html.split(oldRel).join(newRel);
          modified = true;
        }
      }
      if (modified) fs.writeFileSync(htmlFile, html, 'utf-8');
    }

    // Patch all CSS files
    const cssFiles = this.findFiles(this.outputDir, '.css');
    for (const cssFile of cssFiles) {
      let css = fs.readFileSync(cssFile, 'utf-8');
      let modified = false;
      for (const [oldRel, newRel] of relRenameMap) {
        if (css.includes(oldRel)) {
          css = css.split(oldRel).join(newRel);
          modified = true;
        }
      }
      if (modified) fs.writeFileSync(cssFile, css, 'utf-8');
    }

    // Actually rename the files on disk
    for (const [oldPath, newPath] of renameMap) {
      try {
        if (fs.existsSync(oldPath)) {
          fs.renameSync(oldPath, newPath);
        }
      } catch {
        // skip
      }
    }
  }

  // ─────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────
  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  }
}

module.exports = SiteTidier;
