import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { DB_PATH, LOGFILE, PUMP_FUN_ADDRESS } from "../config/config";
import { Metaplex } from "@metaplex-foundation/js";
import { logInfo, logError } from "./logger";
import { 
  getAccount, 
  getMint, 
  getAssociatedTokenAddress, 
  unpackAccount, 
  TOKEN_2022_PROGRAM_ID as SPL_TOKEN_2022_PROGRAM_ID, 
  getTokenMetadata,
  getMetadataPointerState,
  ExtensionType,
  getExtensionTypes,
  TOKEN_PROGRAM_ID
} from "@solana/spl-token";

// Token Metadata Program ID
const TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

// Helper function to get metadata PDA
function findMetadataPda(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('metadata'),
      TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    TOKEN_METADATA_PROGRAM_ID
  );
  return pda;
}

// Function to decode Token-2022 metadata buffer
function decodeMetadata(buffer: Buffer): any {
  try {
    let offset = 1; // Skip key

    // Read update authority (32 bytes)
    const updateAuthority = new PublicKey(buffer.slice(offset, offset + 32));
    offset += 32;

    // Read mint (32 bytes)
    const mint = new PublicKey(buffer.slice(offset, offset + 32));
    offset += 32;

    // Read name
    const nameLength = buffer.readUInt32LE(offset);
    offset += 4;
    const name = buffer.slice(offset, offset + nameLength).toString('utf8').replace(/\0/g, '');
    offset += nameLength;

    // Read symbol
    const symbolLength = buffer.readUInt32LE(offset);
    offset += 4;
    const symbol = buffer.slice(offset, offset + symbolLength).toString('utf8').replace(/\0/g, '');
    offset += symbolLength;

    // Read uri
    const uriLength = buffer.readUInt32LE(offset);
    offset += 4;
    const uri = buffer.slice(offset, offset + uriLength).toString('utf8').replace(/\0/g, '');

    return {
      key: buffer[0],
      updateAuthority: updateAuthority.toBase58(),
      mint: mint.toBase58(),
      data: {
        name,
        symbol,
        uri,
      }
    };
  } catch (error) {
    logError(`Error decoding metadata: ${error}`);
    return null;
  }
}

async function getToken2022Metadata(connection: any, mintPublicKey: PublicKey) {
  try {
    // First check if the token has a metadata pointer
    const mint = await getMint(connection, mintPublicKey);
    const metadataPointer = await getMetadataPointerState(mint);
    if (metadataPointer) {
      logInfo(`Found metadata pointer for ${mintPublicKey.toString()}: ${JSON.stringify(metadataPointer)}`);
      // Use the pointer to fetch metadata
      const metadata = await getTokenMetadata(connection, mintPublicKey);
      if (metadata) {
        return metadata;
      }
    }

    // If no pointer or couldn't get metadata through pointer, try direct metadata fetch
    const metadata = await getTokenMetadata(connection, mintPublicKey);
    if (metadata) {
      return metadata;
    }

    return null;
  } catch (error) {
    logInfo(`Error getting Token-2022 metadata: ${error}`);
    return null;
  }
}

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
    logError('Error getting CA from signature:', error);
    return null;
  }
}

export async function getTokenInfo(connection: any, ca: string) {
  try {
    const mintPublicKey = new PublicKey(ca);

    // First, verify which token program this mint uses
    let mintInfo;
    let isToken2022 = false;
    let decimals = 9;
    let supply = 0;

    try {
      // Get account info to check program ID
      const accountInfo = await connection.getAccountInfo(mintPublicKey);
      isToken2022 = accountInfo?.owner.equals(SPL_TOKEN_2022_PROGRAM_ID);

      // Get mint info for decimals and supply
      mintInfo = await getMint(connection, mintPublicKey);
      decimals = mintInfo.decimals;
      supply = Number(mintInfo.supply) / Math.pow(10, decimals);

      // For Token-2022, check available extensions
      if (isToken2022) {
        try {
          const mintBuffer = accountInfo.data;
          const extensions = getExtensionTypes(mintBuffer);
          logInfo(`Token ${ca} has extensions: ${extensions.join(', ')}`);
        } catch (error) {
          logInfo(`Error getting token extensions: ${error}`);
        }
      }
    } catch (error) {
      logInfo(`Error getting mint info: ${error}`);
      // Try fallback method for account info
      const parsedAccountInfo = await connection.getParsedAccountInfo(mintPublicKey);
      if (parsedAccountInfo.value?.data?.parsed?.info) {
        decimals = parsedAccountInfo.value.data.parsed.info.decimals || 9;
        supply = parsedAccountInfo.value.data.parsed.info.supply
          ? Number(parsedAccountInfo.value.data.parsed.info.supply) / Math.pow(10, decimals)
          : 0;
      }
    }

    logInfo(`Token ${ca} is ${isToken2022 ? 'Token-2022' : 'SPL'} token`);

    // For Token-2022, first try to get metadata using Token-2022 specific methods
    if (isToken2022) {
      const token2022Metadata = await getToken2022Metadata(connection, mintPublicKey);
      if (token2022Metadata) {
        logInfo(`Found Token-2022 metadata for ${ca}: ${JSON.stringify(token2022Metadata)}`);

        // Get token price and calculate market cap
        const price = await getTokenPrice(ca);
        const mc = changeStyle(supply * price);

        return {
          name: token2022Metadata.name,
          symbol: token2022Metadata.symbol,
          decimals,
          supply,
          price,
          mc,
          isPumpToken: ca.toLowerCase().endsWith('pump'),
          isToken2022,
          uri: token2022Metadata.uri
        };
      }
    }

    // Try Metaplex as fallback
    try {
      const metaplex = new Metaplex(connection);
      const nftMetadata = await metaplex.nfts().findByMint({ mintAddress: mintPublicKey });
      logInfo(`Found Metaplex metadata for ${ca}: ${JSON.stringify(nftMetadata)}`);

      // Get token price and calculate market cap
      const price = await getTokenPrice(ca);
      const mc = changeStyle(supply * price);

      return {
        name: nftMetadata.name.replace(/\0/g, '').trim(),
        symbol: nftMetadata.symbol.replace(/\0/g, '').trim(),
        decimals,
        supply,
        price,
        mc,
        isPumpToken: ca.toLowerCase().endsWith('pump'),
        isToken2022
      };
    } catch (metaplexError) {
      logInfo(`Error getting Metaplex metadata: ${metaplexError}`);
    }

    // If all metadata lookups fail, return basic token info
    return {
      name: `Token ${ca.slice(0, 8)}...`,
      symbol: 'Unknown',
      decimals,
      supply,
      price: 0,
      mc: '0',
      isPumpToken: ca.toLowerCase().endsWith('pump'),
      isToken2022
    };
  } catch (error) {
    logError(`Error in getTokenInfo for ${ca}: ${error}`);
    return null;
  }
}

export async function getTokenPrice(ca: string) {
  try {
    const BaseURL = `https://api.jup.ag/price/v2?ids=${ca}`;

    const response = await fetch(BaseURL);
    const data = await response.json();
    const price = data.data[ca]?.price;
    return price;
  } catch (error) {
    logError('Error getting token price:', error);
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
  const logPath = path.join(process.cwd(), LOGFILE);
  if (fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, ""); 
    logInfo("wallet_tracker.log cleared successfully");
  }
};

export const clearDB = () => {
  const dbPath = path.join(process.cwd(), DB_PATH);

  if (fs.existsSync(dbPath)) {
    logInfo(`${DB_PATH} found, removing...`);
    fs.unlinkSync(dbPath);
    logInfo(`${DB_PATH} removed successfully`);
  }
};
