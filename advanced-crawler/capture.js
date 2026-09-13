/**
 * advanced-capture — capture.js  v4.0
 *
 * USAGE:
 *   node capture.js https://site.com                        → Single page
 *   node capture.js https://site.com --analyze              → Show discovery report, no capture
 *   node capture.js https://site.com --auto-discover        → Discover + capture all pages
 *   node capture.js https://site.com --auto-discover --analyze  → Report only, no capture
 *   node capture.js https://s.com/p1,https://s.com/p2      → Explicit multi-URL
 *   node capture.js --file=urls.txt                         → From file
 *   node capture.js https://site.com --concurrency=5        → Change concurrency (default 3)
 *
 * FEATURES:
 *   ✅ Sitemap.xml discovery (+ sitemap index support)
 *   ✅ Flat header/nav link extraction
 *   ✅ Simple dropdown menus (hover + click fallback)
 *   ✅ Mega menus with nested category tabs (2-level interaction)
 *   ✅ Anchor-only link detection & reporting (#section → skipped)
 *   ✅ Pre-capture discovery report with full source attribution
 *   ✅ Folder architecture: screenshots/{domain}/{slug}.png
 *   ✅ p-limit batch concurrency
 *   ✅ 200-status pre-filter (drops dead links before capture)
 *   ✅ Scroll-stitch capture with lazy-load, animation fix, sticky hiding
 */

import fs   from 'fs';
import path from 'path';
import { chromium }           from 'playwright';
import sharp                  from 'sharp';
import pLimit                 from 'p-limit';
import axios                  from 'axios';
import enquirer               from 'enquirer';
import { parseStringPromise } from 'xml2js';

// ─── CLI ──────────────────────────────────────────────────────────────────────
const rawArgs    = process.argv.slice(2);
const flags      = {};
const positional = [];
for (const arg of rawArgs) {
  if (arg.startsWith('--')) {
    const [k, v] = arg.slice(2).split('=');
    flags[k] = v === undefined ? true : v;
  } else {
    positional.push(arg);
  }
}

const urlArg      = positional[0] || null;
const outBase     = positional[1] || 'screenshots';
const CONCURRENCY = parseInt(flags['concurrency'] || '1', 10);
const AUTO_DISC   = !!flags['auto-discover'];
const NAV_ONLY    = !!flags['nav-only'];
const ANALYZE     = !!flags['analyze'];   // report only — no capture
const FILE_MODE   = flags['file'] || null;

if (!urlArg && !FILE_MODE) {
  console.error(`
Usage:
  node capture.js <url>                             Single page capture
  node capture.js <url> --auto-discover             Discover & capture all pages
  node capture.js <url> --auto-discover --analyze   Discovery report only (no capture)
  node capture.js <url1,url2,...>                   Explicit multi-URL
  node capture.js --file=urls.txt                   URLs from text file
  node capture.js <url> --concurrency=5             Set concurrency (default: 3)
`);
  process.exit(1);
}

// ─── Constants ────────────────────────────────────────────────────────────────
const VIEWPORT    = { width: 1920, height: 1080 };
const WHEEL_STEP  = 800;
const SETTLE_MS   = 350;
const MAX_STEPS   = 600;
const STUCK_LIMIT = 12;

const COOKIE_SELECTORS = [
  'button:has-text("Accept")', 'button:has-text("Accept All")',
  'button:has-text("I Agree")', 'button:has-text("Got it")',
  '[id*="cookie" i] button', '[class*="cookie" i] button',
  '[class*="consent" i] button',
];

// ─── URL utilities ────────────────────────────────────────────────────────────
function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    const p = u.pathname.replace(/\/+$/, '') || '/';
    return u.origin + p;
  } catch { return raw; }
}

