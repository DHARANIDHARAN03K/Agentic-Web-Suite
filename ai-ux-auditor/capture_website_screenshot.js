import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const url = process.argv[2];

if (!url) {
    console.error("❌ Please provide a URL.");
    process.exit(1);
}

const VIEWPORT = { width: 1440, height: 900 };
const WHEEL_STEP = 600; 
const SETTLE_MS = 600; 
const MAX_STEPS = 60; 

(async () => {
    console.log(`\n[Research Agent] Starting PRO visual capture for: ${url}`);
    
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: VIEWPORT });
    
    // 🔴 ADVANCED LOGIC: Inject Anti-Animation / GSAP-Killer before the page even loads
    await context.addInitScript(() => {
        window.addEventListener('DOMContentLoaded', () => {
            // Kill GSAP ScrollTrigger if it exists
            if (window.ScrollTrigger) {
                try { window.ScrollTrigger.getAll().forEach(t => t.kill(true)); } catch(e){}
            }
            
            // Force Webflow, GSAP, and Locomotive scroll elements to be visible
            const style = document.createElement('style');
            style.innerHTML = `
                /* Nuke all CSS transitions and animations */
                *, *::before, *::after {
                    transition: none !important;
                    animation: none !important;
                }
                /* Force elements hidden by scroll-jackers to be fully visible */
                .reveal, [data-scroll], [data-scroll-container], .gsap-reveal {
                    opacity: 1 !important;
                    visibility: visible !important;
                    transform: none !important;
                }
                /* Hide scrollbars for stitching */
                ::-webkit-scrollbar { display: none !important; }
                body { -ms-overflow-style: none !important; scrollbar-width: none !important; }
            `;
            document.head.appendChild(style);
        });
    });

    const page = await context.newPage();

    try {
        console.log("⏳ Loading page with Animation-Killers injected...");
        await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => console.log("⚠️ Initial load timed out, proceeding..."));

        console.log("⏬ Triggering lazy-loaders...");
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                const distance = 400;
                let total = 0;
                const timer = setInterval(() => {
                    window.scrollBy(0, distance);
                    total += distance;
                    if (total >= document.documentElement.scrollHeight) {
                        clearInterval(timer);
                        window.scrollTo(0, 0); 
                        resolve();
                    }
                }, 150);
            });
        });

        await page.waitForTimeout(2000);

        const frames = [];
        let lastY = -1;
        let stuckCount = 0;
        let fixedHidden = false;

        console.log("📸 Starting Scroll-Stitch Capture...");

        for (let i = 0; i < MAX_STEPS; i++) {
            if (i === 1 && !fixedHidden) {
                await page.evaluate(() => {
                    for (const el of document.querySelectorAll('*')) {
                        const style = window.getComputedStyle(el);
                        const pos = style.position;
                        // Only hide sticky/fixed elements if they are likely headers (less than 250px tall)
                        // If we hide massive sticky containers, we create black voids!
                        if ((pos === 'fixed' || pos === 'sticky') && el.tagName !== 'BODY' && el.tagName !== 'HTML') {
                            const rect = el.getBoundingClientRect();
                            if (rect.height < 250) {
                                el.style.setProperty('visibility', 'hidden', 'important');
                                el.style.setProperty('opacity', '0', 'important');
                            }
                        }
                    }
                });
                await page.waitForTimeout(100);
                fixedHidden = true;
            }

            const buf = await page.screenshot({ type: 'jpeg', quality: 85, timeout: 60000 });
            const y = await page.evaluate(() => window.scrollY);
            frames.push({ buf, y });

            if (y === lastY) {
                if (++stuckCount > 3) break;
            } else {
                stuckCount = 0;
            }
            lastY = y;

            const atBottom = await page.evaluate(
                () => Math.ceil(window.scrollY + window.innerHeight) >= document.documentElement.scrollHeight
            );
            
            if (atBottom) {
                const bottomBuf = await page.screenshot({ type: 'jpeg', quality: 85, timeout: 60000 });
                frames.push({ buf: bottomBuf, y: await page.evaluate(() => window.scrollY) });
                break;
            }

            await page.mouse.wheel(0, WHEEL_STEP);
            await page.waitForTimeout(SETTLE_MS);
        }

        console.log(`🧩 Stitching ${frames.length} frames together...`);
        
        const composites = [];
        let cursor = 0;
        const width = VIEWPORT.width;

        for (let i = 0; i < frames.length; i++) {
            const { buf, y } = frames[i];
            if (i === 0) { composites.push({ input: buf, top: 0, left: 0 }); cursor = VIEWPORT.height; continue; }
            
            const delta = Math.max(0, Math.min(VIEWPORT.height, y - frames[i - 1].y));
            if (delta === 0) continue;
            
            const strip = await sharp(buf).extract({ left: 0, top: VIEWPORT.height - delta, width, height: delta }).toBuffer();
            composites.push({ input: strip, top: cursor, left: 0 });
            cursor += delta;
        }

        const safeName = url.replace(/https?:\/\//, '').replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
        const siteReportDir = path.join(__dirname, 'webpage reports', safeName);
        if (!fs.existsSync(siteReportDir)) fs.mkdirSync(siteReportDir, { recursive: true });
        
        const filePath = path.join(siteReportDir, `screenshot.png`);

        await sharp({ create: { width, height: cursor, channels: 3, background: '#ffffff' } })
            .composite(composites)
            .png()
            .toFile(filePath);

        console.log(`✅ Flawless Capture Complete! Saved to: \n   ${filePath}\n`);
    } catch (error) {
        console.error("❌ Failed to capture screenshot:", error.message);
    } finally {
        await browser.close();
    }
})();
