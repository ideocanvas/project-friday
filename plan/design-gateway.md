# WhatsApp Gateway Design

## Overview

The WhatsApp Gateway (`gateway.js`) is the primary interface for users to interact with Friday. It handles receiving and sending messages via WhatsApp using the baileys library.

## PM2 Configuration

- **Process Name:** `friday-gateway`
- **File:** `core/gateway.js`
- **Restart Policy:** Restart on crash with 10s delay

---

## Core Responsibilities

### 1. WhatsApp Connection Management

- QR code authentication (first-time setup)
- Session persistence (store auth info in JSON)
- Auto-reconnect on disconnect
- Connection health monitoring

### 2. Message Reception

- Listen for incoming messages from whitelist (`.env: ALLOWED_NUMBERS`)
- Extract message text, audio (voice notes), images
- Route to appropriate handler:
  - Text → LLM processing
  - Audio → MLX STT → LLM processing
  - Images → Process and send to LLM

### 3. Message Sending

- Poll `/queue/pending_messages.json` every 5 seconds
- Send WhatsApp messages to users
- Handle sending failures (retry up to 3 times)

### 4. Context Assembly

- Load user profile from `/users/[phone]/profile.json`
- Load memory from `/users/[phone]/memory.json`
- Combine with agent prompt for LLM request

---

## Directory Structure

```
/core/
├── gateway.js           # Main gateway process
├── whatsapp/
│   ├── client.js       # Baileys client wrapper
│   ├── auth.js         # Session management
│   └── handlers/
│       ├── message.js  # Incoming message handler
│       ├── media.js    # Media processing
│       └── queue.js    # Outgoing message queue
```

---

## Message Flow

```
Incoming WhatsApp Message
         │
         ▼
┌─────────────────┐
│ gateway.js     │
│ (receives)     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Validate       │ ─── If not in whitelist → ignore
│ phone number   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Process Media  │ ─── Audio → MLX STT
│ if needed      │ ─── Image → download & describe
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Assemble       │ ─── profile + memory + current message
│ Context        │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Call Local LLM │ ─── Qwen3.5-35B-A3B via LM Studio
│ (gateway.js)   │
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
┌───────┐ ┌────────┐
│ Skill │ │ Direct │
│ Found │ │ Reply  │
└───┬───┘ └───┬────┘
    │         │
    ▼         │
┌───────────┐ │
│ Execute   │ │
│ Skill     │ │
└─────┬─────┘ │
      │       │
      ▼       ▼
  Write to /queue/pending_messages.json
            │
            ▼
      Gateway polls & sends
```

---

## Configuration (.env)

```env
# WhatsApp
ALLOWED_NUMBERS=+1234567890,+0987654321
SESSION_PATH=./sessions

# LLM
AI_PROVIDER=lmstudio
AI_BASE_URL=http://localhost:1234/v1
CHAT_MODEL=qwen3.5-35b-a3b
```

---

## Queue Message Format

```json
// /queue/pending_messages.json
[
  {
    "id": "uuid",
    "to": "+1234567890",
    "message": "Your gold price alert: $1950 (+1.2%)",
    "type": "text" | "image" | "audio",
    "media_path": "/path/to/file.mp3",
    "timestamp": "2026-03-27T09:00:00Z",
    "retry": 0,
    "status": "pending" | "sent" | "failed"
  }
]
```

---

## Error Handling

| Scenario              | Handling                             |
| --------------------- | ------------------------------------ |
| WhatsApp disconnected | Auto-reconnect, log error            |
| Invalid phone number  | Ignore, don't respond                |
| LLM timeout (60s)     | Return "I'm thinking..." placeholder |
| Queue write failure   | Retry 3 times, log to error file     |
| Message send failure  | Increment retry, max 3 attempts      |

---

## Session Management

```
First Run:
1. Generate QR code
2. User scans with WhatsApp
3. Save session to SESSION_PATH/creds.json
4. On subsequent runs, load existing session

Session File:
SESSION_PATH/
├── creds.json        # Baileys credentials
└── app.state.json    # App state cache
```

---

## Health Monitoring

Gateway writes status to `/queue/status/gateway.json`:

```json
{
  "name": "friday-gateway",
  "status": "running" | "error",
  "connected": true,
  "last_poll": "2026-03-27T09:00:00Z",
  "messages_sent_today": 42,
  "errors": []
}
```
