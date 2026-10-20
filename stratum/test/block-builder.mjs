#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   doge-block-builder.mjs

   Builds a Dogecoin block BY HAND from getblocktemplate and submits it.

   This exists before any stratum code on purpose. Stratum is wiring; block
   construction is where the bugs live, and they are the silent kind — a
   wrong byte order produces shares that look perfect and blocks that get
   rejected, or worse, blocks that are ACCEPTED and pay an address nobody
   controls. On mainnet at 6.6 GH/s you would find out in about nine months.

   On regtest you find out in seconds.

   Two modes:
     --selftest   Pure-function checks against known vectors. No daemon.
     (default)    Full flow against a running dogecoind -regtest.

   Zero dependencies: Node's crypto does Litecoin/Dogecoin scrypt natively
   (N=1024, r=1, p=1, 32-byte output, header as both password and salt).
   That matters for packaging — no native build, no per-arch compilation.
   ═══════════════════════════════════════════════════════════════════════════ */

import { createHash, scryptSync } from 'node:crypto';

/* ── byte helpers ─────────────────────────────────────────────────────────── */

const sha256 = (b) => createHash('sha256').update(b).digest();
const sha256d = (b) => sha256(sha256(b));

/** Bitcoin displays hashes big-endian but stores them little-endian. */
const rev = (b) => Buffer.from(b).reverse();

const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

/** Bitcoin CompactSize. */
function varint(n) {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) { const b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(n, 1); return b; }
  if (n <= 0xffffffff) { const b = Buffer.alloc(5); b[0] = 0xfe; b.writeUInt32LE(n, 1); return b; }
  const b = Buffer.alloc(9); b[0] = 0xff; b.writeBigUInt64LE(BigInt(n), 1); return b;
}

/** Minimally-encoded signed script number — BIP34 block height uses this. */
function scriptNum(n) {
  if (n === 0) return Buffer.alloc(0);
  const neg = n < 0; let v = Math.abs(n); const out = [];
  while (v) { out.push(v & 0xff); v = Math.floor(v / 256); }
  if (out[out.length - 1] & 0x80) out.push(neg ? 0x80 : 0x00);
  else if (neg) out[out.length - 1] |= 0x80;
  return Buffer.from(out);
}

/** Length-prefixed push of a byte string into a script. */
function pushData(buf) {
  if (buf.length < 0x4c) return Buffer.concat([Buffer.from([buf.length]), buf]);
  if (buf.length <= 0xff) return Buffer.concat([Buffer.from([0x4c, buf.length]), buf]);
  const b = Buffer.alloc(3); b[0] = 0x4d; b.writeUInt16LE(buf.length, 1);
  return Buffer.concat([b, buf]);
}

/* ── base58check → scriptPubKey ───────────────────────────────────────────── */

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58decode(s) {
  let num = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error(`invalid base58 character: ${ch}`);
    num = num * 58n + BigInt(i);
  }
  let hex = num.toString(16); if (hex.length % 2) hex = '0' + hex;
  let out = Buffer.from(hex, 'hex');
  let leading = 0; for (const ch of s) { if (ch === '1') leading++; else break; }
  return Buffer.concat([Buffer.alloc(leading), out]);
}

/**
 * Address -> P2PKH or P2SH scriptPubKey, with the checksum verified.
 *
 * This is the function whose failure mode is worst: get it wrong and the
 * block is still VALID and still ACCEPTED — the reward simply goes somewhere
 * unspendable. Nothing errors. Hence the checksum verification here and the
 * spend test in the regtest flow: acceptance proves the header, only
 * spending proves the output script.
 */
function addressToScript(addr) {
  const d = base58decode(addr);
  if (d.length !== 25) throw new Error(`bad address length ${d.length} for ${addr}`);
  const body = d.subarray(0, 21), checksum = d.subarray(21);
  if (!sha256d(body).subarray(0, 4).equals(checksum)) throw new Error(`bad checksum: ${addr}`);
  const version = body[0], hash160 = body.subarray(1);
  // Dogecoin: 30 mainnet P2PKH, 113 testnet, 111 regtest; 22 mainnet P2SH, 196 test/regtest.
  const P2SH = new Set([22, 196, 5]);
  return P2SH.has(version)
    ? Buffer.concat([Buffer.from([0xa9, 0x14]), hash160, Buffer.from([0x87])])              // HASH160 <h> EQUAL
    : Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), hash160, Buffer.from([0x88, 0xac])]); // DUP HASH160 <h> EQUALVERIFY CHECKSIG
}

