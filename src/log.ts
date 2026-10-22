export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export interface Logger {
	debug(message: string): void;
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

export function createLogger(level: LogLevel, out: NodeJS.WritableStream = process.stderr): Logger {
	const threshold = LOG_LEVELS.indexOf(level);
	const write = (messageLevel: LogLevel, message: string): void => {
		if (LOG_LEVELS.indexOf(messageLevel) >= threshold) {
			out.write(`${new Date().toISOString()} ${messageLevel.padEnd(5)} ${message}\n`);
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
