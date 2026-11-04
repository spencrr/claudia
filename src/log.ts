export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export interface Logger {
	debug(message: string): void;
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

const MAX_LINE_CHARS = 2_000;

/**
 * Log lines include client- and model-controlled strings (model ids, tool
 * inputs, error messages). One line per entry, no control characters, bounded
 * length — so nothing a request carries can forge a line or drive the terminal.
 */
export function sanitizeLogLine(message: string): string {
	// eslint-disable-next-line no-control-regex
	const flat = message.replace(/[\u0000-\u0008\u000A-\u001F\u007F-\u009F]/g, ' ');
	return flat.length > MAX_LINE_CHARS ? `${flat.slice(0, MAX_LINE_CHARS)}…` : flat;
}

export function createLogger(level: LogLevel, out: NodeJS.WritableStream = process.stderr): Logger {
	const threshold = LOG_LEVELS.indexOf(level);
	const write = (messageLevel: LogLevel, message: string): void => {
		if (LOG_LEVELS.indexOf(messageLevel) >= threshold) {
			out.write(`${new Date().toISOString()} ${messageLevel.padEnd(5)} ${sanitizeLogLine(message)}\n`);
		}
	};
	return {
		debug: message => write('debug', message),
		info: message => write('info', message),
		warn: message => write('warn', message),
		error: message => write('error', message),
	};
}

export const silentLogger: Logger = { debug() { }, info() { }, warn() { }, error() { } };