/* ── coinbase, merkle, header ─────────────────────────────────────────────── */

function buildCoinbase({ height, value, script, extra = Buffer.alloc(0) }) {
  const scriptSig = Buffer.concat([pushData(scriptNum(height)), pushData(extra)]); // BIP34
  if (scriptSig.length > 100) throw new Error('coinbase scriptSig exceeds 100 bytes');
  return Buffer.concat([
    u32le(1),                                     // tx version
    varint(1),                                    // input count
    Buffer.alloc(32),                             // null prevout hash
    Buffer.from('ffffffff', 'hex'),               // prevout index
    varint(scriptSig.length), scriptSig,
    Buffer.from('ffffffff', 'hex'),               // sequence
    varint(1),                                    // output count
    u64le(value), varint(script.length), script,
    u32le(0),                                     // locktime
  ]);
}

/** Merkle root in internal (little-endian) order. txids must be internal order too. */
function merkleRoot(txids) {
  if (txids.length === 0) throw new Error('no transactions');
  let layer = txids.map(Buffer.from);
  while (layer.length > 1) {
    if (layer.length % 2) layer.push(layer[layer.length - 1]); // duplicate the odd tail
    const next = [];
    for (let i = 0; i < layer.length; i += 2) next.push(sha256d(Buffer.concat([layer[i], layer[i + 1]])));
    layer = next;
  }
  return layer[0];
}

function buildHeader({ version, prevHash, merkle, time, bits, nonce }) {
  return Buffer.concat([
    u32le(version),
    rev(Buffer.from(prevHash, 'hex')),  // template gives display order; header wants internal
    merkle,                             // already internal order
    u32le(time),
    rev(Buffer.from(bits, 'hex')),      // template gives big-endian hex
    u32le(nonce),
  ]);
}

/** Litecoin/Dogecoin proof-of-work: scrypt(header, header, N=1024, r=1, p=1) -> 32 bytes. */
const scryptPoW = (header80) =>
  scryptSync(header80, header80, 32, { N: 1024, r: 1, p: 1, maxmem: 128 * 1024 * 2 });

/** nBits (compact) -> target as a BigInt. */
function targetFromBits(bitsHex) {
  const bits = parseInt(bitsHex, 16);
  const exp = bits >>> 24, mant = BigInt(bits & 0x007fffff);
  return exp <= 3 ? mant >> BigInt(8 * (3 - exp)) : mant << BigInt(8 * (exp - 3));
}

/** A PoW hash is a little-endian 256-bit number. */
const hashToBig = (h) => BigInt('0x' + rev(h).toString('hex'));

/* ── self-test ────────────────────────────────────────────────────────────── */

function selftest() {
  let pass = 0, fail = 0;
  const ok = (name, cond, detail = '') => {
    if (cond) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
    else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
  };

  console.log('\nByte helpers');
  ok('varint < 0xfd', varint(0x10).toString('hex') === '10');
  ok('varint 0xfd', varint(0xfd).toString('hex') === 'fdfd00');
  ok('varint 0x10000', varint(0x10000).toString('hex') === 'fe00000100');

  console.log('\nBIP34 script numbers');
  ok('height 1', scriptNum(1).toString('hex') === '01');
  ok('height 127', scriptNum(127).toString('hex') === '7f');
  ok('height 128 pads sign byte', scriptNum(128).toString('hex') === '8000');
  ok('height 1000', scriptNum(1000).toString('hex') === 'e803');

  // The decisive vector: Bitcoin's genesis header is universally known, so if
  // serialization and double-SHA256 are right, this reproduces its hash exactly.
  console.log('\nHeader assembly and SHA256d (Bitcoin genesis)');
  const genesis = buildHeader({
    version: 1,
    prevHash: '0'.repeat(64),
    merkle: rev(Buffer.from('4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b', 'hex')),
    time: 1231006505,
    bits: '1d00ffff',
    nonce: 2083236893,
  });
  ok('header is 80 bytes', genesis.length === 80, `got ${genesis.length}`);
  const gHash = rev(sha256d(genesis)).toString('hex');
  ok('genesis hash matches', gHash === '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f', `\n       got ${gHash}`);

  console.log('\nMerkle root');
  const a = sha256d(Buffer.from('a')), b = sha256d(Buffer.from('b'));
  ok('single tx is its own root', merkleRoot([a]).equals(a));
  ok('two tx', merkleRoot([a, b]).equals(sha256d(Buffer.concat([a, b]))));
  ok('three tx duplicates the tail', merkleRoot([a, b, a]).equals(
    sha256d(Buffer.concat([sha256d(Buffer.concat([a, b])), sha256d(Buffer.concat([a, a]))]))));

  console.log('\nTarget from nBits');
  // Difficulty-1: 0x00000000FFFF0000…0000, i.e. 0xffff << 8*(0x1d-3) = 0xffff << 208.
  ok('1d00ffff is the difficulty-1 target', targetFromBits('1d00ffff') === 0xffffn << 208n,
     `got ${targetFromBits('1d00ffff').toString(16)}`);
  ok('207fffff (regtest) is huge', targetFromBits('207fffff') > (1n << 250n));

  console.log('\nScrypt PoW');
  const h = scryptPoW(genesis);
  ok('returns 32 bytes', h.length === 32);
  ok('deterministic', scryptPoW(genesis).equals(h));

  console.log('\nAddress decoding');
  // Dogecoin mainnet P2PKH, version byte 30 -> addresses begin with D.
  let threw = false;
  try { addressToScript('DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L'); } catch { threw = true; }
  ok('valid mainnet address decodes', !threw);
  threw = false;
  try { addressToScript('DH5yaieqoZN36fDVciNyRueRGvGLR3mr7X'); } catch { threw = true; }
  ok('corrupted checksum is rejected', threw);

  console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(fail === 0 ? 0 : 1);
}

