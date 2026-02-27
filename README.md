<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/frontend/public/brand/logo.png">
    <source media="(prefers-color-scheme: light)" srcset="apps/frontend/public/brand/logo-dark.png">
    <img src="apps/frontend/public/brand/logo-dark.png" alt="Automated" width="400">
  </picture>
</p>

<p align="center">
  <strong>Automate any browser workflow. Record once, run on autopilot forever.</strong>
</p>

<p align="center">
  <a href="#features">Features</a> &bull;
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#architecture">Architecture</a> &bull;
  <a href="#configuration">Configuration</a> &bull;
  <a href="#desktop-app">Desktop App</a>
</p>


---

**Automated** is an open-source, AI-powered browser automation tool. Record a workflow once by interacting with your browser, and let the AI replay, adapt, and execute it on autopilot - triggered manually, via email, on a schedule, or through the API.

<p align="center">

https://github.com/user-attachments/assets/8f9ecb26-5b42-4b4c-a1ca-ab2ea2589992

</p>

## Features

- **Workflow Recording** — Record browser interactions naturally; the system learns each step
- **AI-Powered Execution** — Intelligent replay using LLMs that adapt to page changes
- **Visual Workflow Editor** — Drag-and-drop editor with conditionals, loops, and data extraction
- **Multiple Triggers** — Run workflows manually, on a schedule, via email, or through the API
- **Live Monitoring** — Watch workflow execution in real-time through a browser session viewer
- **Data Extraction** — Extract structured data from any website using JSON schemas
- **Conditionals & Loops** — Build complex workflows with branching logic and iteration
- **Desktop App** — Native Electron app for macOS, Windows, and Linux
- **Self-Hostable** — Run the entire stack with a single `docker compose up`

## Quick Start

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/)
- An [OpenRouter](https://openrouter.ai/) API key (for AI-powered execution)

### 1. Clone the repository

```bash
git clone https://github.com/useautomated/automated.git
cd automated
```

### 2. Configure environment variables

Create a `.env` file in the project root:

```env
# Required — LLM provider for AI execution
OPENROUTER_API_KEY=your_openrouter_api_key

# Optional — Cloud browser automation (if not using local browser)
HYPERBROWSER_API_KEY=your_hyperbrowser_api_key

# Optional — Email triggers via Resend
RESEND_API_KEY=your_resend_api_key

# Optional — Authentication via Clerk
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=your_clerk_key
CLERK_SECRET_KEY=your_clerk_secret
```

> **Tip:** API keys can also be configured through the Settings panel in the web UI after startup.

### 3. Start the stack

```bash
docker compose up
```

That's it. Open [http://localhost:3000](http://localhost:3000) to access the dashboard.

| Service  | URL                   | Description   |
| -------- | --------------------- | ------------- |
| Frontend | http://localhost:3000 | Web dashboard |
| Backend  | http://localhost:8080 | REST API      |

### 4. Record your first workflow

1. Click **"+ New Workflow"** in the dashboard
2. A browser session will launch — interact with it naturally
3. Once done, save the recording
4. Hit **Run** to replay the workflow with AI

## Architecture

Automated is structured as an [Nx](https://nx.dev) monorepo with four main applications:

```
apps/
├── frontend/       Next.js web dashboard (React 19, Chakra UI, React Flow)
├── backend/        NestJS REST API (Prisma ORM, SQLite / PostgreSQL)
├── cua-agent/      AI orchestration engine (OpenRouter, Stagehand, Playwright)
└── desktop/        Electron wrapper for native desktop usage
```

### Tech Stack

| Layer     | Technology                               |
| --------- | ---------------------------------------- |
| Frontend  | Next.js, React 19, Chakra UI, React Flow |
| Backend   | NestJS, Prisma, SQLite / PostgreSQL      |
| AI Engine | OpenRouter (LLM), Stagehand, Playwright  |
| Desktop   | Electron, electron-builder               |
| Monorepo  | Nx                                       |

### Docker Compose Services

The default `docker-compose.yml` runs two services:

```yaml
services:
  backend: # NestJS API — port 8080, SQLite database
  frontend: # Next.js app — port 3000, depends on backend
```

Data is persisted via a `./data` volume mount. To switch to PostgreSQL, update `DATABASE_URL` in your `.env`.

## Configuration

| Variable                 | Required | Description                                 |
| ------------------------ | -------- | ------------------------------------------- |
| `OPENROUTER_API_KEY`     | Yes      | LLM API key for AI workflow execution       |
| `DATABASE_URL`           | No       | Database connection (default: local SQLite) |
| `HYPERBROWSER_API_KEY`   | No       | Hyperbrowser API key                        |
| `RESEND_API_KEY`         | No       | Email service for email-triggered workflows |

## Local Development

```bash
# Install dependencies
npm install

# Start all services in dev mode
npm run start

# Or start individually
npm run start:backend
npm run start:frontend
```

## Desktop App

The desktop app packages the full Automated experience as a native application.

```bash
# Development
npm run desktop:dev

# Build distributables
npm run desktop:dist:mac      # macOS (DMG + ZIP)
npm run desktop:dist:win      # Windows (NSIS + ZIP)
npm run desktop:dist:linux    # Linux (AppImage + DEB)
```

Supported platforms: **macOS** (Intel & Apple Silicon), **Windows** (x64), **Linux** (x64).
