import { Connection, PublicKey, Context as SolanaContext } from "@solana/web3.js";
import { Database } from "sqlite3";
import TelegramBot from "node-telegram-bot-api";
import fs from 'fs';
import path from 'path';
import {
  DB_PATH,
  LOG_MAX_SIZE,
  LOGFILE,
  MAIN_WALLET_ADDRESS_1,
  MAIN_WALLET_ADDRESS_2,
  MAX_BALANCE_CHANGE,
  SOLANA_RPC_API_KEY,
  SOLANA_RPC_URL,
  SOLANA_WEBSOCKET_URL,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHANNEL_ID,
  TRACKED_WALLETS_SIZE,
} from "../config/config";
import {
  birdeyeLink,
  dextoolLink,
  getSignature2CA,
  getTokenInfo,
  getTransactionDetails,
  shortenAddressWithLink,
  txnLink,
} from "./utils";
import * as fs from "fs";
import { logDebug, logError, logInfo } from "./logger";

interface WalletTrack {
  address: string;
  timestamp: number;
}

interface BotState {
  isTracking: boolean;
  lastUpdated: number;
}

export class WalletTracker {
  private connection: Connection;
  private db: Database;
  private bot: TelegramBot;
  private trackedWallets_1: Map<string, WalletTrack>;
  private trackedWallets_2: Map<string, WalletTrack>;
  private pumpfunTokens: Map<string, number>;
  private isTracking: boolean;
  private stateFile: string;
  private subscriptions: { [key: number]: any };

  constructor() {
    logInfo("Initializing WalletTracker...");
    try {
      // Initialize state file path
      this.stateFile = path.join(__dirname, '../../data/bot_state.json');
      this.ensureDataDirectory();
      this.isTracking = false;
      this.subscriptions = {};

      // Log RPC URL (safely without API key)
      const rpcUrlBase = SOLANA_RPC_URL.split(SOLANA_RPC_API_KEY)[0];
      logInfo(`Connecting to Solana RPC at: ${rpcUrlBase}***`);

      // Log WebSocket URL (safely without API key)
      const wsUrlBase = SOLANA_WEBSOCKET_URL.split(SOLANA_RPC_API_KEY)[0];
      logInfo(`Using WebSocket URL: ${wsUrlBase}***`);
      
      this.connection = new Connection(SOLANA_RPC_URL, {
        wsEndpoint: SOLANA_WEBSOCKET_URL,
        commitment: 'confirmed'
      });

      // Test connection
      this.connection.getSlot()
        .then((slot: number) => logInfo(`Successfully connected to Solana RPC. Current slot: ${slot}`))
        .catch((error: Error) => logError("Failed to connect to Solana RPC", error));

      this.db = new Database(DB_PATH);
      const BOT_TOKEN = TELEGRAM_BOT_TOKEN || "";
      
      // Initialize Telegram bot
      if (!BOT_TOKEN) {
        throw new Error("TELEGRAM_BOT_TOKEN is not set");
      }
      this.bot = new TelegramBot(BOT_TOKEN, { polling: true });
      
      // Set up bot commands
      const commands = [
        { command: '/start', description: 'Start tracking wallets' },
        { command: '/stop', description: 'Stop tracking wallets' },
        { command: '/status', description: 'Show tracking status' },
        { command: '/help', description: 'Show available commands' }
      ];

      this.bot.setMyCommands(commands)
        .then(() => logInfo("Bot commands set up successfully"))
        .catch((error: Error) => logError("Failed to set up bot commands", error));

      // Set up command handlers
      this.bot.onText(/\/start/, async (msg) => {
        if (!this.isTracking) {
          this.isTracking = true;
          await this.saveState();
          await this.startTracking();
          this.bot.sendMessage(msg.chat.id, '🚀 Wallet tracking started!\n\nMonitoring for transactions...');
        } else {
          this.bot.sendMessage(msg.chat.id, '⚠️ Tracking is already active');
        }
      });

      this.bot.onText(/\/stop/, async (msg) => {
        if (this.isTracking) {
          this.isTracking = false;
          await this.saveState();
          await this.stopTracking();
          this.bot.sendMessage(msg.chat.id, '⏹ Wallet tracking stopped');
        } else {
          this.bot.sendMessage(msg.chat.id, '⚠️ Tracking is already stopped');
        }
      });

      this.bot.onText(/\/status/, (msg) => {
        const status = `🔍 Tracking Status:\n` +
          `State: ${this.isTracking ? '🟢 Active' : '🔴 Stopped'}\n` +
          `Wallet 1: ${this.trackedWallets_1.size} addresses\n` +
          `Wallet 2: ${this.trackedWallets_2.size} addresses`;
        this.bot.sendMessage(msg.chat.id, status);
      });

      this.bot.onText(/\/help/, (msg) => {
        this.bot.sendMessage(msg.chat.id, 'Available commands:\n/start - Start tracking\n/stop - Stop tracking\n/status - Show status\n/help - Show this help message');
      });

      // Send initialization message
      this.bot.sendMessage(TELEGRAM_CHANNEL_ID, 
        '🟢 Wallet tracker bot started!\n' +
        `Chat ID: ${TELEGRAM_CHANNEL_ID}\n\n` +
        'Available commands:\n' +
        '/start - Start tracking\n' +
        '/stop - Stop tracking\n' +
        '/status - Show status\n' +
        '/help - Show this help message'
      )
        .then(() => logInfo("Successfully connected to Telegram"))
        .catch((error: Error) => {
          logError("Failed to send Telegram message", error);
          throw error;
        });

      this.trackedWallets_1 = new Map();
      this.trackedWallets_2 = new Map();
      this.pumpfunTokens = new Map();
      
      // Load saved state
      this.loadState();
      
      logInfo("WalletTracker initialized successfully");
    } catch (error) {
      logError("Error initializing WalletTracker", error as Error);
      throw error;
    }
  }

