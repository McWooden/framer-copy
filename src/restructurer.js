const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

/**
 * Restructurer — converts a cloned static site into Next.js App Router (latest version).
 *
 * Options:
 *  - lang: 'ts' (TypeScript) | 'js' (JavaScript)
 */
class SiteRestructurer {
  constructor(outputDir, options = {}) {
    this.outputDir = outputDir;
    this.lang = options.lang || 'ts'; // 'ts' or 'js'
    this.log = options.log || (() => {});
  }

  get ext() { return this.lang === 'ts' ? 'tsx' : 'jsx'; }
  get confExt() { return this.lang === 'ts' ? 'ts' : 'js'; }

  // ─────────────────────────────────────────────
  // Entry Point
  // ─────────────────────────────────────────────
  async restructure(targetDir) {
    return this.toNextjs(targetDir);
  }

  // ─────────────────────────────────────────────
  // Also generate REFACTOR_PROMPT.md in-place
  // (called standalone, saves file to outputDir)
  // ─────────────────────────────────────────────
  async generateAndSavePrompt() {
    this.log('status', { message: 'Building AI prompts...', phase: 'prompt', progress: 10 });

    const htmlFiles = this.findFiles(this.outputDir, '.html');
    const cssFiles  = this.findFiles(this.outputDir, '.css');
    const jsFiles   = this.findFiles(this.outputDir, '.js');
    const imgFiles  = [
      ...this.findFiles(this.outputDir, '.png'),
      ...this.findFiles(this.outputDir, '.jpg'),
      ...this.findFiles(this.outputDir, '.webp'),
      ...this.findFiles(this.outputDir, '.svg'),
    ];
    const fontFiles = [
      ...this.findFiles(this.outputDir, '.woff2'),
      ...this.findFiles(this.outputDir, '.woff'),
    ];

    this.log('status', { message: 'Reading page content...', phase: 'prompt', progress: 40 });

    const pageSummaries = [];
    for (const htmlFile of htmlFiles) {
      const html = fs.readFileSync(htmlFile, 'utf-8');
      const $ = cheerio.load(html, { decodeEntities: false });
      const title = $('title').text();
      const bodyText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 400);
      const relPath = path.relative(this.outputDir, htmlFile).replace(/\\/g, '/');
      pageSummaries.push({ path: relPath, title, excerpt: bodyText });
    }

    let cssPreview = '';
    if (cssFiles.length > 0) cssPreview = fs.readFileSync(cssFiles[0], 'utf-8').slice(0, 2500);

    let homepageBody = '';
    const homepageFile = htmlFiles.find(f => path.relative(this.outputDir, f).replace(/\\/g, '/') === 'index.html');
    if (homepageFile) {
      const $ = cheerio.load(fs.readFileSync(homepageFile, 'utf-8'), { decodeEntities: false });
      homepageBody = ($('body').html() || '').slice(0, 2500);
    }

    const fileTree = this.buildFileTree(this.outputDir);

    const promptContext = {
      fileTree,
      pages: pageSummaries,
      stats: { htmlFiles: htmlFiles.length, cssFiles: cssFiles.length, jsFiles: jsFiles.length, imageFiles: imgFiles.length, fontFiles: fontFiles.length },
      cssPreview,
      homepageBody,
    };

    const tidyPrompt = this.buildTidyPrompt(promptContext);
    const nextjsPrompt = this.buildPrompt(promptContext);

    fs.writeFileSync(path.join(this.outputDir, 'refactor_code.md'), tidyPrompt, 'utf-8');
    fs.writeFileSync(path.join(this.outputDir, 'make_to_nextjs.md'), nextjsPrompt, 'utf-8');

