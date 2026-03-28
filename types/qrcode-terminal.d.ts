declare module 'qrcode-terminal' {
    interface QRCodeTerminalOptions {
        small?: boolean;
    }

    export function generate(text: string, options?: QRCodeTerminalOptions, callback?: (qr: string) => void): void;
    export function generate(text: string, callback: (qr: string) => void): void;
}