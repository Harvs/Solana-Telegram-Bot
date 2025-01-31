import { Connection, PublicKey, ParsedAccountData } from "@solana/web3.js";
import TelegramBot from "node-telegram-bot-api";
import { Database } from "sqlite3";
import path from "path";
import fs from "fs";
import {
  MAIN_WALLET_ADDRESS_1,
  MAIN_WALLET_ADDRESS_2,
  SOLANA_RPC_URL,
  SOLANA_WEBSOCKET_URL,
  SOLANA_RPC_API_KEY,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHANNEL_ID,
  DB_PATH,
  BOT_ADMIN,
} from "../config/config";
import {
  getTokenInfo,
  getSignature2CA,
  birdeyeLink,
  dextoolLink,
} from "./utils";
import { logDebug, logError, logInfo } from "./logger";
import { Metaplex } from "@metaplex-foundation/js";

// SPL Token Program ID (hardcoded since we're having import issues)
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

function shortenAddressWithLink(address: string, type: 'SOL' | 'SPL'): string {
  const shortAddress = `${address.slice(0, 4)}...${address.slice(-4)}`;
  return `<a href="https://solscan.io/account/${address}">${shortAddress}</a>`;
}

function txnLink(signature: string): string {
  return `<a href="https://solscan.io/tx/${signature}">View Transaction</a>`;
}

interface WalletTrack {
  subscription: number;
  walletAddress: string;
}

interface BotState {
  isTracking: boolean;
  trackedWallets: { [key: string]: string[] };
}

export class WalletTracker {
  private connection: Connection;
  private db: Database;
  private bot: TelegramBot;
  private isTracking: boolean;
  private subscriptions: { [key: number]: WalletTrack };
  private tokenNames: Map<string, string>;
  private tokenListLoaded: boolean;
  private recentTransactions: Set<string>;
  private readonly CACHE_EXPIRY = 60000; // 60 seconds
  private stateFile: string;
  private trackedWallets_1: Map<string, number>;
  private trackedWallets_2: Map<string, number>;
  private pumpfunTokens: Map<string, number>;
  private pendingUpdates: Map<number, Map<string, { balance: number, signature: string }>> = new Map();
  private updateTimeouts: Map<number, NodeJS.Timeout> = new Map();
  private readonly UPDATE_DELAY = 10000; // 10 seconds

