<div align="center">
  <h1>🤖🕸️ Agentic-Web-Suite</h1>
  <p><i>An advanced suite of Playwright-based automation tools for modern web scraping, visual capturing, and AI-driven UX auditing.</i></p>

  ![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
  ![Node.js](https://img.shields.io/badge/Node.js-18.x-green.svg)
  ![Playwright](https://img.shields.io/badge/Playwright-Automated-blue.svg)
  ![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)
</div>

<br />

This suite tackles the hardest problems in web automation: **hijacked scrolling (Locomotive/Lenis), GSAP animations, hidden dropdown navigation, and lazy-loaded assets.** 

When standard APIs and headless browsers fail to capture modern animated websites, this suite injects custom CSS, simulates human hardware scrolling, and uses mathematical image stitching to capture 100% perfect visual data.

---

## 📁 Project Structure

The suite is divided into three standalone tools. You can use them individually depending on your needs.

### 1. `/advanced-crawler` (Deep Sitemap & UI Crawler)
An intelligent bot that finds pages not just via `sitemap.xml`, but by physically hovering and clicking on navbar dropdowns and mega-menus.
* **Features:** Concurrent capturing (`p-limit`), interactive terminal selection, bypasses smooth-scroll hijackers to capture native `fullPage` screenshots.

### 2. `/ai-ux-auditor` (Agency-Grade PDF Generator)
A pipeline that captures a perfect screenshot of an animated site, allows an LLM to generate a UX audit based on visual layout, and converts the markdown to a styled PDF.
* **Features:** Injects CSS to kill GSAP animations pre-load, simulates human scrolling to trigger lazy-loads, stitches images together with `sharp` (to avoid sticky-header duplication).

### 3. `/video-recorder` (DOM Animation Capture)
A utility to record `.webm` videos of websites loading and scrolling, perfectly capturing complex WebGL or CSS animations.

---

## 🚀 Getting Started (Usage Instructions)

### Step 1: Prerequisites & Downloading
1. Make sure you have [Node.js](https://nodejs.org/) installed on your computer.
2. Open your terminal (e.g., in VS Code) and download this repository by running:
```bash
git clone https://github.com/DHARANIDHARAN03K/Agentic-Web-Suite.git
cd Agentic-Web-Suite
```

### Tool 1: Running the Advanced Crawler
Use this when you want to discover all pages on a website and take full-page screenshots of them concurrently.
```bash
cd advanced-crawler
npm install
node capture.js https://example.com
```
*(The terminal will prompt you to use your Spacebar to select which pages you want to capture!)*

### Tool 2: Running the AI UX Auditor
Use this when you need a single, perfect screenshot stitched into a PDF audit report.
```bash
cd ai-ux-auditor
npm install
node capture_website_screenshot.js https://example.com

# After the screenshot finishes, generate the PDF:
node generate_pdf.js "webpage reports/example_com"
```

### Tool 3: Running the Video Recorder
Use this to capture a `.webm` video recording of the website's animations.
```bash
cd video-recorder
npm install
node record_site_pro.js https://example.com
```

---

## 🧠 Why this was built (The Technical Flex)
Standard screenshot APIs fail on modern websites. 
* If a site uses **GSAP ScrollTrigger**, a standard screenshot captures a blank screen (because opacity is 0 until scrolled). 
* If a site uses **Locomotive scroll**, `fullPage: true` captures only the viewport. 

This suite was built to inject anti-animation CSS, simulate human hardware-wheel scrolling, and restore native DOM scrolling before capture, resulting in 100% perfect visual data extraction.

## 🤝 Contributing
Contributions, issues, and feature requests are welcome! Feel free to check [issues page](#). If you want to add support for saving videos as `.mp4`, or add AWS S3 upload support, please submit a Pull Request!

## 📝 License
This project is [MIT](LICENSE) licensed.
