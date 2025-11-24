const fs = require('fs');
const path = require('path');

const DATA_DIR_DEBANK = path.join(__dirname, '../data');
const DATA_DIR_ZERION = path.join(__dirname, '../data_zerion');
const OUTPUT_FILE = path.join(__dirname, '../comparison_data.json');

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
  'zksync': 'zksync-era',
  'scroll': 'scroll'
};

// Reverse Map for reading DeBank files
// DeBank uses: eth, bsc, matic, ftm, avax, op, arb, base, linea, scroll, zksync (maybe?)
// Let's just rely on the filename in the data directory if possible, or the content.

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
            symbol: token.symbol,
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
            symbol: token.symbol,
            amount: token.amount,
            price: token.price,
            value: (token.amount * token.price) * -1, // Debt is negative value in this context? Or just track amount.
            type: 'borrow'
          });
        });
      }
      // TODO: Rewards, etc.
    });
  });

  return { protocols, totalValue };
}

// Normalize Zerion Protocol Data
function normalizeZerion(chainDataRaw) {
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
    // if (!attrs.protocol) return; 
    // User wants "Protocol" comparison. Wallet assets in Zerion have protocol=null.
    // DeBank usually separates "Wallet" from "Protocols". 
    // Let's group null protocol as "Wallet" for Zerion to see if DeBank has equivalent?
    // DeBank usually DOES NOT return wallet balances in the `complex_protocol_list` endpoint.
    // So let's skip protocol=null for apples-to-apples protocol comparison.
    if (!attrs.protocol) return;

    const protoName = attrs.protocol;

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

    protocols[protoName].assets.push({
      symbol: attrs.fungible_info?.symbol || '?',
      amount: attrs.quantity?.float || 0,
      price: attrs.price || 0,
      value: val,
      type: attrs.position_type, // 'staked', 'deposited', etc.
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
        zerion: normalizeZerion(zerionDataRaw || [])
      };
    });
  });

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
  console.log(`Generated comparison data at ${OUTPUT_FILE}`);
}

main();

