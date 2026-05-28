#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const BrowserCapture = require('./src/browser');
const ResourceDownloader = require('./src/downloader');
const UrlRewriter = require('./src/rewriter');
const PageCrawler = require('./src/crawler');

// ─────────────────────────────────────────────
// CLI Argument Parsing
// ─────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    url: null,
    output: null,
    wait: 3000,
    noJs: false,
    pages: 1,
    all: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--url':
      case '-u':
        config.url = args[++i];
        break;
      case '--output':
      case '-o':
        config.output = args[++i];
        break;
      case '--wait':
      case '-w':
        config.wait = parseInt(args[++i], 10) || 3000;
        break;
      case '--no-js':
        config.noJs = true;
        break;
      case '--pages':
      case '-p':
        config.pages = parseInt(args[++i], 10) || 1;
        break;
      case '--all':
      case '-a':
        config.all = true;
        break;
      case '--help':
      case '-h':
        config.help = true;
        break;
      default:
        // If no flag, treat as URL
        if (!config.url && !args[i].startsWith('-')) {
          config.url = args[i];
        }
        break;
    }
  }

  return config;
}

function printBanner() {
  console.log('');
  console.log(chalk.bold.cyan('  ╔══════════════════════════════════════════╗'));
  console.log(chalk.bold.cyan('  ║') + chalk.bold.white('    🌐  Framer Website Cloner  v1.0.0    ') + chalk.bold.cyan('║'));
  console.log(chalk.bold.cyan('  ║') + chalk.gray('    Download entire Framer sites locally   ') + chalk.bold.cyan('║'));
  console.log(chalk.bold.cyan('  ╚══════════════════════════════════════════╝'));
  console.log('');
}

function printHelp() {
  printBanner();
  console.log(chalk.bold('Usage:'));
  console.log('  node index.js --url <website-url> [options]');
  console.log('');
  console.log(chalk.bold('Options:'));
  console.log('  --url, -u <url>      Website URL to clone (required)');
  console.log('  --output, -o <dir>   Output directory (default: ./cloned-site)');
  console.log('  --wait, -w <ms>      Extra wait time for slow pages (default: 3000)');
  console.log('  --no-js              Strip all JavaScript (static snapshot)');
  console.log('  --pages, -p <n>      Max number of pages to crawl (default: 1)');
  console.log('  --all, -a            Crawl ALL pages (auto-discovers via sitemap + links)');
  console.log('  --help, -h           Show this help message');
  console.log('');
  console.log(chalk.bold('Examples:'));
  console.log(chalk.gray('  # Clone a single page'));
  console.log('  node index.js --url https://mysite.framer.website');
  console.log('');
  console.log(chalk.gray('  # Clone ALL pages on the site'));
  console.log('  node index.js --url https://mysite.framer.website --all');
  console.log('');
  console.log(chalk.gray('  # Clone up to 10 pages'));
  console.log('  node index.js --url https://mysite.framer.website --pages 10');
  console.log('');
  console.log(chalk.gray('  # Static snapshot without JavaScript'));
  console.log('  node index.js --url https://mysite.framer.website --no-js');
  console.log('');
  console.log(chalk.gray('  # Custom output directory'));
  console.log('  node index.js --url https://mysite.framer.website -o ./my-clone');
  console.log('');
}

