import { appendFile } from 'node:fs/promises';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LoggerOptions {
  logFile?: string;
  silent?: boolean;
}

export class Logger {
  private readonly logFile?: string;
  private readonly silent: boolean;

  constructor(options: LoggerOptions) {
    this.logFile = options.logFile;
    this.silent = options.silent ?? false;
  }

  debug(event: string, details?: unknown): void {
    this.write('debug', event, details);
  }

  info(event: string, details?: unknown): void {
    this.write('info', event, details);
  }

  warn(event: string, details?: unknown): void {
    this.write('warn', event, details);
  }

  error(event: string, details?: unknown): void {
    this.write('error', event, details);
  }

  private write(level: LogLevel, event: string, details?: unknown): void {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      event,
      details,
    };

    const line = JSON.stringify(entry);

    // MCP stdio uses stdout; emit logs on stderr to avoid corrupting protocol output.
    if (!this.silent) {
      console.error(line);
    }

    if (!this.logFile) {
      return;
    }

    void appendFile(this.logFile, `${line}\n`).catch((error) => {
      if (!this.silent) {
        console.error(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            level: 'error',
            event: 'logger.file_write_failed',
            details: {
              message: error instanceof Error ? error.message : String(error),
            },
          }),
        );
      }
    });
  }
}
