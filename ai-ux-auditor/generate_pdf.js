import { chromium } from 'playwright';
import { marked } from 'marked';
import fs from 'fs';
import path from 'path';

const targetDir = process.argv[2];
if (!targetDir) {
    console.error("❌ Please provide the directory path containing Audit_Report.md");
    console.error('Example: node generate_pdf.js "webpage reports/example_com_"');
    process.exit(1);
}

const mdPath = path.join(targetDir, 'Audit_Report.md');
const pdfPath = path.join(targetDir, 'Audit_Report.pdf');

if (!fs.existsSync(mdPath)) {
    console.error(`❌ Markdown file not found at: ${mdPath}`);
    process.exit(1);
}

(async () => {
    try {
        console.log(`📄 Reading Markdown from ${mdPath}...`);
        const mdContent = fs.readFileSync(mdPath, 'utf-8');
        
        // 1. Convert Markdown to HTML
        const parsedHtml = await marked.parse(mdContent);

        // 2. Wrap HTML with Professional Premium CSS Styling
        const fullHtml = `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                @page { margin: 20mm; }
                body {
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                    line-height: 1.6;
                    color: #222;
                    max-width: 900px;
                    margin: 0 auto;
                    font-size: 14px;
                }
                h1 { 
                    color: #111; 
                    font-size: 28px;
                    border-bottom: 3px solid #FF6233; /* Agency Accent Color */
                    padding-bottom: 10px; 
                    margin-bottom: 20px;
                }
                h2 { 
                    color: #111; 
                    font-size: 20px;
                    margin-top: 30px; 
                    border-bottom: 1px solid #eaecef; 
                    padding-bottom: 8px; 
                }
                h3 { color: #444; font-size: 16px; margin-top: 25px; }
                p { margin: 12px 0; }
                ul { margin: 12px 0; padding-left: 20px; }
                li { margin-bottom: 6px; }
                strong { color: #000; font-weight: 600; }
                hr { height: 1px; background-color: #eaecef; border: none; margin: 30px 0; }
                .header-brand { 
                    text-align: right; 
                    font-size: 11px; 
                    color: #888; 
                    text-transform: uppercase;
                    letter-spacing: 1px;
                    margin-bottom: -15px; 
                }
                code {
                    background-color: #f4f4f4;
                    padding: 2px 5px;
                    border-radius: 4px;
                    font-size: 12px;
                }
            </style>
        </head>
        <body>
            <div class="header-brand">Automated UX Audit Report</div>
            ${parsedHtml}
        </body>
        </html>
        `;

        console.log("🖨️ Spinning up Playwright PDF Engine...");
        
        // 3. Launch Playwright headless browser
        const browser = await chromium.launch();
        const page = await browser.newPage();
        
        // 4. Load the beautifully styled HTML into the browser
        await page.setContent(fullHtml, { waitUntil: 'networkidle' });
        
        // 5. Print to PDF
        await page.pdf({
            path: pdfPath,
            format: 'A4',
            printBackground: true,
            displayHeaderFooter: true,
            headerTemplate: '<div></div>', // Hides default playwright headers
            footerTemplate: '<div style="font-size:10px; width:100%; text-align:center; color:#888;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
            margin: { top: '20mm', right: '20mm', bottom: '25mm', left: '20mm' }
        });

        await browser.close();
        console.log(`✅ Success! High-Quality PDF generated at: \n   ${pdfPath}\n`);
    } catch (error) {
        console.error("❌ Error generating PDF:", error);
    }
})();
