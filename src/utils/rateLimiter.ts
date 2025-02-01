import { logError } from './logger';

interface RateLimit {
  lastMessageTime: number;
  messageCount: number;
  resetTime: number;
  retryAfter?: number;  // Added for handling 429 responses
}

export class RateLimiter {
  private chatLimits: Map<number, RateLimit> = new Map();
  private globalMessageCount: number = 0;
  private lastGlobalReset: number = Date.now();
  private lastPollingTime: number = 0;
  private consecutiveErrors: number = 0;
  
  private readonly GLOBAL_LIMIT = 30; // messages per second
  private readonly CHAT_LIMIT = 1; // message per second for individual chats
  private readonly GROUP_LIMIT = 20; // messages per minute for group chats
  private readonly RESET_INTERVAL = 1000; // 1 second in ms
  private readonly GROUP_RESET_INTERVAL = 60000; // 1 minute in ms
  private readonly POLLING_INTERVAL = 1000; // Base polling interval
  private readonly MAX_POLLING_INTERVAL = 30000; // Maximum polling interval (30 seconds)
  private readonly MAX_BACKOFF_ATTEMPTS = 10; // Maximum number of backoff attempts

  async waitForRateLimit(chatId: number, isGroup: boolean = false): Promise<void> {
    // Reset global counter if needed
    if (Date.now() - this.lastGlobalReset >= this.RESET_INTERVAL) {
      this.globalMessageCount = 0;
      this.lastGlobalReset = Date.now();
    }

    // Initialize or get chat limit
    if (!this.chatLimits.has(chatId)) {
      this.chatLimits.set(chatId, {
        lastMessageTime: 0,
        messageCount: 0,
        resetTime: Date.now()
      });
    }

    const limit = this.chatLimits.get(chatId)!;
    const resetInterval = isGroup ? this.GROUP_RESET_INTERVAL : this.RESET_INTERVAL;
    const messageLimit = isGroup ? this.GROUP_LIMIT : this.CHAT_LIMIT;

    // Handle retry after if set
    if (limit.retryAfter && Date.now() < limit.retryAfter) {
      const waitTime = limit.retryAfter - Date.now();
      await new Promise(resolve => setTimeout(resolve, waitTime));
      limit.retryAfter = undefined;
    }

    // Reset chat counter if needed
    if (Date.now() - limit.resetTime >= resetInterval) {
      limit.messageCount = 0;
      limit.resetTime = Date.now();
    }

    // Wait if we've hit the rate limit
    while (
      this.globalMessageCount >= this.GLOBAL_LIMIT ||
      limit.messageCount >= messageLimit ||
      Date.now() - limit.lastMessageTime < (isGroup ? 3000 : 1000) // Minimum delay between messages
    ) {
      const waitTime = Math.max(
        1000, // Minimum wait time
        Math.min(
          this.RESET_INTERVAL - (Date.now() - this.lastGlobalReset),
          resetInterval - (Date.now() - limit.resetTime),
          isGroup ? 3000 : 1000 - (Date.now() - limit.lastMessageTime)
        )
      );

      await new Promise(resolve => setTimeout(resolve, waitTime));

      // Reset counters if enough time has passed
      if (Date.now() - this.lastGlobalReset >= this.RESET_INTERVAL) {
        this.globalMessageCount = 0;
        this.lastGlobalReset = Date.now();
      }
      if (Date.now() - limit.resetTime >= resetInterval) {
        limit.messageCount = 0;
        limit.resetTime = Date.now();
      }
    }

    // Update counters
    this.globalMessageCount++;
    limit.messageCount++;
    limit.lastMessageTime = Date.now();
  }

  // Handle rate limit errors from Telegram
  handleRateLimitError(chatId: number, retryAfterSeconds: number): void {
    const limit = this.chatLimits.get(chatId);
    if (limit) {
      limit.retryAfter = Date.now() + (retryAfterSeconds * 1000);
      limit.messageCount = this.CHAT_LIMIT; // Force rate limiting
    }
  }

  // Get polling interval with exponential backoff
  getPollingInterval(): number {
    const now = Date.now();
    const timeSinceLastPoll = now - this.lastPollingTime;
    
    // If we've waited long enough, reset the error count
    if (timeSinceLastPoll >= this.MAX_POLLING_INTERVAL) {
      this.consecutiveErrors = 0;
    }

    // Calculate backoff interval
    const backoffInterval = Math.min(
      this.POLLING_INTERVAL * Math.pow(2, this.consecutiveErrors),
      this.MAX_POLLING_INTERVAL
    );

    this.lastPollingTime = now;
    return backoffInterval;
  }

  // Handle polling errors
  handlePollingError(error: any): number {
    // Increment error counter but cap it
    this.consecutiveErrors = Math.min(this.consecutiveErrors + 1, this.MAX_BACKOFF_ATTEMPTS);
    
    // If it's a 429 error with retry_after, use that value
    if (error?.message?.includes('ETELEGRAM: 429') && error?.message?.includes('retry after')) {
      const retryAfter = parseInt(error.message.match(/retry after (\d+)/)?.[1] || '5');
      return retryAfter * 1000;
    }

    // For other errors, use exponential backoff
    return this.getPollingInterval();
  }

  // Reset error count when polling is successful
  handlePollingSuccess(): void {
    this.consecutiveErrors = 0;
  }

  // Helper method to check if we should wait before sending
  shouldWait(chatId: number, isGroup: boolean = false): boolean {
    const limit = this.chatLimits.get(chatId);
    if (!limit) return false;

    const resetInterval = isGroup ? this.GROUP_RESET_INTERVAL : this.RESET_INTERVAL;
    const messageLimit = isGroup ? this.GROUP_LIMIT : this.CHAT_LIMIT;

    return (
      this.globalMessageCount >= this.GLOBAL_LIMIT ||
      limit.messageCount >= messageLimit ||
      Date.now() - limit.lastMessageTime < (isGroup ? 3000 : 1000)
    );
  }

  // Get estimated wait time in milliseconds
  getWaitTime(chatId: number, isGroup: boolean = false): number {
    const limit = this.chatLimits.get(chatId);
    if (!limit) return 0;

    const resetInterval = isGroup ? this.GROUP_RESET_INTERVAL : this.RESET_INTERVAL;
    const timeSinceLastMessage = Date.now() - limit.lastMessageTime;
    const timeUntilReset = resetInterval - (Date.now() - limit.resetTime);

    return Math.max(
      0,
      Math.min(
        this.RESET_INTERVAL - (Date.now() - this.lastGlobalReset),
        timeUntilReset,
        isGroup ? 3000 - timeSinceLastMessage : 1000 - timeSinceLastMessage
      )
    );
  }
}
