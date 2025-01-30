import winston from 'winston';
import 'winston-daily-rotate-file';
import { LOG_LEVEL } from '../config/config';

// Define log format
const logFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
);

// Create rotating transport for combined logs
const combinedTransport = new winston.transports.DailyRotateFile({
    filename: 'logs/combined-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxSize: '20m', // Rotate when file reaches 20MB
    maxFiles: '14d', // Keep logs for 14 days
    level: LOG_LEVEL?.toLowerCase() || 'info'
});

// Create rotating transport for error logs
const errorTransport = new winston.transports.DailyRotateFile({
    filename: 'logs/error-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxSize: '20m',
    maxFiles: '30d', // Keep error logs longer
    level: 'error'
});

// Create console transport
const consoleTransport = new winston.transports.Console({
    format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
    ),
    level: LOG_LEVEL?.toLowerCase() || 'info'
});

// Create logger instance
export const logger = winston.createLogger({
    format: logFormat,
    transports: [
        combinedTransport,
        errorTransport,
        consoleTransport
    ]
});

// Helper functions for different log levels
export const logDebug = (message: string, meta?: any) => {
    logger.debug(message, meta);
};

export const logInfo = (message: string, meta?: any) => {
    logger.info(message, meta);
};

export const logError = (message: string, error?: any) => {
    logger.error(message, { error: error?.message || error });
};

// Create logs directory if it doesn't exist
import { mkdirSync } from 'fs';
try {
    mkdirSync('logs', { recursive: true });
} catch (error) {
    console.error('Error creating logs directory:', error);
}
