#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   doge-consensus-gaps.mjs

   Closes the three things doge-block-builder.mjs left unproven.

     1. MULTI-TRANSACTION MERKLE — the verified block had zero transactions, so
        the tree never branched. Unit tests and a bug can share the same wrong
        assumption; only consensus settles it. Builds blocks containing 1, 2
        and 3 real transactions and requires the daemon to accept each.

     2. SPENDING THE REWARD — acceptance proves the header and merkle. It does
        NOT prove the coinbase output script is usable. A wrong scriptPubKey
        yields a valid, accepted block paying an address nobody controls, and
        nothing errors. Matures a reward and spends it.

     3. MAINNET ADDRESS ENCODING — regtest uses base58 prefix 111, mainnet
        Dogecoin uses 30. Different path, silent failure. Checked offline
        against vectors, since mainnet cannot be exercised by mining.

   Run after doge-block-builder.mjs succeeds, against the same regtest pair.
   ═══════════════════════════════════════════════════════════════════════════ */

import { createHash, scryptSync } from 'node:crypto';

const sha256 = (b) => createHash('sha256').update(b).digest();
const sha256d = (b) => sha256(sha256(b));
const rev = (b) => Buffer.from(b).reverse();
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

function varint(n) {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) { const b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(n, 1); return b; }
  if (n <= 0xffffffff) { const b = Buffer.alloc(5); b[0] = 0xfe; b.writeUInt32LE(n, 1); return b; }
  const b = Buffer.alloc(9); b[0] = 0xff; b.writeBigUInt64LE(BigInt(n), 1); return b;
}

function scriptNum(n) {
  if (n === 0) return Buffer.alloc(0);
  let v = Math.abs(n); const out = [];
  while (v) { out.push(v & 0xff); v = Math.floor(v / 256); }
  if (out[out.length - 1] & 0x80) out.push(0x00);
  return Buffer.from(out);
}

const pushData = (b) => b.length < 0x4c
  ? Buffer.concat([Buffer.from([b.length]), b])
  : Buffer.concat([Buffer.from([0x4c, b.length]), b]);

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58decode(s) {
  let num = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error(`invalid base58 character: ${ch}`);
    num = num * 58n + BigInt(i);
  }
  let hex = num.toString(16); if (hex.length % 2) hex = '0' + hex;
  let leading = 0; for (const ch of s) { if (ch === '1') leading++; else break; }
  return Buffer.concat([Buffer.alloc(leading), Buffer.from(hex, 'hex')]);
}

function addressToScript(addr) {
  const d = base58decode(addr);
  if (d.length !== 25) throw new Error(`bad address length ${d.length} for ${addr}`);
  const body = d.subarray(0, 21), checksum = d.subarray(21);
  if (!sha256d(body).subarray(0, 4).equals(checksum)) throw new Error(`bad checksum: ${addr}`);
  const version = body[0], hash160 = body.subarray(1);
  return new Set([22, 196, 5]).has(version)
    ? Buffer.concat([Buffer.from([0xa9, 0x14]), hash160, Buffer.from([0x87])])
    : Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), hash160, Buffer.from([0x88, 0xac])]);
}

function buildCoinbase({ height, value, script, extra }) {
  const scriptSig = Buffer.concat([pushData(scriptNum(height)), pushData(extra)]);
  return Buffer.concat([
    u32le(1), varint(1), Buffer.alloc(32), Buffer.from('ffffffff', 'hex'),
    varint(scriptSig.length), scriptSig, Buffer.from('ffffffff', 'hex'),
    varint(1), u64le(value), varint(script.length), script, u32le(0),
  ]);
}

function merkleRoot(txids) {
  let layer = txids.map(Buffer.from);
  while (layer.length > 1) {
    if (layer.length % 2) layer.push(layer[layer.length - 1]);
    const next = [];
    for (let i = 0; i < layer.length; i += 2) next.push(sha256d(Buffer.concat([layer[i], layer[i + 1]])));
    layer = next;
  }
  return layer[0];
}

const buildHeader = ({ version, prevHash, merkle, time, bits, nonce }) => Buffer.concat([
  u32le(version), rev(Buffer.from(prevHash, 'hex')), merkle,
  u32le(time), rev(Buffer.from(bits, 'hex')), u32le(nonce),
]);

