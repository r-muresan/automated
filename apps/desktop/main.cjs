const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app, BrowserWindow, dialog } = require('electron');

// Use uncommon ports to avoid conflicts with local dev servers or other apps.
const BACKEND_PORT = Number(process.env.BACKEND_PORT || 52140);
const FRONTEND_PORT = Number(process.env.FRONTEND_PORT || 52141);
const EXTERNAL_FRONTEND_URL = process.env.ELECTRON_START_URL;
const FRONTEND_URL = EXTERNAL_FRONTEND_URL || `http://127.0.0.1:${FRONTEND_PORT}`;
const USE_EXTERNAL_SERVERS = Boolean(EXTERNAL_FRONTEND_URL);

const managedProcesses = [];

function projectRoot() {
  if (app.isPackaged) {
    // With asar packaging, files live in app.asar; spawned Electron/Node
    // processes (ELECTRON_RUN_AS_NODE) can load scripts from inside .asar.
    const asarPath = path.join(process.resourcesPath, 'app.asar');
    if (fs.existsSync(asarPath)) {
      return asarPath;
    }
    return path.join(process.resourcesPath, 'app');
  }
  return path.resolve(__dirname, '../..');
}

function loadEnvFileIfPresent(filePath) {
  if (!fs.existsSync(filePath)) return;
  const contents = fs.readFileSync(filePath, 'utf8');

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const splitIndex = line.indexOf('=');
    if (splitIndex <= 0) continue;

    const key = line.slice(0, splitIndex).trim();
    let value = line.slice(splitIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function loadRuntimeEnv(rootDir) {
  const candidates = [path.join(rootDir, '.env'), path.join(process.cwd(), '.env')];
  for (const candidate of candidates) {
    loadEnvFileIfPresent(candidate);
  }
}

function attachLogs(child, label) {
  child.stdout.on('data', (chunk) => {
    process.stdout.write(`[${label}] ${chunk}`);
  });

  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[${label}] ${chunk}`);
  });

  child.on('exit', (code, signal) => {
    const status = signal ? `signal ${signal}` : `code ${code}`;
    console.log(`[${label}] exited with ${status}`);
  });
}

function spawnNodeScript(scriptPath, args, options) {
  return spawn(process.execPath, [scriptPath, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ...options.env,
    },
    cwd: options.cwd,
  });
}

function loadSettingsToEnv() {
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');
  try {
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, 'utf8');
      const data = JSON.parse(raw);
      if (data.openrouterApiKey && !process.env.OPENROUTER_API_KEY) {
        process.env.OPENROUTER_API_KEY = data.openrouterApiKey;
      }
    }
  } catch {
    // settings.json may not exist yet — ignore
  }
}

function getSchemaEngineBinary() {
  const rootDir = projectRoot();
  const enginesDir = app.isPackaged
    ? path.join(process.resourcesPath, 'prisma-engines')
    : path.join(rootDir, 'node_modules/@prisma/engines');

  const platform = process.platform === 'darwin' ? 'darwin'
    : process.platform === 'win32' ? 'windows'
    : 'debian-openssl-3.0.x';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const ext = process.platform === 'win32' ? '.exe' : '';

  return path.join(enginesDir, `schema-engine-${platform}-${arch}${ext}`);
}

function schemaPushViaEngine(schemaPath, schemaContent, dbUrl) {
  return new Promise((resolve, reject) => {
    const engineBin = getSchemaEngineBinary();
    if (!fs.existsSync(engineBin)) {
      return reject(new Error(`Schema engine binary not found: ${engineBin}`));
    }

    // Inject the datasource URL into the schema content so the engine connects
    // to the correct database. Replace the env("DATABASE_URL") with a literal.
    const resolvedSchema = schemaContent.replace(
      /url\s*=\s*env\("DATABASE_URL"\)/,
      `url = "${dbUrl}"`,
    );

    // Write resolved schema to a temp file (schema-engine needs --datamodels)
    const tmpSchemaPath = path.join(app.getPath('userData'), '_schema_push.prisma');
    fs.writeFileSync(tmpSchemaPath, resolvedSchema, 'utf8');

    const child = spawn(engineBin, ['--datamodels', tmpSchemaPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error('Schema engine timed out after 30s'));
      }
    }, 30_000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      try {
        const parsed = JSON.parse(chunk.toString().trim());
        if (parsed.result || parsed.error) {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            setTimeout(() => child.kill(), 500);
            if (parsed.error) {
              reject(new Error(`Schema engine error: ${JSON.stringify(parsed.error)}`));
            } else {
              resolve(parsed.result);
            }
          }
        }
      } catch {
        // not complete JSON yet
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(err); }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // Clean up temp schema file
      try { fs.unlinkSync(tmpSchemaPath); } catch {}
      if (!settled) {
        settled = true;
        if (code !== 0) {
          reject(new Error(`Schema engine exited with code ${code}: ${stderr}`));
        } else {
          resolve(null);
        }
      }
    });

    const request = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'schemaPush',
      params: {
        schema: {
          files: [{ path: tmpSchemaPath, content: resolvedSchema }],
        },
        force: true,
      },
    });

    child.stdin.write(request + '\n');
  });
}

function ensureSqliteDatabase() {
  const userDataDir = app.getPath('userData');
  const dbDir = path.join(userDataDir, 'data');
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const dbPath = path.join(dbDir, 'local.db');

  // Set DATABASE_URL for SQLite if not already set
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = `file:${dbPath}`;
  }

  // Read the SQLite Prisma schema
  const rootDir = projectRoot();
  const unpackedRoot = app.isPackaged
    ? rootDir.replace('app.asar', 'app.asar.unpacked')
    : rootDir;
  const sqliteSchemaPath = path.join(unpackedRoot, 'libs/prisma/prisma/.generated/sqlite.prisma');

  if (!fs.existsSync(sqliteSchemaPath)) {
    console.error(`[desktop] SQLite schema not found: ${sqliteSchemaPath}`);
    return Promise.resolve();
  }

  const schemaContent = fs.readFileSync(sqliteSchemaPath, 'utf8');
  const dbUrl = `file:${dbPath}`;

  return schemaPushViaEngine(sqliteSchemaPath, schemaContent, dbUrl)
    .then((result) => {
      console.log('[desktop] SQLite database schema ensured via schema-engine schemaPush', result);
    })
    .catch((err) => {
      console.error('[desktop] Failed to ensure SQLite schema:', err.message);
      // Non-fatal — backend will still try to connect
    });
}

function startBackend(rootDir) {
  const backendEntry = path.join(rootDir, 'dist/apps/backend/main.js');
  if (!fs.existsSync(backendEntry)) {
    throw new Error(
      `Missing backend bundle at ${backendEntry}. Run "npm run desktop:build" first.`,
    );
  }

  const backendCwd = app.getPath('userData');
  const origins =
    process.env.CORS_ALLOWED_ORIGINS ||
    `http://localhost:${FRONTEND_PORT},http://127.0.0.1:${FRONTEND_PORT}`;

  const backend = spawnNodeScript(backendEntry, [], {
    cwd: backendCwd,
    env: {
      PORT: String(BACKEND_PORT),
      CORS_ALLOWED_ORIGINS: origins,
    },
  });

  managedProcesses.push(backend);
  attachLogs(backend, 'backend');
}

function startFrontend(rootDir) {
  const nextBin = path.join(rootDir, 'node_modules/next/dist/bin/next');
  const frontendDir = path.join(rootDir, 'apps/frontend');
  const nextBuildDir = path.join(frontendDir, '.next');

  if (!fs.existsSync(nextBin)) {
    throw new Error(`Missing Next.js runtime at ${nextBin}. Run "npm install" first.`);
  }
  if (!fs.existsSync(nextBuildDir)) {
    throw new Error(
      `Missing frontend build at ${nextBuildDir}. Run "npm run desktop:build" first.`,
    );
  }

  // Use userData as cwd (can't use asar path as cwd for spawn).
  // Pass the frontend dir as an absolute path argument to `next start`.
  const frontend = spawnNodeScript(
    nextBin,
    ['start', frontendDir, '-p', String(FRONTEND_PORT), '-H', '127.0.0.1'],
    {
      cwd: app.getPath('userData'),
      env: {
        PORT: String(FRONTEND_PORT),
        NODE_ENV: 'production',
        NEXT_TELEMETRY_DISABLED: '1',
      },
    },
  );

  managedProcesses.push(frontend);
  attachLogs(frontend, 'frontend');
}

function checkHttp(url) {
  return new Promise((resolve) => {
    const client = url.startsWith('https://') ? https : http;
    const request = client.get(url, (response) => {
      response.resume();
      resolve((response.statusCode || 0) < 500);
    });
    request.on('error', () => resolve(false));
    request.setTimeout(1000, () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(url, timeoutMs, name) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await checkHttp(url)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  throw new Error(`Timed out waiting for ${name} at ${url}`);
}

function stopManagedProcesses() {
  for (const child of managedProcesses) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }
}

function createWindow() {
  const iconPath = path.join(projectRoot(), 'apps/desktop/icon.png');
  console.log(`[desktop] Creating window, loading ${FRONTEND_URL}`);
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    icon: iconPath,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Automated',
    show: false,
  });

  win.once('ready-to-show', () => {
    console.log('[desktop] Window ready-to-show, calling show()');
    win.show();
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[desktop] Page failed to load: ${errorDescription} (${errorCode}) at ${validatedURL}`);
  });

  win.webContents.on('did-finish-load', () => {
    console.log('[desktop] Page finished loading');
  });

  win.loadURL(FRONTEND_URL);
}

async function bootstrap() {
  const rootDir = projectRoot();
  loadRuntimeEnv(rootDir);

  // Set dock icon on macOS
  const iconPath = path.join(rootDir, 'apps/desktop/icon.png');
  if (process.platform === 'darwin' && app.dock && fs.existsSync(iconPath)) {
    const { nativeImage } = require('electron');
    app.dock.setIcon(nativeImage.createFromPath(iconPath));
  }

  // Load persisted settings (e.g. OPENROUTER_API_KEY)
  loadSettingsToEnv();

  if (!USE_EXTERNAL_SERVERS) {
    // Ensure SQLite database schema is up to date before starting the backend
    await ensureSqliteDatabase();

    startBackend(rootDir);
    await waitForServer(`http://127.0.0.1:${BACKEND_PORT}/api`, 60_000, 'backend');

    startFrontend(rootDir);
    await waitForServer(FRONTEND_URL, 90_000, 'frontend');
  } else {
    await waitForServer(FRONTEND_URL, 90_000, 'frontend');
  }

  createWindow();
}

app.whenReady().then(async () => {
  try {
    await bootstrap();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[desktop] failed to start', error);
    dialog.showErrorBox('Desktop startup failed', message);
    app.quit();
  }
});

app.on('before-quit', () => {
  stopManagedProcesses();
});

app.on('window-all-closed', () => {
  app.quit();
});

