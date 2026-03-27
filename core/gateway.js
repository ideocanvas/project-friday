/**
 * Friday Gateway - WhatsApp Message Handler
 * 
 * This is the primary interface for users to interact with Friday.
 * Handles receiving and sending messages via WhatsApp using Baileys.
 */

import makeWASocket, { 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion 
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const ALLOWED_NUMBERS = (process.env.ALILED_NUMBERS || '').split(',').map(n => n.trim()).filter(Boolean);
const USER_DATA_ROOT = process.env.USER_DATA_ROOT || './users';
const QUEUE_PATH = process.env.QUEUE_PATH || './queue';
const SESSION_PATH = process.env.SESSION_PATH || './auth_info_baileys';

// Logger
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

/**
 * WhatsApp Gateway Class
 */
class WhatsAppGateway {
    constructor() {
        this.sock = null;
        this.isReady = false;
    }

    /**
     * Connect to WhatsApp
     */
    async connect() {
        // Setup Auth State (persistent session)
        const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
        const { version } = await fetchLatestBaileysVersion();

        // Create socket
        this.sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: true,  // Shows QR in console
            logger: pino({ level: 'silent' }),
            browser: ['Friday Bot', 'MacOS', '1.0.0'],
            markOnlineOnConnect: true
        });

        // Handle connection updates
        this.sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect.error instanceof Boom)
                    ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                    : true;
                
                logger.info('Connection closed. Reconnecting...', shouldReconnect);
                if (shouldReconnect) this.connect();
            } else if (connection === 'open') {
                logger.info('✅ Friday is online on WhatsApp');
                this.isReady = true;
                this.updateStatus('running');
            }
        });

        // Save credentials when updated
        this.sock.ev.on('creds.update', saveCreds);

        // Handle incoming messages
        this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            for (const msg of messages) {
                if (!msg.message || msg.key.fromMe) continue;

                const jid = msg.key.remoteJid;
                const phone = this.jidToPhone(jid);
                
                // Check whitelist
                if (ALLOWED_NUMBERS.length > 0 && !ALLOWED_NUMBERS.includes(phone)) {
                    logger.debug(`Ignoring message from ${phone} (not in whitelist)`);
                    continue;
                }

                const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
                if (!text) continue;

                logger.info(`📩 New message from ${jid}: ${text}`);

                // Mark as read (blue checkmarks)
                await this.sock.readMessages([msg.key]);

                // Show typing indicator
                await this.sock.sendPresenceUpdate('composing', jid);

                try {
                    // Process message
                    const response = await this.processMessage(jid, text);
                    
                    // Send response
                    await this.sock.sendPresenceUpdate('paused', jid);
                    await this.sock.sendMessage(jid, { text: response });

                    // Save to memory
                    this.appendMemory(jid, 'assistant', response);
                } catch (error) {
                    logger.error('Error processing message:', error);
                    await this.sock.sendMessage(jid, { text: 'Sorry, I encountered an error. Please try again.' });
                }
            }
        });

        // Start queue poller
        this.startQueuePoller();

        return this.sock;
    }

    /**
     * Process incoming message
     */
    async processMessage(jid, text) {
        // TODO: Implement full message processing
        // 1. Load user profile
        // 2. Load recent memory
        // 3. Check for skill triggers
        // 4. Call Local LLM
        // 5. Return response
        
        // For now, return a simple response
        this.appendMemory(jid, 'user', text);
        return `I received your message: "${text}". Full processing coming soon!`;
    }

    /**
     * Append to JSONL memory
     */
    appendMemory(jid, role, content) {
        const phone = this.jidToPhone(jid);
        const userDir = path.join(USER_DATA_ROOT, phone);
        
        if (!fs.existsSync(userDir)) {
            fs.mkdirSync(userDir, { recursive: true });
        }
        
        const memoryPath = path.join(userDir, 'memory.log');
        const entry = JSON.stringify({
            timestamp: new Date().toISOString(),
            role: role,
            content: content
        }) + '\n';
        
        fs.appendFileSync(memoryPath, entry, 'utf8');
    }

    /**
     * Get recent context from memory
     */
    getRecentContext(jid, limit = 10) {
        const phone = this.jidToPhone(jid);
        const memoryPath = path.join(USER_DATA_ROOT, phone, 'memory.log');
        
        if (!fs.existsSync(memoryPath)) return [];
        
        const lines = fs.readFileSync(memoryPath, 'utf8').trim().split('\n');
        return lines.slice(-limit).map(line => {
            try {
                return JSON.parse(line);
            } catch {
                return null;
            }
        }).filter(Boolean);
    }

    /**
     * Start polling for outgoing messages
     */
    startQueuePoller() {
        setInterval(() => {
            this.pollQueue();
        }, 5000); // Poll every 5 seconds
    }

    /**
     * Poll pending messages queue
     */
    pollQueue() {
        const queueFile = path.join(QUEUE_PATH, 'pending_messages.json');
        
        if (!fs.existsSync(queueFile)) return;
        
        try {
            const messages = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
            const pending = messages.filter(m => m.status === 'pending');
            
            for (const msg of pending) {
                this.sendQueuedMessage(msg);
            }
        } catch (error) {
            logger.error('Error polling queue:', error);
        }
    }

    /**
     * Send queued message
     */
    async sendQueuedMessage(msg) {
        if (!this.isReady) return;
        
        const jid = this.phoneToJid(msg.to);
        
        try {
            await this.sock.sendMessage(jid, { text: msg.message });
            logger.info(`✅ Sent queued message to ${msg.to}`);
            
            // Mark as sent
            this.updateQueueMessageStatus(msg.id, 'sent');
        } catch (error) {
            logger.error(`Failed to send message to ${msg.to}:`, error);
            
            // Increment retry
            const retries = (msg.retry || 0) + 1;
            if (retries >= 3) {
                this.updateQueueMessageStatus(msg.id, 'failed');
            } else {
                this.updateQueueMessageRetry(msg.id, retries);
            }
        }
    }

    /**
     * Update queue message status
     */
    updateQueueMessageStatus(id, status) {
        const queueFile = path.join(QUEUE_PATH, 'pending_messages.json');
        const messages = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
        const idx = messages.findIndex(m => m.id === id);
        if (idx !== -1) {
            messages[idx].status = status;
            fs.writeFileSync(queueFile, JSON.stringify(messages, null, 2));
        }
    }

    /**
     * Update queue message retry count
     */
    updateQueueMessageRetry(id, retry) {
        const queueFile = path.join(QUEUE_PATH, 'pending_messages.json');
        const messages = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
        const idx = messages.findIndex(m => m.id === id);
        if (idx !== -1) {
            messages[idx].retry = retry;
            fs.writeFileSync(queueFile, JSON.stringify(messages, null, 2));
        }
    }

    /**
     * Convert phone number to JID
     */
    phoneToJid(phone) {
        return phone.replace(/\D/g, '') + '@s.whatsapp.net';
    }

    /**
     * Extract phone from JID
     */
    jidToPhone(jid) {
        return jid.split('@')[0];
    }

    /**
     * Update process status
     */
    updateStatus(status) {
        const statusFile = path.join(QUEUE_PATH, 'status.json');
        const statusData = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
        statusData['friday-gateway'] = {
            ...statusData['friday-gateway'],
            status: status,
            uptime: new Date().toISOString(),
            last_error: null
        };
        fs.writeFileSync(statusFile, JSON.stringify(statusData, null, 2));
    }
}

// Start the gateway
async function main() {
    const gateway = new WhatsAppGateway();
    
    try {
        await gateway.connect();
    } catch (error) {
        logger.error('Failed to start gateway:', error);
        process.exit(1);
    }
}

main();