const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const axios = require('axios');
require('dotenv').config();

// Configuration
const DATA_FILE = path.join(__dirname, '../addresses.yaml');
const OUTPUT_DIR = path.join(__dirname, '../data_zerion');

// Load Env Variables
const API_KEY = process.env.ZERION_API_KEY;
const BASE_URL = 'https://api.zerion.io/v1';

// Target Chains Map (User provided IDs -> Zerion Chain IDs)
// Note: Zerion uses IDs like 'ethereum', 'binance-smart-chain', 'polygon', etc.
// Mapping from EVM Chain ID to Zerion Chain ID
const TARGET_CHAIN_MAP = {
  1: 'ethereum',
  10: 'optimism',
  56: 'binance-smart-chain',
  137: 'polygon',
  250: 'fantom',
  324: 'zksync-era',
  8453: 'base',
  42161: 'arbitrum',
  43114: 'avalanche',
  59144: 'linea',
  534352: 'scroll'
};

const TARGET_CHAINS_IDS = [
  1, 10, 137, 250, 324, 42161, 43114, 534352, 56, 59144, 8453
];

// Generate allowed Zerion chain list
const ALLOWED_ZERION_CHAINS = TARGET_CHAINS_IDS.map(id => TARGET_CHAIN_MAP[id]).filter(Boolean);

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
      'accept': 'application/json',
      'authorization': `Basic ${Buffer.from(API_KEY + ':').toString('base64')}`
    },
    timeout: 15000
  };

  return axios.create(config);
};

const apiClient = createApiClient();

/**
 * Fetch wallet positions (assets/protocols) from Zerion
 * Endpoint: /wallets/{address}/positions
 * Docs: https://developers.zerion.io/reference/listwalletpositions
 */
async function getWalletPositions(address) {
  const MAX_RETRIES = 3;
  let retries = 0;

  while (retries < MAX_RETRIES) {
    try {
      // Using /positions endpoint to get actual asset list
      // Note: This usually returns tokens/assets.
      // For DeFi protocol positions (like Aave lending), we might need to check if they are included here 
      // OR if we need a different parameter. Zerion docs say:
      // "Liquidity pools (Uniswap, Curve, Balancer, etc.) return multiple positions - one for each token in the pool."
      // This implies protocol positions ARE included in this endpoint.

      const response = await apiClient.get(`/wallets/${address}/positions`, {
        params: {
          'currency': 'usd',
          'filter[positions]': 'no_filter',
          'filter[trash]': 'no_filter',
          // 'filter[position_types]': 'wallet,deposited,borrowed,locked,staked' // Ensure we get everything
        }
      });

      if (response.status === 202) {
        console.log('    ⏳ Data processing (202), retrying in 3s...');
        await sleep(3000, 4000);
        retries++;
        continue;
      }

      // JSON:API format: data is an array of position objects
      return response.data.data;
    } catch (error) {
      if (error.response && error.response.status === 429) {
        console.log('    ⏳ Rate limited (429), retrying in 5s...');
        await sleep(5000, 6000);
        retries++;
        continue;
      }
      console.error(`    ✗ Error fetching positions: ${error.message}`);
      return null;
    }
  }
  return null;
}

async function main() {
  // Dynamic import for ESM-only modules (chalk)
  const { default: chalk } = await import('chalk');

  console.log(chalk.blue.bold('🚀 Starting Zerion Protocol Data Fetcher...'));
  console.log(chalk.gray(`Target Chains: ${ALLOWED_ZERION_CHAINS.join(', ')}`));

  if (!API_KEY) {
    console.warn(chalk.yellow('⚠️  Warning: ZERION_API_KEY is not set. Requests will fail.'));
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

      // Create address specific directory
      const addressDir = path.join(OUTPUT_DIR, address);
      if (!fs.existsSync(addressDir)) {
        fs.mkdirSync(addressDir, { recursive: true });
      }

      // Zerion API response structure:
      // { data: { id: "portfolio-id", type: "portfolio", attributes: { ... } } }
      // The actual positions are usually NOT in the main response of /wallets/{address}/portfolio.
      // Wait, looking at the docs and typical JSON:API response:
      // The /v1/wallets/{address}/portfolio endpoint returns a "portfolio" object.
      // But usually for POSITIONS, we need: /v1/wallets/{address}/positions
      // OR the portfolio endpoint returns aggregate stats.

      // However, if the user wants POSITIONS (protocols, tokens), the endpoint is likely:
      // /v1/wallets/{address}/positions
      // The user's previous error "positions.forEach is not a function" suggests we were trying to iterate over an object.

      // Let's correct the endpoint to get actual POSITIONS if that's what we want (DeFi protocols).
      // OR if we stick to /portfolio, we need to see what it returns. 
      // Docs say: "This endpoint returns the portfolio overview".
      // It typically returns `data: { attributes: { positions_distribution_by_type: ..., total: ... } }`
      // It does NOT return an array of positions directly in `data`.

      // To get the detailed list of assets/protocols like DeBank, we should use:
      // GET /v1/wallets/{address}/positions
      // Docs: https://developers.zerion.io/reference/listwalletpositions

      console.log(chalk.yellow('    ⚠️  Correcting endpoint to fetch POSITIONS...'));
      const positionsData = await getWalletPositions(address);

      if (!positionsData || !Array.isArray(positionsData)) {
        console.log(chalk.yellow(`    ⚠️  No positions found or invalid format.`));
        continue;
      }

      const positions = positionsData;
      console.log(chalk.green(`✓ Got ${positions.length} positions`));

      // Group positions by Chain
      const chainData = {};

      // Initialize buckets for our target chains
      ALLOWED_ZERION_CHAINS.forEach(chain => {
        chainData[chain] = [];
      });

      let matchCount = 0;

      positions.forEach(pos => {
        // Extract chain ID from relationships
        // Structure: data[i].relationships.chain.data.id (e.g. "ethereum")
        const chainId = pos.relationships?.chain?.data?.id;

        if (chainId && ALLOWED_ZERION_CHAINS.includes(chainId)) {
          chainData[chainId].push(pos);
          matchCount++;
        }
      });

      console.log(chalk.blue(`  ↳ Matched ${matchCount} positions on target chains.`));

      // Save individual chain files
      for (const chainId of ALLOWED_ZERION_CHAINS) {
        const chainPositions = chainData[chainId];
        if (chainPositions && chainPositions.length > 0) {
          // Map Zerion ID back to EVM numeric ID if needed, or use Zerion ID as filename
          // To keep consistent with previous script, we can try to map back or just use the Zerion ID name
          // Let's use the Zerion ID name (e.g. "arbitrum.json") which is readable

          const filename = `${chainId}.json`;
          const savePath = path.join(addressDir, filename);

          // Construct a wrapper object similar to response or just the array
          const output = {
            data: chainPositions,
            meta: {
              chain_id: chainId,
              address: address,
              timestamp: new Date().toISOString()
            }
          };

          fs.writeFileSync(savePath, JSON.stringify(output, null, 2));
          console.log(chalk.gray(`    • Saved ${chainId}.json (${chainPositions.length} items)`));
        }
      }

      // Save Full Raw Response for debugging/backup
      // fs.writeFileSync(path.join(addressDir, 'full_zerion_raw.json'), JSON.stringify(portfolioData, null, 2));

      console.log(chalk.gray('----------------------------------------'));

      // Rate limit
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

