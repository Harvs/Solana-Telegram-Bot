import {
  Connection,
  PublicKey,
  Context as SolanaContext,
} from "@solana/web3.js";
import { Database } from "sqlite3";
import TelegramBot from "node-telegram-bot-api";
import * as fs from "fs";
import path from 'path';
import {
  SOLANA_RPC_URL,
  SOLANA_WEBSOCKET_URL,
  SOLANA_RPC_API_KEY,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHANNEL_ID,
  MAIN_WALLET_ADDRESS_1,
  MAIN_WALLET_ADDRESS_2,
  DB_PATH,
  TRACKED_WALLETS_SIZE,
} from "../config/config";
import {
  getTransactionDetails,
  birdeyeLink,
  dextoolLink,
  getSignature2CA,
  getTokenInfo,
} from "./utils";
import { logDebug, logError, logInfo } from "./logger";
import { AccountLayout } from '@solana/spl-token';
import { Metaplex } from "@metaplex-foundation/js";

function shortenAddressWithLink(address: string, type: 'SOL' | 'SPL'): string {
  const baseUrl = type === 'SOL' ? 'https://solscan.io/account/' : 'https://solscan.io/token/';
  const shortened = `${address.slice(0, 4)}...${address.slice(-4)}`;
  return `<a href="${baseUrl}${address}">${shortened}</a>`;
}

