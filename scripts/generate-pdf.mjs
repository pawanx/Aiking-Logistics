import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const DOC_MD = path.resolve('docs/TECHNICAL_DOCUMENTATION.md');
const DOC_HTML = path.resolve('docs/temp_doc.html');
const DOC_PDF = path.resolve('docs/TECHNICAL_DOCUMENTATION.pdf');

console.log('📄 Reading markdown documentation from:', DOC_MD);
const mdContent = fs.readFileSync(DOC_MD, 'utf8');

// Generate styled HTML with embedded Marked and Mermaid
const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Aiking Connect — Technical Architecture & Engineering Documentation</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
  <style>
    @page {
      size: A4;
      margin: 18mm 16mm 18mm 16mm;
      @bottom-right {
        content: counter(page);
      }
    }
    *, *::before, *::after {
      box-sizing: border-box;
    }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13.5px;
      line-height: 1.6;
      color: #1e293b;
      background: #ffffff;
      padding: 0;
      margin: 0;
    }
    h1 {
      font-size: 26px;
      font-weight: 800;
      color: #0f172a;
      border-bottom: 2px solid #004e9f;
      padding-bottom: 8px;
      margin-top: 0;
      margin-bottom: 16px;
      letter-spacing: -0.02em;
    }
    h2 {
      font-size: 19px;
      font-weight: 800;
      color: #0f172a;
      border-bottom: 1px solid #e2e8f0;
      padding-bottom: 6px;
      margin-top: 28px;
      margin-bottom: 12px;
      letter-spacing: -0.01em;
      page-break-after: avoid;
    }
    h3 {
      font-size: 15px;
      font-weight: 700;
      color: #1e293b;
      margin-top: 20px;
      margin-bottom: 8px;
      page-break-after: avoid;
    }
    p {
      margin-top: 0;
      margin-bottom: 12px;
    }
    strong {
      color: #0f172a;
      font-weight: 700;
    }
    hr {
      border: none;
      border-top: 1px solid #e2e8f0;
      margin: 24px 0;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 16px 0;
      font-size: 12px;
      page-break-inside: avoid;
    }
    th, td {
      border: 1px solid #cbd5e1;
      padding: 7px 10px;
      text-align: left;
    }
    th {
      background-color: #f1f5f9;
      color: #0f172a;
      font-weight: 700;
    }
    tr:nth-child(even) td {
      background-color: #f8fafc;
    }
    pre {
      background: #0f172a;
      color: #f8fafc;
      padding: 12px 14px;
      border-radius: 6px;
      overflow-x: auto;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11.5px;
      line-height: 1.45;
      margin: 12px 0;
      page-break-inside: avoid;
    }
    code {
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      background: #f1f5f9;
      color: #0369a1;
      padding: 2px 5px;
      border-radius: 4px;
      border: 1px solid #e2e8f0;
    }
    pre code {
      background: transparent;
      color: inherit;
      padding: 0;
      border: none;
    }
    blockquote {
      margin: 14px 0;
      padding: 10px 14px;
      background: #eff6ff;
      border-left: 4px solid #2563eb;
      color: #1e3a8a;
      font-size: 13px;
      page-break-inside: avoid;
    }
    ul, ol {
      margin-top: 0;
      margin-bottom: 12px;
      padding-left: 22px;
    }
    li {
      margin-bottom: 4px;
    }
    .mermaid {
      background: #ffffff;
      padding: 16px;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      margin: 16px 0;
      display: flex;
      justify-content: center;
      page-break-inside: avoid;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04);
    }
    .mermaid svg {
      max-width: 100% !important;
      height: auto !important;
    }
  </style>
</head>
<body>
  <div id="content"></div>

  <script>
    const rawMarkdown = ${JSON.stringify(mdContent)};

    // Custom renderer for marked to intercept mermaid code blocks
    const renderer = new marked.Renderer();
    const defaultCodeRenderer = renderer.code.bind(renderer);

    renderer.code = function(code, language) {
      if (language === 'mermaid') {
        return '<div class="mermaid">' + code + '</div>';
      }
      return defaultCodeRenderer(code, language);
    };

    marked.setOptions({
      renderer: renderer,
      gfm: true,
      breaks: false,
    });

    document.getElementById('content').innerHTML = marked.parse(rawMarkdown);

    // Initialize and run Mermaid
    mermaid.initialize({
      startOnLoad: false,
      theme: 'default',
      themeVariables: {
        fontFamily: 'Inter, sans-serif',
        fontSize: '12px',
        primaryColor: '#e0e7ff',
        primaryBorderColor: '#6366f1',
        primaryTextColor: '#1e1b4b',
        lineColor: '#64748b',
        secondaryColor: '#f1f5f9',
        tertiaryColor: '#ffffff'
      }
    });

    window.addEventListener('DOMContentLoaded', async () => {
      await mermaid.run();
      window.status = 'ready_to_print';
    });
  </script>
</body>
</html>`;

fs.writeFileSync(DOC_HTML, html, 'utf8');
console.log('✅ Temporary HTML written to:', DOC_HTML);

const chromePath = 'C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe';
const edgePath = 'C:\\\\Program Files (x86)\\\\Microsoft\\\\Edge\\\\Application\\\\msedge.exe';
const browserExe = fs.existsSync(chromePath) ? chromePath : edgePath;

console.log('🚀 Using browser for PDF rendering:', browserExe);

const fileUri = 'file:///' + DOC_HTML.replace(/\\\\/g, '/');
const cmd = `"${browserExe}" --headless --disable-gpu --run-all-compositor-stages-before-draw --virtual-time-budget=9000 --print-to-pdf="${DOC_PDF}" --no-pdf-header-footer "${fileUri}"`;

console.log('🖨️ Generating PDF...');
execSync(cmd, { stdio: 'inherit' });

if (fs.existsSync(DOC_PDF)) {
  const stats = fs.statSync(DOC_PDF);
  console.log(`🎉 PDF successfully created at: ${DOC_PDF} (${(stats.size / 1024).toFixed(1)} KB)`);
  // Clean up temporary HTML
  fs.unlinkSync(DOC_HTML);
  console.log('🧹 Cleaned up temporary HTML.');
} else {
  console.error('❌ Failed to generate PDF.');
  process.exit(1);
}