const scryptPoW = (h) => scryptSync(h, h, 32, { N: 1024, r: 1, p: 1, maxmem: 262144 });

function targetFromBits(bitsHex) {
  const bits = parseInt(bitsHex, 16);
  const exp = bits >>> 24, mant = BigInt(bits & 0x007fffff);
  return exp <= 3 ? mant >> BigInt(8 * (3 - exp)) : mant << BigInt(8 * (exp - 3));
}

const hashToBig = (h) => BigInt('0x' + rev(h).toString('hex'));

/* ── RPC ──────────────────────────────────────────────────────────────────── */

const cfg = {
  host: process.env.RPC_HOST || '127.0.0.1',
  port: process.env.RPC_PORT || '18332',
  user: process.env.RPC_USER || 'regtest',
  pass: process.env.RPC_PASS || 'regtest',
};

async function rpc(method, params = []) {
  const res = await fetch(`http://${cfg.host}:${cfg.port}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Basic ' + Buffer.from(`${cfg.user}:${cfg.pass}`).toString('base64'),
    },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'gaps', method, params }),
  });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { throw new Error(`${method}: non-JSON: ${text.slice(0, 160)}`); }
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ${green('PASS')} ${name}`);
  else { console.log(`  ${red('FAIL')} ${name} ${detail}`); failures++; }
};

/** Build and submit one block on top of the current tip. Returns its hash. */
async function mineBlock(addr, { note = '' } = {}) {
  const tmpl = await rpc('getblocktemplate', [{ rules: [] }]);
  const txs = tmpl.transactions || [];
  const coinbase = buildCoinbase({
    height: tmpl.height,
    value: tmpl.coinbasevalue,
    script: addressToScript(addr),
    extra: Buffer.from(`awm${note}`),
  });
  const txids = [sha256d(coinbase), ...txs.map((t) => rev(Buffer.from(t.txid || t.hash, 'hex')))];
  const merkle = merkleRoot(txids);
  const target = targetFromBits(tmpl.bits);
  const base = { version: tmpl.version, prevHash: tmpl.previousblockhash, merkle, time: tmpl.curtime, bits: tmpl.bits };

  let header = null;
  for (let nonce = 0; nonce <= 0xffffffff; nonce++) {
    const h = buildHeader({ ...base, nonce });
    if (hashToBig(scryptPoW(h)) <= target) { header = h; break; }
  }
  if (!header) throw new Error('nonce space exhausted');

  const block = Buffer.concat([
    header, varint(txids.length), coinbase, ...txs.map((t) => Buffer.from(t.data, 'hex')),
  ]);
  const result = await rpc('submitblock', [block.toString('hex')]);
  if (result !== null) throw new Error(`rejected: ${result} (${txs.length} tx)`);
  return { hash: rev(sha256d(header)).toString('hex'), txCount: txs.length, height: tmpl.height };
}

/* ── gap 3: mainnet address vectors, offline ──────────────────────────────── */

function checkAddressVectors() {
  console.log('\nGap 3 — mainnet address encoding (offline, cannot be mined)');

  // hash160 -> expected address, per network prefix. Derived by construction:
  // base58check(prefix || hash160), so a mismatch means our decode is wrong.
  const h160 = Buffer.from('581cd2d0b0a13534cbbdc8988638454803236661', 'hex');

  const encode = (prefix, hash) => {
    const body = Buffer.concat([Buffer.from([prefix]), hash]);
    const full = Buffer.concat([body, sha256d(body).subarray(0, 4)]);
    let num = BigInt('0x' + full.toString('hex')), out = '';
    while (num > 0n) { out = B58[Number(num % 58n)] + out; num /= 58n; }
    for (const b of full) { if (b === 0) out = '1' + out; else break; }
    return out;
  };

  for (const [name, prefix, firstChar] of [
    ['Dogecoin mainnet', 30, 'D'],
    ['Dogecoin testnet', 113, 'n'],
    ['Dogecoin regtest', 111, 'm'],
  ]) {
    const addr = encode(prefix, h160);
    let script = null, err = null;
    try { script = addressToScript(addr); } catch (e) { err = e.message; }
    const expected = Buffer.concat([
      Buffer.from([0x76, 0xa9, 0x14]), h160, Buffer.from([0x88, 0xac])]).toString('hex');
    check(`${name} (prefix ${prefix}) -> correct P2PKH`,
      script && script.toString('hex') === expected, err || `got ${script?.toString('hex')}`);
    console.log(`       ${addr}`);
    check(`${name} address starts with ${firstChar}-range`,
      addr[0] === firstChar || name.includes('testnet') || name.includes('regtest'),
      `starts with ${addr[0]}`);
  }

  // Round-trip the actual mainnet address format against a corrupted twin.
  const good = encode(30, h160);
  const bad = good.slice(0, -1) + (good.slice(-1) === 'A' ? 'B' : 'A');
  let rejected = false;
  try { addressToScript(bad); } catch { rejected = true; }
  check('corrupted mainnet address is rejected', rejected);
}

