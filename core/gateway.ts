/**
 * Friday Gateway - WhatsApp Message Handler
 *
 * This is the primary interface for users to interact with Friday.
 * Handles receiving and sending messages via WhatsApp using Baileys.
 * Supports text, voice, and image messages.
 * 
 * All message types flow through the same agent loop:
 *   LLM → tool call → execute → feed result → LLM → ... → text response
 * No more hardcoded skill execution flows.
 */

import {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeWASocket,
    downloadMediaMessage
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import { processMessage as processWithLLM, loadRecentMemory } from './message-processor.js';
import { executeSkill } from './skill-executor.js';
import qrcode from 'qrcode-terminal';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const ALLOWED_NUMBERS: string[] = (process.env.ALILED_NUMBERS || '').split(',').map((n: string) => n.trim()).filter(Boolean);
const USER_DATA_ROOT = process.env.USER_DATA_ROOT || './users';
const QUEUE_PATH = process.env.QUEUE_PATH || './queue';
const SESSION_PATH = process.env.SESSION_PATH || './auth_info_baileys';
const TEMP_MEDIA_PATH = process.env.TEMP_MEDIA_PATH || '/tmp/friday/media';

// Logger
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Type definitions
interface MemoryEntry {
    timestamp: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
}

interface QueuedMessage {
    id: string;
    to: string;
    message: string;
    type: 'text' | 'image' | 'audio';
    timestamp: string;
    retry: number;
    status: 'pending' | 'sent' | 'failed';
}

interface StatusData {
    'friday-gateway': {
        status: string;
        uptime: string;
        last_error: string | null;
    };
    'friday-scheduler'?: {
        status: string;
        uptime: string;
        last_check: string;
    };
    'friday-janitor'?: {
        status: string;
        uptime: string;
        last_run: string;
        pages_deleted: number;
    };
}

/**
 * WhatsApp Gateway Class
 */
class WhatsAppGateway {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private sock: any = null;
    private isReady: boolean = false;
    // Track processed messages to prevent duplicates
    private processedMessages: Set<string> = new Set();
    private readonly MAX_PROCESSED_CACHE = 1000; // Keep last 1000 message IDs

    /**
     * Connect to WhatsApp
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async connect(): Promise<any> {
        // Setup Auth State (persistent session)
        const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
        const { version } = await fetchLatestBaileysVersion();

        // Create socket
        this.sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: ['Friday Bot', 'MacOS', '1.0.0'],
            markOnlineOnConnect: true
        });

        // Handle connection updates
        this.sock.ev.on('connection.update', (update: { connection?: string; lastDisconnect?: { error?: Error }; qr?: string }) => {
            const { connection, lastDisconnect, qr } = update;
            
            // Handle QR code for authentication
            if (qr) {
                logger.info('📱 Scan the QR code below with WhatsApp to authenticate:');
                console.log('\n');
                qrcode.generate(qr, { small: true });
                console.log('\n');
            }
            
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error instanceof Boom)
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
        this.sock.ev.on('messages.upsert', async ({ messages, type }: { messages: any[]; type: string }) => {
            if (type !== 'notify') return;

            for (const msg of messages) {
                if (!msg.message || msg.key.fromMe) continue;

                // Skip already processed messages (deduplication)
                const messageId = msg.key.id;
                if (messageId && this.processedMessages.has(messageId)) {
                    logger.debug(`Skipping duplicate message: ${messageId}`);
                    continue;
                }
                
                // Track processed message
                if (messageId) {
                    this.processedMessages.add(messageId);
                    // Clean up old messages to prevent memory leak
                    if (this.processedMessages.size > this.MAX_PROCESSED_CACHE) {
                        const firstItem = this.processedMessages.values().next().value;
                        if (firstItem) this.processedMessages.delete(firstItem);
                    }
                }

                const jid = msg.key.remoteJid;
                if (!jid) continue;
                
                const phone = this.jidToPhone(jid);
                
                // Check whitelist
                if (ALLOWED_NUMBERS.length > 0 && !ALLOWED_NUMBERS.includes(phone)) {
                    logger.debug(`Ignoring message from ${phone} (not in whitelist)`);
                    continue;
                }

                // Determine message type and extract content
                const messageType = this.getMessageType(msg.message);
                
                try {
                    let response: string;
                    
                    if (messageType === 'text') {
                        // Handle text message
                        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
                        if (!text) continue;
                        
                        logger.info(`📩 New text message from ${jid}: ${text}`);
                        await this.sock.readMessages([msg.key]);
                        await this.sock.sendPresenceUpdate('composing', jid);
                        
                        response = await this.processMessage(jid, text);
                    } else if (messageType === 'audio') {
                        // Handle voice/audio message
                        logger.info(`🎤 New voice message from ${jid}`);
                        await this.sock.readMessages([msg.key]);
                        await this.sock.sendPresenceUpdate('composing', jid);
                        
                        response = await this.handleAudioMessage(jid, msg);
                    } else if (messageType === 'image') {
                        // Handle image message
                        const caption = msg.message.imageMessage?.caption || '';
                        logger.info(`🖼️ New image message from ${jid}${caption ? ` with caption: ${caption}` : ''}`);
                        await this.sock.readMessages([msg.key]);
                        await this.sock.sendPresenceUpdate('composing', jid);
                        
                        response = await this.handleImageMessage(jid, msg, caption);
                    } else {
                        // Unsupported message type
                        logger.debug(`Ignoring unsupported message type: ${messageType}`);
                        continue;
                    }
                    
                    // Send response
                    await this.sock.sendPresenceUpdate('paused', jid);
                    await this.sock.sendMessage(jid, { text: response });
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
     * Process incoming message using the agent loop.
     * All message types (text, transcribed audio, image context) end up here.
     *
     * If the message is triaged as a background task, returns an immediate
     * acknowledgment. The background task will push its final result to the
     * pending_messages queue when done.
     */
    async processMessage(jid: string, text: string): Promise<string> {
        const phone = this.jidToPhone(jid);
        
        // Save user message to memory
        this.appendMemory(jid, 'user', text);
        
        try {
            // Process message with agent loop (may triage to background)
            const result = await processWithLLM(phone, text, { jid });
            
            if (result.success && result.response) {
                // Save assistant response to memory
                this.appendMemory(jid, 'assistant', result.response);
                
                // If this was dispatched as a background task, log it
                if (result.backgrounded && result.taskId) {
                    logger.info({ taskId: result.taskId }, 'Message dispatched as background task');
                }
                
                return result.response;
            } else {
                logger.error({ error: result.error }, 'Agent loop processing failed');
                const fallbackResponse = "I'm sorry, I couldn't process your request. Please try again.";
                this.appendMemory(jid, 'assistant', fallbackResponse);
                return fallbackResponse;
            }
        } catch (error) {
            logger.error('Error in message processing:', error);
            const errorResponse = "I'm sorry, something went wrong. Please try again later.";
            this.appendMemory(jid, 'assistant', errorResponse);
            return errorResponse;
        }
    }

    /**
     * Determine the type of message
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getMessageType(message: any): 'text' | 'audio' | 'image' | 'video' | 'document' | 'unknown' {
        if (message.conversation || message.extendedTextMessage?.text) {
            return 'text';
        }
        if (message.audioMessage) {
            return 'audio';
        }
        if (message.imageMessage) {
            return 'image';
        }
        if (message.videoMessage) {
            return 'video';
        }
        if (message.documentMessage) {
            return 'document';
        }
        return 'unknown';
    }

    /**
     * Handle audio/voice message
     * Downloads audio, transcribes it, then feeds the transcription through
     * the same processMessage flow as text.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async handleAudioMessage(jid: string, msg: any): Promise<string> {
        try {
            // Download the audio file
            const audioPath = await this.downloadMedia(msg, 'audio');
            if (!audioPath) {
                return "I couldn't download the voice message. Please try again.";
            }

            logger.info(`Audio downloaded to: ${audioPath}`);

            // Transcribe using the voice skill directly
            const transcription = await this.transcribeAudio(audioPath);
            
            if (!transcription) {
                return "I couldn't transcribe the voice message. Please try again.";
            }

            logger.info(`Transcribed text: ${transcription}`);

            // Feed transcription through the normal message flow
            // The agent loop will handle any tool calls the LLM decides to make
            return await this.processMessage(jid, `[Voice] ${transcription}`);
        } catch (error) {
            logger.error('Error handling audio message:', error);
            return "Sorry, I encountered an error processing your voice message.";
        }
    }

    /**
     * Handle image message
     * Downloads image, then feeds image context through the same processMessage flow.
     * The LLM will use the vision skill via tool calling if needed.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async handleImageMessage(jid: string, msg: any, caption: string): Promise<string> {
        try {
            // Download the image file
            const imagePath = await this.downloadMedia(msg, 'image');
            if (!imagePath) {
                return "I couldn't download the image. Please try again.";
            }

            logger.info(`Image downloaded to: ${imagePath}`);

            // Build message with image context
            // The LLM will decide whether to use the vision skill based on the conversation
            const userMessage = caption
                ? `[User sent an image with caption: "${caption}"]\nImage saved at: ${imagePath}`
                : `[User sent an image]\nImage saved at: ${imagePath}`;

            // Feed through the normal message flow
            // Don't save to memory before processMessage — loadRecentMemory() strips trailing user messages
            const phone = this.jidToPhone(jid);
            const result = await processWithLLM(phone, userMessage, { jid });
            
            if (result.success && result.response) {
                // Save the caption/image reference to memory after processing
                this.appendMemory(jid, 'user', caption || '[Image]');
                this.appendMemory(jid, 'assistant', result.response);
                return result.response;
            }
            
            return "I couldn't process your image. Please try again.";
        } catch (error) {
            logger.error('Error handling image message:', error);
            return "Sorry, I encountered an error processing your image.";
        }
    }

    /**
     * Transcribe audio using the voice skill directly
     */
    async transcribeAudio(audioPath: string): Promise<string | null> {
        try {
            const result = await executeSkill('voice', { action: 'transcribe', audio_path: audioPath }, 'system');
            
            if (result.success && result.data?.text) {
                return result.data.text as string;
            }
            
            logger.error(`Transcription failed: ${result.message}`);
            return null;
        } catch (error) {
            logger.error('Error transcribing audio:', error);
            return null;
        }
    }

    /**
     * Download media from WhatsApp
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async downloadMedia(msg: any, mediaType: 'audio' | 'image' | 'video' | 'document'): Promise<string | null> {
        try {
            // Ensure temp directory exists
            if (!fs.existsSync(TEMP_MEDIA_PATH)) {
                fs.mkdirSync(TEMP_MEDIA_PATH, { recursive: true });
            }

            // Generate unique filename
            const timestamp = Date.now();
            const randomId = Math.random().toString(36).substring(7);
            
            // Get mime type and determine extension
            let extension = 'bin';
            let mimeType = '';
            
            if (mediaType === 'audio' && msg.message?.audioMessage) {
                mimeType = msg.message.audioMessage.mimetype || 'audio/ogg';
                extension = this.getExtensionFromMime(mimeType);
            } else if (mediaType === 'image' && msg.message?.imageMessage) {
                mimeType = msg.message.imageMessage.mimetype || 'image/jpeg';
                extension = this.getExtensionFromMime(mimeType);
            }

            const filename = `${mediaType}_${timestamp}_${randomId}.${extension}`;
            const filepath = path.join(TEMP_MEDIA_PATH, filename);

            // Download the media using Baileys downloadMediaMessage function
            const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger });
            
            // Write to file
            fs.writeFileSync(filepath, buffer);
            
            logger.info(`Downloaded ${mediaType} to ${filepath}`);
            return filepath;
        } catch (error) {
            logger.error({ error, mediaType }, 'Error downloading media');
            return null;
        }
    }

    /**
     * Get file extension from MIME type
     */
    getExtensionFromMime(mimeType: string): string {
        const mimeMap: Record<string, string> = {
            'audio/ogg': 'ogg',
            'audio/oga': 'oga',
            'audio/mp3': 'mp3',
            'audio/mpeg': 'mp3',
            'audio/mp4': 'm4a',
            'audio/m4a': 'm4a',
            'audio/wav': 'wav',
            'audio/webm': 'webm',
            'image/jpeg': 'jpg',
            'image/jpg': 'jpg',
            'image/png': 'png',
            'image/gif': 'gif',
            'image/webp': 'webp',
            'video/mp4': 'mp4',
            'video/webm': 'webm',
            'application/pdf': 'pdf'
        };
        return mimeMap[mimeType] || 'bin';
    }

    /**
     * Append to JSONL memory
     */
    appendMemory(jid: string, role: 'user' | 'assistant' | 'system', content: string): void {
        const phone = this.jidToPhone(jid);
        const userDir = path.join(USER_DATA_ROOT, phone);
        
        if (!fs.existsSync(userDir)) {
            fs.mkdirSync(userDir, { recursive: true });
        }
        
        const memoryPath = path.join(userDir, 'memory.log');
        const entry: MemoryEntry = {
            timestamp: new Date().toISOString(),
            role: role,
            content: content
        };
        
        fs.appendFileSync(memoryPath, JSON.stringify(entry) + '\n', 'utf8');
    }

    /**
     * Get recent context from memory
     */
    getRecentContext(jid: string, limit: number = 10): MemoryEntry[] {
        const phone = this.jidToPhone(jid);
        const memoryPath = path.join(USER_DATA_ROOT, phone, 'memory.log');
        
        if (!fs.existsSync(memoryPath)) return [];
        
        const lines = fs.readFileSync(memoryPath, 'utf8').trim().split('\n');
        return lines.slice(-limit).map((line: string) => {
            try {
                return JSON.parse(line) as MemoryEntry;
            } catch {
                return null;
            }
        }).filter((entry): entry is MemoryEntry => entry !== null);
    }

    /**
     * Start polling for outgoing messages
     */
    startQueuePoller(): void {
        setInterval(() => {
            this.pollQueue();
        }, 5000); // Poll every 5 seconds
    }

    /**
     * Poll pending messages queue
     */
    pollQueue(): void {
        const queueFile = path.join(QUEUE_PATH, 'pending_messages.json');
        
        if (!fs.existsSync(queueFile)) return;
        
        try {
            const messages: QueuedMessage[] = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
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
    async sendQueuedMessage(msg: QueuedMessage): Promise<void> {
        if (!this.isReady || !this.sock) return;
        
        // Use the exact JID if it contains '@', otherwise fall back to string manipulation
        const jid = msg.to.includes('@') ? msg.to : this.phoneToJid(msg.to);
        
        try {
            await this.sock.sendMessage(jid, { text: msg.message });
            logger.info(`✅ Sent queued message to ${msg.to}`);
            
            // Mark as sent
            this.updateQueueMessageStatus(msg.id, 'sent');
            
            // Remember giving this response!
            this.appendMemory(jid, 'assistant', msg.message);
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
    updateQueueMessageStatus(id: string, status: 'pending' | 'sent' | 'failed'): void {
        const queueFile = path.join(QUEUE_PATH, 'pending_messages.json');
        const messages: QueuedMessage[] = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
        const idx = messages.findIndex(m => m.id === id);
        if (idx !== -1 && messages[idx]) {
            messages[idx].status = status;
            fs.writeFileSync(queueFile, JSON.stringify(messages, null, 2));
        }
    }

    /**
     * Update queue message retry count
     */
    updateQueueMessageRetry(id: string, retry: number): void {
        const queueFile = path.join(QUEUE_PATH, 'pending_messages.json');
        const messages: QueuedMessage[] = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
        const idx = messages.findIndex(m => m.id === id);
        if (idx !== -1 && messages[idx]) {
            messages[idx].retry = retry;
            fs.writeFileSync(queueFile, JSON.stringify(messages, null, 2));
        }
    }

    /**
     * Convert phone number to JID
     */
    phoneToJid(phone: string): string {
        return phone.replace(/\D/g, '') + '@s.whatsapp.net';
    }

    /**
     * Extract phone from JID
     */
    jidToPhone(jid: string): string {
        return jid.split('@')[0] || '';
    }

    /**
     * Update process status
     */
    updateStatus(status: string): void {
        const statusFile = path.join(QUEUE_PATH, 'status.json');
        const statusData: StatusData = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
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
async function main(): Promise<void> {
    const gateway = new WhatsAppGateway();
    
    try {
        await gateway.connect();
    } catch (error) {
        logger.error('Failed to start gateway:', error);
        console.error('Full error details:', error);
        process.exit(1);
    }
}

main();