// ─────────────────────────────────────────────
// Main Orchestration
// ─────────────────────────────────────────────
async function main() {
  const config = parseArgs();

  if (config.help) {
    printHelp();
    process.exit(0);
  }

  if (!config.url) {
    printHelp();
    console.log(chalk.red('  ✖ Error: Please provide a URL with --url'));
    process.exit(1);
  }

  // Ensure URL has protocol
  let url = config.url;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }

  // Remove trailing slash for consistency
  url = url.replace(/\/$/, '');

  // Determine output directory
  const hostname = new URL(url).hostname.replace(/[^a-zA-Z0-9.-]/g, '_');
  const outputDir = path.resolve(config.output || `./cloned-${hostname}`);

  printBanner();

  const crawlMode = config.all ? 'ALL (sitemap + link discovery)' : `${config.pages} page(s)`;

  console.log(chalk.bold('  Configuration:'));
  console.log(`    URL:       ${chalk.cyan(url)}`);
  console.log(`    Output:    ${chalk.cyan(outputDir)}`);
  console.log(`    Crawl:     ${chalk.cyan(crawlMode)}`);
  console.log(`    Wait:      ${chalk.cyan(config.wait + 'ms')}`);
  console.log(`    Strip JS:  ${chalk.cyan(config.noJs ? 'Yes' : 'No')}`);
  console.log('');

  // Create output directory
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const startTime = Date.now();

  // ─── Phase 1: Page Discovery ──────────────
  console.log(chalk.bold.yellow('  ▸ Phase 1: Page Discovery'));

  const crawler = new PageCrawler(url, {
    pages: config.pages,
    all: config.all,
  });

  // Try sitemap first if crawling all or multiple pages
  let sitemapPages = [];
  if (config.all || config.pages > 1) {
    console.log(chalk.gray('    Checking sitemap.xml...'));
    sitemapPages = await crawler.discoverFromSitemap();

    if (sitemapPages.length > 0) {
      console.log(chalk.green(`    ✓ Found ${sitemapPages.length} page(s) in sitemap.xml`));
      for (const p of sitemapPages) {
        console.log(chalk.gray(`      • ${p}`));
      }
    } else {
      console.log(chalk.gray('    No sitemap found — will discover pages by following links'));
    }
  }

  console.log('');

  // ─── Phase 2: Browser Capture ─────────────
  console.log(chalk.bold.yellow('  ▸ Phase 2: Browser Capture'));

  const browser = new BrowserCapture({ wait: config.wait });
  const allResources = new Map();
  const pageResults = new Map(); // pageUrl → { html, localPath }

  try {
    await browser.launch();

    // Build initial page queue
    const pagesToCrawl = [];

    // Always start with the root URL
    pagesToCrawl.push(url);
    crawler.markVisited(url);

    // Add sitemap pages
    for (const sitemapPage of sitemapPages) {
      if (!crawler.isVisited(sitemapPage)) {
        pagesToCrawl.push(sitemapPage);
        crawler.markVisited(sitemapPage);
      }
    }

    // Limit total pages if not --all
    const maxPages = config.all ? 500 : config.pages;
    let pageCount = 0;

    while (pagesToCrawl.length > 0 && pageCount < maxPages) {
      const currentUrl = pagesToCrawl.shift();
      pageCount++;

      const pageLocalPath = crawler.getLocalPath(currentUrl);

      console.log(chalk.gray(`    [${pageCount}] Capturing: ${currentUrl}`));

      try {
        const result = await browser.capture(currentUrl);

        // Merge resources
        for (const [resUrl, info] of result.resources) {
          if (!allResources.has(resUrl)) {
            allResources.set(resUrl, info);
          }
        }

        // Store page result
        pageResults.set(currentUrl, {
          html: result.html,
          localPath: pageLocalPath,
          links: result.links,
          injectedStyles: result.injectedStyles,
        });

        // Discover new pages from links (if crawling multiple pages)
        if (config.all || pageCount < config.pages) {
          const newPages = crawler.addLinks(result.links, 0);
          for (const newPageUrl of newPages) {
            if (!pagesToCrawl.includes(newPageUrl)) {
              pagesToCrawl.push(newPageUrl);
              crawler.markVisited(newPageUrl);
              console.log(chalk.gray(`      Discovered: ${newPageUrl}`));
            }
          }
        }
      } catch (err) {
        console.log(chalk.red(`    ✖ Failed to capture ${currentUrl}: ${err.message}`));
      }
    }

    console.log(chalk.green(`    ✓ Captured ${pageResults.size} page(s), found ${allResources.size} resources`));
    console.log('');

    // ─── Phase 3: Download Resources ──────────
    console.log(chalk.bold.yellow('  ▸ Phase 3: Download Resources'));

    const downloader = new ResourceDownloader(outputDir, {
      concurrency: 8,
      retries: 3,
    });

    const urlMap = await downloader.downloadAll(allResources, url);

    console.log('');

    // ─── Phase 4: Rewrite URLs ────────────────
    console.log(chalk.bold.yellow('  ▸ Phase 4: Rewrite URLs'));

    const rewriter = new UrlRewriter(urlMap, url, {
      noJs: config.noJs,
      stripTracking: true,
    });

    // Rewrite and save each page
    for (const [pageUrl, pageData] of pageResults) {
      const rewrittenHtml = rewriter.rewriteHtml(pageData.html, pageData.localPath);

      const fullPath = path.join(outputDir, pageData.localPath);
      const parentDir = path.dirname(fullPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      fs.writeFileSync(fullPath, rewrittenHtml, 'utf-8');
      console.log(chalk.gray(`    Saved: ${pageData.localPath}`));
    }

    // Rewrite CSS files
    const cssFiles = Array.from(urlMap.entries()).filter(([_, localPath]) =>
      localPath.startsWith('css/')
    );

    for (const [originalUrl, localPath] of cssFiles) {
      const fullPath = path.join(outputDir, localPath);
      if (fs.existsSync(fullPath)) {
        let css = fs.readFileSync(fullPath, 'utf-8');
        css = rewriter.rewriteCss(css, localPath);
        fs.writeFileSync(fullPath, css, 'utf-8');
      }
    }

    console.log(chalk.green(`    ✓ Rewrote URLs in ${pageResults.size} page(s) and ${cssFiles.length} CSS file(s)`));
    console.log('');

    // ─── Phase 5: Summary ─────────────────────
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const totalFiles = urlMap.size + pageResults.size;

    console.log(chalk.bold.green('  ═══════════════════════════════════════'));
    console.log(chalk.bold.green('  ✓ Clone Complete!'));
    console.log(chalk.bold.green('  ═══════════════════════════════════════'));
    console.log(`    📁 Output:     ${chalk.cyan(outputDir)}`);
    console.log(`    📄 Pages:      ${chalk.cyan(pageResults.size)}`);
    console.log(`    📦 Resources:  ${chalk.cyan(urlMap.size)}`);
    console.log(`    📊 Total:      ${chalk.cyan(totalFiles + ' files')}`);
    console.log(`    ⏱  Time:       ${chalk.cyan(elapsed + 's')}`);
    console.log('');

    // List all cloned pages
    if (pageResults.size > 1) {
      console.log(chalk.bold('  Cloned Pages:'));
      for (const [pageUrl, pageData] of pageResults) {
        console.log(`    ${chalk.gray('•')} ${pageData.localPath} ${chalk.gray('←')} ${pageUrl}`);
      }
      console.log('');
    }

    console.log(chalk.gray(`    Open ${path.join(outputDir, 'index.html')} in your browser to view the cloned site.`));
    console.log(chalk.gray(`    Or serve it: npx serve ${outputDir}`));
    console.log('');

  } catch (err) {
    console.error(chalk.red(`\n  ✖ Error: ${err.message}`));
    console.error(chalk.gray(`    ${err.stack}`));
    process.exit(1);
  } finally {
    await browser.close();
  }
}

// ─────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────
main().catch((err) => {
  console.error(chalk.red(`\n  ✖ Fatal Error: ${err.message}`));
  process.exit(1);
});
