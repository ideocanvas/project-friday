declare module '@whiskeysockets/baileys' {
    import { EventEmitter } from 'events';

    export interface WASocket extends EventEmitter {
        ev: EventEmitter;
        readMessages: (keys: proto.IKey[]) => Promise<void>;
        sendPresenceUpdate: (type: WAPresence, jid: string) => Promise<void>;
        sendMessage: (jid: string, content: any) => Promise<any>;
    }

    export interface AuthenticationState {
        creds: any;
        keys: any;
    }

    export interface AuthState {
        state: AuthenticationState;
        saveCreds: () => Promise<void>;
    }

    export interface WASocketConfig {
        version?: [number, number, number];
        auth: AuthenticationState;
        printQRInTerminal?: boolean;
        logger?: any;
        browser?: [string, string, string];
        markOnlineOnConnect?: boolean;
    }

    export const DisconnectReason: {
        loggedOut: number;
        connectionClosed: number;
        connectionLost: number;
        connectionReplaced: number;
        timedOut: number;
        unknown: number;
    };

    export type WAPresence = 'unavailable' | 'available' | 'composing' | 'paused' | 'recording';

    export namespace proto {
        export interface IKey {
            remoteJid?: string | null;
            fromMe?: boolean | null;
            id?: string | null;
            participant?: string | null;
        }

        export interface IMessage {
            conversation?: string | null;
            extendedTextMessage?: {
                text?: string | null;
            } | null;
        }

        export interface IWebMessageInfo {
            key: IKey;
            message?: IMessage | null;
            messageTimestamp?: number | null;
        }
    }

    export function useMultiFileAuthState(path: string): Promise<AuthState>;
    export function fetchLatestBaileysVersion(): Promise<{ version: [number, number, number] }>;
    export function makeWASocket(config: WASocketConfig): WASocket;
}