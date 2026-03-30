/**
 * Friday Gateway - WhatsApp Message Handler
 *
 * This is the primary interface for users to interact with Friday.
 * Handles receiving and sending messages via WhatsApp using Baileys.
 */

import {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeWASocket
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import { processMessage as processWithLLM, processWithCustomPrompt, loadRecentMemory } from './message-processor.js';
import { processSkillAction } from './skill-executor.js';
import { loadUserProfile } from './message-processor.js';
import qrcode from 'qrcode-terminal';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const ALLOWED_NUMBERS: string[] = (process.env.ALILED_NUMBERS || '').split(',').map((n: string) => n.trim()).filter(Boolean);
const USER_DATA_ROOT = process.env.USER_DATA_ROOT || './users';
const QUEUE_PATH = process.env.QUEUE_PATH || './queue';
const SESSION_PATH = process.env.SESSION_PATH || './auth_info_baileys';

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

                const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
                if (!text) continue;

                logger.info(`📩 New message from ${jid}: ${text}`);

                // Mark as read (blue checkmarks)
                await this.sock.readMessages([msg.key]);

                // Show typing indicator
                await this.sock.sendPresenceUpdate('composing', jid);

                try {
                    // Process message (memory is saved inside processMessage)
                    const response = await this.processMessage(jid, text);
                    
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
     * Process incoming message using LLM
     */
    async processMessage(jid: string, text: string): Promise<string> {
        const phone = this.jidToPhone(jid);
        
        // Save user message to memory
        this.appendMemory(jid, 'user', text);
        
        try {
            // Process message with LLM
            const result = await processWithLLM(phone, text);
            
            if (result.success && result.response) {
                // Check if response contains a skill action
                const skillResult = await processSkillAction(result.response, phone);
                
                if (skillResult.skillExecuted) {
                    // Skill was executed - send result back to LLM for natural language response
                    const finalResponse = await this.processSkillResultWithLLM(phone, text, skillResult.response, skillResult.skillResult);
                    
                    // Save final response to memory
                    this.appendMemory(jid, 'assistant', finalResponse);
                    return finalResponse;
                }
                
                // Save assistant response to memory
                this.appendMemory(jid, 'assistant', result.response);
                return result.response;
            } else {
                logger.error({ error: result.error }, 'LLM processing failed');
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
     * Process skill result with LLM to generate natural language response
     */
    async processSkillResultWithLLM(phone: string, originalQuery: string, skillResultMessage: string, skillResultData?: { success: boolean; data?: Record<string, unknown> }): Promise<string> {
        try {
            // Load user profile for context
            const userProfile = loadUserProfile(phone);
            const userName = userProfile?.name || 'there';
            
            // Get current date and time
            const now = new Date();
            const currentDate = now.toLocaleDateString('en-US', { 
                weekday: 'long', 
                year: 'numeric', 
                month: 'long', 
                day: 'numeric' 
            });
            const userTimezone = userProfile?.timezone || 'Asia/Hong_Kong';
            
            // Extract actual search data if available
            let searchResultsContext = skillResultMessage;
            if (skillResultData?.data?.results && Array.isArray(skillResultData.data.results)) {
                // Format the search results in a cleaner way for the LLM
                const results = skillResultData.data.results as Array<{ title?: string; url?: string; snippet?: string }>;
                const formattedResults = results.slice(0, 5).map((r, i) => 
                    `${i + 1}. ${r.title || 'Untitled'}\n   ${r.snippet || 'No description'}\n   Source: ${r.url || 'Unknown'}`
                ).join('\n\n');
                searchResultsContext = `Found ${results.length} results for "${originalQuery}":\n\n${formattedResults}`;
            }
            
            // Build a prompt for the LLM to process the skill results
            const systemPrompt = `You are Friday, a helpful AI assistant. You just searched for information to help answer the user's question.

The user's name is ${userName}.

## Current Date

Today's date is ${currentDate}.
When answering questions about "today", "now", or current events, use this date as reference.
If the search results contain outdated information, acknowledge this and provide the most relevant current information.

## Response Guidelines

IMPORTANT: You must respond in plain, natural language. Do NOT return JSON. Do NOT return the raw search results. 
Your response should be a friendly, conversational answer that synthesizes the information from the search results.

- Answer the user's question directly and helpfully
- Summarize the key information from the search results in your own words
- Be concise but informative (2-4 sentences is usually enough)
- If the search results don't fully answer the question, acknowledge this
- Always respond as if you're having a conversation, not reading a list
- Never include URLs or technical formatting in your response unless specifically asked

User's question: "${originalQuery}"

Search results:
${searchResultsContext}

Provide a helpful, conversational response:`;

            // Call LLM with the skill results (no history needed for this synthesis task)
            const response = await processWithCustomPrompt(
                systemPrompt,
                [], // No history needed - we just want to synthesize the search results
                `Please answer my question based on the search results.`,
                { temperature: 0.7, maxTokens: 512 }
            );
            
            if (response.success && response.response) {
                // Check if the response looks like JSON (which would indicate an error)
                const trimmedResponse = response.response.trim();
                if (trimmedResponse.startsWith('{') && trimmedResponse.includes('"success"')) {
                    // LLM returned JSON instead of natural language - this shouldn't happen
                    // but if it does, provide a fallback
                    logger.warn('LLM returned JSON instead of natural language, providing fallback response');
                    return this.generateFallbackResponse(originalQuery, skillResultMessage);
                }
                logger.info('Successfully processed skill result with LLM');
                return trimmedResponse;
            } else {
                // Fallback to a generated response
                logger.warn('LLM processing of skill result failed, generating fallback response');
                return this.generateFallbackResponse(originalQuery, skillResultMessage);
            }
        } catch (error) {
            logger.error('Error processing skill result with LLM:', error);
            // Fallback to a generated response
            return this.generateFallbackResponse(originalQuery, skillResultMessage);
        }
    }

    /**
     * Generate a fallback response when LLM processing fails
     */
    generateFallbackResponse(originalQuery: string, skillResultMessage: string): string {
        // Extract key information from the search results
        const lines = skillResultMessage.split('\n').filter(line => line.trim());
        
        // Find the query and result count
        const queryMatch = skillResultMessage.match(/Found \d+ results for "([^"]+)"/);
        const query = queryMatch ? queryMatch[1] : originalQuery;
        
        // Extract the first few result titles
        const titles: string[] = [];
        for (const line of lines) {
            const titleMatch = line.match(/^\d+\.\s+\*\*(.+?)\*\*/);
            if (titleMatch && titleMatch[1] && titles.length < 3) {
                titles.push(titleMatch[1]);
            }
        }
        
        if (titles.length > 0) {
            return `I found some information about "${query}". Here are the top results:\n\n${titles.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\nWould you like me to look up more specific information?`;
        }
        
        return `I searched for "${query}" but couldn't find clear results. Could you try rephrasing your question?`;
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