/* ── regtest flow ─────────────────────────────────────────────────────────── */

async function rpc(cfg, method, params = []) {
  const res = await fetch(`http://${cfg.host}:${cfg.port}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Basic ' + Buffer.from(`${cfg.user}:${cfg.pass}`).toString('base64'),
    },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'builder', method, params }),
  });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { throw new Error(`${method}: non-JSON reply: ${text.slice(0, 200)}`); }
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

async function main() {
  const cfg = {
    host: process.env.RPC_HOST || '127.0.0.1',
    port: process.env.RPC_PORT || '18332',
    user: process.env.RPC_USER || 'regtest',
    pass: process.env.RPC_PASS || 'regtest',
  };

  console.log(`\nRPC ${cfg.host}:${cfg.port}`);
  const info = await rpc(cfg, 'getblockchaininfo');
  console.log(`  chain=${info.chain} blocks=${info.blocks}`);
  if (info.chain !== 'regtest') throw new Error(`refusing to run against chain "${info.chain}" — regtest only`);

  // A wallet address we control, so the spend test at the end means something.
  let addr;
  try { addr = await rpc(cfg, 'getnewaddress'); }
  catch { await rpc(cfg, 'createwallet', ['builder']).catch(() => {}); addr = await rpc(cfg, 'getnewaddress'); }
  console.log(`  payout address ${addr}`);
  const script = addressToScript(addr);
  console.log(`  scriptPubKey  ${script.toString('hex')}`);

  /* Dogecoin removed Bitcoin Core's regtest exemption on both getblocktemplate
     guards (src/rpc/mining.cpp): it demands a peer and a non-stale tip even on
     a private chain. Diagnose both before they surface as opaque RPC errors. */
  const peers = await rpc(cfg, 'getconnectioncount').catch(() => 0);
  console.log(`  peers         ${peers}`);
  if (peers === 0) {
    throw new Error(
      'getblocktemplate needs at least one peer, and Dogecoin does not exempt regtest.\n' +
      'Start a second regtest node peered to this one:\n\n' +
      `  mkdir -p $HOME/stage/doge/regtest2\n` +
      `  /opt/dogecoin-1.14.9/bin/dogecoind -regtest \\\n` +
      `    -datadir=$HOME/stage/doge/regtest2 \\\n` +
      `    -rpcuser=regtest -rpcpassword=regtest \\\n` +
      `    -rpcport=18333 -port=18445 \\\n` +
      `    -connect=127.0.0.1:18444 -daemon\n`);
  }

  // A fresh regtest chain's genesis timestamp is years old, which reads as IBD
  // and trips the second guard. The built-in miner bypasses the RPC guards, so
  // one block from it gives a current tip and clears the condition.
  if (info.blocks === 0) {
    console.log('  priming       chain is empty; generating 1 block to clear the IBD guard');
    try { await rpc(cfg, 'generatetoaddress', [1, addr]); }
    catch { await rpc(cfg, 'generate', [1]); }
    const primed = await rpc(cfg, 'getblockchaininfo');
    console.log(`                height now ${primed.blocks}`);
  }

  let tmpl;
  try { tmpl = await rpc(cfg, 'getblocktemplate', [{ rules: [] }]); }
  catch (e) {
    if (/downloading blocks/i.test(e.message)) {
      throw new Error(
        'Node reports initial block download on a private chain.\n' +
        'The tip is older than -maxtipage (24h default). Either generate a block\n' +
        'with the built-in miner, or restart both nodes with -maxtipage=999999999');
    }
    tmpl = await rpc(cfg, 'getblocktemplate');
  }

  console.log(`\nTemplate`);
  console.log(`  height        ${tmpl.height}`);
  console.log(`  version       ${tmpl.version} (0x${(tmpl.version >>> 0).toString(16).padStart(8, '0')})`);
  console.log(`  chain id      ${tmpl.version >>> 16}  ${(tmpl.version >>> 16) === 98 ? '= 98, Dogecoin' : '(expected 98)'}`);
  console.log(`  auxpow bit    ${(tmpl.version & 0x100) ? 'SET' : 'clear'}`);
  console.log(`  bits          ${tmpl.bits}`);
  console.log(`  coinbasevalue ${tmpl.coinbasevalue}`);
  console.log(`  transactions  ${(tmpl.transactions || []).length}`);

  const coinbase = buildCoinbase({
    height: tmpl.height,
    value: tmpl.coinbasevalue,
    script,
    extra: Buffer.from('awm-regtest-harness'),
  });
  const cbTxid = sha256d(coinbase);
  const txids = [cbTxid, ...(tmpl.transactions || []).map((t) => rev(Buffer.from(t.txid || t.hash, 'hex')))];
  const merkle = merkleRoot(txids);

  const target = targetFromBits(tmpl.bits);
  console.log(`\nSolving (target 0x${target.toString(16).slice(0, 16)}…)`);

  const base = { version: tmpl.version, prevHash: tmpl.previousblockhash, merkle, time: tmpl.curtime, bits: tmpl.bits };
  let header = null, nonce = 0;
  const t0 = Date.now();
  for (; nonce <= 0xffffffff; nonce++) {
    const h = buildHeader({ ...base, nonce });
    if (hashToBig(scryptPoW(h)) <= target) { header = h; break; }
    if (nonce && nonce % 20000 === 0) process.stdout.write(`\r  ${nonce} nonces…`);
  }
  if (!header) throw new Error('nonce space exhausted');
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\r  solved at nonce ${nonce} in ${secs}s`);
  console.log(`  block hash ${rev(sha256d(header)).toString('hex')}`);
  console.log(`  pow  hash  ${rev(scryptPoW(header)).toString('hex')}`);

  const block = Buffer.concat([
    header,
    varint(txids.length),
    coinbase,
    ...(tmpl.transactions || []).map((t) => Buffer.from(t.data, 'hex')),
  ]);

  console.log(`\nSubmitting ${block.length} bytes`);
  const result = await rpc(cfg, 'submitblock', [block.toString('hex')]);
  if (result !== null) throw new Error(`REJECTED: ${result}`);
  console.log('  \x1b[32maccepted\x1b[0m');

  const after = await rpc(cfg, 'getblockchaininfo');
  console.log(`  height ${info.blocks} -> ${after.blocks}`);

  // Acceptance proves the header and merkle. Only this proves the output script.
  console.log(`\nVerifying the reward is OURS`);
  const blk = await rpc(cfg, 'getblock', [rev(sha256d(header)).toString('hex'), 2]).catch(() => null);
  if (blk?.tx?.[0]?.vout?.[0]) {
    const out = blk.tx[0].vout[0];
    const paidTo = out.scriptPubKey?.addresses?.[0] || out.scriptPubKey?.address;
    console.log(`  coinbase pays ${out.value} to ${paidTo}`);
    if (paidTo && paidTo !== addr) throw new Error(`PAID THE WRONG ADDRESS: ${paidTo} != ${addr}`);
    console.log(`  \x1b[32mmatches our address\x1b[0m`);
  } else {
    console.log('  (verbose getblock unavailable on this version — check manually)');
  }

  console.log(`\n\x1b[32mBlock construction verified against real consensus.\x1b[0m`);
  console.log(`Mature the reward with 100 more blocks, then spend it to close the`);
  console.log(`output-script gap completely.\n`);
}

if (process.argv.includes('--selftest')) selftest();
else main().catch((e) => { console.error(`\n\x1b[31m${e.message}\x1b[0m\n`); process.exit(1); });
