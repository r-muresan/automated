import path from 'node:path';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { Hyperbrowser } from '@hyperbrowser/sdk';

dotenv.config();

function parseArgs(argv) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const defaults = {
    outputDir: path.join(process.cwd(), 'tmp', `hyperbrowser-vnc-stagehand-${timestamp}`),
    buildDir: path.join(process.cwd(), '.tmp', 'hyperbrowser-vnc-stagehand-build'),
    width: 1280,
    height: 800,
  };

  const next = { ...defaults };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output-dir' && argv[index + 1]) {
      next.outputDir = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--build-dir' && argv[index + 1]) {
      next.buildDir = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--width' && argv[index + 1]) {
      next.width = Math.max(800, Number(argv[index + 1]) || defaults.width);
      index += 1;
      continue;
    }
    if (arg === '--height' && argv[index + 1]) {
      next.height = Math.max(600, Number(argv[index + 1]) || defaults.height);
      index += 1;
      continue;
    }
  }

  return next;
}

function tryParseUrl(value) {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function extractTokenFromUrl(value) {
  const url = tryParseUrl(value);
  if (!url) return null;
  return url.searchParams.get('token') ?? url.searchParams.get('vncAuthToken');
}

function extractConnectHostFromUrl(value) {
  const url = tryParseUrl(value);
  if (!url) return null;
  return url.searchParams.get('connect') ?? url.hostname;
}

function extractConnectHostFromLiveUrl(value) {
  const url = tryParseUrl(value);
  if (!url) return null;
  return extractConnectHostFromUrl(url.searchParams.get('liveDomain'));
}

function extractHyperbrowserVncUrl(session) {
  const tokenCandidates = new Set();
  const hostCandidates = new Set();
  const add = (set, value) => {
    const normalized = value?.trim();
    if (normalized) set.add(normalized);
  };

  add(tokenCandidates, extractTokenFromUrl(session.liveUrl));
  add(tokenCandidates, extractTokenFromUrl(session.wsEndpoint));
  add(tokenCandidates, extractTokenFromUrl(session.computerActionEndpoint));
  add(tokenCandidates, session.token);

  add(hostCandidates, extractConnectHostFromUrl(session.wsEndpoint));
  add(hostCandidates, extractConnectHostFromUrl(session.computerActionEndpoint));
  add(hostCandidates, extractConnectHostFromLiveUrl(session.liveUrl));

  const token = Array.from(tokenCandidates)[0];
  const host = Array.from(hostCandidates)[0];
  return host && token
    ? `wss://${host}/websockify?vncAuthToken=${encodeURIComponent(token)}`
    : null;
}

function createTestPageDataUrl(title, background, body) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: Georgia, serif;
        background: ${background};
        color: white;
      }
      main {
        text-align: center;
        padding: 48px;
        border: 3px solid rgba(255,255,255,0.75);
        background: rgba(0, 0, 0, 0.18);
      }
      h1 {
        margin: 0 0 12px;
        font-size: 56px;
        letter-spacing: 0.04em;
      }
      p {
        margin: 0;
        font-size: 22px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <p>${body}</p>
    </main>
  </body>
</html>`)}`;
}

async function compileCuaAgent(buildDir) {
  await fs.rm(buildDir, { recursive: true, force: true });
  await fs.mkdir(buildDir, { recursive: true });
  execFileSync(
    'npx',
    ['tsc', '-p', 'apps/cua-agent/tsconfig.app.json', '--outDir', buildDir],
    { stdio: 'inherit', cwd: process.cwd() },
  );
}

async function loadStagehandModules(buildDir) {
  const stagehandIndexUrl = pathToFileURL(
    path.join(buildDir, 'apps', 'cua-agent', 'stagehand', 'v3', 'index.js'),
  ).href;
  const controllerUrl = pathToFileURL(
    path.join(
      buildDir,
      'apps',
      'cua-agent',
      'stagehand',
      'v3',
      'screen',
      'VncScreenController.js',
    ),
  ).href;

  const { Stagehand } = await import(stagehandIndexUrl);
  const { VncScreenController } = await import(controllerUrl);
  return { Stagehand, VncScreenController };
}

async function screenshotToFile(stagehand, targetPath) {
  const buffer = await stagehand.captureModelScreenshot({ type: 'png' });
  await fs.writeFile(targetPath, buffer);
}

async function getActiveSummary(stagehand) {
  const page = await stagehand.context.awaitActivePage();
  return {
    title: await page.title(),
    url: page.url(),
  };
}

