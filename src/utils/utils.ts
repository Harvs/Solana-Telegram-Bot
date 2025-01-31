import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { DB_PATH, LOGFILE, PUMP_FUN_ADDRESS } from "../config/config";
import { Metaplex } from "@metaplex-foundation/js";
import { get } from "http";

export async function getTransactionDetails(
  connection: any,
  signature: string
) {
  const txn = await connection.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });

  if (txn?.meta && txn.transaction) {
    const instructions = txn.transaction.message.instructions;

    const timestamp = txn.blockTime
      ? new Date(txn.blockTime * 1000).toISOString()
      : new Date().toISOString();

    const preBalances = txn.meta.preBalances;
    const postBalances = txn.meta.postBalances;
    const balanceChange = (postBalances[0] - preBalances[0]) / LAMPORTS_PER_SOL;

    const details = {
      signature,
      timestamp,
      balanceChange: `${balanceChange} SOL`,
      sender: txn.transaction.message.accountKeys[0].pubkey.toString(),
      instructions: instructions.map((ix: any) => {
        if ("parsed" in ix) {
          return {
            program: ix.program,
            type: ix.parsed.type,
            receiver: ix.parsed.info.destination,
          };
        }
        return {
          programId: ix.programId.toString(),
        };
      }),
      logs: txn.meta.logs,
    };

    return details;
  }
}

export async function getSignature2CA(connection: any, signature: string): Promise<string | null> {
  try {
    const tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });

    if (!tx?.meta?.innerInstructions?.[0]?.instructions) {
      return null;
    }

    for (const ix of tx.meta.innerInstructions[0].instructions) {
      if (ix.parsed?.type === 'mintTo' || ix.parsed?.type === 'transferChecked') {
        return ix.parsed.info.mint;
      }
    }

    return null;
  } catch (error) {
    console.error('Error getting CA from signature:', error);
    return null;
  }
}

export async function getTokenInfo(connection: any, ca: string) {
  try {
    const metaplex = new Metaplex(connection);
    const mintPublicKey = new PublicKey(ca);
    const nft = await metaplex.nfts().findByMint({ mintAddress: mintPublicKey });
    
    // Get token supply and decimals
    const decimal = nft.mint?.decimals || 9;
    const supply = nft.mint?.supply ? Number(nft.mint.supply.basisPoints) / Math.pow(10, decimal) : 0;
    
    // Get token price and calculate market cap
    const price = await getTokenPrice(ca);
    const mc = changeStyle(supply * price);

    // For pump.fun tokens, we want to use the actual token name
    let name = nft.name || 'Unknown';
    let symbol = nft.symbol || 'Unknown';

    // Clean up the name by removing null bytes and trimming
    name = name.replace(/\0/g, '').trim();
    symbol = symbol.replace(/\0/g, '').trim();

    // If it's a pump.fun token, use the name as the symbol
    if (ca.toLowerCase().endsWith('pump')) {
      symbol = name;
    }

    return {
      name,
      symbol,
      decimals: decimal,
      mc: mc || '0',
      supply: supply,
      isPumpToken: ca.toLowerCase().endsWith('pump')
    };
  } catch (error) {
    console.error('Error getting token info:', error);
    return {
      name: 'Unknown',
      symbol: 'Unknown',
      decimals: 9,
      mc: '0',
      supply: 0,
      isPumpToken: false
    };
  }
}

export async function getTokenPrice(ca: string) {
  try {
    const BaseURL = `https://api.jup.ag/price/v2?ids=${ca}`;

    const response = await fetch(BaseURL);
    const data = await response.json();
    // console.log("data", data);
    const price = data.data[ca]?.price;
    return price;
  } catch (error) {
    return 0;
  }
}

export function changeStyle(input: number): string {
  if (isNaN(input) || !isFinite(input)) return '0';
  
  const suffixes = ['', 'K', 'M', 'B', 'T'];
  const magnitude = Math.floor(Math.log10(Math.abs(input)) / 3);
  const scaledNumber = input / Math.pow(10, magnitude * 3);
  const suffix = suffixes[magnitude] || '';
  
  return scaledNumber.toFixed(2) + suffix;
};

export const txnLink = (txn: string) => {
  return `<a href="https://solscan.io/tx/${txn}">TX</a>`;
};

export const shortenAddress = (address: string, chars = 4): string => {
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
};

export const shortenAddressWithLink = (address: string, symbol:string): string => {
  return `<a href="https://solscan.io/account/${address}">${symbol}</a>`;
};

export function birdeyeLink(address: string): string {
  return `<a href="https://birdeye.so/token/${address}">Birdeye</a>`;
}

export function dextoolLink(address: string): string {
  return `<a href="https://www.dextools.io/app/en/solana/pair-explorer/${address}">Dextools</a>`;
}

export const clearLogs = () => {
  // Clear the log file at startup
  const logPath = path.join(process.cwd(), LOGFILE);
  if (fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, ""); // Write empty string to clear the file
    console.log("wallet_tracker.log cleared successfully");
  }
};

export const clearDB = () => {
  const dbPath = path.join(process.cwd(), DB_PATH);

  if (fs.existsSync(dbPath)) {
    console.log(`${DB_PATH} found, removing...`);
    fs.unlinkSync(dbPath);
    console.log(`${DB_PATH} removed successfully`);
  }
};
