import dotenv from "dotenv";
dotenv.config();

export const PUMP_FUN_ADDRESS = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

export const MAIN_WALLET_ADDRESS_1 = process.env.MAIN_WALLET_ADDRESS_1 || "";
export const MAIN_WALLET_ADDRESS_2 = process.env.MAIN_WALLET_ADDRESS_2 || "";
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
export const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || "";
export const SOLANA_RPC_API_KEY = process.env.SOLANA_RPC_API_KEY || "";

// Construct RPC URL with API key
export const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL
  ? process.env.SOLANA_RPC_URL.replace("api-key/", "") + "api-key/" + SOLANA_RPC_API_KEY
  : "";

// Construct WebSocket URL with API key
export const SOLANA_WEBSOCKET_URL = process.env.SOLANA_WEBSOCKET_URL
  ? process.env.SOLANA_WEBSOCKET_URL.replace("api-key/", "") + "api-key/" + SOLANA_RPC_API_KEY
  : "";

export const TRACKED_WALLETS_SIZE = 1000;

export const MAX_BALANCE_CHANGE = 25

// log file
export const LOGFILE = "wallet_tracker.log";
export const LOG_LEVEL = process.env.LOG_LEVEL || "INFO";
export const LOG_MAX_SIZE = 1024 * 1024; // 1MB in bytes

// db
export const DB_PATH = "wallets.db";