  constructor() {
    logInfo("Initializing WalletTracker...");
    try {
      // Initialize state file path
      this.stateFile = path.join(__dirname, '../../data/bot_state.json');
      this.ensureDataDirectory();

      // Initialize tracking state and caches
      this.isTracking = false;
      this.subscriptions = {};
      this.tokenNames = new Map();
      this.tokenListLoaded = false;
      this.recentTransactions = new Set();
      this.trackedWallets_1 = new Map();
      this.trackedWallets_2 = new Map();
      this.pumpfunTokens = new Map();

      // Set up Solana connection
      this.connection = new Connection(SOLANA_RPC_URL, {
        wsEndpoint: SOLANA_WEBSOCKET_URL,
        httpHeaders: { "x-api-key": SOLANA_RPC_API_KEY },
        commitment: 'confirmed'
      });

      // Initialize database
      this.db = new Database(DB_PATH);

      // Initialize Telegram bot
      if (!TELEGRAM_BOT_TOKEN) {
        throw new Error("TELEGRAM_BOT_TOKEN is not set");
      }
      this.bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

      // Clean up old transactions from cache periodically
      setInterval(() => {
        this.recentTransactions.clear();
        logDebug("Cleared transaction cache");
      }, this.CACHE_EXPIRY);

      // Set up command handlers
      this.setupCommandHandlers();

      // Load saved state
      this.loadState();

      logInfo("WalletTracker initialized successfully");
    } catch (error) {
      logError("Error initializing WalletTracker", error as Error);
      throw error;
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

  private setupCommandHandlers(): void {
    // Set up bot commands
    const commands = [
      { command: '/start', description: 'Start tracking wallets' },
      { command: '/stop', description: 'Stop tracking wallets' },
      { command: '/status', description: 'Show tracking status' },
      { command: '/help', description: 'Show available commands' },
      { command: '/remove', description: 'Remove bot from chat' }
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
        `State: ${this.isTracking ? '🟢 Active' : '🔴 Stopped'}`;
      this.bot.sendMessage(msg.chat.id, status, { parse_mode: 'HTML', disable_web_page_preview: true });
    });

    this.bot.onText(/\/help/, (msg) => {
      this.bot.sendMessage(msg.chat.id, 'Available commands:\n/start - Start tracking\n/stop - Stop tracking\n/status - Show status\n/help - Show this help message\n/remove - Remove bot from chat', { parse_mode: 'HTML', disable_web_page_preview: true });
    });

    this.bot.onText(/\/remove/, async (msg) => {
      try {
        const chatId = msg.chat.id;
        const chatType = msg.chat.type;
        const fromId = msg.from?.id;

        if (!fromId) {
          await this.bot.sendMessage(chatId, '❌ Could not identify user.');
          return;
        }

        // Only allow in groups and channels
        if (chatType === 'private') {
          await this.bot.sendMessage(chatId, '❌ This command can only be used in groups and channels.');
          return;
        }

        // Check if user is an admin
        const isAdmin = await this.isUserAdmin(chatId, fromId);
        if (!isAdmin) {
          await this.bot.sendMessage(chatId, '❌ Only administrators can remove the bot.');
          return;
        }

        // Send goodbye message and leave the chat
        await this.bot.sendMessage(chatId, '👋 Goodbye! The bot will now leave this chat.');
        await this.bot.leaveChat(chatId);
        logInfo(`Bot removed from chat ${chatId} by user ${fromId}`);
      } catch (error) {
        logError(`Error handling /remove command: ${error}`);
      }
    });

    // Send initialization message
    this.bot.sendMessage(TELEGRAM_CHANNEL_ID, 
      '🟢 Wallet tracker bot started!\n' +
      `Chat ID: ${TELEGRAM_CHANNEL_ID}\n\n` +
      'Available commands:\n' +
      '/start - Start tracking\n' +
      '/stop - Stop tracking\n' +
      '/status - Show status\n' +
      '/help - Show this help message\n' +
      '/remove - Remove bot from chat',
      { parse_mode: 'HTML', disable_web_page_preview: true }
    )
      .then(() => logInfo("Successfully connected to Telegram"))
      .catch((error: Error) => {
        logError("Error sending Telegram message", error);
        throw error;
      });
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
        const state = JSON.parse(data) as BotState;
        this.isTracking = state.isTracking;
        logInfo("State loaded successfully");
      }
    } catch (error) {
      logError(`Error loading state: ${error}`);
    }
  }

  private async saveState(): Promise<void> {
    try {
      const state: BotState = {
        isTracking: this.isTracking,
        trackedWallets: {}
      };
      
      // Ensure data directory exists
      this.ensureDataDirectory();
      
      // Save state
      fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
      logInfo("State saved successfully");
    } catch (error) {
      logError(`Error saving state: ${error}`);
    }
  }

  private async startTracking(): Promise<void> {
    try {
      if (!this.isTracking) {
        this.isTracking = true;
        
        // Initialize main wallets
        this.trackedWallets_1.clear();
        this.trackedWallets_2.clear();
        
        // Start monitoring both wallets
        await Promise.all([
          this.monitorTransactions(1),
          this.monitorTransactions(2)
        ]);

        await this.saveState();
        logInfo("Wallet tracking started");
      }
    } catch (error) {
      logError(`Error starting tracking: ${error}`);
      this.isTracking = false;
    }
  }

  private async stopTracking(): Promise<void> {
    try {
      this.isTracking = false;
      await Promise.all([
        this.stopMonitoring(1),
        this.stopMonitoring(2)
      ]);
      logInfo("Stopped tracking all wallets");
    } catch (error) {
      logError(`Error stopping tracking: ${error}`);
    }
  }

  private async trackNewWallet(
    wallet_id: number,
    address: string
  ): Promise<void> {
    try {
      // Add wallet to tracking
      logInfo(`Added new wallet ${address} to wallet ${wallet_id} tracking`);
    } catch (error) {
      logError(`Error tracking new wallet: ${error}`);
    }
  }

  private async trackUpdateWallet(
    wallet_id: number,
    address: string
  ): Promise<void> {
    try {
      // Update wallet in tracking
      logInfo(`Updated wallet ${address} in wallet ${wallet_id} tracking`);
    } catch (error) {
      logError(`Error updating wallet: ${error}`);
    }
  }

  private async MonitorSmallWallets(
    signature: string,
    id: number,
    newTrackedWalletAddress: string,
    CA_ADDRESS: string
  ): Promise<void> {
    try {
      if (
        CA_ADDRESS === MAIN_WALLET_ADDRESS_1 ||
        CA_ADDRESS === MAIN_WALLET_ADDRESS_2
      ) {
        this.pumpfunTokens.set(CA_ADDRESS, -1);
      } else if (
        this.pumpfunTokens.get(CA_ADDRESS) === id ||
        this.pumpfunTokens.get(CA_ADDRESS) === 3
      ) {
        const { symbol, mc } = await getTokenInfo(
          this.connection,
          CA_ADDRESS
        );

        logInfo(
          `TG alert: 📝 ${id} Main wall: sm:${newTrackedWalletAddress} => ca:${CA_ADDRESS}, tx: ${signature}`
        );
        this.pumpfunTokens.set(CA_ADDRESS, 3);
      } else if (this.pumpfunTokens.get(CA_ADDRESS) !== -1) {
        this.pumpfunTokens.set(CA_ADDRESS, id);
      }
    } catch (error) {
      logError(`Error monitoring small wallets: ${error}`);
    }
  }

  private async sendTelegramNotification(
    symbol: string,
    mc: number,
    newTrackedWalletAddress: string,
    CA_ADDRESS: string,
    signature: string
  ): Promise<void> {
    try {
      const message = `🚨 New Token Alert 🚨\n\n` +
        `Symbol: ${symbol}\n` +
        `Market Cap: $${mc.toLocaleString()}\n` +
        `Contract: ${CA_ADDRESS}\n` +
        `Wallet: ${newTrackedWalletAddress}\n\n` +
        `Links:\n` +
        `${birdeyeLink(CA_ADDRESS)}\n` +
        `${dextoolLink(CA_ADDRESS)}\n` +
        `${txnLink(signature)}`;

      await this.bot.sendMessage(TELEGRAM_CHANNEL_ID, message, {
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });
    } catch (error) {
      logError(`Error sending Telegram notification: ${error}`);
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
        const tokenInfo = await getTokenInfo(
          this.connection,
          mint
        );
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
      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(publicKey, {
        programId: TOKEN_PROGRAM_ID,
      });

      if (tokenAccounts.value.length === 0) {
        return "No token balances found";
      }

      const balances: string[] = [];
      for (const { account } of tokenAccounts.value) {
        const parsedInfo = account.data.parsed.info;
        const balance = Number(parsedInfo.tokenAmount.uiAmount);
        if (balance > 0) {
          const tokenInfo = await getTokenInfo(this.connection, parsedInfo.mint);
          const tokenDisplay = tokenInfo.isPumpToken ? 
            `🎯 PUMP ${tokenInfo.name}` : 
            `💰 ${tokenInfo.name || parsedInfo.mint}`;
          balances.push(`${tokenDisplay}: ${balance.toFixed(4)}`);
        }
      }

      return balances.length > 0 ? balances.join('\n') : "No token balances found";
    } catch (error) {
      logError(`Error getting wallet balances: ${error}`);
      return "Error fetching token balances";
    }
  }

  private async batchTokenUpdate(walletNumber: number, tokenMint: string, balance: number, signature: string) {
    if (!this.pendingUpdates.has(walletNumber)) {
      this.pendingUpdates.set(walletNumber, new Map());
    }
    
    const walletUpdates = this.pendingUpdates.get(walletNumber)!;
    walletUpdates.set(tokenMint, { balance, signature });

    // Clear existing timeout if any
    const existingTimeout = this.updateTimeouts.get(walletNumber);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    // Set new timeout
    const timeout = setTimeout(async () => {
      try {
        const updates = this.pendingUpdates.get(walletNumber)!;
        this.pendingUpdates.set(walletNumber, new Map()); // Clear updates
        
        if (updates.size > 0) {
          const walletAddress = walletNumber === 1 ? MAIN_WALLET_ADDRESS_1 : MAIN_WALLET_ADDRESS_2;
          const timestamp = Math.floor(Date.now() / 1000);
          
          // Group updates by type (new tokens vs balance changes)
          const newTokens: string[] = [];
          const balanceChanges: string[] = [];
          
          for (const [mint, { balance }] of updates) {
            const trackedWallets = walletNumber === 1 ? this.trackedWallets_1 : this.trackedWallets_2;
            const previousBalance = trackedWallets.get(mint) || 0;
            
            // Get token info for display
            const tokenInfo = await getTokenInfo(this.connection, mint);
            const tokenDisplay = tokenInfo.isPumpToken ? 
              `🎯 PUMP ${tokenInfo.name}` : 
              `💰 ${tokenInfo.name || mint}`;
            
            if (previousBalance === 0 && balance > 0) {
              newTokens.push(`${tokenDisplay} (${balance.toFixed(4)})`);
            } else if (balance !== previousBalance) {
              balanceChanges.push(`${tokenDisplay} (${previousBalance.toFixed(4)} → ${balance.toFixed(4)})`);
            }
            
            // Update tracked balance
            trackedWallets.set(mint, balance);
          }
          
          // Create message parts
          const messageParts: string[] = [];
          if (newTokens.length > 0) {
            messageParts.push(`New tokens received:\n${newTokens.join('\n')}`);
          }
          if (balanceChanges.length > 0) {
            messageParts.push(`Balance changes:\n${balanceChanges.join('\n')}`);
          }
          
          // Send combined message if there are any changes
          if (messageParts.length > 0) {
            const message = `Updates for wallet ${walletNumber}:\n\n${messageParts.join('\n\n')}`;
            await this.bot.sendMessage(TELEGRAM_CHANNEL_ID, message);
          }
        }
      } catch (error) {
        logError(`Error processing batched updates: ${error}`);
      } finally {
        this.updateTimeouts.delete(walletNumber);
      }
    }, this.UPDATE_DELAY);
    
    this.updateTimeouts.set(walletNumber, timeout);
  }

  private async updateTokenBalances(walletPublicKey: PublicKey, walletNumber: number): Promise<void> {
    try {
      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
        walletPublicKey,
        { programId: TOKEN_PROGRAM_ID }
      );

      const timestamp = Math.floor(Date.now() / 1000);

      for (const { account } of tokenAccounts.value) {
        const parsedData = account.data.parsed;
        const tokenMint = parsedData.info.mint;
        const balance = Number(parsedData.info.tokenAmount.uiAmount);
        
        // Queue update for batching
        await this.batchTokenUpdate(
          walletNumber,
          tokenMint,
          balance,
          `refresh_${timestamp}`
        );
      }
    } catch (error) {
      logError(`Error updating token balances: ${error}`);
    }
  }

  private async monitorTransactions(walletNumber: number): Promise<void> {
    try {
      const walletAddress = walletNumber === 1 ? MAIN_WALLET_ADDRESS_1 : MAIN_WALLET_ADDRESS_2;
      const walletPublicKey = new PublicKey(walletAddress);

      // Remove existing subscription if any
      await this.stopMonitoring(walletNumber);

      // Get initial token accounts and store their balances
      await this.updateTokenBalances(walletPublicKey, walletNumber);

      // Subscribe to wallet account changes to detect new token accounts
      const walletSubscriptionId = this.connection.onAccountChange(
        walletPublicKey,
        async () => {
          try {
            if (!this.isTracking) return;
            await this.updateTokenBalances(walletPublicKey, walletNumber);
          } catch (error) {
            logError(`Error in wallet change handler: ${error}`);
          }
        },
        'confirmed'
      );

      // Subscribe to token program changes
      const tokenSubscriptionId = this.connection.onProgramAccountChange(
        TOKEN_PROGRAM_ID,
        async (accountInfo, context) => {
          try {
            if (!this.isTracking) return;

            const parsedInfo = await this.connection.getParsedAccountInfo(accountInfo.accountId);
            
            if (!parsedInfo.value || !('parsed' in parsedInfo.value.data)) {
              return;
            }

            const parsedData = parsedInfo.value.data as ParsedAccountData;
            const owner = parsedData.parsed.info.owner;

            if (owner === walletAddress) {
              const tokenMint = parsedData.parsed.info.mint;
              const balance = Number(parsedData.parsed.info.tokenAmount.uiAmount);
              
              // Queue update for batching
              await this.batchTokenUpdate(
                walletNumber,
                tokenMint,
                balance,
                context.slot.toString()
              );
            }
          } catch (error) {
            logError(`Error in token account change handler: ${error}`);
          }
        },
        'confirmed',
        [
          {
            memcmp: {
              offset: 32,
              bytes: walletAddress
            }
          }
        ]
      );

      // Store subscriptions
      this.subscriptions[walletNumber] = {
        subscription: tokenSubscriptionId,
        walletAddress: walletAddress
      };

      logInfo(`Started monitoring wallet ${walletNumber}: ${walletAddress}`);
    } catch (error) {
      logError(`Error setting up monitoring for wallet ${walletNumber}: ${error}`);
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

  private async isUserAdmin(chatId: number, userId: number): Promise<boolean> {
    try {
      // First check if user is the BOT_ADMIN
      if (userId === Number(BOT_ADMIN)) {
        return true;
      }

      // Then check if user is a chat admin
      const chatMember = await this.bot.getChatMember(chatId, userId);
      return ['creator', 'administrator'].includes(chatMember.status);
    } catch (error) {
      logError(`Error checking admin status: ${error}`);
      return false;
    }
  }

  private async handleTokenBalanceChange(
    walletAddress: string,
    walletNumber: number,
    tokenMint: string,
    newBalance: number,
    signature: string,
    timestamp: number
  ): Promise<void> {
    try {
      // Check if we've already handled this transaction
      const cacheKey = `${signature}_${tokenMint}`;
      if (this.recentTransactions.has(cacheKey)) {
        return;
      }
      this.recentTransactions.add(cacheKey);

      const tokenName = await this.getTokenMetadata(tokenMint);
      const date = new Date(timestamp * 1000).toLocaleString();
      
      const message = `💰 Wallet ${walletNumber} Token Update:\n` +
        `Address: ${shortenAddressWithLink(walletAddress, 'SOL')}\n` +
        `Token: ${tokenName}\n` +
        `New Balance: ${newBalance.toFixed(4)}\n` +
        `Time: ${date}\n` +
        `${txnLink(signature)}`;

      await this.bot.sendMessage(TELEGRAM_CHANNEL_ID, message, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
    } catch (error) {
      logError(`Error handling token balance change: ${error}`);
    }
  }

  private async stopMonitoring(walletNumber: number): Promise<void> {
    try {
      const walletTrack = this.subscriptions[walletNumber];
      if (walletTrack) {
        await this.connection.removeAccountChangeListener(walletTrack.subscription);
        delete this.subscriptions[walletNumber];
        logInfo(`Stopped monitoring wallet ${walletNumber}: ${walletTrack.walletAddress}`);
      }
    } catch (error) {
      logError(`Error stopping monitoring for wallet ${walletNumber}: ${error}`);
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
