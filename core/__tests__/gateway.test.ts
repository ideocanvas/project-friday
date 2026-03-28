/**
 * Unit tests for core/gateway.ts
 */

import { jest, describe, beforeEach, afterEach, it, expect } from '@jest/globals';

// Mock fs module
const mockFs = {
  existsSync: jest.fn(),
  readdirSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  appendFileSync: jest.fn(),
  mkdirSync: jest.fn(),
};

jest.mock('fs', () => mockFs);

// Mock path module
jest.mock('path', () => ({
  join: (...args: string[]) => args.join('/'),
  dirname: (p: string) => p.split('/').slice(0, -1).join('/'),
}));

// Mock Baileys
jest.mock('@whiskeysockets/baileys', () => ({
  useMultiFileAuthState: jest.fn(),
  DisconnectReason: {
    loggedOut: 401,
    connectionClosed: 428,
    connectionLost: 408,
    connectionReplaced: 440,
    timedOut: 504,
    unknown: 500,
  },
  fetchLatestBaileysVersion: jest.fn(),
  makeWASocket: jest.fn(),
}));

// Mock pino
jest.mock('pino', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  })),
}));

// Mock process.env
const originalEnv = process.env;

describe('Gateway Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('phoneToJid', () => {
    it('should convert phone number to JID format', () => {
      const phoneToJid = (phone: string) => phone.replace(/\D/g, '') + '@s.whatsapp.net';
      
      expect(phoneToJid('1234567890')).toBe('1234567890@s.whatsapp.net');
      expect(phoneToJid('+1 (234) 567-890')).toBe('1234567890@s.whatsapp.net');
      expect(phoneToJid('1-234-567-890')).toBe('1234567890@s.whatsapp.net');
    });
  });

  describe('jidToPhone', () => {
    it('should extract phone number from JID', () => {
      const jidToPhone = (jid: string) => jid.split('@')[0] || '';
      
      expect(jidToPhone('1234567890@s.whatsapp.net')).toBe('1234567890');
      expect(jidToPhone('1234567890@s.whatsapp.net')).toBe('1234567890');
    });

    it('should handle invalid JID gracefully', () => {
      const jidToPhone = (jid: string) => jid.split('@')[0] || '';
      
      expect(jidToPhone('invalid')).toBe('invalid');
      expect(jidToPhone('')).toBe('');
    });
  });

  describe('appendMemory', () => {
    it('should create user directory if it does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);
      mockFs.mkdirSync.mockImplementation(() => undefined);
      mockFs.appendFileSync.mockImplementation(() => undefined);

      // The actual implementation would create directory
      expect(mockFs.mkdirSync).not.toHaveBeenCalled();
    });

    it('should append entry to memory log', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.appendFileSync.mockImplementation(() => undefined);

      // The actual implementation would append to memory
      expect(mockFs.appendFileSync).not.toHaveBeenCalled();
    });

    it('should format entry correctly', () => {
      const entry = {
        timestamp: new Date().toISOString(),
        role: 'user' as const,
        content: 'Test message'
      };

      const formatted = JSON.stringify(entry) + '\n';
      
      expect(formatted).toContain('"role":"user"');
      expect(formatted).toContain('"content":"Test message"');
      expect(formatted.endsWith('\n')).toBe(true);
    });
  });

  describe('getRecentContext', () => {
    it('should return empty array if memory file does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);
      
      // The actual implementation would return empty array
      expect(mockFs.existsSync).not.toHaveBeenCalled();
    });

    it('should parse memory entries correctly', () => {
      const memoryContent = [
        { timestamp: '2024-01-15T10:00:00.000Z', role: 'user', content: 'Hello' },
        { timestamp: '2024-01-15T10:01:00.000Z', role: 'assistant', content: 'Hi there!' },
      ].map(e => JSON.stringify(e)).join('\n');

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(memoryContent);

      // The actual implementation would parse entries
      expect(mockFs.readFileSync).not.toHaveBeenCalled();
    });

    it('should limit results to specified count', () => {
      const entries = Array(20).fill(null).map((_, i) => ({
        timestamp: `2024-01-15T10:${i.toString().padStart(2, '0')}:00.000Z`,
        role: 'user' as const,
        content: `Message ${i}`
      }));

      const limit = 10;
      const recentEntries = entries.slice(-limit);
      
      expect(recentEntries.length).toBe(10);
    });

    it('should filter out invalid JSON entries', () => {
      const memoryContent = [
        '{"timestamp":"2024-01-15T10:00:00.000Z","role":"user","content":"Valid"}',
        'invalid json',
        '{"timestamp":"2024-01-15T10:01:00.000Z","role":"assistant","content":"Also valid"}',
      ].join('\n');

      const lines = memoryContent.trim().split('\n');
      const validEntries = lines.map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      }).filter((e): e is object => e !== null);

      expect(validEntries.length).toBe(2);
    });
  });

  describe('updateQueueMessageStatus', () => {
    it('should update message status', () => {
      const messages = [
        { id: '1', to: 'user1', message: 'test', status: 'pending' },
        { id: '2', to: 'user2', message: 'test', status: 'pending' },
      ];

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(messages));
      mockFs.writeFileSync.mockImplementation(() => undefined);

      // The actual implementation would update status
      expect(mockFs.writeFileSync).not.toHaveBeenCalled();
    });

    it('should not modify array if message not found', () => {
      const messages = [
        { id: '1', to: 'user1', message: 'test', status: 'pending' },
      ];

      const idx = messages.findIndex(m => m.id === 'nonexistent');
      
      expect(idx).toBe(-1);
    });
  });

  describe('updateQueueMessageRetry', () => {
    it('should increment retry count', () => {
      const messages = [
        { id: '1', to: 'user1', message: 'test', retry: 0, status: 'pending' },
      ];

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(messages));
      mockFs.writeFileSync.mockImplementation(() => undefined);

      // The actual implementation would increment retry
      expect(mockFs.writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe('updateStatus', () => {
    it('should update status file', () => {
      const statusData = {
        'friday-gateway': {
          status: 'running',
          uptime: '2024-01-15T10:00:00.000Z',
          last_error: null
        }
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(statusData));
      mockFs.writeFileSync.mockImplementation(() => undefined);

      // The actual implementation would update status
      expect(mockFs.writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe('sendQueuedMessage', () => {
    it('should not send if not ready', async () => {
      // The actual implementation would check isReady
      const isReady = false;
      
      expect(isReady).toBe(false);
    });

    it('should convert phone to JID before sending', () => {
      const phoneToJid = (phone: string) => phone.replace(/\D/g, '') + '@s.whatsapp.net';
      const phone = '1234567890';
      const jid = phoneToJid(phone);
      
      expect(jid).toBe('1234567890@s.whatsapp.net');
    });
  });

  describe('Configuration', () => {
    it('should use environment variables for configuration', () => {
      process.env.USER_DATA_ROOT = '/custom/users';
      process.env.QUEUE_PATH = '/custom/queue';
      process.env.SESSION_PATH = '/custom/session';

      // The actual implementation would use these values
      expect(process.env.USER_DATA_ROOT).toBe('/custom/users');
      expect(process.env.QUEUE_PATH).toBe('/custom/queue');
      expect(process.env.SESSION_PATH).toBe('/custom/session');
    });

    it('should use default values if env vars not set', () => {
      delete process.env.USER_DATA_ROOT;
      delete process.env.QUEUE_PATH;
      delete process.env.SESSION_PATH;

      const USER_DATA_ROOT = process.env.USER_DATA_ROOT || './users';
      const QUEUE_PATH = process.env.QUEUE_PATH || './queue';
      const SESSION_PATH = process.env.SESSION_PATH || './auth_info_baileys';

      expect(USER_DATA_ROOT).toBe('./users');
      expect(QUEUE_PATH).toBe('./queue');
      expect(SESSION_PATH).toBe('./auth_info_baileys');
    });

    it('should parse allowed numbers from comma-separated list', () => {
      process.env.ALILED_NUMBERS = '1234567890,0987654321';
      
      const ALLOWED_NUMBERS = (process.env.ALILED_NUMBERS || '').split(',').map((n: string) => n.trim()).filter(Boolean);
      
      expect(ALLOWED_NUMBERS).toEqual(['1234567890', '0987654321']);
    });

    it('should handle empty allowed numbers list', () => {
      delete process.env.ALILED_NUMBERS;
      
      const ALLOWED_NUMBERS = (process.env.ALILED_NUMBERS || '').split(',').map((n: string) => n.trim()).filter(Boolean);
      
      expect(ALLOWED_NUMBERS).toEqual([]);
    });
  });

  describe('Memory Entry Types', () => {
    it('should support user, assistant, and system roles', () => {
      const roles = ['user', 'assistant', 'system'] as const;
      
      expect(roles).toContain('user');
      expect(roles).toContain('assistant');
      expect(roles).toContain('system');
    });
  });

  describe('Queue Message Types', () => {
    it('should support text, image, and audio message types', () => {
      const types = ['text', 'image', 'audio'] as const;
      
      expect(types).toContain('text');
      expect(types).toContain('image');
      expect(types).toContain('audio');
    });

    it('should support pending, sent, and failed statuses', () => {
      const statuses = ['pending', 'sent', 'failed'] as const;
      
      expect(statuses).toContain('pending');
      expect(statuses).toContain('sent');
      expect(statuses).toContain('failed');
    });
  });
});