  private ensureDataDirectory(): void {
    const dataDir = path.dirname(this.stateFile);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  }

  private async loadState(): Promise<void> {
    try {
      if (fs.existsSync(this.stateFile)) {
        const data = fs.readFileSync(this.stateFile, 'utf8');
        const state: BotState = JSON.parse(data);
        this.isTracking = state.isTracking;
        logInfo(`Loaded state: tracking=${this.isTracking}`);
        
        if (this.isTracking) {
          await this.startTracking();
        }
      }
    } catch (error) {
      logError("Error loading state:", error);
      this.isTracking = false;
    }
  }

  private async saveState(): Promise<void> {
    try {
      const state: BotState = {
        isTracking: this.isTracking,
        lastUpdated: Date.now()
      };
      fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
      logInfo(`Saved state: tracking=${this.isTracking}`);
    } catch (error) {
      logError("Error saving state:", error);
    }
  }

  private async startTracking(): Promise<void> {
    if (this.isTracking) {
      await this.monitorTransactions(1);
      await this.monitorTransactions(2);
      logInfo("Wallet tracking started");
    }
  }

  private async stopTracking(): Promise<void> {
    // Clean up any existing subscriptions
    Object.values(this.subscriptions).forEach(subscription => {
      if (subscription && typeof subscription.remove === 'function') {
        subscription.remove();
      }
    });
    this.subscriptions = {};
    logInfo("Wallet tracking stopped");
  }

  public saveLog(message: string): void {
    logInfo(message);
  }

  private async trackNewWallet(
    wallet_id: number,
    address: string
  ): Promise<void> {
    const timestamp = Date.now();
    if (wallet_id === 1)
      this.trackedWallets_1.set(address, { address, timestamp });
    if (wallet_id === 2)
      this.trackedWallets_2.set(address, { address, timestamp });
  }
  private async trackUpdateWallet(
    wallet_id: number,
    address: string
  ): Promise<void> {
    const timestamp = Date.now();
    if (wallet_id === 1)
      this.trackedWallets_1.set(address, {
        address: address,
        timestamp,
      });

    if (wallet_id === 2)
      this.trackedWallets_2.set(address, {
        address: address,
        timestamp,
      });
  }

  private async MonitorSmallWallets(
    id: number,
    newTrackedWalletAddress: string
  ) {
    // monitor small wallet from main wallet 1
    this.connection.onLogs(
      new PublicKey(newTrackedWalletAddress),
      async ({ logs, err, signature }) => {
        try {
          if (err) return;
          // console.log(`${newTrackedWalletAddress} Logs:`);
          // this.saveLog(`${newTrackedWalletAddress} Logs: ${logs}`);
          const CA = await getSignature2CA(this.connection, signature);
          // console.log("CA:", CA);

          if (CA) {
            this.saveLog(
              `small wallet tx: sm: ${newTrackedWalletAddress}, token: ${CA}, siggnature: ${signature}`
            );
            const CA_ADDRESS = CA.toString();
            const tmpAnother = 3 - id;
            if (
              CA_ADDRESS === MAIN_WALLET_ADDRESS_1 ||
              CA_ADDRESS === MAIN_WALLET_ADDRESS_2
            ) {
              this.pumpfunTokens.set(CA_ADDRESS, -1);
            } else if (
              this.pumpfunTokens.get(CA_ADDRESS) === tmpAnother ||
              this.pumpfunTokens.get(CA_ADDRESS) === 3
            ) {
              const { symbol, mc } = await getTokenInfo(
                this.connection,
                CA_ADDRESS
              );
              await this.sendTelegramNotification(
                symbol,
                mc,
                newTrackedWalletAddress,
                CA_ADDRESS,
                signature
              );
              this.saveLog(
                `TG alert: 📝 ${id} Main wall: sm:${newTrackedWalletAddress} => ca:${CA_ADDRESS}, tx: ${signature}`
              );
              this.pumpfunTokens.set(CA_ADDRESS, 3);
            } else if (this.pumpfunTokens.get(CA_ADDRESS) !== -1) {
              this.pumpfunTokens.set(CA_ADDRESS, id);
            }
          }
        } catch (error) {
          this.saveLog(`Error: ${error}`);
        }
      }
    );
  }

