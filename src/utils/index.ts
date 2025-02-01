import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import TelegramBot, { PollingOptions } from "node-telegram-bot-api";
import {
  TELEGRAM_CHANNEL_ID,
  MAIN_WALLET_ADDRESS_1,
  MAIN_WALLET_ADDRESS_2,
  SOLANA_RPC_URL,
  TELEGRAM_BOT_TOKEN,
} from "../config/config";
import {
  getTokenInfo,
  getSignature2CA,
  birdeyeLink,
  dextoolLink,
  getTransactionDetails,
} from "./utils";
import { logDebug, logError, logInfo } from "./logger";
import { Metaplex } from "@metaplex-foundation/js";
import { RateLimiter } from './rateLimiter';

// Program IDs for both token standards
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

// SPL Token Program ID (hardcoded since we're having import issues)

interface TokenInfo {
  name: string;
  symbol: string;
  decimals: number;
  supply: number;
  price: number;
  mc: string;
  isPumpToken: boolean;
}

interface TokenUpdate {
  balance: number;
  signature: string;
}

interface WalletTrack {
  address: string;
  lastSignature: string;
  trackedWallets: { [key: string]: string[] };
}

function shortenAddressWithLink(address: string, type: 'SOL' | 'SPL'): string {
  const shortAddress = `${address.slice(0, 4)}...${address.slice(-4)}`;
  return `<a href="https://solscan.io/account/${address}">${shortAddress}</a>`;
}

function txnLink(signature: string): string {
  return `<a href="https://solscan.io/tx/${signature}">View Transaction</a>`;
}

export class WalletTracker {
  private connection: Connection;
  private bot: TelegramBot;
  private isTracking: boolean = false;
  private isInitialLoad: boolean = true;
  private trackedWallets_1: Map<string, number> = new Map();
  private trackedWallets_2: Map<string, number> = new Map();
  private subscriptions: { [key: number]: { subscription: number; walletAddress: string } } = {};
  private pendingUpdates: Map<number, Map<string, TokenUpdate>> = new Map();
  private updateTimeouts: Map<number, NodeJS.Timeout> = new Map();
  private rateLimiter: RateLimiter;
  private readonly UPDATE_DELAY = 5000; // 5 seconds

  constructor() {
    logInfo("Initializing WalletTracker...");
    try {
      // Initialize tracking state and caches
      this.isTracking = false;
      this.rateLimiter = new RateLimiter();

      // Set up Solana connection
      this.connection = new Connection(SOLANA_RPC_URL, {
        commitment: 'confirmed'
      });

      // Initialize Telegram bot with proper error handling
      if (!TELEGRAM_BOT_TOKEN) {
        throw new Error("TELEGRAM_BOT_TOKEN is not set");
      }
      
      const pollingOptions: PollingOptions = {
        params: {
          timeout: 30 // Long polling timeout in seconds
        }
      };
      
      this.bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: pollingOptions });

      // Set up polling error handler
      this.bot.on('polling_error', async (error: any) => {
        const waitTime = this.rateLimiter.handlePollingError(error);
        logError(`Polling error: ${error.message}. Waiting ${waitTime}ms before retry.`);
        
        // Update polling parameters
        if (this.bot.isPolling()) {
          await this.bot.stopPolling();
        }
        
        setTimeout(async () => {
          try {
            await this.bot.startPolling();
          } catch (e) {
            logError(`Failed to restart polling: ${e}`);
          }
        }, waitTime);
      });

      // Set up successful polling handler
      this.bot.on('polling_success', () => {
        this.rateLimiter.handlePollingSuccess();
      });

      // Set up command handlers
      this.setupCommandHandlers();

