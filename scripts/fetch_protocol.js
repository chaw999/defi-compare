const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
require('dotenv').config();

// Configuration
const DATA_FILE = path.join(__dirname, '../addresses.yaml');
const OUTPUT_DIR = path.join(__dirname, '../data');

// Load Env Variables
const API_KEY = process.env.DEBANK_ACCESS_KEY;
const BASE_URL = process.env.DEBANK_API_URL || 'https://pro-openapi.debank.com';


// Target chains whitelist (internal IDs, not necessarily matching DeBank IDs directly if DeBank uses 'eth' etc.)
// Note: DeBank uses 'eth', 'bsc' etc. The user provided "evm--1" format which looks like OneKey or internal IDs.
// We need to map or filter based on what DeBank returns.
// Assuming the user WANTS to filter DeBank results to ONLY include chains that correspond to these IDs if possible,
// OR the user just wants to filter the list of chains returned by DeBank.

// Let's first define the target list.
// Since DeBank returns IDs like 'eth', 'bsc', 'matic', we might need a mapping if the user provides 'evm--1'.
// However, if the user just wants specific chains, let's assume we filter the `usedChains` list.

// Common DeBank Chain IDs: eth, bsc, matic, ftm, avax, op, arb, base, linea, zksync, manta, blast ...
// The user provided list looks like: "evm--1" (Mainnet), "evm--56" (BSC), "evm--137" (Polygon)...
// We need a mapper from "evm--ID" to DeBank ID, or just logic to filter.

// Mapping based on standard Chain IDs:
// 1 -> eth
// 10 -> op
// 56 -> bsc
// 137 -> matic
// 250 -> ftm
// 324 -> zksync
// 8453 -> base
// 42161 -> arb
// 43114 -> avax
// 59144 -> linea
// 534352 -> scroll
// 84532 -> base_sepolia (DeBank might not have this or use a different ID)

const TARGET_CHAIN_MAP = {
  1: 'eth',
  10: 'op',
  56: 'bsc',
  137: 'matic',
  250: 'ftm',
  324: 'zksync',
  8453: 'base',
  42161: 'arb',
  43114: 'avax',
  59144: 'linea',
  534352: 'scroll'
  // 'evm--84532': 'base_sepolia'? DeBank usually only tracks mainnets for portfolio.
};

const TARGET_CHAINS_IDS = [
  1, 10, 137, 250, 324, 42161, 43114, 534352, 56, 59144, 8453
];

// Helper to convert evm--ID or ID to DeBank Chain ID
const getDeBankChainId = (chainIdOrString) => {
  let numericId = chainIdOrString;
  if (typeof chainIdOrString === 'string' && chainIdOrString.startsWith('evm--')) {
    numericId = parseInt(chainIdOrString.split('--')[1]);
  }
  return TARGET_CHAIN_MAP[numericId];
};

// Generate the allowed DeBank chain list
const ALLOWED_DEBANK_CHAINS = TARGET_CHAINS_IDS.map(id => TARGET_CHAIN_MAP[id]).filter(Boolean);
console.log('Allowed DeBank Chains:', ALLOWED_DEBANK_CHAINS);

// Sleep helper
const sleep = (min, max) => {
  const ms = Math.floor(Math.random() * (max - min + 1) + min);
  return new Promise(resolve => setTimeout(resolve, ms));
};

// Create axios instance with default config
const createApiClient = () => {
  const config = {
    baseURL: BASE_URL,
    headers: {
      'AccessKey': API_KEY,
    },
    timeout: 10000
  };

  return axios.create(config);
};

const apiClient = createApiClient();

/**
 * Fetch used chains for a user
 * @param {string} address 
 * @returns {Promise<string[]>} List of chain IDs
 */
async function getUsedChains(address) {
  try {
    const response = await apiClient.get('/v1/user/used_chain_list', {
      params: { id: address }
    });
    return response.data.map(chain => chain.id);
  } catch (error) {
    console.error(`  ✗ Failed to fetch chains for ${address}: ${error.message}`);
    return [];
  }
}

/**
 * Fetch protocol data for a specific chain with retry logic
 * @param {string} address 
 * @param {string} chainId 
 * @returns {Promise<Array>} Protocol list
 */
async function getProtocolList(address, chainId) {
  const MAX_RETRIES = 3;
  let retries = 0;

  while (retries <= MAX_RETRIES) {
    try {
      const response = await apiClient.get('/v1/user/complex_protocol_list', {
        params: {
          id: address,
          chain_id: chainId
        }
      });
      return response.data || [];
    } catch (error) {
      if (error.response && error.response.status === 429) {
        retries++;
        const waitTime = 2000 + Math.random() * 1000;
        if (retries <= MAX_RETRIES) {
          await sleep(waitTime, waitTime);
          continue;
        }
      }
      // If 400/404 or max retries reached
      console.error(`    ✗ Error fetching ${chainId}: ${error.message}`);
      return [];
    }
  }
  return [];
}

