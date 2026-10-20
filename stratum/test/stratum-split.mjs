#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   doge-stratum-split.mjs

   Stratum never sends the coinbase. It sends four pieces —

       coinb1 ++ extranonce1 ++ extranonce2 ++ coinb2

   — and makes the MINER assemble them, then hands over a merkle_branch array
   the miner folds against the resulting coinbase txid to get the root.

   Two new things can be subtly wrong: the split point, and the branch order.
   Both fail the same way everything in this domain fails — shares that
   validate locally, blocks the network rejects.

   We now have an oracle. doge-block-builder.mjs proved the direct path against
   real consensus, so the split path can be tested DIFFERENTIALLY: build the
   same coinbase both ways and require identical merkle roots. If they agree,
   the stratum layer cannot corrupt a block.

     --selftest   Pure differential, no daemon. Covers 0..6 transactions.
     (default)    Same, then mines a real block via the stratum path and
                  requires the daemon to accept it.
   ═══════════════════════════════════════════════════════════════════════════ */

import { createHash, scryptSync, randomBytes } from 'node:crypto';

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

/* ── the direct path (proven against consensus) ───────────────────────────── */

function buildCoinbaseDirect({ height, value, script, extranonce }) {
  const scriptSig = Buffer.concat([pushData(scriptNum(height)), pushData(extranonce)]);
  return Buffer.concat([
    u32le(1), varint(1), Buffer.alloc(32), Buffer.from('ffffffff', 'hex'),
    varint(scriptSig.length), scriptSig, Buffer.from('ffffffff', 'hex'),
    varint(1), u64le(value), varint(script.length), script, u32le(0),
  ]);
}

function merkleRootDirect(txids) {
  let layer = txids.map(Buffer.from);
  while (layer.length > 1) {
    if (layer.length % 2) layer.push(layer[layer.length - 1]);
    const next = [];
    for (let i = 0; i < layer.length; i += 2) next.push(sha256d(Buffer.concat([layer[i], layer[i + 1]])));
    layer = next;
  }
  return layer[0];
}

/* ── the stratum path ─────────────────────────────────────────────────────── */

/**
 * Split a coinbase at the extranonce, the way a pool does.
 *
 * The scriptSig reserves en1Size+en2Size zero bytes inside its push. coinb1
 * ends where that reservation begins; coinb2 begins where it ends. The length
 * prefixes in coinb1 already account for the full assembled size, which is why
 * the gap must be reserved rather than appended.
 */
function splitCoinbase({ height, value, script, en1Size, en2Size, tail = Buffer.alloc(0) }) {
  const gap = Buffer.alloc(en1Size + en2Size);          // placeholder, never sent
  const payload = Buffer.concat([gap, tail]);
  const scriptSig = Buffer.concat([pushData(scriptNum(height)), pushData(payload)]);
  if (scriptSig.length > 100) throw new Error(`scriptSig ${scriptSig.length} > 100 bytes`);

  const full = Buffer.concat([
    u32le(1), varint(1), Buffer.alloc(32), Buffer.from('ffffffff', 'hex'),
    varint(scriptSig.length), scriptSig, Buffer.from('ffffffff', 'hex'),
    varint(1), u64le(value), varint(script.length), script, u32le(0),
  ]);

  // Offset of the gap inside the serialized transaction.
  const prefixLen =
    4 + 1 + 32 + 4 +                                     // version, incount, prevout
    varint(scriptSig.length).length +                    // scriptSig length prefix
    pushData(scriptNum(height)).length +                 // BIP34 height push
    (payload.length < 0x4c ? 1 : 2);                     // payload push opcode

  return {
    coinb1: full.subarray(0, prefixLen),
    coinb2: full.subarray(prefixLen + en1Size + en2Size),
    en1Size, en2Size,
  };
}

/** What the miner does: glue the four pieces together. */
const assembleCoinbase = (coinb1, en1, en2, coinb2) => Buffer.concat([coinb1, en1, en2, coinb2]);

/**
 * merkle_branch for a coinbase at index 0, given the OTHER txids.
 * Each level contributes the sibling the coinbase side pairs against.
 */