      logInfo("WalletTracker initialized successfully");
    } catch (error) {
      logError("Error initializing WalletTracker", error as Error);
      throw error;
    }
  }

  private async sendMessage(chatId: number | string, message: string, options: TelegramBot.SendMessageOptions = {}): Promise<void> {
    const numericChatId = typeof chatId === 'string' ? parseInt(chatId) : chatId;
    try {
      const isGroup = String(numericChatId).startsWith('-');
      await this.rateLimiter.waitForRateLimit(numericChatId, isGroup);
      await this.bot.sendMessage(numericChatId, message, { ...options, disable_web_page_preview: true });
    } catch (error: any) {
      if (error.message?.includes('ETELEGRAM: 429')) {
        const retryAfter = parseInt(error.message.match(/retry after (\d+)/)?.[1] || '5');
        this.rateLimiter.handleRateLimitError(numericChatId, retryAfter);
        // Retry the message after the rate limit period
        setTimeout(() => this.sendMessage(numericChatId, message, options), retryAfter * 1000);
      } else {
        logError(`Error sending message to ${chatId}: ${error}`);
      }
    }
  }

  private setupCommandHandlers(): void {
    // Set up bot commands
    const commands = [
      { command: '/start', description: 'Start tracking wallets' },
      { command: '/stop', description: 'Stop tracking wallets' },
      { command: '/status', description: 'Show tracking status' },
      { command: '/balances', description: 'Show current wallet balances' },
      { command: '/help', description: 'Show available commands' },
      { command: '/remove', description: 'Remove bot from chat' }
    ];

    this.bot.setMyCommands(commands)
      .then(() => logInfo("Bot commands set up successfully"))
      .catch((error: Error) => logError("Failed to set up bot commands", error));

    // Set up command handlers with rate limiting
    this.bot.onText(/\/start/, async (msg) => {
      if (!this.isTracking) {
        this.isTracking = true;
        await this.startTracking();
        await this.sendMessage(msg.chat.id, '🚀 Wallet tracking started!\n\nMonitoring for transactions...', { parse_mode: 'HTML' });
      } else {
        await this.sendMessage(msg.chat.id, '⚠️ Tracking is already active', { parse_mode: 'HTML' });
      }
    });

    this.bot.onText(/\/stop/, async (msg) => {
      if (this.isTracking) {
        this.isTracking = false;
        await this.stopTracking();
        await this.sendMessage(msg.chat.id, '⏹ Wallet tracking stopped', { parse_mode: 'HTML' });
      } else {
        await this.sendMessage(msg.chat.id, '⚠️ Tracking is already stopped', { parse_mode: 'HTML' });
      }
    });

    this.bot.onText(/\/status/, async (msg) => {
      const status = `🔍 Tracking Status:\n` +
        `State: ${this.isTracking ? '🟢 Active' : '🔴 Stopped'}`;
      await this.sendMessage(msg.chat.id, status, { parse_mode: 'HTML' });
    });

    this.bot.onText(/\/help/, async (msg) => {
      const fromId = msg.from?.id;
      if (!fromId) return;

      const helpMessage = `Available commands:
/start - Start tracking
/stop - Stop tracking
/status - Show status
/balances - Show current wallet balances
/help - Show this help message
/remove - Remove bot from chat`;

      await this.sendMessage(msg.chat.id, helpMessage);
    });

    this.bot.onText(/\/balances/, async (msg) => {
      const fromId = msg.from?.id;
      if (!fromId) return;

      try {
        await this.displayCurrentBalances();
      } catch (error) {
        logError(`Error displaying balances for user ${fromId}: ${error}`);
        await this.sendMessage(msg.chat.id, '❌ Error fetching wallet balances');
      }
    });

    this.bot.onText(/\/remove/, async (msg) => {
      try {
        const chatId = msg.chat.id;
        const chatType = msg.chat.type;
        const fromId = msg.from?.id;

        if (!fromId) {
          await this.sendMessage(chatId, '❌ Could not identify user.');
          return;
        }

        // Only allow in groups and channels
        if (chatType === 'private') {
          await this.sendMessage(chatId, '❌ This command can only be used in groups and channels.');
          return;
        }

        // Check if user is an admin
        const isAdmin = await this.isUserAdmin(chatId, fromId);
        if (!isAdmin) {
          await this.sendMessage(chatId, '❌ Only administrators can remove the bot.');
          return;
        }

        // Send goodbye message and leave the chat
        await this.sendMessage(chatId, '👋 Goodbye! The bot will now leave this chat.');
        await this.bot.leaveChat(chatId);
        logInfo(`Bot removed from chat ${chatId} by user ${fromId}`);
      } catch (error) {
        logError(`Error handling /remove command: ${error}`);
      }
    });

    // Send initialization message
    const numericChannelId = typeof TELEGRAM_CHANNEL_ID === 'string' ? parseInt(TELEGRAM_CHANNEL_ID) : TELEGRAM_CHANNEL_ID;
    this.bot.sendMessage(numericChannelId, 
      '🟢 Wallet tracker bot started!\n' +
      `Chat ID: ${numericChannelId}\n\n` +
      'Available commands:\n' +
      '/start - Start tracking\n' +
      '/stop - Stop tracking\n' +
      '/status - Show status\n' +
      '/balances - Show current wallet balances\n' +
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

  private async displayCurrentBalances(): Promise<void> {
    try {
      const balances1 = await this.getWalletBalances(MAIN_WALLET_ADDRESS_1);
      const balances2 = await this.getWalletBalances(MAIN_WALLET_ADDRESS_2);

      const message = `Current Wallet Balances:\n\n` +
        `Wallet 1 (${shortenAddressWithLink(MAIN_WALLET_ADDRESS_1, 'SOL')}):\n${balances1}\n\n` +
        `Wallet 2 (${shortenAddressWithLink(MAIN_WALLET_ADDRESS_2, 'SOL')}):\n${balances2}`;

      const numericChannelId = typeof TELEGRAM_CHANNEL_ID === 'string' ? parseInt(TELEGRAM_CHANNEL_ID) : TELEGRAM_CHANNEL_ID;
      await this.sendMessage(numericChannelId, message, {
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });
    } catch (error) {
      logError(`Error displaying balances: ${error}`);
      throw error;
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

  private async monitorTransactions(walletNumber: number): Promise<void> {
    try {
      const walletAddress = walletNumber === 1 ? MAIN_WALLET_ADDRESS_1 : MAIN_WALLET_ADDRESS_2;
      const walletPublicKey = new PublicKey(walletAddress);
      logInfo(`Setting up monitoring for wallet ${walletAddress}`);

      // Monitor token accounts
      const tokenSubscriptionId = this.connection.onProgramAccountChange(
        TOKEN_PROGRAM_ID,
        async (accountInfo) => {
          try {
            logInfo(`Token program change detected for wallet ${walletAddress}`);
            // Get parsed account info
            const parsedInfo = await this.connection.getParsedAccountInfo(accountInfo.accountId);
            if (!parsedInfo.value || !('parsed' in parsedInfo.value.data)) {
              return;
            }

            const parsedData = parsedInfo.value.data;
            if (!parsedData.parsed?.info?.owner || !parsedData.parsed?.info?.mint || !parsedData.parsed?.info?.tokenAmount) {
              return;
            }

            // Check if this token account belongs to our wallet
            if (parsedData.parsed.info.owner === walletAddress) {
              const tokenMint = parsedData.parsed.info.mint;
              const balance = Number(parsedData.parsed.info.tokenAmount.uiAmount || 0);
              logInfo(`Token change detected - Mint: ${tokenMint}, Balance: ${balance}`);

              // Get the transaction signature
              const signatures = await this.connection.getSignaturesForAddress(accountInfo.accountId);
              const signature = signatures[0]?.signature || '';

              // Queue the token update
              await this.batchTokenUpdate(walletNumber, tokenMint, balance, signature);
            } else {
              logInfo(`Skipping: Token account owned by different wallet: ${parsedData.parsed.info.owner}`);
            }
          } catch (error) {
            logError(`Error in token account change handler: ${error}`);
          }
        },
        'confirmed',
        [
          {
            memcmp: {
              offset: 32, // Owner offset in token account data
              bytes: walletAddress
            }
          }
        ]
      );

      // Also monitor the wallet account for direct token account changes
      const walletSubscriptionId = this.connection.onAccountChange(
        walletPublicKey,
        async () => {
          try {
            logInfo(`Wallet account change detected for ${walletAddress}`);
            // Get all token accounts for the wallet
            const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
              walletPublicKey,
              { programId: TOKEN_PROGRAM_ID }
            );

            logInfo(`Found ${tokenAccounts.value.length} token accounts after wallet change`);

            // Process each token account
            for (const { pubkey, account } of tokenAccounts.value) {
              if (!account.data.parsed?.info?.tokenAmount) {
                logInfo(`Skipping token account ${pubkey.toString()}: Missing token amount`);
                continue;
              }

              const tokenMint = account.data.parsed.info.mint;
              const balance = Number(account.data.parsed.info.tokenAmount.uiAmount || 0);
              logInfo(`Processing token ${tokenMint} with balance ${balance}`);

              // Get the transaction signature
              const signatures = await this.connection.getSignaturesForAddress(pubkey);
              const signature = signatures[0]?.signature || '';

              // Queue the token update
              await this.batchTokenUpdate(walletNumber, tokenMint, balance, signature);
            }
          } catch (error) {
            logError(`Error in wallet change handler: ${error}`);
          }
        },
        'confirmed'
      );

      // Store subscriptions for cleanup
      this.subscriptions[walletNumber] = {
        subscription: tokenSubscriptionId,
        walletAddress: walletAddress
      };

      logInfo(`Started monitoring wallet ${walletNumber}: ${walletAddress}`);
    } catch (error) {
      logError(`Error setting up monitoring for wallet ${walletNumber}: ${error}`);
    }
  }

  private async getWalletBalances(walletAddress: string): Promise<string> {
    try {
      const publicKey = new PublicKey(walletAddress);
      logInfo(`Fetching token accounts for wallet ${walletAddress}`);
      
      // Get token accounts for both programs
      const [splTokenAccounts, token2022Accounts] = await Promise.all([
        this.connection.getParsedTokenAccountsByOwner(publicKey, {
          programId: TOKEN_PROGRAM_ID,
        }),
        this.connection.getParsedTokenAccountsByOwner(publicKey, {
          programId: TOKEN_2022_PROGRAM_ID,
        })
      ]);

      // Combine both account types
      const allTokenAccounts = [...splTokenAccounts.value, ...token2022Accounts.value];
      
      logInfo(`Found ${allTokenAccounts.length} total token accounts for wallet ${walletAddress} (${splTokenAccounts.value.length} SPL + ${token2022Accounts.value.length} Token-2022)`);

      if (allTokenAccounts.length === 0) {
        return "No token balances found";
      }

      const balances: string[] = [];
      const trackedWallets = walletAddress === MAIN_WALLET_ADDRESS_1 ? this.trackedWallets_1 : this.trackedWallets_2;

      // Process each token account
      for (const { account } of allTokenAccounts) {
        try {
          const parsedInfo = account.data.parsed.info;
          const balance = Number(parsedInfo.tokenAmount.uiAmount);
          const mint = parsedInfo.mint;
          
          // Check which program this token uses
          const isToken2022 = account.owner.equals(TOKEN_2022_PROGRAM_ID);
          logInfo(`Processing ${isToken2022 ? 'Token-2022' : 'SPL'} token ${mint} with balance ${balance}`);

          if (balance > 0) {
            // Get token info
            const tokenInfo = await getTokenInfo(this.connection, mint);
            
            let displayName: string;
            if (tokenInfo) {
              displayName = tokenInfo.isPumpToken ? 
                `🎯 PUMP ${tokenInfo.name}` : 
                `${isToken2022 ? '💎' : '💰'} ${tokenInfo.name}`;
            } else {
              // If no token info, use mint address
              displayName = `${isToken2022 ? '💎' : '💰'} Token ${mint.slice(0, 8)}...`;
            }

            balances.push(`${displayName}: ${balance.toFixed(4)}`);

            // Update tracked balances
            trackedWallets.set(mint, balance);
            
            // During initial load, also queue the token update
            if (this.isInitialLoad) {
              await this.batchTokenUpdate(walletAddress === MAIN_WALLET_ADDRESS_1 ? 1 : 2, mint, balance, '');
            }
          } else {
            logInfo(`Skipping token ${mint} due to zero balance`);
          }
        } catch (error) {
          logError(`Error processing token account: ${error}`);
          continue;
        }
      }

      return balances.length > 0 ? balances.join('\n') : "No token balances found";
    } catch (error) {
      logError(`Error getting wallet balances: ${error}`);
      return "Error fetching token balances";
    }
  }

  private async handleTokenChange(ca: string, signature: string, isNewToken: boolean) {
    try {
      const tokenInfo = await getTokenInfo(this.connection, ca);
      if (!tokenInfo) {
        logError(`Failed to get token info for ${ca}`);
        return;
      }

      // Create message for new token
      if (isNewToken) {
        const message = `New token detected: ${tokenInfo.name}\n` +
          `Symbol: ${tokenInfo.symbol}\n` +
          `Market Cap: ${tokenInfo.mc}\n` +
          `View on Solscan: https://solscan.io/token/${ca}`;
        
        const numericChannelId = typeof TELEGRAM_CHANNEL_ID === 'string' ? parseInt(TELEGRAM_CHANNEL_ID) : TELEGRAM_CHANNEL_ID;
        await this.sendMessage(numericChannelId, message, { parse_mode: 'HTML', disable_web_page_preview: true });
      }
    } catch (error) {
      logError(`Error handling token change: ${error}`);
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
        
        if (updates.size > 0 && !this.isInitialLoad) {  // Skip batch update message during initial load
          const walletAddress = walletNumber === 1 ? MAIN_WALLET_ADDRESS_1 : MAIN_WALLET_ADDRESS_2;
          
          // Group updates by type (new tokens vs balance changes)
          const newTokens: string[] = [];
          const balanceChanges: string[] = [];
          
          for (const [mint, { balance }] of updates) {
            const trackedWallets = walletNumber === 1 ? this.trackedWallets_1 : this.trackedWallets_2;
            const previousBalance = trackedWallets.get(mint) || 0;
            
            // Get token info for display
            const tokenInfo = await getTokenInfo(this.connection, mint);
            if (!tokenInfo) continue;

            const tokenDisplay = tokenInfo.isPumpToken ? 
              `🎯 PUMP ${tokenInfo.name}` : 
              `💰 ${tokenInfo.name}`;
            
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
            const numericChannelId = typeof TELEGRAM_CHANNEL_ID === 'string' ? parseInt(TELEGRAM_CHANNEL_ID) : TELEGRAM_CHANNEL_ID;
            await this.sendMessage(numericChannelId, message);
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
    try {
      this.isInitialLoad = true;  // Set initial load flag
      await this.displayCurrentBalances();
      this.isInitialLoad = false;  // Clear initial load flag after setup
      
      // Start monitoring transactions
      await this.monitorTransactions(1);
      await this.monitorTransactions(2);
      
      this.isTracking = true;
      logInfo("Wallet tracker started successfully");
    } catch (error) {
      logError(`Error starting wallet tracker: ${error}`);
      throw error;
    }
  }

  private async isUserAdmin(chatId: number | string, userId: number): Promise<boolean> {
    try {
      // First check if user is the BOT_ADMIN
      if (userId === Number(process.env.BOT_ADMIN)) {
        return true;
      }

      // Then check if user is a chat admin
      const numericChatId = typeof chatId === 'string' ? parseInt(chatId) : chatId;
      const chatMember = await this.bot.getChatMember(numericChatId, userId);
      return ['creator', 'administrator'].includes(chatMember.status);
    } catch (error) {
      logError(`Error checking admin status: ${error}`);
      return false;
    }
  }
}
