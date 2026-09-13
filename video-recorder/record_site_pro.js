const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Target configuration
const url = 'https://osai-media.vercel.app/';
const outDir = path.join(__dirname, 'osai-media.vercel.app', 'pro_scan');
const baseName = 'osaimedia_pro';

if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
}

(async () => {
  console.log('Launching browser with GPU Hardware Acceleration...');
  const browser = await chromium.launch({ 
    headless: false, 
    args: [
      '--enable-gpu',
      '--use-gl=desktop',
      '--ignore-gpu-blocklist',
      '--window-size=1920,1080'
    ]
  });
  
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1, 
    recordVideo: {
      dir: outDir,
      size: { width: 1920, height: 1080 }
    }
  });

  const page = await context.newPage();
  
  console.log('Navigating to ' + url + '...');
  
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    console.log("Navigation timeout or error, proceeding anyway. Error: " + e.message);
  }
  
  console.log('Waiting for initial animations to finish (8s)...');
  await page.waitForTimeout(8000);

  console.log('Scrolling down the page slowly to capture all animations...');
  
  for (let i = 0; i < 50; i++) {
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(1500); 
    
    let currentHeight = await page.evaluate(() => window.scrollY + window.innerHeight);
    let totalHeight = await page.evaluate(() => document.body.scrollHeight);
    
    if (currentHeight >= totalHeight && i > 10) {
        console.log('Reached the bottom of the page.');
        break;
    }
  }
  
  await page.waitForTimeout(3000);

  console.log('Extracting HTML and CSS...');
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  const css = await page.evaluate(() => {
    let styles = '';
    for (let styleSheet of document.styleSheets) {
      try {
        for (let rule of styleSheet.cssRules) {
          styles += rule.cssText + '\n';
        }
      } catch (e) {}
    }
    return styles;
  });

  fs.writeFileSync(path.join(outDir, `${baseName}.html`), html);
  fs.writeFileSync(path.join(outDir, `${baseName}.css`), css);

  // Close context to finish video recording
  await context.close();
  await browser.close();

  // Rename the video file to our desired name
  const files = fs.readdirSync(outDir);
  const webmFiles = files.filter(f => f.endsWith('.webm') && f !== `${baseName}.webm`);
  
  if (webmFiles.length > 0) {
    const recentVideo = webmFiles.map(name => ({
      name,
      time: fs.statSync(path.join(outDir, name)).ctime.getTime()
    })).sort((a, b) => b.time - a.time)[0].name;

    const finalVideoPath = path.join(outDir, `${baseName}.webm`);
    
    if (fs.existsSync(finalVideoPath)) {
        fs.unlinkSync(finalVideoPath);
    }
    
    fs.renameSync(path.join(outDir, recentVideo), finalVideoPath);
    console.log(`Video saved to ${baseName}.webm in ${outDir}`);
  }

  console.log('Finished successfully!');
})();