function merkleBranch(otherTxids) {
  const branch = [];
  let layer = otherTxids.map(Buffer.from);
  while (layer.length > 0) {
    branch.push(layer[0]);
    const next = [];
    for (let i = 1; i < layer.length; i += 2) {
      const left = layer[i];
      const right = i + 1 < layer.length ? layer[i + 1] : layer[i];  // duplicate odd tail
      next.push(sha256d(Buffer.concat([left, right])));
    }
    layer = next;
  }
  return branch;
}

/** What the miner does: fold the branch into the coinbase txid. */
function foldBranch(coinbaseTxid, branch) {
  let root = Buffer.from(coinbaseTxid);
  for (const sib of branch) root = sha256d(Buffer.concat([root, sib]));
  return root;
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

/* ── the differential ─────────────────────────────────────────────────────── */

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ${green('PASS')} ${name}`);
  else { console.log(`  ${red('FAIL')} ${name} ${detail}`); failures++; }
};

const SCRIPT = Buffer.concat([
  Buffer.from([0x76, 0xa9, 0x14]),
  Buffer.from('581cd2d0b0a13534cbbdc8988638454803236661', 'hex'),
  Buffer.from([0x88, 0xac]),
]);

function differential({ txCount, height, en1Size = 4, en2Size = 4, tail = Buffer.from('awm') }) {
  const value = 50000000000000;
  const others = Array.from({ length: txCount }, (_, i) => sha256d(Buffer.from(`tx${i}`)));

  const en1 = randomBytes(en1Size);
  const en2 = randomBytes(en2Size);
  const extranonce = Buffer.concat([en1, en2, tail]);

  // Direct: build the whole coinbase, compute the whole tree.
  const direct = buildCoinbaseDirect({ height, value, script: SCRIPT, extranonce });
  const rootDirect = merkleRootDirect([sha256d(direct), ...others]);

  // Stratum: split, send the pieces, let the "miner" reassemble and fold.
  const { coinb1, coinb2 } = splitCoinbase({ height, value, script: SCRIPT, en1Size, en2Size, tail });
  const assembled = assembleCoinbase(coinb1, en1, en2, coinb2);
  const rootStratum = foldBranch(sha256d(assembled), merkleBranch(others));

  return { direct, assembled, rootDirect, rootStratum, coinb1, coinb2, en1, en2 };
}

function selftest() {
  console.log('\nCoinbase reassembly — split path must reproduce the direct bytes');
  for (const txCount of [0, 1, 2, 3, 4, 5, 6]) {
    const r = differential({ txCount, height: 1000 + txCount });
    check(`${txCount} other tx: assembled coinbase is byte-identical`,
      r.assembled.equals(r.direct),
      `\n       direct    ${r.direct.toString('hex')}\n       assembled ${r.assembled.toString('hex')}`);
  }

  console.log('\nMerkle root — folded branch must equal the full tree');
  for (const txCount of [0, 1, 2, 3, 4, 5, 6]) {
    const r = differential({ txCount, height: 2000 + txCount });
    check(`${txCount} other tx: roots agree`,
      r.rootDirect.equals(r.rootStratum),
      `\n       direct  ${r.rootDirect.toString('hex')}\n       stratum ${r.rootStratum.toString('hex')}`);
  }

  console.log('\nExtranonce sizes other than 4/4');
  for (const [a, b] of [[2, 2], [3, 4], [4, 8], [8, 8]]) {
    const r = differential({ txCount: 3, height: 3000, en1Size: a, en2Size: b });
    check(`en1=${a} en2=${b}: identical and roots agree`,
      r.assembled.equals(r.direct) && r.rootDirect.equals(r.rootStratum));
  }

  console.log('\nThe split must actually be sensitive to the extranonce');
  const x = differential({ txCount: 2, height: 4000 });
  const otherEn2 = Buffer.alloc(x.en2.length, 0xff);
  const altered = assembleCoinbase(x.coinb1, x.en1, otherEn2, x.coinb2);
  check('changing extranonce2 changes the coinbase',
    !altered.equals(x.assembled) || x.en2.equals(otherEn2));
  check('altered coinbase keeps the same length',
    altered.length === x.assembled.length);

  console.log(`\n${failures === 0 ? green('Differential clean — the stratum split cannot corrupt a block.')
                                   : red(`${failures} failure(s).`)}\n`);
  return failures;
}

/* ── consensus confirmation ───────────────────────────────────────────────── */

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
    body: JSON.stringify({ jsonrpc: '1.0', id: 'split', method, params }),
  });
  const j = JSON.parse(await res.text());
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

function addressToScript(addr) {
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let num = 0n;
  for (const ch of addr) { const i = B58.indexOf(ch); if (i < 0) throw new Error('bad base58'); num = num * 58n + BigInt(i); }
  let hex = num.toString(16); if (hex.length % 2) hex = '0' + hex;
  let leading = 0; for (const ch of addr) { if (ch === '1') leading++; else break; }
  const d = Buffer.concat([Buffer.alloc(leading), Buffer.from(hex, 'hex')]);
  const body = d.subarray(0, 21);
  if (!sha256d(body).subarray(0, 4).equals(d.subarray(21))) throw new Error('bad checksum');
  return new Set([22, 196, 5]).has(body[0])
    ? Buffer.concat([Buffer.from([0xa9, 0x14]), body.subarray(1), Buffer.from([0x87])])
    : Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), body.subarray(1), Buffer.from([0x88, 0xac])]);
}

async function consensus() {
  const info = await rpc('getblockchaininfo');
  if (info.chain !== 'regtest') throw new Error(`regtest only, got "${info.chain}"`);
  console.log(`\nMining a block via the STRATUM path (regtest, height ${info.blocks})`);

  let addr;
  try { addr = await rpc('getnewaddress'); }
  catch { await rpc('createwallet', ['split']).catch(() => {}); addr = await rpc('getnewaddress'); }

  // Put a couple of transactions in the mempool so the branch is non-trivial.
  for (let i = 0; i < 2; i++) await rpc('sendtoaddress', [await rpc('getnewaddress'), 1]).catch(() => {});

  const tmpl = await rpc('getblocktemplate', [{ rules: [] }]);
  const txs = tmpl.transactions || [];
  console.log(`  template carries ${txs.length} transaction(s)`);

  const en1 = randomBytes(4), en2 = randomBytes(4);
  const { coinb1, coinb2 } = splitCoinbase({
    height: tmpl.height, value: tmpl.coinbasevalue,
    script: addressToScript(addr), en1Size: 4, en2Size: 4, tail: Buffer.from('awm-split'),
  });
  console.log(`  coinb1 ${coinb1.length}B  en1 4B  en2 4B  coinb2 ${coinb2.length}B`);

  const coinbase = assembleCoinbase(coinb1, en1, en2, coinb2);
  const others = txs.map((t) => rev(Buffer.from(t.txid || t.hash, 'hex')));
  const branch = merkleBranch(others);
  console.log(`  merkle branch depth ${branch.length}`);

  const merkle = foldBranch(sha256d(coinbase), branch);
  const direct = merkleRootDirect([sha256d(coinbase), ...others]);
  check('branch-folded root matches direct root on a live template', merkle.equals(direct));

  const target = targetFromBits(tmpl.bits);
  const base = { version: tmpl.version, prevHash: tmpl.previousblockhash, merkle, time: tmpl.curtime, bits: tmpl.bits };
  let header = null;
  for (let nonce = 0; nonce <= 0xffffffff; nonce++) {
    const h = buildHeader({ ...base, nonce });
    if (hashToBig(scryptPoW(h)) <= target) { header = h; break; }
  }

  const block = Buffer.concat([
    header, varint(1 + txs.length), coinbase, ...txs.map((t) => Buffer.from(t.data, 'hex')),
  ]);
  const result = await rpc('submitblock', [block.toString('hex')]);
  check('daemon accepted a block assembled from stratum pieces', result === null, `got ${result}`);

  const after = await rpc('getblockchaininfo');
  check(`height advanced ${info.blocks} -> ${after.blocks}`, after.blocks > info.blocks);
}

/* ── entry ────────────────────────────────────────────────────────────────── */

if (process.argv.includes('--selftest')) {
  process.exit(selftest() === 0 ? 0 : 1);
} else {
  selftest();
  consensus()
    .then(() => {
      console.log(`\n${failures === 0 ? green('Stratum split verified against consensus.')
                                      : red(`${failures} failure(s).`)}\n`);
      process.exit(failures === 0 ? 0 : 1);
    })
    .catch((e) => { console.error(`\n${red(e.message)}\n`); process.exit(1); });
}
