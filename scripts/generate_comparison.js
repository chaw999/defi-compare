const fs = require('fs');
const path = require('path');

const DATA_DIR_DEBANK = path.join(__dirname, '../data');
const DATA_DIR_ZERION = path.join(__dirname, '../data_zerion');
const OUTPUT_FILE = path.join(__dirname, '../dashboard/comparison_data.json');

// Chain Mapping: DeBank -> Zerion (Standardized to Zerion IDs for keying)
const CHAIN_MAP = {
  'eth': 'ethereum',
  'bsc': 'binance-smart-chain',
  'matic': 'polygon',
  'ftm': 'fantom',
  'avax': 'avalanche',
  'op': 'optimism',
  'arb': 'arbitrum',
  'base': 'base',
  'linea': 'linea',
  'era': 'zksync-era',
  'scrl': 'scroll'
};

// Reverse Map for reading DeBank files
// DeBank uses: eth, bsc, matic, ftm, avax, op, arb, base, linea, scroll, zksync (maybe?)
// Let's just rely on the filename in the data directory if possible, or the content.

// Protocol Name Mapping (Zerion -> DeBank)
const PROTOCOL_NAME_MAP = {
  'binance-smart-chain': {
    'Helio': 'Lista DAO'
  },
  'ethereum': {
    'Morpho Blue': 'Morpho',
    'Tokemak': 'AUTO Finance',
    'Spool': 'Yelay',
    'Euler v2': 'Euler',
    'Compound V2': 'Compound',
    'MakerDAO': 'Maker'
  },
  'optimism': {
    'Velodrome V2': 'Velodrome'
  }
};

function getDirectories(srcPath) {
  return fs.readdirSync(srcPath).filter(file => fs.statSync(path.join(srcPath, file)).isDirectory());
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.error(`Error reading ${filePath}:`, e.message);
    return null;
  }
}

// Normalize DeBank Protocol Data
function normalizeDeBank(chainData) {
  const protocols = {};
  let totalValue = 0;

  if (!Array.isArray(chainData)) return { protocols, totalValue };

  chainData.forEach(proto => {
    // DeBank "Name" is usually the Protocol Name (e.g. "Aave V3")
    const protoName = proto.name || 'Unknown';

    if (!protocols[protoName]) {
      protocols[protoName] = {
        name: protoName,
        id: proto.id,
        value: 0,
        assets: []
      };
    }

    // Sum up portfolio items
    proto.portfolio_item_list.forEach(item => {
      const val = item.stats.net_usd_value || 0;
      protocols[protoName].value += val;
      totalValue += val;

      // Extract tokens from detail
      if (item.detail && item.detail.supply_token_list) {
        item.detail.supply_token_list.forEach(token => {
          protocols[protoName].assets.push({
            symbol: token.symbol.trim(), // Normalize symbol
            amount: token.amount,
            price: token.price,
            value: (token.amount * token.price),
            type: 'supply'
          });
        });
      }
      if (item.detail && item.detail.borrow_token_list) {
        item.detail.borrow_token_list.forEach(token => {
          protocols[protoName].assets.push({
            symbol: token.symbol.trim(), // Normalize symbol
            amount: token.amount,
            price: token.price,
            value: (token.amount * token.price) * -1, // Debt is negative value in this context? Or just track amount.
            type: 'borrow'
          });
        });
      }
      if (item.detail && item.detail.reward_token_list) {
        item.detail.reward_token_list.forEach(token => {
          // Normalize symbols for DeBank too
          let symbol = token.symbol.trim();
          // if (symbol === 'WAVAX') symbol = 'AVAX'; // Normalize WAVAX -> AVAX

          protocols[protoName].assets.push({
            symbol: symbol,
            amount: token.amount,
            price: token.price,
            value: (token.amount * token.price),
            type: 'reward'
          });
        });
      }
    });
  });

  return { protocols, totalValue };
}

// Normalize Zerion Protocol Data
function normalizeZerion(chainDataRaw, chainId) {
  const protocols = {};
  let totalValue = 0;

  // Check for 'data' wrapper or direct array (Zerion script output wrapper)
  let items = [];
  if (chainDataRaw.data && Array.isArray(chainDataRaw.data)) {
    items = chainDataRaw.data;
  } else if (Array.isArray(chainDataRaw)) {
    items = chainDataRaw;
  }

  items.forEach(pos => {
    const attrs = pos.attributes;
    if (!attrs) return;

    // Filter out wallet assets (Protocol is null)
    if (!attrs.protocol) return;

    let protoName = attrs.protocol;

    // Apply Protocol Name Mapping
    if (chainId && PROTOCOL_NAME_MAP[chainId] && PROTOCOL_NAME_MAP[chainId][protoName]) {
      protoName = PROTOCOL_NAME_MAP[chainId][protoName];
    }

    if (!protocols[protoName]) {
      protocols[protoName] = {
        name: protoName,
        id: protoName, // Zerion doesn't give a stable slug ID easily here, use name
        value: 0,
        assets: []
      };
    }

    const val = attrs.value || 0;
    protocols[protoName].value += val;
    totalValue += val;

    let type = attrs.position_type;
    // Fix: Zerion 'locked' and 'staked' is equivalent to DeBank 'supply'
    if (type === 'locked' || type === 'staked') {
      type = 'supply';
    }

    let symbol = attrs.fungible_info?.symbol || '?';
    // Normalize symbols
    symbol = symbol.trim();

    // Fix: Avalanche Aave uses AVAX for Wrapped AVAX in Zerion, but WAVAX in DeBank
    // We standardize to AVAX to match Zerion's usage in this context for better matching
    // if (symbol === 'WAVAX') {
    //   symbol = 'AVAX';
    // }

    protocols[protoName].assets.push({
      symbol: symbol,
      amount: attrs.quantity?.float || 0,
      price: attrs.price || 0,
      value: val,
      type: type, // 'staked', 'deposited', etc.
      flags: attrs.fungible_info?.flags // Capture flags for risk analysis
    });
  });

  return { protocols, totalValue };
}

function main() {
  const addresses = getDirectories(DATA_DIR_DEBANK);
  const result = {};

  addresses.forEach(address => {
    result[address] = {};

    // Identify common chains between both datasets for this address
    // Iterate our CHAIN_MAP keys (DeBank IDs)
    Object.keys(CHAIN_MAP).forEach(debankChainId => {
      const zerionChainId = CHAIN_MAP[debankChainId];

      const debankFile = path.join(DATA_DIR_DEBANK, address, `${debankChainId}.json`);
      const zerionFile = path.join(DATA_DIR_ZERION, address, `${zerionChainId}.json`);

      // Only process if at least one exists
      if (!fs.existsSync(debankFile) && !fs.existsSync(zerionFile)) return;

      const debankDataRaw = readJson(debankFile);
      const zerionDataRaw = readJson(zerionFile);

      result[address][zerionChainId] = {
        debank: normalizeDeBank(debankDataRaw),
        zerion: normalizeZerion(zerionDataRaw || [], zerionChainId)
      };
    });
  });

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
  console.log(`Generated comparison data at ${OUTPUT_FILE}`);
}

main();

