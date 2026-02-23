#!/usr/bin/env node

import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

function printUsage() {
  console.log(`Render interactions JSON into an HTML file.

Usage:
  node scripts/render-interactions-html.mjs --input <file.json> [--output <file.html>] [--title "Name"] [--open]

Examples:
  npm run interactions:render -- --input /tmp/interactions.json
  npm run interactions:render -- --input apps/backend/logs/interactions-123.json --output /tmp/preview.html --open
`);
}

function parseArgs(argv) {
  const args = { input: null, output: null, title: null, open: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--open') {
      args.open = true;
    } else if (arg === '--input' || arg === '-i') {
      args.input = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--output' || arg === '-o') {
      args.output = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--title' || arg === '-t') {
      args.title = argv[i + 1] ?? null;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('`', '&#96;');
}

function interactionTitle(interaction) {
  if (interaction.data?.type === 'starting_url') {
    return `Start at ${interaction.element?.href || 'page'}`;
  }
  if (interaction.data?.type === 'url_navigation') {
    return `Navigate to ${interaction.data?.url || interaction.element?.href || 'page'}`;
  }
  if (interaction.data?.type === 'click') {
    const text = String(interaction.element?.text || '').trim();
    if (text) return `Click "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`;
    return `Click ${String(interaction.element?.tagName || 'element').toLowerCase()}`;
  }
  if (interaction.data?.type === 'keydown') {
    return `Type "${String(interaction.element?.text || '').slice(0, 80)}"`;
  }
  if (interaction.data?.type === 'keypress') {
    return `Press ${interaction.data?.combo || interaction.element?.text || 'keys'}`;
  }
  if (interaction.type === 'tab_navigation') {
    return interaction.element?.text || 'Tab navigation';
  }
  if (interaction.type === 'frame_navigation') {
    return interaction.element?.text || interaction.data?.url || 'Frame navigation';
  }
  return interaction.element?.text || interaction.type || 'Interaction';
}

function toIso(timestamp) {
  if (typeof timestamp !== 'number' || Number.isNaN(timestamp)) return '';
  return new Date(timestamp).toISOString();
}

function parseUserPartText(partText) {
  if (typeof partText !== 'string') return null;
  const lines = partText.split('\n').map((line) => line.trim());
  const stepLine = lines.find((line) => /^Step\s+\d+:/i.test(line)) || '';
  const stepMatch = stepLine.match(/^Step\s+(\d+):/i);
  const typeLine = lines.find((line) => line.startsWith('Type:')) || '';
  const valueLine =
    lines.find((line) => line.startsWith('Text:')) ||
    lines.find((line) => line.startsWith('Typed:')) ||
    lines.find((line) => line.startsWith('URL:')) ||
    '';
  const narrationLine = lines.find((line) => line.startsWith('Voice narration:')) || '';

  const step = stepMatch ? Number(stepMatch[1]) : null;
  const typeText = typeLine.replace(/^Type:\s*/i, '').toLowerCase();
  const valueText = valueLine.replace(/^(Text|Typed|URL):\s*/i, '').replace(/^"|"$/g, '');
  const narration = narrationLine
    .replace(/^Voice narration:\s*/i, '')
    .replace(/^"|"$/g, '')
    .trim();

  const interaction = {
    id: step ? `step-${step}` : `step-${Math.random().toString(36).slice(2, 8)}`,
    type: typeText.includes('navigation') ? 'tab_navigation' : 'user_event',
    timestamp: null,
    pageId: '',
    element: {
      tagName: typeText.toUpperCase() || 'STEP',
      text: valueText,
      href: valueText.startsWith('http') ? valueText : undefined,
    },
    data: {},
    transcript: narration || undefined,
  };

  if (typeText.includes('click')) interaction.data.type = 'click';
  else if (typeText.includes('typing')) interaction.data.type = 'keydown';
  else if (typeText.includes('key press')) interaction.data.type = 'keypress';
  else if (typeText.includes('starting url')) interaction.data.type = 'starting_url';
  else if (typeText.includes('navigation')) interaction.data.type = 'url_navigation';

  return interaction;
}

function normalizeInteractions(payload) {
  if (Array.isArray(payload) && payload.every((item) => item && typeof item === 'object')) {
    // Direct interactions payload
    if (payload.some((item) => 'timestamp' in item || 'element' in item || 'data' in item)) {
      return payload;
    }

    // User parts payload from backend logs
    if (payload.some((item) => item.type === 'text' || item.type === 'image_url')) {
      const interactions = [];
      for (const part of payload) {
        if (part.type === 'text') {
          const parsed = parseUserPartText(part.text);
          if (parsed) interactions.push(parsed);
          continue;
        }
        if (part.type === 'image_url' && interactions.length > 0) {
          const last = interactions[interactions.length - 1];
          if (typeof part.image_url?.url === 'string') {
            last.screenshotUrl = part.image_url.url;
          }
        }
      }
      return interactions;
    }
  }

  if (payload && typeof payload === 'object' && Array.isArray(payload.interactions)) {
    return payload.interactions;
  }

  throw new Error(
    'Unsupported JSON format. Expected an interactions array, an object with "interactions", or backend user-parts logs.',
  );
}

function renderHtml(interactions, pageTitle) {
  const cards = interactions
    .map((interaction, index) => {
      const title = interactionTitle(interaction);
      const screenshot = interaction.screenshotUrl
        ? `<img class="shot" src="${escapeAttr(interaction.screenshotUrl)}" alt="interaction screenshot" loading="lazy" />`
        : '';
      const selector = interaction.element?.selector
        ? `<div class="meta"><strong>Selector:</strong> <code>${escapeHtml(interaction.element.selector)}</code></div>`
        : '';
      const transcript = interaction.transcript
        ? `<div class="transcript">${escapeHtml(interaction.transcript)}</div>`
        : '';
      const clickPoint =
        interaction.data?.type === 'click' &&
        typeof interaction.data?.x === 'number' &&
        typeof interaction.data?.y === 'number'
          ? `<div class="meta"><strong>Click:</strong> x=${interaction.data.x}, y=${interaction.data.y}</div>`
          : '';

      const timestamp = toIso(interaction.timestamp);
      const timestampHtml = timestamp
        ? `<div class="meta"><strong>Time:</strong> ${escapeHtml(timestamp)}</div>`
        : '';

      const typeLabel = escapeHtml(interaction.data?.type || interaction.type || 'interaction');

      return `
<article class="card">
  <div class="head">
    <span class="step">${index + 1}</span>
    <div class="title-wrap">
      <h3 class="title">${escapeHtml(title)}</h3>
      <span class="badge">${typeLabel}</span>
    </div>
  </div>
  ${timestampHtml}
  ${clickPoint}
  ${selector}
  ${screenshot}
  ${transcript}
</article>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(pageTitle)}</title>
  <style>
    :root {
      --bg: #f6f8fb;
      --card: #ffffff;
      --text: #111827;
      --muted: #4b5563;
      --border: #e5e7eb;
      --badge-bg: #dbeafe;
      --badge-text: #1d4ed8;
    }
    body {
      margin: 0;
      font-family: ui-sans-serif, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
      color: var(--text);
      background: linear-gradient(180deg, #f8fafc 0%, var(--bg) 100%);
    }
    .container {
      max-width: 980px;
      margin: 32px auto;
      padding: 0 16px 40px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 24px;
      line-height: 1.2;
    }
    .sub {
      margin: 0 0 24px;
      color: var(--muted);
      font-size: 14px;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 16px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px;
      box-shadow: 0 2px 10px rgba(15, 23, 42, 0.05);
    }
    .head {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 8px;
    }
    .step {
      display: inline-flex;
      width: 24px;
      height: 24px;
      border-radius: 999px;
      align-items: center;
      justify-content: center;
      background: #eff6ff;
      color: #1d4ed8;
      font-size: 12px;
      font-weight: 700;
    }
    .title-wrap {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
    }
    .title {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
    }
    .badge {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      background: var(--badge-bg);
      color: var(--badge-text);
      padding: 2px 8px;
      border-radius: 999px;
    }
    .meta {
      font-size: 13px;
      color: var(--muted);
      margin: 4px 0;
      word-break: break-word;
    }
    code {
      background: #f3f4f6;
      border: 1px solid #e5e7eb;
      border-radius: 6px;
      padding: 1px 6px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
    }
    .shot {
      margin-top: 10px;
      width: 100%;
      max-width: 420px;
      border-radius: 10px;
      border: 1px solid var(--border);
      display: block;
      background: #fff;
    }
    .transcript {
      margin-top: 10px;
      font-size: 13px;
      color: #1f2937;
      border-left: 3px solid #93c5fd;
      padding-left: 10px;
      white-space: pre-wrap;
    }
  </style>
</head>
<body>
  <main class="container">
    <h1>${escapeHtml(pageTitle)}</h1>
    <p class="sub">${interactions.length} interaction${interactions.length === 1 ? '' : 's'}</p>
    <section class="grid">
      ${cards}
    </section>
  </main>
</body>
</html>`;
}

async function maybeOpen(filePath) {
  const platform = process.platform;
  if (platform === 'darwin') {
    spawn('open', [filePath], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  if (platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', filePath], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  spawn('xdg-open', [filePath], { detached: true, stdio: 'ignore' }).unref();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  if (!args.input) {
    printUsage();
    throw new Error('Missing required --input argument.');
  }

  const inputPath = path.resolve(process.cwd(), args.input);
  const rawText = await fs.readFile(inputPath, 'utf-8');
  const payload = JSON.parse(rawText);
  const interactions = normalizeInteractions(payload);

  const defaultOutput = path.join(
    path.dirname(inputPath),
    `${path.basename(inputPath, path.extname(inputPath))}.preview.html`,
  );
  const outputPath = path.resolve(process.cwd(), args.output || defaultOutput);
  const pageTitle = args.title || `Interactions Preview (${path.basename(inputPath)})`;

  const html = renderHtml(interactions, pageTitle);
  await fs.writeFile(outputPath, html, 'utf-8');

  console.log(`Rendered ${interactions.length} interaction(s) to: ${outputPath}`);

  if (args.open) {
    await maybeOpen(outputPath);
    console.log(`Opened: ${outputPath}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