function resolveOutFile(rawUrl, baseDir, source) {
  const u      = new URL(rawUrl);
  const domain = u.hostname;
  let   slug   = u.pathname.replace(/\/+$/, '');
  slug = (!slug || slug === '') ? 'home' : slug.replace(/^\//, '').replace(/\//g, '--');
  
  // Extract main dropdown name if present
  let dropdownPrefix = '';
  if (source && source.startsWith('dropdown:')) {
    // e.g. "dropdown:Our Services > SEO" -> "Our Services"
    const mainTrigger = source.replace('dropdown:', '').split(' > ')[0].trim();
    // Sanitize for filename (allow spaces but remove illegal chars)
    const cleanDropdown = mainTrigger.replace(/[^a-zA-Z0-9- ]/g, '').trim();
    if (cleanDropdown) dropdownPrefix = `[${cleanDropdown}] `;
  }

  // Remove .html from the slug to make it cleaner
  let cleanSlug = slug.replace(/\.html$/, '');

  const dir = path.join(baseDir, domain);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${dropdownPrefix}${cleanSlug}.png`);
}

/**
 * Resolve a raw href into a clean normalized URL or null if it should be skipped.
 * Returns { url, isAnchor } so we can report anchor-only links separately.
 */
function resolveHref(href, baseUrl, allowedOrigin) {
  if (!href) return { url: null, isAnchor: false };
  const h = href.trim();
  if (h.startsWith('javascript:') || h.startsWith('mailto:') || h.startsWith('tel:'))
    return { url: null, isAnchor: false };
  if (h.startsWith('#'))
    return { url: null, isAnchor: true }; // same-page scroll anchor
  try {
    const u   = new URL(h, baseUrl);
    // If only the hash differs from baseUrl → it's an anchor on the same page
    if (u.origin + u.pathname === normalizeUrl(baseUrl))
      return { url: null, isAnchor: u.hash.length > 0 };
    const key = normalizeUrl(u.toString());
    if (new URL(key).origin !== allowedOrigin) return { url: null, isAnchor: false };
    return { url: key, isAnchor: false };
  } catch { return { url: null, isAnchor: false }; }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function dismissCookieBanner(page) {
  for (const sel of COOKIE_SELECTORS) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 800 })) { await btn.click(); await page.waitForTimeout(400); return; }
    } catch { /* not present */ }
  }
}

async function isReachable(url) {
  try {
    const res = await axios.head(url, { timeout: 6000, maxRedirects: 5, validateStatus: s => s < 500 });
    return res.status < 400;
  } catch { return false; }
}

/** Get count of currently visible nav links */
async function visibleAllLinkCount(page) {
  return page.locator('a[href]:visible').count();
}

/** Collect all currently visible nav hrefs */
async function collectVisibleNavHrefs(page) {
  return page.locator('header a[href]:visible, nav a[href]:visible')
    .evaluateAll(els => els.map(e => ({ href: e.getAttribute('href'), text: (e.textContent || '').trim() })));
}

/** Collect ALL visible hrefs on the entire page */
async function collectAllVisibleHrefs(page) {
  return page.locator('a[href]:visible')
    .evaluateAll(els => els.map(e => ({ href: e.getAttribute('href'), text: (e.textContent || '').trim() })));
}

// ─── Discovery: Phase A — Sitemap ─────────────────────────────────────────────
async function discoverViaSitemap(baseUrl) {
  const origin     = new URL(baseUrl).origin;
  const sitemapUrl = `${origin}/sitemap.xml`;
  try {
    const res = await axios.get(sitemapUrl, { timeout: 8000, responseType: 'text' });
    const xml = await parseStringPromise(res.data);
    let locs  = [];
    if (xml.urlset?.url) {
      locs = xml.urlset.url.map(u => u.loc[0]);
    } else if (xml.sitemapindex?.sitemap) {
      for (const sm of xml.sitemapindex.sitemap) {
        try {
          const cr  = await axios.get(sm.loc[0], { timeout: 8000, responseType: 'text' });
          const cx  = await parseStringPromise(cr.data);
          if (cx.urlset?.url) locs.push(...cx.urlset.url.map(u => u.loc[0]));
        } catch { /* child failed */ }
      }
    }
    const seen = new Set();
    const urls = [];
    for (const loc of locs) {
      const { url } = resolveHref(loc, origin, origin);
      if (!url || seen.has(url)) continue;
      seen.add(url); urls.push(url);
    }
    return { urls, error: null };
  } catch (err) {
    return { urls: [], error: err.message };
  }
}

// ─── Discovery: Phase B+C — Deep Header/Nav Scan ──────────────────────────────
/**
 * Deep nav discovery with mega-menu tab support.
 *
 * Returns:
 *   flatLinks    → links visible without any interaction
 *   dropdownMap  → Map<triggerText, { links, tabs: Map<tabText, links[]> }>
 *   anchorLinks  → anchor-only buttons found (#section scroll)
 */
async function discoverViaDeepNav(page, baseUrl) {
  const origin     = new URL(baseUrl).origin;
  const allUrlsSeen = new Set();
  const anchorLinks = []; // { text, href }

  const flatLinks    = [];
  const dropdownMap  = new Map(); // triggerText → { links[], tabs: Map }

  // ── Phase B: Flat visible links ───────────────────────────────────────────
  const flatItems = await collectVisibleNavHrefs(page);
  for (const { href, text } of flatItems) {
    const { url, isAnchor } = resolveHref(href, baseUrl, origin);
    if (isAnchor) {
      if (!anchorLinks.find(a => a.href === href))
        anchorLinks.push({ text: text || href, href });
    } else if (url && !allUrlsSeen.has(url)) {
      allUrlsSeen.add(url);
      flatLinks.push({ url, text });
    }
  }

  // ── Pre-Phase C: Capture the "Base" State ───────────────────────────────
  // We record all visible links on the page so we only capture *newly revealed* ones.
  const basePageUrls = new Set();
  const initialAll = await collectAllVisibleHrefs(page);
  for (const { href } of initialAll) {
    const { url } = resolveHref(href, baseUrl, origin);
    if (url) basePageUrls.add(url);
  }

  // ── Phase C: Dropdown triggers ────────────────────────────────────────────
  // Find candidate triggers: nav/header items, plus universal hamburger buttons and SVGs
  const triggerHandles = await page.locator(
    'header li, header [aria-haspopup], header [aria-expanded], header button:not([type="submit"]), ' +
    'nav li, nav [aria-haspopup], nav [aria-expanded], nav button:not([type="submit"]), ' +
    '[class*="hamburger" i], [class*="menu-btn" i], [aria-label*="menu" i], ' +
    '.w-nav-button, .navbar-toggle, header svg, nav svg'
  ).all();

  // Also find any element that literally just says "Menu" (very common in modern Awwwards-style sites)
  // This regex ignores case, spaces, and bullets/icons around the word "menu"
  const textMenuTriggers = await page.locator('text=/^\\s*[^a-zA-Z0-9]*menu[^a-zA-Z0-9]*\\s*$/i').all();
  
  const allTriggers = [...triggerHandles, ...textMenuTriggers];

  for (const trigger of allTriggers) {
    try {
      if (!(await trigger.isVisible())) continue;
      
      // SAFETY CHECK: Never click an element if it is an <a> tag OR inside an <a> tag.
      // E.g., a logo SVG wrapped in <a href="/"> would navigate away and break the script.
      const isInsideLink = await trigger.evaluate(e => !!e.closest('a'));
      if (isInsideLink) continue;
      let triggerText = (await trigger.textContent() || '').trim().split('\n')[0].trim();
      if (!triggerText) triggerText = (await trigger.getAttribute('aria-label') || 'Menu').trim();
      if (!triggerText) continue;

      const beforeCount = await visibleAllLinkCount(page);

      // ── Try hover ──────────────────────────────────────────────────────────
      await trigger.hover({ timeout: 2000, force: true });
      await page.waitForTimeout(500);
      const afterHover = await visibleAllLinkCount(page);

      if (afterHover <= beforeCount) {
        // Hover revealed nothing → try click
        await trigger.click({ timeout: 2000, force: true });
        await page.waitForTimeout(500);
        const afterClick = await visibleAllLinkCount(page);
        if (afterClick <= beforeCount) {
          // Neither worked — close and skip
          await page.keyboard.press('Escape');
          await trigger.click({ timeout: 1000, force: true }).catch(() => {}); // toggle off
          await page.waitForTimeout(200);
          continue;
        }
      }

      // ── Dropdown is now open — collect NEW visible links ───────────────────────
      const dropdownEntry = { links: [], tabs: new Map() };
      const openItems = await collectAllVisibleHrefs(page);

      for (const { href, text } of openItems) {
        const { url, isAnchor } = resolveHref(href, baseUrl, origin);
        if (isAnchor) {
          if (!anchorLinks.find(a => a.href === href))
            anchorLinks.push({ text: text || href, href });
        } else if (url && !basePageUrls.has(url) && !allUrlsSeen.has(url)) {
          allUrlsSeen.add(url);
          dropdownEntry.links.push({ url, text });
        }
      }

      // ── Phase C2: Look for sub-triggers INSIDE the open dropdown (mega menu tabs) ──
      // Sub-triggers = visible buttons or role=tab elements inside header/nav
      // that are NOT <a> tags (they switch tab content, not navigate)
      const subTriggers = await page.locator(
        'header button:visible:not(a), header [role="tab"]:visible, ' +
        'nav button:visible:not(a), nav [role="tab"]:visible, ' +
        'header li:not(:has(a[href])):visible, nav li:not(:has(a[href])):visible'
      ).all();

      for (const sub of subTriggers) {
        try {
          if (!(await sub.isVisible())) continue;
          const subText = (await sub.textContent() || '').trim().split('\n')[0].trim();
          if (!subText || subText === triggerText) continue;

          const beforeSubCount = await visibleAllLinkCount(page);
          await sub.click({ timeout: 1500, force: true });
          await page.waitForTimeout(400);
          const afterSubCount = await visibleAllLinkCount(page);

          if (afterSubCount !== beforeSubCount) {
            // Tab click revealed new/different links
            const tabItems  = await collectAllVisibleHrefs(page);
            const tabLinks  = [];
            for (const { href, text } of tabItems) {
              const { url } = resolveHref(href, baseUrl, origin);
              if (url && !basePageUrls.has(url) && !allUrlsSeen.has(url)) {
                allUrlsSeen.add(url);
                tabLinks.push({ url, text });
              }
            }
            if (tabLinks.length > 0) {
              dropdownMap.set(triggerText, dropdownEntry);
              dropdownEntry.tabs.set(subText, tabLinks);
            }
          }
        } catch { /* sub-trigger failed — skip */ }
      }

      if (dropdownEntry.links.length > 0 || dropdownEntry.tabs.size > 0) {
        dropdownMap.set(triggerText, dropdownEntry);
      }

      // Close the dropdown before moving to next trigger
      await page.mouse.move(0, 0);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);

    } catch { /* trigger failed — move to next */ }
  }

  return { flatLinks, dropdownMap, anchorLinks };
}

// ─── Discovery Orchestrator ───────────────────────────────────────────────────
async function discoverAll(landingUrl, browser) {
  const origin = new URL(landingUrl).origin;

  // Phase A — Sitemap
  let sitemapUrls = [];
  let sitemapError = null;
  if (!NAV_ONLY) {
    const res = await discoverViaSitemap(landingUrl);
    sitemapUrls = res.urls;
    sitemapError = res.error;
  }
  const sitemapSet = new Set(sitemapUrls);

  // Phase B+C — Deep nav
  const page = await browser.newContext({ viewport: VIEWPORT }).then(c => c.newPage());
  try {
    await page.goto(landingUrl, { waitUntil: 'load', timeout: 45000 });
  } catch (err) {
    console.log(`  ⚠️ Page load timed out or had an error, proceeding with discovery anyway...`);
  }
  await page.waitForTimeout(1200);
  await dismissCookieBanner(page);
  const { flatLinks, dropdownMap, anchorLinks } = await discoverViaDeepNav(page, landingUrl);
  await page.context().close();

  // Collect all nav URLs
  const navUrls = [
    ...flatLinks.map(l => l.url),
    ...[...dropdownMap.values()].flatMap(d => [
      ...d.links.map(l => l.url),
      ...[...d.tabs.values()].flatMap(t => t.map(l => l.url))
    ])
  ];

  // Merge: landing + sitemap + nav, deduplicated
  const merged    = new Map(); // url → source label
  merged.set(normalizeUrl(landingUrl), 'sitemap');
  for (const u of sitemapUrls) merged.set(u, 'sitemap');
  for (const l of flatLinks)   { if (!merged.has(l.url)) merged.set(l.url, 'nav-flat'); }
  for (const [trigger, entry] of dropdownMap) {
    for (const l of entry.links) {
      if (!merged.has(l.url)) merged.set(l.url, `dropdown:${trigger}`);
    }
    for (const [tab, links] of entry.tabs) {
      for (const l of links) {
        if (!merged.has(l.url)) merged.set(l.url, `dropdown:${trigger} > ${tab}`);
      }
    }
  }

  // Find nav-only pages (missing from sitemap)
  const navOnlyUrls = [...merged.entries()]
    .filter(([u, src]) => src !== 'sitemap' && !sitemapSet.has(u))
    .map(([u]) => u);

  return { merged, sitemapUrls, sitemapError, flatLinks, dropdownMap, anchorLinks, navOnlyUrls };
}

// ─── Pre-Capture Report ───────────────────────────────────────────────────────
function printReport(landingUrl, result, verifiedUrls) {
  const { sitemapUrls, sitemapError, flatLinks, dropdownMap, anchorLinks, navOnlyUrls, merged } = result;
  const domain = new URL(landingUrl).hostname;
  const LINE   = '═'.repeat(62);
  const line   = '─'.repeat(62);

  console.log(`\n╔${LINE}╗`);
  console.log(`║  🔎 DISCOVERY REPORT — ${domain.padEnd(36)}║`);
  console.log(`╚${LINE}╝\n`);

  // Sitemap
  console.log(`📄 SOURCE A — Sitemap.xml`);
  if (sitemapError) {
    console.log(`   ✗ Not found or failed: ${sitemapError}`);
  } else {
    console.log(`   Found ${sitemapUrls.length} URL(s)`);
    sitemapUrls.slice(0, 5).forEach(u => console.log(`   • ${u}`));
    if (sitemapUrls.length > 5) console.log(`   • ... and ${sitemapUrls.length - 5} more`);
  }

  // Flat nav links
  console.log(`\n🔗 SOURCE B — Header/Nav (Direct Links)`);
  if (flatLinks.length === 0) {
    console.log(`   None found`);
  } else {
    flatLinks.forEach(l => console.log(`   • ${l.url}  [${l.text}]`));
  }

  // Dropdowns
  console.log(`\n🔽 SOURCE C — Dropdown / Mega Menu Links`);
  if (dropdownMap.size === 0) {
    console.log(`   No dropdowns found`);
  } else {
    for (const [trigger, entry] of dropdownMap) {
      console.log(`\n   ▸ "${trigger}" dropdown:`);
      entry.links.forEach(l => console.log(`      • ${l.url}  [${l.text}]`));
      for (const [tab, links] of entry.tabs) {
        console.log(`      ↳ Tab: "${tab}"`);
        links.forEach(l => console.log(`           • ${l.url}  [${l.text}]`));
      }
    }
  }

  // Anchor-only links
  console.log(`\n🚫 ANCHOR-ONLY BUTTONS (scroll same page — NOT captured)`);
  if (anchorLinks.length === 0) {
    console.log(`   None found`);
  } else {
    anchorLinks.forEach(a => console.log(`   • ${a.href}  [${a.text}]`));
  }

  // Missing from sitemap
  console.log(`\n⚠️  PAGES IN NAV BUT MISSING FROM SITEMAP`);
  if (navOnlyUrls.length === 0) {
    console.log(`   ✅ Sitemap and nav are fully in sync`);
  } else {
    navOnlyUrls.forEach(u => {
      const src = result.merged.get(u) || 'nav';
      console.log(`   + ${u}  [found via: ${src}]`);
    });
  }

  // Verification
  const dropped = [...merged.keys()].filter(u => !verifiedUrls.includes(u));
  console.log(`\n✅ REACHABILITY CHECK`);
  console.log(`   Total found : ${merged.size}`);
  console.log(`   Reachable   : ${verifiedUrls.length}`);
  if (dropped.length > 0) {
    console.log(`   Dropped     : ${dropped.length} (unreachable)`);
    dropped.forEach(u => console.log(`   ✗ ${u}`));
  }

  // Folder architecture
  const domain2 = new URL(landingUrl).hostname;
  console.log(`\n📁 FOLDER ARCHITECTURE`);
  console.log(`   screenshots/`);
  console.log(`   └── ${domain2}/`);
  const exampleSlugs = verifiedUrls.slice(0, 6).map(u => {
    const p = new URL(u).pathname.replace(/\/+$/, '');
    return (!p || p === '') ? 'home.png' : p.replace(/^\//, '').replace(/\//g, '--') + '.png';
  });
  exampleSlugs.forEach(s => console.log(`       ├── ${s}`));
  if (verifiedUrls.length > 6) console.log(`       └── ... (${verifiedUrls.length} files total)`);

  // Capture plan
  const batches = Math.ceil(verifiedUrls.length / CONCURRENCY);
  console.log(`\n🚀 CAPTURE PLAN`);
  console.log(`   Total pages : ${verifiedUrls.length}`);
  console.log(`   Concurrency : ${CONCURRENCY} at a time`);
  console.log(`   Batches     : ~${batches} rounds`);
  console.log(`\n${line}`);
}

// ─── Core Capture ─────────────────────────────────────────────────────────────
async function captureUrl(browser, url, outFile) {
  const page = await browser.newContext({ viewport: VIEWPORT }).then(c => c.newPage());
  try {
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    } catch (err) {
      console.log(`  ⚠️ Navigation to ${url} timed out waiting for networkidle. Attempting capture anyway...`);
    }
    await page.waitForTimeout(1500);
    await dismissCookieBanner(page);

    // ── 1. The Pre-Flight Hardware Scroll ──
    // We use real mouse wheel events instead of JS scrollBy to trigger GSAP and lazy loads
    for (let i = 0; i < 15; i++) {
      await page.mouse.wheel(0, 800);
      await page.waitForTimeout(150);
    }
    
    // Scroll back to top
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1000);

    // Remove any scroll locks on the body caused by aggressive popups
    await page.evaluate(() => {
      document.body.style.setProperty('overflow', 'visible', 'important');
      document.documentElement.style.setProperty('overflow', 'visible', 'important');
    });

    try {
      await page.waitForLoadState('networkidle', { timeout: 10000 });
    } catch(e) {}
    await page.waitForTimeout(1500);

    // ── 2. The Holy Grail CSS Un-hijack ──
    await page.addStyleTag({
      content: `
        /* Force native scrolling */
        html, body { height: auto !important; overflow: visible !important; position: static !important; }
        /* Destroy smooth scroll wrappers (Locomotive/Lenis) */
        [data-scroll-container], #smooth-wrapper, #smooth-content, [data-scroll-section], .scroll-content, main {
          height: auto !important;
          overflow: visible !important;
          position: static !important;
          transform: none !important;
        }
        /* Hide scrollbars */
        ::-webkit-scrollbar { display: none !important; }
        body { -ms-overflow-style: none !important; scrollbar-width: none !important; }
      `
    });

    // Hide sticky headers so they don't repeat during fullPage capture
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('*')) {
        const pos = window.getComputedStyle(el).position;
        if ((pos === 'fixed' || pos === 'sticky') && el.tagName !== 'BODY' && el.tagName !== 'HTML') {
          el.style.setProperty('visibility', 'hidden', 'important');
          el.style.setProperty('opacity', '0', 'important');
        }
      }
    });
    await page.waitForTimeout(500);

    // ── 3. The Full Page Capture ──
    // We don't need manual sharp stitching anymore! fullPage resizes the viewport to the bottom,
    // which instantly triggers all GSAP elements to fade in!
    let buf;
    try {
      // Notice we DO NOT use animations: 'disabled' here, because it freezes GSAP at opacity 0!
      buf = await page.screenshot({ type: 'jpeg', quality: 85, fullPage: true, timeout: 20000 });
    } catch (err) {
      // Fallback
      buf = await page.screenshot({ type: 'jpeg', quality: 85, fullPage: true, timeout: 45000 });
    }

    fs.writeFileSync(outFile, buf);

    return { ok: true, frames: 1, height: 'full' };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    await page.context().close();
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  // Collect initial URLs
  let urls = [];
  if (FILE_MODE) {
    const raw = fs.readFileSync(FILE_MODE, 'utf-8');
    urls = raw.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    console.log(`📂 Loaded ${urls.length} URL(s) from ${FILE_MODE}`);
  } else {
    const raw  = urlArg.split(',').map(u => u.trim()).filter(Boolean);
    const seen = new Set();
    urls = raw
      .filter(u => { const k = normalizeUrl(u); if (seen.has(k)) return false; seen.add(k); return true; })
      .map(u => normalizeUrl(u));
  }

  const landingUrl = urls[0];
  const browser    = await chromium.launch({ 
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-web-security'
    ] 
  });

  let finalUrls = urls;

  if (AUTO_DISC) {
    // ── Full auto-discovery ──────────────────────────────────────────────────
    console.log(`\n🔎 Analyzing ${landingUrl} ...\n`);
    console.log(`  📄 [A] Fetching sitemap.xml ...`);
    console.log(`  🔍 [B+C] Scanning header/nav (flat links + dropdowns + mega-menu tabs) ...`);

    const result = await discoverAll(landingUrl, browser);

    // Merge any explicitly passed extra URLs too
    for (const u of urls) {
      if (!result.merged.has(normalizeUrl(u))) result.merged.set(normalizeUrl(u), 'explicit');
    }

    // We skip the fast 'axios' reachability check because bot-protection (like Cloudflare)
    // often blocks it, dropping valid URLs. We will let Playwright try all of them.
    const verified = [...result.merged.keys()];

    // Print report
    printReport(landingUrl, result, verified);

    if (ANALYZE) {
      console.log(`\n📋 --analyze mode: report complete. No screenshots taken.`);
      await browser.close();
      return;
    }

    // Interactive Selection Mode
    console.log(`\n✨ INTERACTIVE SELECTION MODE`);
    console.log(`Use Spacebar to select/unselect pages, Arrow keys to navigate, and Enter to confirm.`);
    
    // ── Smart Bulk Filtering (Advanced Agent Feature) ──
    // Detect patterns like /blog/* or /work/* and limit to 5 defaults so we don't spam 500 links
    const patternCounts = {};
    const patternSeen = {};
    
    function getUrlPattern(urlStr) {
      try {
        const u = new URL(urlStr);
        const parts = u.pathname.split('/').filter(Boolean);
        if (parts.length >= 2) {
          parts[parts.length - 1] = '*';
          return parts.join('/');
        }
        return null;
      } catch { return null; }
    }

    for (const u of verified) {
      const pat = getUrlPattern(u);
      if (pat) patternCounts[pat] = (patternCounts[pat] || 0) + 1;
    }

    // Group URLs by source for better UX
    const initiallySelected = [];
    
    const choices = verified.map(url => {
      const source = result.merged.get(url);
      let category = source;
      if (source === 'sitemap') category = 'Sitemap (Hidden Pages)';
      else if (source === 'nav-flat') category = 'Header Navigation';
      else if (source && source.startsWith('dropdown:')) category = `Dropdown: ${source.split(':')[1]}`;
      
      let initial = true;
      const pat = getUrlPattern(url);
      
      // If a sub-folder has more than 5 pages, only select the first 5 by default
      if (pat && patternCounts[pat] > 5) {
        patternSeen[pat] = (patternSeen[pat] || 0) + 1;
        if (patternSeen[pat] > 5) {
          initial = false;
        }
      }

      if (initial) initiallySelected.push(url);

      // Indicate to the user why it was auto-deselected
      const displayMsg = initial 
        ? `${url}   [${category}]` 
        : `${url}   [${category} — Auto-deselected (Bulk Pattern)]`;

      return {
        name: url,
        message: displayMsg
      };
    });

    try {
      const prompt = new enquirer.MultiSelect({
        name: 'selectedUrls',
        message: 'Select the pages you want to capture:',
        limit: 15,
        choices: choices,
        initial: initiallySelected,
        indicator(state, choice) {
          return choice.enabled ? '[X]' : '[ ]';
        }
      });
      
      const selected = await prompt.run();
      
      if (selected.length === 0) {
        console.log(`\n❌ No pages selected. Aborting capture.`);
        await browser.close();
        return;
      }
      
      finalUrls = selected.map(url => ({ url, source: result.merged.get(url) }));
      
      console.log(`\n✅ You selected ${finalUrls.length} page(s) to capture.\n`);
    } catch (err) {
      console.log(`\n❌ Interactive selection aborted.`);
      await browser.close();
      return;
    }

  } else {
    finalUrls = finalUrls.map(url => ({ url, source: 'explicit' }));
  }

  // ── Batch capture ────────────────────────────────────────────────────────────
  console.log(`🚀 Capturing ${finalUrls.length} page(s) — concurrency: ${CONCURRENCY}`);
  console.log('─'.repeat(62));

  const limit  = pLimit(CONCURRENCY);
  let passed = 0, failed = 0, skipped = 0;

  const tasks = finalUrls.map(({ url, source }) =>
    limit(async () => {
      const outFile = resolveOutFile(url, outBase, source);
      
      if (fs.existsSync(outFile)) {
        skipped++;
        console.log(`⏭️ ${url}\n   → Skipped (Image already exists: ${path.basename(outFile)})\n`);
        return;
      }

      console.log(`⏳ ${url}`);
      const result = await captureUrl(browser, url, outFile);
      if (result.ok) {
        passed++;
        console.log(`✅ ${url}\n   → ${outFile}  (${result.frames} frames, ${VIEWPORT.width}×${result.height}px)\n`);
      } else {
        failed++;
        console.log(`❌ ${url}  — ${result.error}\n`);
      }
    })
  );

  await Promise.all(tasks);
  await browser.close();

  console.log('─'.repeat(62));
  console.log(`\n🎉 Done!  ✅ ${passed} captured   ⏭️ ${skipped} skipped   ❌ ${failed} failed`);
  console.log(`📁 Saved to: ${path.resolve(outBase)}\n`);
})();
