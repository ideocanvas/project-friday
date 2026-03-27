# Project Friday

A privacy-first, local AI assistant with WhatsApp integration. Zero-database architecture using file-based storage.

## Features

- **WhatsApp Gateway** - Message handling via Baileys (WebSocket)
- **Local LLM** - qwen/qwen3.5-35b-a3b via LM Studio
- **Cloud Evolution** - GLM-5:cloud via Ollama for skill generation
- **MLX-Audio** - Voice STT/TTS for Mac M-series
- **4 PM2 Processes** - Gateway, Scheduler, Janitor, Evolution

## Quick Start

### 1. Install Dependencies

```bash
# Node.js dependencies
npm install

# Python dependencies (for skills)
conda create -n friday-skills python=3.11
conda activate friday-skills
pip install mlx-whisper mlx-audio python-dotenv requests
```

### 2. Configure Environment

```bash
# Copy example config
cp .env.example .env

# Edit .env with your values
# - Add your phone number to ALLOWED_NUMBERS
# - Configure LM Studio URL (default: http://localhost:1234/v1)
# - Configure Ollama URL (default: http://localhost:11434)
```

### 3. Start LM Studio

1. Open LM Studio
2. Load qwen/qwen3.5-35b-a3b model
3. Start local server on port 1234

### 4. Start Ollama (for GLM-5)

```bash
# Install Ollama if not already installed
# Then pull and run GLM-5:cloud
ollama pull glm-5:cloud
ollama serve
```

### 5. Start PM2

```bash
# Start all processes
npm run start

# View status
npm run status

# View logs
npm run logs
```

### 5. Connect WhatsApp

1. Check the terminal for QR code
2. Scan with WhatsApp → Linked Devices
3. Session will be saved in `auth_info_baileys/`

## Project Structure

```
/Friday-Project
├── core/                    # Node.js processes
│   ├── gateway.js          # WhatsApp Gateway
│   ├── heartbeat.js        # Scheduler/Reminder
│   ├── janitor.js          # Web Portal Cleanup
│   └── evolution.js        # Skill Factory
├── skills/
│   ├── builtin/            # Pre-installed skills
│   ├── generated/          # AI-generated skills
│   ├── registry.json       # Skill registry
│   └── ai_utils.py         # Python utilities
├── users/                   # User data (per phone)
├── queue/                   # Inter-process messages
├── web_portal/             # Static HTML pages
├── logs/                    # PM2 logs
└── temp/                    # GPU lock, temp files
```

## Architecture

See `plan/project.md` for detailed architecture documentation.

## Design Documents

- [`plan/design-gateway.md`](plan/design-gateway.md) - WhatsApp Gateway
- [`plan/design-scheduler.md`](plan/design-scheduler.md) - Heartbeat/Scheduler
- [`plan/design-pm2.md`](plan/design-pm2.md) - PM2 Configuration
- [`plan/design-browser.md`](plan/design-browser.md) - Live Browser Skill
- [`plan/design-search.md`](plan/design-search.md) - Google Search Skill
- [`plan/design-voice.md`](plan/design-voice.md) - Voice STT/TTS
- [`plan/design-static-page.md`](plan/design-static-page.md) - Static Page Generator
- [`plan/design-skill-factory.md`](plan/design-skill-factory.md) - Skill Factory

## License

MIT