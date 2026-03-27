# WhatsApp Gateway Design

## Overview

The WhatsApp Gateway (`gateway.js`) is the primary interface for users to interact with Friday. It handles receiving and sending messages via WhatsApp using **@whiskeysockets/baileys** - a lightweight WebSocket-based library (not Puppeteer).

## PM2 Configuration

- **Process Name:** `friday-gateway`
- **File:** `core/gateway.js`
- **Restart Policy:** Restart on crash with 10s delay
- **Dependencies:** `npm install @whiskeysockets/baileys pino @hapi/boom`

---

## Core Responsibilities

### 1. WhatsApp Connection Management

- QR code authentication (first-time setup via terminal)
- Session persistence using `useMultiFileAuthState`
- Auto-reconnect on disconnect with proper error handling
- Connection health monitoring

### 2. Message Reception

- Listen for incoming messages from whitelist (`.env: ALLOWED_NUMBERS`)
- Extract message text, audio (voice notes), images
- Mark messages as read (blue checkmarks) using `readMessages()`
- Show "typing" status during processing
- Route to appropriate handler:
  - Text → LLM processing
  - Audio → MLX STT → LLM processing
  - Images → Process and send to LLM

### 3. Message Sending

- Poll `/queue/pending_messages.json` every 5 seconds
- Send WhatsApp messages (text, image, audio)
- Handle sending failures (retry up to 3 times)

### 4. Context Assembly

- Load user profile from `/users/[phone]/profile.json`
- Load memory from `/users/[phone]/memory.log` (JSONL)
- Combine with agent prompt for LLM request

---

## Implementation - gateway.js

```javascript
import makeWASocket, { 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion 
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import { appendMemory, getRecentContext } from './memory-manager.js';
import { processMessage } from './orchestrator.js';

// JID format: [phone]@s.whatsapp.net for user, [id]@g.us for groups
const GROUP_JID_SUFFIX = '@g.us';
const USER_JID_SUFFIX = '@s.whatsapp.net';

export class WhatsAppGateway {
    constructor() {
        this.sock = null;
        this.isReady = false;
    }

    async connect() {
        // 1. Setup Auth State (persistent session)
        const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
        const { version } = await fetchLatestBaileysVersion();

        // 2. Create socket
        this.sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: true,  // Shows QR in console
            logger: pino({ level: 'silent' }),
            browser: ["Friday Bot", "MacOS", "1.0.0"],
            markOnlineOnConnect: true
        });

        // 3. Handle connection updates
        this.sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect.error instanceof Boom)
                    ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                    : true;
                
                console.log('Connection closed. Reconnecting...', shouldReconnect);
                if (shouldReconnect) this.connect();
            } else if (connection === 'open') {
                console.log('✅ Friday is online on WhatsApp');
                this.isReady = true;
            }
        });

        // 4. Save credentials when updated
        this.sock.ev.on('creds.update', saveCreds);

        // 5. Handle incoming messages
        this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            for (const msg of messages) {
                if (!msg.message || msg.key.fromMe) continue;

                const jid = msg.key.remoteJid;
                const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

                if (!text) continue;

                console.log(`📩 New message from ${jid}: ${text}`);

                // Mark as read (blue checkmarks)
                await this.sock.readMessages([msg.key]);

                // Show typing indicator
                await this.sock.sendPresenceUpdate('composing', jid);

                // Save to JSONL memory
                appendMemory(jid, 'user', text);

                // Get AI response
                const response = await processMessage(jid, text);

                // Send response
                await this.sock.sendPresenceUpdate('paused', jid);
                await this.sock.sendMessage(jid, { text: response });

                // Save AI response to memory
                appendMemory(jid, 'assistant', response);
            }
        });

        return this.sock;
    }

    // Send message to user (called by queue poller)
    async sendMessage(jid, content, type = 'text') {
        if (!this.sock) throw new Error('WhatsApp not connected');

        const messageOptions = {};
        
        switch (type) {
            case 'image':
                messageOptions.image = { url: content };
                break;
            case 'audio':
                messageOptions.audio = { url: content };
                messageOptions.mimetype = 'audio/mp4';
                break;
            default:
                messageOptions.text = content;
        }

        await this.sock.sendMessage(jid, messageOptions);
    }

    // Get JID from phone number
    phoneToJid(phone) {
        return phone.replace(/\D/g, '') + USER_JID_SUFFIX;
    }

    // Extract phone from JID
    jidToPhone(jid) {
        return jid.split('@')[0];
    }
}
```