  private async sendTelegramNotification(
    symbol: string,
    mc: string,
    walletAddress: string,
    ca: string,
    signature: string
  ): Promise<void> {
    const message = `🔗 ${shortenAddressWithLink(
      ca,
      symbol
    )} | <code>MC: $${mc}</code> | ${birdeyeLink(ca)} | ${dextoolLink(
      ca
    )} | ${txnLink(signature)}
      <code>${ca}</code>
      `;
    // console.log(message);

    try {
      await this.bot.sendMessage(TELEGRAM_CHANNEL_ID, message, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
    } catch (error) {
      logError("Error sending Telegram notification:", error);
    }
  }

  public async monitorTransactions(id: number): Promise<void> {
    const MAIN_WALLET_ADDRESS = id === 1 ? MAIN_WALLET_ADDRESS_1 : MAIN_WALLET_ADDRESS_2;
    logInfo(`Starting transaction monitoring for wallet ${id}`, { address: MAIN_WALLET_ADDRESS });

    try {
      this.connection.onLogs(
        new PublicKey(MAIN_WALLET_ADDRESS),
        async (logs, ctx: SolanaContext) => {
          try {
            logDebug(`Received logs for wallet ${id}`, { 
              signature: logs.signature,
              slot: ctx.slot,
              logCount: logs.logs.length 
            });

            const data = await getTransactionDetails(
              this.connection,
              logs.signature
            );
            
            if (data?.balanceChange && data.sender === MAIN_WALLET_ADDRESS) {
              logDebug(`Processing transaction for wallet ${id}`, {
                signature: logs.signature,
                balanceChange: data.balanceChange,
                sender: data.sender
              });
              let smWallets = [];

              if (data?.balanceChange && data.sender === MAIN_WALLET_ADDRESS) {
                const balanceValue = parseFloat(
                  data.balanceChange.replace(" SOL", "")
                );
                if (Math.abs(balanceValue) < MAX_BALANCE_CHANGE) {
                  for (const instruction of data?.instructions) {
                    const newTrackedWalletAddress = instruction.receiver;

                    if (
                      instruction.program === "system" &&
                      instruction.type === "transfer" &&
                      newTrackedWalletAddress
                    ) {
                      smWallets.push(newTrackedWalletAddress);
                      const tmpTrackedWallets =
                        id === 1 ? this.trackedWallets_1 : this.trackedWallets_2;
                      if (tmpTrackedWallets.has(newTrackedWalletAddress)) {
                        await this.trackUpdateWallet(id, newTrackedWalletAddress);
                        continue;
                      }
                      if (tmpTrackedWallets.size >= TRACKED_WALLETS_SIZE) {
                        this.saveLog(
                          `Main wallet ${id} tracked limited wallets. Skipping...`
                        );
                        continue;
                      }
                      await this.trackNewWallet(id, newTrackedWalletAddress);
                      try {
                        await this.MonitorSmallWallets(
                          id,
                          newTrackedWalletAddress
                        );
                      } catch (error) {
                        this.saveLog(
                          `Error monitoring ${id} transactions: ${error}`
                        );
                      }
                    }
                  }
                }
              }
              if (smWallets.length > 0) {
                this.saveLog(
                  `${id} Main wallet txn: ${
                    data?.signature
                  } smWallets: ${smWallets.join(", ")}`
                );
              }
            }
          } catch (error) {
            logError(`Error processing ${id} transactions:`, error);
          }
        },
        "confirmed"
      );
    } catch (error) {
      logError(`Error monitoring ${id} transactions:`, error);
      this.saveLog(`Error monitoring ${id} transactions`);
    }
  }

  public async start(): Promise<void> {
    await this.monitorTransactions(1);
    await this.monitorTransactions(2);
    this.saveLog("Wallet tracker started...");
    logInfo("Wallet tracker started...");
  }
}
