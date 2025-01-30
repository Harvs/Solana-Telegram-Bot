import { WalletTracker } from "./utils";
import { logError, logInfo } from "./utils/logger";

const tracker = new WalletTracker();

async function main() {
  try {
    await tracker.start();
  } catch (error) {
    logError("Error starting wallet tracker:", error);
    tracker.saveLog(`Error starting wallet tracker: ${error} `);
  }
}

main().catch((error) => {
  logError("Main process error:", error);
  logInfo("Restarting in 3 seconds...");
  setTimeout(() => {
    main();
  }, 3000);
});
