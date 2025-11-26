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
    'MakerDAO': 'Maker',
    'ParaSwap': 'Velora',
  },
  'optimism': {
    'Velodrome': 'Velodrome V2',
    'Velodrome V2': 'Velodrome',
  }
};

// Target addresses from dashboard/index.html addressOrder
const TARGET_ADDRESSES = [
  "0x9d17bb55b57b31329cf01aa7017948e398b277bc",
  "0x5c9e30def85334e587cf36eb07bdd6a72bf1452d",
  "0xd92293daca6bbed57f8cb6d498b48ea93e035e99",
  "0x15b325660a1C4a9582a7d834C31119C0CB9e3A42",
  "0x47441bd9fb3441370cb5b6c4684a0104353aec66",
  "0x011b0a055e02425461a1ae95b30f483c4ff05be7",
  "0x0b32aa5c1e71715206fe29b7badb21ad95f272c0",
  "0x87f16c31e32ae543278f5194cf94862f1cb1eee0",
  "0xbbbc35dfac3a00a03a8fde3540eca4f0e15c5e64",
  "0x4e5ed30e3b4eb39abce3c150f31e180a3ae5806e",
  "0x84a6a7c0674a3aa03e09c026600cb46181821f07",
  "0x5c051c0ff69b6f5fdd47e847eb370dd48726ec4d",
  "0x7bfee91193d9df2ac0bfe90191d40f23c773c060",
  "0xde6b2a06407575b98724818445178c1f5fd53361",
  "0xbdfa4f4492dd7b7cf211209c4791af8d52bf5c50",
  "0x33eecc48943aaeabb5328a25ff28eb85f67945c2",
  "0x3e8734ec146c981e3ed1f6b582d447dde701d90c"
].map(addr => addr.toLowerCase());

function getDirectories(srcPath) {
  return fs.readdirSync(srcPath).filter(file => {
    return fs.statSync(path.join(srcPath, file)).isDirectory();
  });
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
      // Handle Vesting (Single Token in Detail)
      if (item.detail && item.detail.token) {
        const token = item.detail.token;
        protocols[protoName].assets.push({
          symbol: token.symbol.trim(),
          amount: token.amount,
          price: token.price,
          value: (token.amount * token.price),
          type: 'vesting' // Treat as supply/vesting
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
  let addresses = getDirectories(DATA_DIR_DEBANK);
  
  // Filter addresses based on TARGET_ADDRESSES
  if (TARGET_ADDRESSES.length > 0) {
    addresses = addresses.filter(addr => TARGET_ADDRESSES.includes(addr.toLowerCase()));
  }

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

      const debankDataRaw = readJson(debankFile) || []; // Default to empty array if missing
      const zerionDataRaw = readJson(zerionFile) || []; // Default to empty array if missing

      result[address][zerionChainId] = {
        debank: normalizeDeBank(debankDataRaw),
        zerion: normalizeZerion(zerionDataRaw, zerionChainId)
      };
    });
  });

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
  console.log(`Generated comparison data at ${OUTPUT_FILE}`);
}

main();