async function main() {
  // Dynamic import for ESM-only modules (chalk)
  const { default: chalk } = await import('chalk');

  console.log(chalk.blue.bold('🚀 Starting DeBank Protocol Data Fetcher...'));

  // Check Env
  if (!API_KEY) {
    console.warn(chalk.yellow('⚠️  Warning: DEBANK_ACCESS_KEY is not set. Requests may fail.'));
  }

  try {
    // 1. Read YAML
    if (!fs.existsSync(DATA_FILE)) {
      throw new Error(`Data file not found: ${DATA_FILE}`);
    }

    console.log(chalk.gray(`📂 Reading addresses from ${DATA_FILE}...`));
    const fileContents = fs.readFileSync(DATA_FILE, 'utf8');
    const addresses = yaml.load(fileContents, { schema: yaml.FAILSAFE_SCHEMA });

    if (!Array.isArray(addresses)) {
      throw new Error('Invalid YAML format: Expected an array of addresses.');
    }

    console.log(chalk.green(`✅ Loaded ${addresses.length} addresses.`));
    console.log(chalk.gray('----------------------------------------'));

    // Ensure output directory exists
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    // 2. Process Addresses
    for (let i = 0; i < addresses.length; i++) {
      const address = addresses[i];
      const progress = `[${i + 1}/${addresses.length}]`;

      console.log(chalk.yellow(`${progress} Processing ${address}...`));

      // Step A: Get Used Chains
      process.stdout.write(chalk.gray(`  ↳ Fetching active chains... `));
      let usedChains = await getUsedChains(address);

      if (usedChains.length === 0) {
        console.log(chalk.red('No active chains found or API error.'));
        continue;
      }

      // FILTER: Only keep chains that are in our ALLOWED list
      const originalCount = usedChains.length;
      usedChains = usedChains.filter(c => ALLOWED_DEBANK_CHAINS.includes(c));

      console.log(chalk.blue(`${usedChains.length}/${originalCount} chains matched target list (${usedChains.join(', ')})`));

      if (usedChains.length === 0) {
        console.log(chalk.yellow('  ⚠️ No matching target chains active for this address.'));
        continue;
      }

      // Step B: Fetch Protocols per Chain
      let allProtocols = [];
      for (const chainId of usedChains) {
        process.stdout.write(chalk.gray(`    Fetching ${chainId}... `));
        const protocols = await getProtocolList(address, chainId);

        if (protocols.length > 0) {
          allProtocols.push(...protocols);
          console.log(chalk.green(`✓ (${protocols.length})`));

          // Save INDIVIDUAL chain data
          // Create directory for address if it doesn't exist
          const addressDir = path.join(OUTPUT_DIR, address);
          if (!fs.existsSync(addressDir)) {
            fs.mkdirSync(addressDir, { recursive: true });
          }

          const chainFilename = `${chainId}.json`;
          const chainSavePath = path.join(addressDir, chainFilename);
          fs.writeFileSync(chainSavePath, JSON.stringify(protocols, null, 2));
          // console.log(chalk.gray(`      ↳ Saved to ${address}/${chainFilename}`));

        } else {
          console.log(chalk.gray(`- (0)`));
        }

        // Rate limit between chains
        await sleep(200, 500);
      }

      // Step C: Save Data
      if (allProtocols.length > 0) {
        const addressDir = path.join(OUTPUT_DIR, address);
        if (!fs.existsSync(addressDir)) {
          fs.mkdirSync(addressDir, { recursive: true });
        }

        const filename = `all_protocols.json`;
        const savePath = path.join(addressDir, filename);
        fs.writeFileSync(savePath, JSON.stringify(allProtocols, null, 2));
        console.log(chalk.green(`  ✨ Saved ${allProtocols.length} protocols to ${address}/${filename}`));
      } else {
        console.log(chalk.yellow(`  ⚠️ No protocol data found.`));
      }

      console.log(chalk.gray('----------------------------------------'));

      // Rate limiting sleep between addresses
      if (i < addresses.length - 1) {
        await sleep(1000, 2000);
      }
    }

    console.log(chalk.blue.bold('✨ All done!'));

  } catch (e) {
    console.error(chalk.red.bold('\n⛔ Fatal Error:'));
    console.error(chalk.red(e.message));
    process.exit(1);
  }
}

main();