    this.log('status', { message: 'Saved prompt files', phase: 'prompt', progress: 100 });
    return path.join(this.outputDir, 'refactor_code.md');
  }

  buildTidyPrompt({ fileTree, pages, stats, cssPreview, homepageBody }) {
    const pageList = pages.map(p =>
      `- **${p.title || p.path}** (\`${p.path}\`)\n  > ${p.excerpt.slice(0, 200)}`
    ).join('\n');

    const routes = pages.map(p => `\`${p.path.replace('/index.html', '') || '/'}\``).join(', ');

    return `# AI Prompt — Tidy & Refactor Code
> Paste this into Claude, ChatGPT, or Gemini to tidy the HTML, CSS, and JS code of this cloned site.

---

## Context

I have a website cloned from a Framer-built site with:
- **${stats.htmlFiles} HTML pages**, ${stats.cssFiles} CSS files, ${stats.jsFiles} JS bundles
- **${stats.imageFiles} images**, ${stats.fontFiles} fonts

The files currently contain inline style attributes, generated class names (like \`.framer-abc123\`), and tracking/analytics scripts.

## Pages

${pageList}

## File Structure

\`\`\`
${fileTree}
\`\`\`

---

## Task

Tidy and refactor the code to make it clean, formatted, and easily maintainable.

### Core Goals
1. **Clean CSS styles** — consolidate duplicate or redundant style blocks.
2. **Improve HTML semantic tags** — use proper tags like \`<header>\`, \`<nav>\`, \`<main>\`, and \`<footer>\` instead of nested \`<div>\`s.
3. **Format & Beautify** — remove garbage attributes like \`data-framer-page-id\` or tracking links, and format the HTML/CSS/JS beautifully.
4. **JavaScript cleaning** — remove or simplify minified/unused JS scripts, replacing them with clean vanilla JS where necessary for interactivity (such as navigation menus).

---

## Homepage HTML Body (sample)

\`\`\`html
${homepageBody}
\`\`\`

## CSS Sample

\`\`\`css
${cssPreview}
\`\`\`
`;
  }

  // ═══════════════════════════════════════════════════════════════
  //  NEXT.JS CONVERSION
  // ═══════════════════════════════════════════════════════════════
  async toNextjs(targetDir) {
    this.log('status', { message: 'Setting up Next.js project...', phase: 'restructure', progress: 0 });

    fs.mkdirSync(targetDir, { recursive: true });

    // Find all HTML pages
    const htmlFiles = this.findFiles(this.outputDir, '.html');
    this.log('status', { message: `Found ${htmlFiles.length} page(s) to convert`, phase: 'restructure', progress: 5 });

    const pages = htmlFiles.map(htmlFile => {
      const relPath = path.relative(this.outputDir, htmlFile).replace(/\\/g, '/');
      const routePath = relPath.replace(/\/index\.html$/, '').replace(/^index\.html$/, '');
      return { htmlFile, relPath, routePath: routePath || '/' };
    });

    // ── 1. Copy assets to public/ ─────────────────────────
    this.log('status', { message: 'Copying assets to public/...', phase: 'restructure', progress: 10 });

    const targetPublicDir = path.join(targetDir, 'public');
    if (!fs.existsSync(targetPublicDir)) {
      fs.mkdirSync(targetPublicDir, { recursive: true });
    }

    for (const dir of ['images', 'fonts', 'assets']) {
      const src = path.join(this.outputDir, dir);
      if (fs.existsSync(src)) this.copyDirSync(src, path.join(targetPublicDir, dir));
    }

    // Also copy any styles.css / merged CSS into public/
    const rootCssFiles = fs.readdirSync(this.outputDir).filter(f => f.endsWith('.css'));
    for (const f of rootCssFiles) {
      fs.copyFileSync(path.join(this.outputDir, f), path.join(targetPublicDir, f));
    }

    // ── 2. Generate app/globals.css ───────────────────────
    this.log('status', { message: 'Generating globals.css...', phase: 'restructure', progress: 20 });
    this.generateGlobalsCss(targetDir, pages);

    // ── 3. Generate app/layout ────────────────────────────
    this.log('status', { message: `Generating layout.${this.ext}...`, phase: 'restructure', progress: 30 });
    this.generateLayout(targetDir, pages[0]);

    // ── 4. Convert each page ──────────────────────────────
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const pct = 40 + Math.round(((i + 1) / pages.length) * 40);
      this.log('status', { message: `Converting: ${page.routePath}`, phase: 'restructure', progress: pct });
      this.convertPage(targetDir, page);
    }

    // ── 5. Boilerplate files ──────────────────────────────
    this.log('status', { message: 'Writing config files...', phase: 'restructure', progress: 85 });
    this.generateBoilerplate(targetDir, pages);

    // ── 6. Copy prompts if they exist ───────────
    const prompt1Src = path.join(this.outputDir, 'refactor_code.md');
    if (fs.existsSync(prompt1Src)) {
      fs.copyFileSync(prompt1Src, path.join(targetDir, 'refactor_code.md'));
    }
    const prompt2Src = path.join(this.outputDir, 'make_to_nextjs.md');
    if (fs.existsSync(prompt2Src)) {
      fs.copyFileSync(prompt2Src, path.join(targetDir, 'make_to_nextjs.md'));
    }

    this.log('status', { message: 'Done! Next.js project ready.', phase: 'restructure', progress: 100 });

    return { targetDir, pages: pages.length };
  }

  // ─────────────────────────────────────────────────────────────
  // globals.css — merge all CSS from first page's linked sheets
  // ─────────────────────────────────────────────────────────────
  generateGlobalsCss(targetDir, pages) {
    const appDir = path.join(targetDir, 'app');
    fs.mkdirSync(appDir, { recursive: true });

    let combined = '/* ======================================\n * Global Styles — Converted from Framer\n * ====================================== */\n\n';

    if (pages.length > 0) {
      const $ = cheerio.load(fs.readFileSync(pages[0].htmlFile, 'utf-8'));
      const htmlDir = path.dirname(pages[0].htmlFile);

      $('link[rel="stylesheet"]').each((_, el) => {
        const href = $(el).attr('href');
        if (!href || href.startsWith('http')) return;
        const cssPath = path.resolve(htmlDir, href.split('?')[0]);
        if (!fs.existsSync(cssPath)) return;
        const css = fs.readFileSync(cssPath, 'utf-8');
        const rebased = css.replace(/url\(['"]?(?:\.\.\/|\.\/)?([^'"()]+)['"]?\)/g, (_, p) => `url('/${p}')`);
        combined += `/* ${path.basename(cssPath)} */\n${rebased}\n\n`;
      });

      // Inline <style> blocks
      $('style').each((_, el) => {
        const content = $(el).html();
        if (content) combined += `/* Inline */\n${content}\n\n`;
      });
    }

    fs.writeFileSync(path.join(appDir, 'globals.css'), combined, 'utf-8');
  }

  // ─────────────────────────────────────────────────────────────
  // layout.tsx / layout.jsx
  // ─────────────────────────────────────────────────────────────
  generateLayout(targetDir, homePage) {
    const appDir = path.join(targetDir, 'app');
    fs.mkdirSync(appDir, { recursive: true });

    const html = fs.readFileSync(homePage.htmlFile, 'utf-8');
    const $ = cheerio.load(html, { decodeEntities: false });

    const title       = this.escapeStr($('title').text() || 'My Site');
    const description = this.escapeStr($('meta[name="description"]').attr('content') || '');
    const ogImage     = $('meta[property="og:image"]').attr('content') || '';

    const childrenProp = this.lang === 'ts'
      ? '{ children }: { children: React.ReactNode }'
      : '{ children }';

    const content = `import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '${title}',
  description: '${description}',${ogImage ? `\n  openGraph: {\n    images: ['${this.escapeStr(ogImage)}'],\n  },` : ''}
};

export default function RootLayout(${childrenProp}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`;
    fs.writeFileSync(path.join(appDir, `layout.${this.ext}`), content, 'utf-8');
  }

  // ─────────────────────────────────────────────────────────────
  // page.tsx / page.jsx per route
  // ─────────────────────────────────────────────────────────────
  convertPage(targetDir, page) {
    const html = fs.readFileSync(page.htmlFile, 'utf-8');
    const $ = cheerio.load(html, { decodeEntities: false });

    // Strip scripts/noscript
    $('script, noscript').remove();
    let bodyHtml = $('body').html() || '';

    const jsxBody = this.htmlToJsx(bodyHtml);

    const routePath = page.routePath === '/' ? '' : page.routePath;
    const pageDir = routePath
      ? path.join(targetDir, 'app', routePath)
      : path.join(targetDir, 'app');
    fs.mkdirSync(pageDir, { recursive: true });

    const componentName = this.routeToComponentName(page.routePath);
    const returnType = this.lang === 'ts' ? ': JSX.Element' : '';

    const content = `export default function ${componentName}Page()${returnType} {
  return (
    <>
${jsxBody.split('\n').map(l => '      ' + l).join('\n')}
    </>
  );
}
`;
    fs.writeFileSync(path.join(pageDir, `page.${this.ext}`), content, 'utf-8');
  }

  // ─────────────────────────────────────────────────────────────
  // HTML → JSX
  // ─────────────────────────────────────────────────────────────
  htmlToJsx(html) {
    let jsx = html;

    // Comments
    jsx = jsx.replace(/<!--([\s\S]*?)-->/g, (_, c) => `{/*${c}*/}`);

    // Attribute renames
    const attrMap = {
      '\\bclass=': 'className=',
      '\\bfor=': 'htmlFor=',
      '\\btabindex=': 'tabIndex=',
      '\\breadonly=': 'readOnly=',
      '\\bmaxlength=': 'maxLength=',
      '\\bcrossorigin=': 'crossOrigin=',
      '\\benctype=': 'encType=',
      '\\bformmethod=': 'formMethod=',
      '\\bautocomplete=': 'autoComplete=',
      '\\bautofocus=': 'autoFocus=',
      '\\bspellcheck=': 'spellCheck=',
      '\\bcontenteditable=': 'contentEditable=',
    };
    for (const [from, to] of Object.entries(attrMap)) {
      jsx = jsx.replace(new RegExp(from, 'g'), to);
    }

    // Self-closing void elements
    for (const tag of ['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']) {
      jsx = jsx.replace(new RegExp(`<(${tag})(\\s[^>]*)?>(?!</${tag}>)`, 'gi'),
        (_, t, a) => `<${t}${a || ''} />`);
    }

    // Inline style strings → objects
    jsx = jsx.replace(/style="([^"]+)"/g, (_, s) => `style={${JSON.stringify(this.cssToObj(s))}}`);

    // Boolean attributes
    jsx = jsx.replace(
      /\b(checked|disabled|selected|multiple|required|autoFocus|autoPlay|controls|loop|muted|open|hidden)(?=[\s/>])/g,
      attr => `${attr}={true}`
    );

    // Local asset paths → Next.js public paths
    jsx = jsx.replace(/src="(?:\.\.\/|\.\/)(images|fonts|assets)\/([^"]+)"/g, (_, d, f) => `src="/${d}/${f}"`);
    jsx = jsx.replace(/href="(?:\.\.\/|\.\/)(css)\/([^"]+)"/g, (_, d, f) => `href="/${d}/${f}"`);

    return jsx.trim();
  }

  cssToObj(styleStr) {
    const obj = {};
    for (const decl of styleStr.split(';')) {
      const ci = decl.indexOf(':');
      if (ci === -1) continue;
      const prop = decl.slice(0, ci).trim();
      const val  = decl.slice(ci + 1).trim();
      if (prop && val) obj[prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = val;
    }
    return obj;
  }

  // ─────────────────────────────────────────────────────────────
  // Boilerplate: package.json, next.config, tsconfig, .gitignore, README
  // ─────────────────────────────────────────────────────────────
  generateBoilerplate(targetDir, pages) {
    const name = path.basename(targetDir).toLowerCase().replace(/[^a-z0-9-]/g, '-');

    // package.json — Next.js (latest) + React (latest)
    const pkg = {
      name,
      version: '0.1.0',
      private: true,
      scripts: { dev: 'next dev', build: 'next build', start: 'next start', lint: 'next lint' },
      dependencies: {
        next: 'latest',
        react: 'latest',
        'react-dom': 'latest',
      },
      devDependencies: this.lang === 'ts' ? {
        typescript: '^5.7.0',
        '@types/node': '^22.0.0',
        '@types/react': '^19.0.0',
        '@types/react-dom': '^19.0.0',
      } : {},
    };
    fs.writeFileSync(path.join(targetDir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf-8');

    // next.config.ts / next.config.js
    const nextCfg = `import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  images: { unoptimized: true },
};

export default nextConfig;
`;
    const nextCfgJs = `/** @type {import('next').NextConfig} */
const nextConfig = {
  images: { unoptimized: true },
};

module.exports = nextConfig;
`;
    fs.writeFileSync(
      path.join(targetDir, `next.config.${this.confExt}`),
      this.lang === 'ts' ? nextCfg : nextCfgJs,
      'utf-8'
    );

    // tsconfig.json (TypeScript only)
    if (this.lang === 'ts') {
      const tsconfig = {
        compilerOptions: {
          target: 'ES2017',
          lib: ['dom', 'dom.iterable', 'esnext'],
          allowJs: true,
          skipLibCheck: true,
          strict: true,
          noEmit: true,
          esModuleInterop: true,
          module: 'esnext',
          moduleResolution: 'bundler',
          resolveJsonModule: true,
          isolatedModules: true,
          jsx: 'preserve',
          incremental: true,
          plugins: [{ name: 'next' }],
          paths: { '@/*': ['./*'] },
        },
        include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
        exclude: ['node_modules'],
      };
      fs.writeFileSync(path.join(targetDir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2), 'utf-8');
    }

    // .gitignore
    fs.writeFileSync(path.join(targetDir, '.gitignore'),
      '.next/\nnode_modules/\n.env\n.env.local\n.env*.local\n', 'utf-8');

    // README.md
    const ext = this.ext;
    const routeList = pages
      .map(p => `- \`${p.routePath || '/'}\` → \`app/${p.routePath && p.routePath !== '/' ? p.routePath + '/' : ''}page.${ext}\``)
      .join('\n');

    fs.writeFileSync(path.join(targetDir, 'README.md'), `# Cloned Framer Site — Next.js (Latest) ${this.lang === 'ts' ? '(TypeScript)' : '(JavaScript)'}

Auto-converted from a Framer website clone.

## Quick Start

\`\`\`bash
npm install
npm run dev
\`\`\`

Open [http://localhost:3000](http://localhost:3000)

## Pages

${routeList}

## Structure

\`\`\`
app/
├── layout.${ext}      ← Shared HTML shell + metadata
├── globals.css        ← All merged styles
└── [route]/page.${ext} ← One per page
public/
├── images/
└── fonts/
\`\`\`

## Notes

- Framer Motion animations require the Framer runtime — they won't animate in this export
- See **REFACTOR_PROMPT.md** for an AI prompt to fully refactor this into clean components
- Run \`npm run build\` to check for JSX errors before deploying
`, 'utf-8');
  }

  // ─────────────────────────────────────────────────────────────
  // Build AI refactor prompt text
  // ─────────────────────────────────────────────────────────────
  buildPrompt({ fileTree, pages, stats, cssPreview, homepageBody }) {
    const pageList = pages.map(p =>
      `- **${p.title || p.path}** (\`${p.path}\`)\n  > ${p.excerpt.slice(0, 200)}`
    ).join('\n');

    const routes = pages.map(p => `\`${p.path.replace('/index.html', '') || '/'}\``).join(', ');

    return `# AI Refactor Prompt — Cloned Framer Site
> Generated by Framer Website Cloner
> Paste this into Claude, ChatGPT, or Gemini to refactor your site into clean code.

---

## Context

I have a static website cloned from a Framer-built site with:
- **${stats.htmlFiles} HTML pages**, ${stats.cssFiles} CSS files, ${stats.jsFiles} JS bundles
- **${stats.imageFiles} images**, ${stats.fontFiles} fonts

The HTML was server-rendered by React/Framer and has:
- CSS-in-JS \`<style>\` blocks with scoped class names (e.g. \`.framer-abc123\`)
- \`style="..."\` inline attributes on almost every element
- \`data-framer-*\` attributes (removable bloat)
- No meaningful semantic class names

## Pages

${pageList}

## File Structure

\`\`\`
${fileTree}
\`\`\`

---

## Task

Refactor this into a **clean Next.js (latest version) App Router project (TypeScript)**.

### Target Structure
\`\`\`
my-app/
├── app/
│   ├── layout.tsx         ← shared shell + metadata
│   ├── globals.css        ← clean consolidated CSS
│   ├── page.tsx           ← homepage
│   └── [route]/page.tsx   ← one per route
├── components/
│   ├── Navbar.tsx
│   ├── Footer.tsx
│   └── ...               ← extract repeating patterns
└── public/
    ├── images/
    └── fonts/
\`\`\`

### Requirements
- **TypeScript** — \`.tsx\` files, proper types
- **Semantic HTML** — \`<nav>\`, \`<section>\`, \`<article>\`, \`<footer>\`, \`<main>\`
- **Readable class names** — replace \`.framer-abc123\` with BEM (\`.hero__title\`) or Tailwind
- **CSS Modules or Tailwind** — move all inline styles to CSS
- **Extract components** — find repeated patterns (cards, nav, footer, sections)
- **Next.js \`<Image>\`** — replace \`<img>\` with proper image component
- **\`next/font\`** — replace raw font imports

### What to Keep
- All content (text, links, images)
- All routes (${routes})
- Visual design (colors, spacing, layout, typography)
- Responsive behavior

### What to Remove
- \`data-framer-*\` attributes
- Framer analytics/tracking scripts
- Cryptic generated class names
- Redundant inline styles

---

## Homepage HTML Body (sample)

\`\`\`html
${homepageBody}
\`\`\`

## CSS Sample

\`\`\`css
${cssPreview}
\`\`\`

---

## Instructions

1. Start with \`app/layout.tsx\` — global fonts, metadata, HTML shell
2. Create \`components/Navbar.tsx\` and \`components/Footer.tsx\`
3. Convert each page route to \`page.tsx\`
4. Write complete file contents — no placeholder comments
5. Show \`globals.css\` with all styles consolidated and cleaned up
`;
  }

  // ─────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────
  findFiles(dir, ext) {
    const results = [];
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) results.push(...this.findFiles(full, ext));
      else if (entry.name.endsWith(ext)) results.push(full);
    }
    return results;
  }

  copyDirSync(src, dest) {
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, entry.name);
      const d = path.join(dest, entry.name);
      entry.isDirectory() ? this.copyDirSync(s, d) : fs.copyFileSync(s, d);
    }
  }

  buildFileTree(dir, prefix = '') {
    if (!fs.existsSync(dir)) return '';
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules');
    let result = '';
    entries.forEach((entry, i) => {
      const last = i === entries.length - 1;
      result += prefix + (last ? '└── ' : '├── ') + entry.name + '\n';
      if (entry.isDirectory())
        result += this.buildFileTree(path.join(dir, entry.name), prefix + (last ? '    ' : '│   '));
    });
    return result;
  }

  routeToComponentName(routePath) {
    if (!routePath || routePath === '/') return 'Home';
    return routePath.split('/').filter(Boolean)
      .map(s => s[0].toUpperCase() + s.slice(1).replace(/-([a-z])/g, (_, c) => c.toUpperCase()))
      .join('');
  }

  escapeStr(s) {
    return (s || '').replace(/'/g, "\\'").replace(/\n/g, ' ').replace(/`/g, '\\`');
  }
}

module.exports = SiteRestructurer;
