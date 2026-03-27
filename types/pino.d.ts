declare module 'pino' {
    interface Logger {
        info: (...args: any[]) => void;
        debug: (...args: any[]) => void;
        error: (...args: any[]) => void;
        warn: (...args: any[]) => void;
        trace: (...args: any[]) => void;
        fatal: (...args: any[]) => void;
        child: (bindings?: object) => Logger;
        level: string;
    }

    interface PinoOptions {
        level?: string;
        name?: string;
        [key: string]: any;
    }

    function pino(options?: PinoOptions): Logger;

    export default pino;
    export { Logger, PinoOptions };
}