---

## Directory Structure

```
/core/
├── gateway.js           # Main gateway process (WhatsAppGateway class)
├── memory-manager.js    # JSONL append-only memory
├── orchestrator.js      # Message processing & LLM calls
├── auth_info_baileys/   # Session credentials (auto-created)
├── whatsapp/
│   ├── client.js       # (Legacy - now in gateway.js)
│   └── handlers/
│       └── message.js  # (Legacy - now in gateway.js)
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
│ Mark as Read   │ ─── sock.readMessages([msg.key])
│ (blue ticks)   │
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
│ Show Typing    │ ─── sendPresenceUpdate('composing')
│ indicator      │
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
│ Append Memory  │ ─── JSONL append (atomic)
│ (memory.log)  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Assemble       │ ─── profile + memory.log + current message
│ Context        │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Call Local LLM │ ─── qwen/qwen3.5-35b-a3b via LM Studio
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
SESSION_PATH=./auth_info_baileys

# LLM
AI_PROVIDER=lmstudio
AI_BASE_URL=http://localhost:1234/v1
CHAT_MODEL=qwen/qwen3.5-35b-a3b
```

---

## Installation

```bash
# In /core directory
npm install @whiskeysockets/baileys pino @hapi/boom
```

---

## JID Format

| Type | Format | Example |
|------|--------|---------|
| User | `[phone]@s.whatsapp.net` | `1234567890@s.whatsapp.net` |
| Group | `[id]@g.us` | `1234567890@g.us` |

Use `phoneToJid(phone)` and `jidToPhone(jid)` helpers for conversion.

---

## Message Features

### Mark as Read
```javascript
// Mark a message as read (blue checkmarks)
await sock.readMessages([msg.key]);
```

### Typing Indicator
```javascript
// Show "typing..." to user
await sock.sendPresenceUpdate('composing', jid);

// When done
await sock.sendPresenceUpdate('paused', jid);
```

### Send Different Message Types
```javascript
// Text
await sock.sendMessage(jid, { text: "Hello!" });

// Image with caption
await sock.sendMessage(jid, { image: { url: '...' }, caption: 'Description' });

// Audio (Voice note)
await sock.sendMessage(jid, { audio: { url: '...' }, mimetype: 'audio/mp4' });
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

| Scenario              | Handling                                                     |
| --------------------- | ------------------------------------------------------------ |
| WhatsApp disconnected | Auto-reconnect unless `DisconnectReason.loggedOut`         |
| Invalid phone number  | Ignore, don't respond                                        |
| LLM timeout (60s)     | Return "I'm thinking..." placeholder                         |
| Queue write failure   | Retry 3 times, log to error file                             |
| Message send failure  | Increment retry, max 3 attempts                             |
| Session expired      | Delete auth folder, require new QR scan                     |

### Reconnection Logic

```javascript
// Proper reconnection with loggedOut check
if (connection === 'close') {
    const shouldReconnect = (lastDisconnect.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
        : true;
    
    if (shouldReconnect) connectToWhatsApp();
    // Don't reconnect if user manually logged out from phone
}
```

---

## Session Management

```
First Run:
1. QR code displays in terminal
2. User scans with WhatsApp → Linked Devices
3. Credentials auto-saved to ./auth_info_baileys/
4. On subsequent runs, load from same folder

Session Directory (auto-created):
./auth_info_baileys/
├── creds.json        # Baileys credentials (encrypted)
├── appState.json     # App state cache
└── ...               # Other session files
```

**Key Point:** Don't manually create this folder - `useMultiFileAuthState` creates it automatically.

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
