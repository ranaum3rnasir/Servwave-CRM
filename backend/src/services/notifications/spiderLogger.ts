import fs from 'fs';
import path from 'path';

// Store logs in /logs/spider-notifications.log (gitignored)
const LOG_DIR = path.resolve(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'spider-notifications.log');

export interface SpiderLogEntry {
  channel: 'EMAIL' | 'SMS';
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  recipient: string;
  leadNumber?: string;
  customerName?: string;
  stageName?: string;
  details?: string;
  error?: string;
}

/**
 * Appends a formatted timestamped log entry to the local spider-notifications.log file
 */
export function logSpiderNotification(entry: SpiderLogEntry): void {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }

    const timestamp = new Date().toISOString();
    const localTime = new Date().toLocaleString();

    const logLine =
      `[${timestamp}] [${localTime}] [${entry.channel}] [${entry.status}] ` +
      `Recipient: ${entry.recipient} | Lead: ${entry.leadNumber || 'N/A'} (${entry.customerName || 'N/A'}) | ` +
      `Stage: ${entry.stageName || 'N/A'} | ` +
      `${entry.details ? `Details: "${entry.details}" | ` : ''}` +
      `${entry.error ? `Error: ${entry.error}` : ''}\n`;

    fs.appendFileSync(LOG_FILE, logLine, 'utf8');
  } catch (err) {
    // Fail-safe: file logging should never throw or break execution
    console.error('[spiderLogger] Failed to write to spider log file:', err);
  }
}

/**
 * Helper to read all contents of the local spider notification log file
 */
export function readSpiderLogs(): string {
  try {
    if (fs.existsSync(LOG_FILE)) {
      return fs.readFileSync(LOG_FILE, 'utf8');
    }
  } catch (err) {
    console.error('[spiderLogger] Failed to read spider log file:', err);
  }
  return '';
}
