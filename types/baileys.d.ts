declare module '@whiskeysockets/baileys' {
    import { EventEmitter } from 'events';
    import { Transform } from 'stream';

    export interface WASocket extends EventEmitter {
        ev: EventEmitter;
        readMessages: (keys: proto.IKey[]) => Promise<void>;
        sendPresenceUpdate: (type: WAPresence, jid: string) => Promise<void>;
        sendMessage: (jid: string, content: any) => Promise<any>;
    }

    export interface MediaDownloadOptions {
        logger?: any;
        reuploadRequest?: any;
    }

    export interface DownloadMediaMessageContext {
        logger?: any;
    }

    export interface WAMessage {
        key: proto.IKey;
        message?: proto.IMessage | null;
        messageTimestamp?: number | null;
    }

    export function downloadMediaMessage<Type extends "buffer" | "stream">(
        message: WAMessage,
        type: Type,
        options: MediaDownloadOptions,
        ctx?: DownloadMediaMessageContext
    ): Promise<Type extends "buffer" ? Buffer : Transform>;

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

        export interface IAudioMessage {
            url?: string | null;
            mimetype?: string | null;
            fileSha256?: string | null;
            fileLength?: string | null;
            seconds?: number | null;
            ptt?: boolean | null; // true for voice notes
            mediaKey?: string | null;
            fileEncSha256?: string | null;
            encFileSha256?: string | null;
        }

        export interface IImageMessage {
            url?: string | null;
            mimetype?: string | null;
            fileSha256?: string | null;
            fileLength?: string | null;
            height?: number | null;
            width?: number | null;
            mediaKey?: string | null;
            fileEncSha256?: string | null;
            encFileSha256?: string | null;
            jpegThumbnail?: string | null;
            caption?: string | null;
        }

        export interface IVideoMessage {
            url?: string | null;
            mimetype?: string | null;
            fileSha256?: string | null;
            fileLength?: string | null;
            seconds?: number | null;
            mediaKey?: string | null;
            fileEncSha256?: string | null;
            encFileSha256?: string | null;
            jpegThumbnail?: string | null;
            caption?: string | null;
        }

        export interface IDocumentMessage {
            url?: string | null;
            mimetype?: string | null;
            fileSha256?: string | null;
            fileLength?: string | null;
            pageCount?: number | null;
            mediaKey?: string | null;
            fileName?: string | null;
            fileEncSha256?: string | null;
        }

        export interface IMessage {
            conversation?: string | null;
            extendedTextMessage?: {
                text?: string | null;
            } | null;
            audioMessage?: IAudioMessage | null;
            imageMessage?: IImageMessage | null;
            videoMessage?: IVideoMessage | null;
            documentMessage?: IDocumentMessage | null;
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