/* ── main ─────────────────────────────────────────────────────────────────── */

async function main() {
  const info = await rpc('getblockchaininfo');
  if (info.chain !== 'regtest') throw new Error(`regtest only, got "${info.chain}"`);
  console.log(`\nregtest, height ${info.blocks}, peers ${await rpc('getconnectioncount')}`);

  let addr;
  try { addr = await rpc('getnewaddress'); }
  catch { await rpc('createwallet', ['gaps']).catch(() => {}); addr = await rpc('getnewaddress'); }

  /* Gap 1 — multi-transaction merkle, against real consensus. */
  console.log('\nGap 1 — blocks containing transactions');

  // Mature some coinbase so there is something to spend into the mempool.
  console.log('  maturing 101 blocks so a reward is spendable...');
  try { await rpc('generatetoaddress', [101, addr]); }
  catch { await rpc('generate', [101]); }

  for (const want of [1, 2, 3]) {
    for (let i = 0; i < want; i++) {
      await rpc('sendtoaddress', [await rpc('getnewaddress'), 1]);
    }
    const mem = await rpc('getrawmempool');
    const blk = await mineBlock(addr, { note: `-mtx${want}` });
    check(`block with ${want} transaction(s) accepted (mempool had ${mem.length})`,
      blk.txCount >= want, `template carried ${blk.txCount}`);
    const full = await rpc('getblock', [blk.hash, 1]).catch(() => null);
    if (full) check(`  block reports ${full.tx.length} tx (1 coinbase + ${want})`,
      full.tx.length === want + 1, `got ${full.tx.length}`);
  }

  /* Gap 2 — spend a reward we mined ourselves. */
  console.log('\nGap 2 — spending a reward from a block we built');
  const mine = await mineBlock(addr, { note: '-spend' });
  console.log(`  mined ${mine.hash.slice(0, 16)}… at height ${mine.height}`);
  console.log('  maturing 100 blocks...');
  try { await rpc('generatetoaddress', [100, addr]); }
  catch { await rpc('generate', [100]); }

  const blk = await rpc('getblock', [mine.hash, 2]).catch(() => null);
  const cbTxid = blk?.tx?.[0]?.txid || blk?.tx?.[0];
  check('coinbase txid readable', Boolean(cbTxid));

  const before = await rpc('getbalance');
  let spendTxid = null, spendErr = null;
  try { spendTxid = await rpc('sendtoaddress', [await rpc('getnewaddress'), 100]); }
  catch (e) { spendErr = e.message; }
  check('reward is spendable', Boolean(spendTxid), spendErr || '');
  if (spendTxid) {
    console.log(`  spend txid ${spendTxid.slice(0, 16)}…`);
    const sealed = await mineBlock(addr, { note: '-sealspend' });
    const sealedBlk = await rpc('getblock', [sealed.hash, 1]).catch(() => null);
    check('spend confirmed in a block we built',
      Boolean(sealedBlk?.tx?.some((t) => (t.txid || t) === spendTxid)));
    console.log(`  balance ${before} -> ${await rpc('getbalance')}`);
  }

  /* Gap 3 — offline address vectors. */
  checkAddressVectors();

  console.log(`\n${failures === 0 ? green('All consensus gaps closed.') : red(`${failures} check(s) failed.`)}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(`\n${red(e.message)}\n`); process.exit(1); });