async function clickTabUntilActive({
  stagehand,
  controller,
  expectedTitle,
  candidateXs,
  y,
  pauseMs = 700,
}) {
  for (const clickX of candidateXs) {
    await controller.click(clickX, y, { button: 'left', clickCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
    await stagehand.syncActivePageFromFocus();
    const active = await getActiveSummary(stagehand);
    if (active.title === expectedTitle) {
      return { success: true, clickX, activeTitle: active.title, activeUrl: active.url };
    }
  }

  const active = await getActiveSummary(stagehand);
  return { success: false, activeTitle: active.title, activeUrl: active.url };
}

async function main() {
  const apiKey = process.env.HYPERBROWSER_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Missing HYPERBROWSER_API_KEY. Set it in the environment or .env before running this script.',
    );
  }

  const { outputDir, buildDir, width, height } = parseArgs(process.argv.slice(2));
  await fs.mkdir(outputDir, { recursive: true });
  await compileCuaAgent(buildDir);
  const { Stagehand, VncScreenController } = await loadStagehandModules(buildDir);

  const client = new Hyperbrowser({ apiKey });
  let session = null;
  let stagehand = null;

  try {
    session = await client.sessions.create({
      timeoutMinutes: 15,
      screen: { width, height },
      saveDownloads: false,
      enableWebRecording: true,
      enableVideoWebRecording: false,
      useStealth: true,
      solveCaptchas: false,
      profile: process.env.HYPERBROWSER_PROFILE_ID
        ? {
            id: process.env.HYPERBROWSER_PROFILE_ID,
            persistChanges: false,
          }
        : undefined,
    });

    if (!session.wsEndpoint) {
      throw new Error('Hyperbrowser did not return a wsEndpoint.');
    }

    const vncUrl = extractHyperbrowserVncUrl(session);
    if (!vncUrl) {
      throw new Error('Unable to derive a VNC URL from the Hyperbrowser session.');
    }

    stagehand = new Stagehand({
      env: 'LOCAL',
      verbose: 1,
      model: {
        modelName: 'openai/gpt-4.1-mini',
        apiKey:
          process.env.OPENROUTER_API_KEY ??
          process.env.OPENAI_API_KEY ??
          'unused-for-vnc-transport-test',
      },
      localBrowserLaunchOptions: {
        cdpUrl: session.wsEndpoint,
      },
      experimental: true,
      disableAPI: true,
    });

    await stagehand.init();

    const controller = new VncScreenController({ vncUrl });
    await controller.connect();
    stagehand.setScreenController(controller);

    const firstPage = stagehand.context.pages()[0];
    await firstPage.goto(
      createTestPageDataUrl(
        'TAB ONE',
        'linear-gradient(135deg, #b91c1c, #7f1d1d)',
        'The red tab should be active before the VNC click.',
      ),
      { waitUntil: 'load' },
    );
    await firstPage.waitForLoadState('load');

    const secondPage = await stagehand.context.newPage();
    await secondPage.goto(
      createTestPageDataUrl(
        'TAB TWO',
        'linear-gradient(135deg, #1d4ed8, #172554)',
        'The blue tab should become active after clicking the browser tab strip.',
      ),
      { waitUntil: 'load' },
    );
    await secondPage.waitForLoadState('load');

    stagehand.context.setActivePage(firstPage);
    await firstPage.waitForTimeout(800);
    await stagehand.syncActivePageFromFocus();

    const before = await getActiveSummary(stagehand);
    await screenshotToFile(stagehand, path.join(outputDir, 'before-tab-click.png'));

    const switchToSecond = await clickTabUntilActive({
      stagehand,
      controller,
      expectedTitle: 'TAB TWO',
      candidateXs: [210, 250, 290, 330, 370],
      y: 20,
    });

    if (!switchToSecond.success) {
      throw new Error(
        `Failed to activate the second browser tab via VNC click. Active tab remained "${switchToSecond.activeTitle}".`,
      );
    }

    await screenshotToFile(stagehand, path.join(outputDir, 'after-tab-click.png'));

    const switchBackToFirst = await clickTabUntilActive({
      stagehand,
      controller,
      expectedTitle: 'TAB ONE',
      candidateXs: [90, 120, 150, 180],
      y: 20,
    });

    const after = await getActiveSummary(stagehand);
    await fs.writeFile(
      path.join(outputDir, 'summary.json'),
      JSON.stringify(
        {
          sessionId: session.id,
          liveUrl: session.liveUrl ?? null,
          wsEndpoint: session.wsEndpoint ?? null,
          vncUrl,
          before,
          after,
          switchToSecond,
          switchBackToFirst,
        },
        null,
        2,
      ),
      'utf8',
    );

    console.log(`Session ID: ${session.id}`);
    console.log(`Live URL: ${session.liveUrl ?? ''}`);
    console.log(`VNC URL: ${vncUrl}`);
    console.log(`Output directory: ${outputDir}`);
    console.log(`Before click active tab: ${before.title}`);
    console.log(`After VNC tab click active tab: ${after.title} (clicked x=${switchToSecond.clickX})`);
    console.log(`Switch back to first tab: ${switchBackToFirst.success ? 'passed' : 'failed'}`);
  } finally {
    if (stagehand) {
      await stagehand.close().catch(() => {});
    }
    if (session?.id) {
      await client.sessions.stop(session.id).catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
