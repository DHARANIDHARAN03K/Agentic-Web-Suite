# Agentic-Web-Suite 🤖🕸️

An advanced suite of Playwright-based automation tools for modern web scraping, visual capturing, and AI-driven UX auditing. 

This suite tackles the hardest problems in web automation: **hijacked scrolling (Locomotive/Lenis), GSAP animations, hidden dropdown navigation, and lazy-loaded assets.**

## 📁 Project Structure

The suite is divided into three standalone tools:

### 1. `/advanced-crawler` (Deep Sitemap & UI Crawler)
An intelligent bot that finds pages not just via `sitemap.xml`, but by physically hovering and clicking on navbar dropdowns and mega-menus.
*   **Features:** Concurrent capturing (`p-limit`), interactive terminal selection, bypasses smooth-scroll hijackers to capture native `fullPage` screenshots.
*   **Tech:** Playwright, Axios, xml2js, Enquirer.

### 2. `/ai-ux-auditor` (Agency-Grade PDF Generator)
A two-step pipeline that captures a perfect screenshot of an animated site, allows an LLM to generate a UX audit based on visual layout, and converts the markdown to a styled PDF.
*   **Features:** Injects CSS to kill GSAP animations pre-load, simulates human scrolling to trigger lazy-loads, stitches images together with `sharp` (to avoid sticky-header duplication), and uses Chromium's print-to-PDF engine.
*   **Tech:** Playwright, Sharp, Marked.

### 3. `/video-recorder` (DOM Animation Capture)
A utility to record `.webm` videos of websites loading and scrolling, perfectly capturing complex WebGL or CSS animations.
*   **Features:** Uses native Playwright hardware acceleration and `recordVideo`.

## 🚀 Getting Started

To run any of the tools, navigate into their respective directory, install dependencies, and run the script.

**Example: Running the AI UX Auditor**
```bash
cd ai-ux-auditor
npm install
node capture_website_screenshot.js https://example.com
# Followed by...
node generate_pdf.js "webpage reports/example_com"
```

*(Note: Ensure you have Node.js installed. Playwright will download its required browser binaries upon first install).*

## 🧠 Why this was built
Standard screenshot APIs fail on modern websites. If a site uses GSAP ScrollTrigger, a standard screenshot captures a blank screen (because opacity is 0 until scrolled). If a site uses Locomotive scroll, `fullPage: true` captures only the viewport. 

This suite was built to inject anti-animation CSS, simulate human hardware-wheel scrolling, and restore native DOM scrolling before capture, resulting in 100% perfect visual data extraction.

---
*Open source and available for modification. Pull requests welcome!*
