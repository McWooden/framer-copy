# 🌐 Framer Website Cloner

Clone entire Framer websites locally — HTML, CSS, JS, images, fonts, and all assets — so they work identically when opened from your file system.

## Features

- **Full Page Rendering** — Uses Puppeteer (headless Chrome) to render React-based Framer sites, capturing CSS-in-JS styles and dynamically injected content
- **Complete Asset Download** — Downloads all CSS, JS, images, fonts, videos, and other resources
- **Smart URL Rewriting** — Rewrites all URLs in HTML and CSS to point to local files
- **Multi-Page Crawling** — Follows internal links to clone multiple pages
- **Organized Output** — Resources are categorized into `css/`, `js/`, `images/`, `fonts/`, `assets/` directories
- **Progress Tracking** — Visual progress bars and detailed logging
- **Retry Logic** — Automatic retries for failed downloads
- **Static Snapshot Mode** — Option to strip all JavaScript for a pure HTML/CSS snapshot

## Requirements

- **Node.js** 18 or higher
- **npm** or **yarn**

## Installation

```bash
cd copytools
npm install
```

This will install all dependencies including Puppeteer (which downloads a Chromium browser automatically).

## Usage

### Basic — Clone a Single Page

```bash
node index.js --url https://mysite.framer.website
```

### Clone Entire Site (Multiple Pages)

```bash
node index.js --url https://mysite.framer.website --pages 5
```

### Static Snapshot (No JavaScript)

```bash
node index.js --url https://mysite.framer.website --no-js
```

### Custom Output Directory

```bash
node index.js --url https://mysite.framer.website --output ./my-site-clone
```

### Extra Wait for Slow Pages

```bash
node index.js --url https://mysite.framer.website --wait 5000
```

## CLI Options

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `--url` | `-u` | *required* | Website URL to clone |
| `--output` | `-o` | `./cloned-{hostname}` | Output directory |
| `--wait` | `-w` | `3000` | Extra wait time (ms) for dynamic content |
| `--no-js` | — | `false` | Strip all JavaScript from output |
| `--pages` | `-p` | `1` | Number of pages to crawl |
| `--help` | `-h` | — | Show help message |

## Output Structure

```
cloned-mysite.framer.website/
├── index.html              # Main page (fully rendered)
├── about/
│   └── index.html          # Subpage (if crawled)
├── css/
│   ├── styles-abc123.css
│   └── chunk-def456.css
├── js/
│   ├── main-ghi789.js
│   └── vendor-jkl012.js
├── images/
│   ├── hero.webp
│   ├── logo.svg
│   └── bg-pattern.png
├── fonts/
│   ├── Inter-Regular.woff2
│   └── Inter-Bold.woff2
└── assets/
    └── video.mp4
```

## How It Works

1. **Browser Capture** — Launches a headless Chromium browser, navigates to the site, and waits for full rendering. Intercepts all network requests to build a resource inventory. Auto-scrolls to trigger lazy-loaded content.

2. **Resource Download** — Downloads all discovered CSS, JS, images, fonts, and other assets with concurrent connections and automatic retries.

3. **URL Rewriting** — Parses the rendered HTML with Cheerio and rewrites all `src`, `href`, `srcset`, `url()`, `@import`, and inline style references to point to the local files.

4. **Page Crawling** — (Optional) Follows internal links to discover and clone additional pages on the same domain.

## Tips

- **Framer sites with custom domains** — Use the custom domain URL directly (e.g., `https://www.mysite.com`)
- **Large sites** — Increase `--wait` if some content doesn't appear in the clone
- **Fonts not loading** — Check browser console; some fonts may require CORS headers that don't work from `file://`. Use a local HTTP server instead:
  ```bash
  npx serve ./cloned-mysite.framer.website
  ```
- **Animations** — Framer Motion animations are preserved when JavaScript is kept (default). Use `--no-js` only if you want a static snapshot.

## Troubleshooting

### "Navigation timeout" error
Increase the wait time: `--wait 10000`

### Missing images
Some images may load lazily after scroll. The tool auto-scrolls but very long pages may need more time. Try increasing `--wait`.

### Fonts look different
Serve the cloned site via HTTP instead of opening `file://` directly:
```bash
npx serve ./cloned-mysite.framer.website
```

### Puppeteer won't install
On some systems, Puppeteer needs additional dependencies:
```bash
# Windows — usually works out of the box
# Linux — may need:
sudo apt install -y chromium-browser
```

## License

MIT