function txnLink(signature: string): string {
  return `<a href="https://solscan.io/tx/${signature}">View Transaction</a>`;
}

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
  private tokenNames: Map<string, string> = new Map();
  private tokenListLoaded: boolean = false;

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
          this.bot.sendMessage(msg.chat.id, '🚀 Wallet tracking started!\n\nMonitoring for transactions...', { parse_mode: 'HTML', disable_web_page_preview: true });
        } else {
          this.bot.sendMessage(msg.chat.id, '⚠️ Tracking is already active', { parse_mode: 'HTML', disable_web_page_preview: true });
        }
      });

      this.bot.onText(/\/stop/, async (msg) => {
        if (this.isTracking) {
          this.isTracking = false;
          await this.saveState();
          await this.stopTracking();
          this.bot.sendMessage(msg.chat.id, '⏹ Wallet tracking stopped', { parse_mode: 'HTML', disable_web_page_preview: true });
        } else {
          this.bot.sendMessage(msg.chat.id, '⚠️ Tracking is already stopped', { parse_mode: 'HTML', disable_web_page_preview: true });
        }
      });

      this.bot.onText(/\/status/, (msg) => {
        const status = `🔍 Tracking Status:\n` +
          `State: ${this.isTracking ? '🟢 Active' : '🔴 Stopped'}\n` +
          `Wallet 1: ${this.trackedWallets_1.size} addresses\n` +
          `Wallet 2: ${this.trackedWallets_2.size} addresses`;
        this.bot.sendMessage(msg.chat.id, status, { parse_mode: 'HTML', disable_web_page_preview: true });
      });

      this.bot.onText(/\/help/, (msg) => {
        this.bot.sendMessage(msg.chat.id, 'Available commands:\n/start - Start tracking\n/stop - Stop tracking\n/status - Show status\n/help - Show this help message', { parse_mode: 'HTML', disable_web_page_preview: true });
      });

      // Send initialization message
      this.bot.sendMessage(TELEGRAM_CHANNEL_ID, 
        '🟢 Wallet tracker bot started!\n' +
        `Chat ID: ${TELEGRAM_CHANNEL_ID}\n\n` +
        'Available commands:\n' +
        '/start - Start tracking\n' +
        '/stop - Stop tracking\n' +
        '/status - Show status\n' +
        '/help - Show this help message',
        { parse_mode: 'HTML', disable_web_page_preview: true }
      )
        .then(() => logInfo("Successfully connected to Telegram"))
        .catch((error: Error) => {
          logError("Error sending Telegram message", error);
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
      // Initialize main wallets
      this.trackedWallets_1.set(MAIN_WALLET_ADDRESS_1, {
        address: MAIN_WALLET_ADDRESS_1,
        timestamp: Date.now()
      });
      this.trackedWallets_2.set(MAIN_WALLET_ADDRESS_2, {
        address: MAIN_WALLET_ADDRESS_2,
        timestamp: Date.now()
      });
      
      logInfo(`Initialized main wallets for tracking:
        Wallet 1: ${MAIN_WALLET_ADDRESS_1}
        Wallet 2: ${MAIN_WALLET_ADDRESS_2}`);

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
    
    // Clear tracked wallets
    this.trackedWallets_1.clear();
    this.trackedWallets_2.clear();
    
    logInfo("Wallet tracking stopped");
  }

  private async trackNewWallet(
    wallet_id: number,
    address: string
  ): Promise<void> {
    try {
      const walletMap = wallet_id === 1 ? this.trackedWallets_1 : this.trackedWallets_2;

      if (walletMap.size >= TRACKED_WALLETS_SIZE) {
        const oldestEntry = Array.from(walletMap.entries()).reduce((oldest, current) =>
          current[1].timestamp < oldest[1].timestamp ? current : oldest
        );

        if (oldestEntry) {
          walletMap.delete(oldestEntry[0]);
          logInfo(
            `Removed oldest wallet ${oldestEntry[0]} from wallet ${wallet_id} tracking`
          );
        }
      }

      walletMap.set(address, {
        address,
        timestamp: Date.now(),
      });

      logInfo(`Added new wallet ${address} to wallet ${wallet_id} tracking`);
    } catch (error) {
      logError(`Error tracking new wallet: ${error}`);
    }
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
            logInfo(
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
              logInfo(
                `TG alert: 📝 ${id} Main wall: sm:${newTrackedWalletAddress} => ca:${CA_ADDRESS}, tx: ${signature}`
              );
              this.pumpfunTokens.set(CA_ADDRESS, 3);
            } else if (this.pumpfunTokens.get(CA_ADDRESS) !== -1) {
              this.pumpfunTokens.set(CA_ADDRESS, id);
            }
          }
        } catch (error) {
          logError(`Error: ${error}`);
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
      'SPL' // Since this is for tokens/contracts, we'll use SPL type
    )} | <code>MC: $${mc}</code> | ${birdeyeLink(ca)} | ${dextoolLink(
      ca
    )} | ${txnLink(signature)}
      <code>${ca}</code>`;

    const options = {
      parse_mode: "HTML" as const,
      disable_web_page_preview: true
    };

    try {
      await this.bot.sendMessage(TELEGRAM_CHANNEL_ID, message.trim(), options);
    } catch (error) {
      logError("Error sending Telegram notification:", error);
    }
  }

  private async loadTokenList() {
    if (this.tokenListLoaded) return;
    
    try {
      // Load from Solana Token List
      const response = await fetch('https://raw.githubusercontent.com/solana-labs/token-list/main/src/tokens/solana.tokenlist.json');
      const tokenList = await response.json();
      
      for (const token of tokenList.tokens) {
        // Store token metadata directly
        this.tokenNames.set(token.address, token.symbol);
      }
      
      this.tokenListLoaded = true;
      logInfo("Token list loaded successfully");
    } catch (error) {
      logError(`Error loading token list: ${error}`);
      // Reset the flag if loading failed
      this.tokenListLoaded = false;
    }
  }

  private getPumpFunTokenId(address: string): string {
    // Extract the token ID from the address by removing the 'pump' suffix
    // and getting the last part after any separator
    const withoutPump = address.slice(0, -4); // remove 'pump'
    const parts = withoutPump.split(/[_\-./]/); // split by common separators
    return parts[parts.length - 1] || withoutPump; // use the last part or full string if no separators
  }

  private async getTokenMetadata(mint: string): Promise<string> {
    try {
      // Check for pump.fun tokens
      if (mint.toLowerCase().endsWith('pump')) {
        const tokenInfo = await getTokenInfo(this.connection, mint);
        return `🎯 PUMP ${tokenInfo.symbol}`;
      }

      // Try to get from cache first
      const cachedName = this.tokenNames.get(mint);
      if (cachedName) {
        return cachedName;
      }

      // Load token list if not loaded
      if (!this.tokenListLoaded) {
        await this.loadTokenList();
      }

      try {
        const metaplex = new Metaplex(this.connection);
        const mintPublicKey = new PublicKey(mint);
        const nft = await metaplex.nfts().findByMint({ mintAddress: mintPublicKey });
        if (nft.name) {
          const name = nft.name.replace(/\0/g, '').trim();
          this.tokenNames.set(mint, name);
          return name;
        }
      } catch (error) {
        // If metadata fails, try getting symbol from token mint
        try {
          const tokenMintInfo = await this.connection.getParsedAccountInfo(new PublicKey(mint));
          const symbol = (tokenMintInfo.value?.data as any)?.parsed?.info?.symbol;
          if (symbol) {
            const name = symbol.replace(/\0/g, '').trim();
            this.tokenNames.set(mint, name);
            return name;
          }
        } catch (error) {
          // If all else fails, return shortened address with more context
          const shortName = `Token: ${mint.slice(0, 12)}...${mint.slice(-4)}`;
          this.tokenNames.set(mint, shortName);
          return shortName;
        }
      }

      // If we get here, return a default format
      return `Token: ${mint.slice(0, 12)}...${mint.slice(-4)}`;
    } catch (error) {
      logError(`Error fetching token name for ${mint}: ${error}`);
      return `Token: ${mint.slice(0, 12)}...${mint.slice(-4)}`;
    }
  }

  private async getWalletTokenBalances(walletAddress: string): Promise<string> {
    try {
      const publicKey = new PublicKey(walletAddress);
      const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
      
      // Get all token accounts for this wallet
      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(publicKey, {
        programId: TOKEN_PROGRAM_ID,
      });

      let balanceText = '';
      
      // Sort accounts by balance value to show highest value tokens first
      const accountsWithValue = await Promise.all(
        tokenAccounts.value.map(async (account) => {
          const parsedInfo = account.account.data.parsed.info;
          const mintAddress = parsedInfo.mint;
          const amount = parsedInfo.tokenAmount.uiAmount;
          const tokenName = await this.getTokenMetadata(mintAddress);
          return { tokenName, amount };
        })
      );

      // Filter out zero balances and sort by amount
      const nonZeroBalances = accountsWithValue
        .filter(account => account.amount > 0)
        .sort((a, b) => b.amount - a.amount);

      // Format the balance text
      if (nonZeroBalances.length > 0) {
        for (const { tokenName, amount } of nonZeroBalances) {
          balanceText += `\n${tokenName}: ${amount.toFixed(4)}`;
        }
      } else {
        balanceText = '\nNo token balances found';
      }

      return balanceText;
    } catch (error) {
      logError(`Error getting token balances: ${error}`);
      return '\nError fetching token balances';
    }
  }

  private async displayCurrentBalances(): Promise<void> {
    try {
      // Get balances for both wallets
      const balances1 = await this.getWalletTokenBalances(MAIN_WALLET_ADDRESS_1);
      const balances2 = await this.getWalletTokenBalances(MAIN_WALLET_ADDRESS_2);

      const message = `📊 Current Wallet Balances:\n\n` +
        `Wallet 1 (${shortenAddressWithLink(MAIN_WALLET_ADDRESS_1, 'SOL')}):${balances1}\n\n` +
        `Wallet 2 (${shortenAddressWithLink(MAIN_WALLET_ADDRESS_2, 'SOL')}):${balances2}`;

      await this.bot.sendMessage(TELEGRAM_CHANNEL_ID, message, {
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });
    } catch (error) {
      logError(`Error displaying current balances: ${error}`);
    }
  }

  private async monitorTransactions(id: number): Promise<void> {
    try {
      // Remove existing subscription if any
      if (this.subscriptions[id]) {
        try {
          if (typeof this.subscriptions[id].remove === 'function') {
            this.subscriptions[id].remove();
          } else if (typeof this.subscriptions[id].unsubscribe === 'function') {
            this.subscriptions[id].unsubscribe();
          }
        } catch (error) {
          logError(`Error removing subscription for wallet ${id}: ${error}`);
        }
        delete this.subscriptions[id];
      }

      const mainWalletAddress = id === 1 ? MAIN_WALLET_ADDRESS_1 : MAIN_WALLET_ADDRESS_2;
      const walletMap = id === 1 ? this.trackedWallets_1 : this.trackedWallets_2;
      const publicKey = new PublicKey(mainWalletAddress);
      const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
      
      logInfo(`Setting up token account monitoring for wallet ${id} (${mainWalletAddress})`);

      // Monitor token account changes
      this.subscriptions[id] = this.connection.onProgramAccountChange(
        TOKEN_PROGRAM_ID,
        async (accountInfo, context) => {
          try {
            // Check if this token account belongs to our wallet
            const tokenAccountInfo = AccountLayout.decode(accountInfo.accountInfo.data);
            const owner = new PublicKey(tokenAccountInfo.owner);
            
            if (owner.toString() === mainWalletAddress) {
              logInfo(`Token account change detected for wallet ${mainWalletAddress}`);
              
              // Get the mint address
              const mint = new PublicKey(tokenAccountInfo.mint);
              const tokenName = await this.getTokenMetadata(mint.toString());
              
              // Get token account data including decimals
              const tokenMintInfo = await this.connection.getParsedAccountInfo(mint);
              const decimals = (tokenMintInfo.value?.data as any)?.parsed?.info?.decimals || 9;
              const amount = Number(tokenAccountInfo.amount) / Math.pow(10, decimals);
              
              // Get the transaction signature from the context
              const signature = context.slot ? await this.getRecentSignatureForAddress(publicKey, context.slot) : null;
              
              const message = `💰 Wallet ${id} Token Update:
Address: ${shortenAddressWithLink(mainWalletAddress, 'SOL')}
Token: ${tokenName}
New Balance: ${amount.toFixed(4)}
Time: ${new Date().toLocaleString()}
${signature ? txnLink(signature) : ''}`;

              logInfo(message);
              await this.bot.sendMessage(TELEGRAM_CHANNEL_ID, message, {
                parse_mode: 'HTML',
                disable_web_page_preview: true
              });
            }
          } catch (error) {
            logError(`Error processing token account change: ${error}`);
          }
        },
        'confirmed',
        [
          {
            memcmp: {
              offset: 32, // Owner offset in token account data
              bytes: mainWalletAddress
            }
          }
        ]
      );

      logInfo(`Started monitoring token accounts for wallet ${id} (${mainWalletAddress})`);
    } catch (error) {
      logError(`Error setting up transaction monitoring for wallet ${id}: ${error}`);
    }
  }

  private async getRecentSignatureForAddress(address: PublicKey, slot: number): Promise<string | null> {
    try {
      const signatures = await this.connection.getSignaturesForAddress(address, {
        limit: 1
      });
      
      if (signatures.length > 0) {
        return signatures[0].signature;
      }
      return null;
    } catch (error) {
      logError(`Error getting recent signature: ${error}`);
      return null;
    }
  }

  private async handleNewTransaction(signature: string): Promise<void> {
    try {
      const ca = await getSignature2CA(this.connection, signature);
      if (!ca) {
        logDebug(`No token contract found for signature: ${signature}`);
        return;
      }

      const tokenInfo = await getTokenInfo(this.connection, ca);
      const symbol = tokenInfo?.symbol || 'Unknown';
      const marketCap = tokenInfo?.mc || '0';

      const message = `🔔 New Transaction Detected!\n` +
        `Token: ${symbol}\n` +
        `Market Cap: $${marketCap}\n` +
        `Links: ${birdeyeLink(ca)} | ${dextoolLink(ca)} | ${txnLink(signature)}`;

      await this.bot.sendMessage(TELEGRAM_CHANNEL_ID, message, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
    } catch (error) {
      logError(`Error handling transaction: ${error}`);
    }
  }

  public async start(): Promise<void> {
    logInfo("Wallet tracker starting...");
    
    // Display current balances when starting
    await this.displayCurrentBalances();
    
    // Start monitoring transactions
    await this.monitorTransactions(1);
    await this.monitorTransactions(2);
  }
}
