import { WalletTracker } from "./utils";
import { logError } from "./utils/logger";

const tracker = new WalletTracker();

process.on("uncaughtException", (error) => {
  try {
    logError(`Error starting wallet tracker: ${error}`);
  } catch (e) {
    console.error("Failed to log error:", e);
    console.error("Original error:", error);
  }
});

process.on("unhandledRejection", (error) => {
  try {
    logError(`Unhandled rejection in wallet tracker: ${error}`);
  } catch (e) {
    console.error("Failed to log error:", e);
    console.error("Original rejection:", error);
  }
});

async function main() {
  try {
    await tracker.start();
  } catch (error) {
    logError("Error starting wallet tracker:", error);
  }
}

main().catch((error) => {
  logError("Main process error:", error);
  logError("Restarting in 3 seconds...");
  setTimeout(() => {
    main();
  }, 3000);
});
