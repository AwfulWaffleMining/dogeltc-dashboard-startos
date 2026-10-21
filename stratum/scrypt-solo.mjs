#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   doge-stratum-server.mjs — solo Scrypt stratum server for Dogecoin Core

   Built on primitives already proven against real consensus:
     doge-block-builder.mjs    block construction accepted by the daemon
     doge-consensus-gaps.mjs   multi-tx merkle, spendable rewards, addresses
     doge-stratum-split.mjs    coinb1/coinb2 split and merkle branch folding

   Solo only. No shares database, no payout accounting, no balances. The
   miner's username IS the payout address: whoever finds the block is paid
   directly by its coinbase. That is the whole point, and it is why this needs
   no PostgreSQL.

     --selftest   Starts the server, connects a synthetic miner, mines a real
                  regtest block through the full stratum loop, requires the
                  daemon to accept it, then exits.
     (default)    Runs the server.

   Env: RPC_HOST RPC_PORT RPC_USER RPC_PASS STRATUM_PORT COIN_NETWORK
   ═══════════════════════════════════════════════════════════════════════════ */

import net from 'node:net';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash, scryptSync, randomBytes } from 'node:crypto';

/* ── primitives (verified) ────────────────────────────────────────────────── */

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

/* ── bech32 / bech32m ──────────────────────────────────────────────────────
 *
 * Needed because Litecoin's `getnewaddress` returns bech32 by default. A
 * base58-only converter rejects the address most Litecoin users will paste,
 * and did: `ltc1…` threw "invalid base58 in address".
 *
 * Two checksum constants, not one. BIP350 changed the constant for witness
 * version 1 and above (taproot) precisely so that a v1 address cannot be
 * validated by a v0-only implementation and silently paid to the wrong
 * script. Honouring that is the whole point of implementing this rather than
 * pattern-matching the string. */
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_CONST = 1, BECH32M_CONST = 0x2bc830a3;

function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

function bech32HrpExpand(hrp) {
  const out = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

/** 5-bit groups to 8-bit bytes, rejecting invalid padding. */
function convert5to8(data) {
  let acc = 0, bits = 0;
  const out = [];
  for (const v of data) {
    if (v < 0 || v >> 5 !== 0) throw new Error('bad bech32 value');
    acc = (acc << 5) | v; bits += 5;
    while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
  }
  /* Leftover bits must be zero padding of under 5 bits. Accepting more would
     let two different addresses decode to the same program. */
  if (bits >= 5 || ((acc << (8 - bits)) & 0xff) !== 0) {
    throw new Error('bad bech32 padding');
  }
  return Buffer.from(out);
}

/* Human-readable parts that mean "this is a segwit address on a chain this
   server pays". Dogecoin has no bech32 addresses at all.

   The HRP is the discriminator, NOT the shape of the string, and that is
   load-bearing: a base58 address can coincidentally contain a '1' with only
   bech32-charset characters after it. `QetEvio3nP3tJ1N3pheTn3gQCd8eR2GkgW` is
   a real P2SH address that does exactly that. Deciding by shape sent it down
   the bech32 path, where the mixed-case rule then rejected it — which broke
   every legacy and P2SH payout. Matching the HRP cannot make that mistake. */
const SEGWIT_HRPS = new Set([
  'ltc',   // Litecoin mainnet
  'tltc',  // Litecoin testnet
  'rltc',  // Litecoin regtest
]);

/** Returns a witness scriptPubKey, or null when `addr` is not bech32 at all. */
function bech32ToScript(addr) {
  const lower = addr.toLowerCase();
  const pos = lower.lastIndexOf('1');
  if (pos < 1 || pos + 7 > lower.length || lower.length > 90) return null;
  const hrp = lower.slice(0, pos);
  if (!SEGWIT_HRPS.has(hrp)) return null;   // not ours; let base58 try it

  /* Only now that the HRP says this IS a bech32 address does BIP173's
     case rule apply. Applying it earlier rejects base58. */
  if (lower !== addr && addr.toUpperCase() !== addr) {
    throw new Error(`mixed case in bech32 address: ${addr}`);
  }

  const dataPart = lower.slice(pos + 1);
  const data = [];
  for (const ch of dataPart) {
    const v = BECH32_CHARSET.indexOf(ch);
    if (v < 0) throw new Error(`invalid bech32 character '${ch}' in ${addr}`);
    data.push(v);
  }

  const chk = bech32Polymod([...bech32HrpExpand(hrp), ...data]);
  const version = data[0];
  const want = version === 0 ? BECH32_CONST : BECH32M_CONST;
  if (chk !== want) {
    throw new Error(
      `bad bech32 checksum for ${addr}`
      + (chk === (version === 0 ? BECH32M_CONST : BECH32_CONST)
        ? ' (encoded for the other witness version — refusing rather than guessing)'
        : ''));
  }

  const program = convert5to8(data.slice(1, -6));
  if (version > 16) throw new Error(`witness version ${version} out of range`);
  if (program.length < 2 || program.length > 40) {
    throw new Error(`witness program length ${program.length} invalid`);
  }
  if (version === 0 && program.length !== 20 && program.length !== 32) {
    throw new Error(`v0 witness program must be 20 or 32 bytes, got ${program.length}`);
  }

  // OP_0 is 0x00; OP_1..OP_16 are 0x51..0x60.
  const opVersion = version === 0 ? 0x00 : 0x50 + version;
  return Buffer.concat([
    Buffer.from([opVersion, program.length]), program,
  ]);
}

function addressToScript(addr) {
  const segwit = bech32ToScript(addr);
  if (segwit) return segwit;

  let num = 0n;
  for (const ch of addr) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error(`invalid base58 in address: ${addr}`);
    num = num * 58n + BigInt(i);
  }
  let hex = num.toString(16); if (hex.length % 2) hex = '0' + hex;
  let leading = 0; for (const ch of addr) { if (ch === '1') leading++; else break; }
  const d = Buffer.concat([Buffer.alloc(leading), Buffer.from(hex, 'hex')]);
  if (d.length !== 25) throw new Error(`bad address length for ${addr}`);
  const body = d.subarray(0, 21);
  if (!sha256d(body).subarray(0, 4).equals(d.subarray(21))) throw new Error(`bad checksum: ${addr}`);
  /* P2SH version bytes for every chain this server pays.
   *
   * Getting this wrong LOSES THE BLOCK, silently. An unlisted P2SH version
   * falls through to the P2PKH branch, which wraps a SCRIPT hash in a
   * pay-to-pubkey-hash output. Nobody holds a private key for that, the
   * output is unspendable by anyone forever, and nothing rejects it: the
   * block is valid, the node accepts it, the dashboard shows a win.
   *
   * The original set was Dogecoin's and Bitcoin's only. Litecoin's `M…`
   * (mainnet, 50) and `Q…` (testnet/regtest, 58) were missing, so a Litecoin
   * P2SH payout address would have been paid into a void. Verified against
   * litecoind: a regtest `Q…` address has version byte 58 and the node's own
   * scriptPubKey is a914…87.
   *
   *    5  Bitcoin / Litecoin legacy  3…
   *   22  Dogecoin                   A…
   *   50  Litecoin                   M…
   *   58  Litecoin testnet/regtest   Q…
   *  196  Bitcoin / Dogecoin testnet 2…
   *
   * Before adding a chain, confirm its version bytes against that chain's own
   * `getaddressinfo`. Do not infer them from the address letter. */
  return new Set([5, 22, 50, 58, 196]).has(body[0])
    ? Buffer.concat([Buffer.from([0xa9, 0x14]), body.subarray(1), Buffer.from([0x87])])
    : Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), body.subarray(1), Buffer.from([0x88, 0xac])]);
}

/* The coinbase witness BIP141 requires when a commitment output is present:
   exactly one stack item of 32 zero bytes. `default_witness_commitment` from
   the template is computed assuming precisely this value, so it must not be
   anything else or the commitment will not match what we committed to. */
const WITNESS_RESERVED = Buffer.alloc(32);

/* ── merged mining (AuxPoW) ───────────────────────────────────────────────
 *
 * The Namecoin merged-mining standard, which is how Dogecoin has accepted
 * blocks since height 371,337. Nothing here is specific to scrypt or to any
 * algorithm: it is a rule about where a parent chain's coinbase commits to a
 * child chain's block hash.
 *
 * With exactly ONE aux chain the structure collapses pleasantly:
 *   - the chain merkle branch is empty
 *   - size is 1 << 0 == 1
 *   - the expected index reduces to 0 for any nonce, since it ends in
 *     `% (1 << 0)`
 * so the "merkle tree of aux chains" degenerates to the aux block hash
 * itself. Verified against Dogecoin's own CAuxPow::check and
 * getExpectedIndex. */
const MM_MAGIC = Buffer.from('fabe6d6d', 'hex');

/* The bytes that must appear in the PARENT coinbase scriptSig.
 *
 * `auxHashHex` is the hash as createauxblock reports it. Dogecoin reverses
 * the internal uint256 before searching the script ("correct endian" in its
 * own comment), which means the bytes it looks for are the display-order hex
 * exactly as given — no reversal here. Getting that backwards produces a
 * coinbase that looks right and fails with "missing chain merkle root". */
function mergedMiningTail(auxHashHex) {
  return Buffer.concat([
    MM_MAGIC,
    Buffer.from(auxHashHex, 'hex'),
    u32le(1),   // merkle size: 1 << branch length, and the branch is empty
    u32le(0),   // nonce; with one chain the expected index is 0 regardless
  ]);
}

const i32le = (n) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };

/* Serialize a CAuxPow exactly as Dogecoin deserializes it:
 *
 *   CMerkleTx: tx, hashBlock, vMerkleBranch, nIndex
 *   then:      vChainMerkleBranch, nChainIndex, parentBlock
 *
 * `tx` is the STRIPPED parent coinbase, never the witness form. Dogecoin 1.14
 * predates segwit and its deserializer has no marker/flag concept: handed the
 * witness serialization it reads the 0x00 marker as an input count of zero
 * and rejects with "Aux POW coinbase has no inputs". The txid the merkle
 * branch proves is defined over these bytes anyway. */
function buildAuxPow({ coinbaseStripped, branch, parentHeader }) {
  const parentHash = sha256d(parentHeader);
  return Buffer.concat([
    coinbaseStripped,
    parentHash,
    varint(branch.length), ...branch,
    i32le(0),              // coinbase is always index 0 in the parent block
    varint(0),             // empty chain merkle branch: a single aux chain
    i32le(0),              // and therefore chain index 0
    parentHeader,
  ]).toString('hex');
}

/* Re-serialise a coinbase in segwit form for block submission.
 *
 * This is deliberately NOT what miners are given. coinb1/coinb2 stay the
 * stripped, pre-segwit serialisation because the miner concatenates them with
 * its extranonces and hashes the result to get the coinbase TXID for the
 * merkle root — and a txid is defined over the non-witness bytes. Handing a
 * miner the witness form would make every merkle root it computes wrong,
 * which is how a pool produces shares that look fine and blocks that are
 * rejected.
 *
 * The witness is spliced in only here, at submission: marker+flag after the
 * version, and the witness stack immediately before the locktime. */
function coinbaseWithWitness(stripped) {
  const version = stripped.subarray(0, 4);
  const body = stripped.subarray(4, stripped.length - 4);
  const locktime = stripped.subarray(stripped.length - 4);
  return Buffer.concat([
    version,
    Buffer.from([0x00, 0x01]),          // segwit marker + flag
    body,
    varint(1), varint(WITNESS_RESERVED.length), WITNESS_RESERVED,
    locktime,
  ]);
}

function splitCoinbase({ height, value, script, en1Size, en2Size, tail, commitment }) {
  const payload = Buffer.concat([Buffer.alloc(en1Size + en2Size), tail]);
  const scriptSig = Buffer.concat([pushData(scriptNum(height)), pushData(payload)]);
  if (scriptSig.length > 100) throw new Error(`coinbase scriptSig ${scriptSig.length} > 100`);
  /* A second, zero-value output carrying the witness commitment, when the
     chain supplies one. Dogecoin 1.14 has no segwit and supplies none, so it
     keeps a single output exactly as before. */
  const outputs = commitment
    ? Buffer.concat([
        varint(2),
        u64le(value), varint(script.length), script,
        u64le(0), varint(commitment.length), commitment,
      ])
    : Buffer.concat([
        varint(1),
        u64le(value), varint(script.length), script,
      ]);
  const full = Buffer.concat([
    u32le(1), varint(1), Buffer.alloc(32), Buffer.from('ffffffff', 'hex'),
    varint(scriptSig.length), scriptSig, Buffer.from('ffffffff', 'hex'),
    outputs, u32le(0),
  ]);
  const at = 4 + 1 + 32 + 4 + varint(scriptSig.length).length
    + pushData(scriptNum(height)).length + (payload.length < 0x4c ? 1 : 2);
  return { coinb1: full.subarray(0, at), coinb2: full.subarray(at + en1Size + en2Size) };
}

function merkleBranch(otherTxids) {
  const branch = []; let layer = otherTxids.map(Buffer.from);
  while (layer.length > 0) {
    branch.push(layer[0]);
    const next = [];
    for (let i = 1; i < layer.length; i += 2)
      next.push(sha256d(Buffer.concat([layer[i], i + 1 < layer.length ? layer[i + 1] : layer[i]])));
    layer = next;
  }
  return branch;
}

const foldBranch = (cbTxid, branch) =>
  branch.reduce((root, sib) => sha256d(Buffer.concat([root, sib])), Buffer.from(cbTxid));

const scryptPoW = (h) => scryptSync(h, h, 32, { N: 1024, r: 1, p: 1, maxmem: 262144 });

function targetFromBits(bitsHex) {
  const bits = parseInt(bitsHex, 16);
  const exp = bits >>> 24, mant = BigInt(bits & 0x007fffff);
  return exp <= 3 ? mant >> BigInt(8 * (3 - exp)) : mant << BigInt(8 * (exp - 3));
}

const hashToBig = (h) => BigInt('0x' + rev(h).toString('hex'));

/* Scrypt difficulty-1 target. Share target = this / difficulty.
 *
 * NOT Bitcoin's. Bitcoin's difficulty-1 target is 0xffff << 208, which costs
 * 2^32 hashes per share. Scrypt pools shift that left by another 16 bits, so a
 * difficulty-1 Scrypt share costs 2^16 hashes. Using the Bitcoin value here
 * makes every assigned difficulty 65536x too hard, which on mainnet rejects
 * essentially every honest share as "low difficulty" — regtest hid it entirely,
 * because the either-target fallback let the shares through anyway.
 *
 * The arbiter was the hardware: a VolcMiner asks its other pool for d=1098633.
 * At ~2.3 GH/s that is 31 s/share under the 2^16 convention and 24 DAYS under
 * 2^32. Override only if a chain is found to disagree. */
const SCRYPT_SHIFT = BigInt(process.env.SCRYPT_DIFF_SHIFT || 16);
const DIFF1 = (0x0000ffffn << 208n) << SCRYPT_SHIFT;
const targetForDifficulty = (d) => DIFF1 / BigInt(Math.max(1, Math.floor(d)));

/**
 * THE ONE FIELD REGTEST CANNOT VALIDATE.
 *
 * mining.notify sends prevhash with each 4-byte word reversed. Implementations
 * have historically disagreed about this, and a test miner written alongside
 * this function would share any misunderstanding it contains — a self-consistent
 * bug passes its own test. Only real mining firmware settles it.
 *
 * Isolated here deliberately: if an ASIC rejects jobs, this is the first and
 * probably only thing to change.
 */
function prevhashToStratum(displayHex) {
  const internal = rev(Buffer.from(displayHex, 'hex'));   // display -> internal
  const out = Buffer.alloc(32);
  for (let i = 0; i < 8; i++) rev(internal.subarray(i * 4, i * 4 + 4)).copy(out, i * 4);
  return out.toString('hex');
}

/* ── RPC ──────────────────────────────────────────────────────────────────── */

/* Cookie auth, read fresh on every call and never cached.
 *
 * Core rewrites .cookie on every start, so a cached value is wrong the moment
 * the node restarts — and the node restarting is exactly when a miner most
 * needs the stratum to keep working. Reading per call always has the current
 * one. This is why a dependent that can see the node's volume needs no
 * credential issued to it at all. */
function cookieAuth(path) {
  const raw = readFileSync(path, 'utf8').trim();
  return 'Basic ' + Buffer.from(raw).toString('base64');
}

const cfg = {
  host: process.env.RPC_HOST || '127.0.0.1',
  port: process.env.RPC_PORT || '18332',
  user: process.env.RPC_USER || 'regtest',
  pass: process.env.RPC_PASS || 'regtest',
  cookie: process.env.RPC_COOKIE || '',
};

/* The AUX chain, when merge mining. Its own endpoint: the parent chain builds
   the block, the aux chain contributes a hash to commit to and receives the
   solution back. Absent means single-chain mining, exactly as before. */
const auxCfg = {
  host: process.env.AUX_RPC_HOST || '',
  port: process.env.AUX_RPC_PORT || '',
  user: process.env.AUX_RPC_USER || '',
  pass: process.env.AUX_RPC_PASS || '',
  cookie: process.env.AUX_RPC_COOKIE || '',
};
const AUX_ENABLED = Boolean(auxCfg.host && auxCfg.port);

async function rpcTo(c, method, params = []) {
  const res = await fetch(`http://${c.host}:${c.port}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: c.cookie
        ? cookieAuth(c.cookie)
        : 'Basic ' + Buffer.from(`${c.user}:${c.pass}`).toString('base64'),
    },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'stratum', method, params }),
  });
  const j = JSON.parse(await res.text());
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

const rpc = (method, params = []) => rpcTo(cfg, method, params);
const auxRpc = (method, params = []) => rpcTo(auxCfg, method, params);

/* ── vardiff ──────────────────────────────────────────────────────────────── */

/**
 * Difficulty 1 is correct for a CPU and absurd for an ASIC: a 2 GH/s Scrypt
 * miner clears it twice a second, which floods the server, the daemon and the
 * log while measuring nothing better than a higher difficulty would.
 *
 * Aim for a fixed SECONDS-PER-SHARE instead, and let each client's difficulty
 * follow its own hashrate. Nothing about consensus changes: share difficulty
 * is a server-side accounting floor, and a solution that clears the NETWORK
 * target is still a block at any share difficulty (see onSubmit).
 */
const pow2 = (x) => 2 ** Math.max(0, Math.round(Math.log2(Math.max(x, 1e-9))));

const VARDIFF = {
  target:    Number(process.env.VARDIFF_TARGET   || 15),      // seconds per share
  retarget:  Number(process.env.VARDIFF_RETARGET || 60),      // seconds between moves
  minShares: 20,                                             // or this many shares, whichever first
  min:       Number(process.env.VARDIFF_MIN      || 1),
  /* A 2.3 GH/s rig at 15 s/share needs ~524288. A ceiling of 2^20 would have
     capped a modest fleet; 2^28 leaves room without being unbounded. */
  max:       Number(process.env.VARDIFF_MAX      || 2 ** 28),
  start:     Number(process.env.VARDIFF_START    || 4096),
  maxStep:   8,                                              // never move more than 8x at once
  tolerance: 0.3,                                            // ignore deviations under 30%
};

/**
 * Pure. Next difficulty from shares observed in a window.
 * Separated from the server so convergence can be simulated without sockets.
 */
function nextDifficulty(cur, shares, secs, v = VARDIFF) {
  if (secs <= 0) return cur;

  /* Zero shares measures nothing — a rate of 0 would demand difficulty 0.
     Step down GENTLY (2x, not maxStep) and look again. A full 8x cut on an
     empty window is destructive: at difficulty 1048576 and 2.23 GH/s the
     expected interval is 30.8s, so one empty 60s window arrives by chance 14%
     of the time, and a healthy rig was dropped to 131072 and made to climb
     back through every step. vardiffPass also holds this branch back until the
     window is long enough that an empty one is genuinely improbable. */
  if (shares === 0) return Math.max(v.min, pow2(cur / 2));

  const ratio = (shares / secs) / (1 / v.target);   // >1 means too many shares
  if (Math.abs(ratio - 1) < v.tolerance) return cur;

  /* Damped: move by the square root of the indicated factor. An estimate from
     a handful of shares carries tens of percent of error, and applying it
     undamped overshoots — this run settled on 1048576 when the ideal for 2.23
     GH/s is 524288, then oscillated. Converging in a few more steps is cheaper
     than ringing around the answer. */
  let next = cur * Math.sqrt(ratio);
  next = Math.min(next, cur * v.maxStep);
  next = Math.max(next, cur / v.maxStep);

  /* Damping and power-of-two rounding can cancel each other out: at 2097152
     against an ideal of 4194304 the damped target is 2768840, which pow2
     rounds straight back to 2097152 — no movement, forever, one notch short.
     When the direction is clear and outside tolerance, guarantee at least one
     step so convergence cannot stall. */
  let out = pow2(next);
  if (out === cur) out = ratio > 1 ? cur * 2 : cur / 2;
  return Math.min(v.max, Math.max(v.min, pow2(out)));
}

/* ── metering ─────────────────────────────────────────────────────────────── */

/**
 * Per-worker share accounting.
 *
 * This is the renting primitive, and it is deliberately separate from payouts.
 * A renter's question is not "who got paid" but "did my hashrate arrive and get
 * used" — which is answerable from accepted shares and their difficulty alone,
 * with no fee structure settled.
 *
 * Hashrate is an ESTIMATE from a Poisson process: at difficulty d a share costs
 * d * 2^32 scrypt hashes on average, so the rate is the share difficulty summed
 * over a window divided by its length. Over a few minutes at difficulty 1 it is
 * noisy by tens of percent, and it is not evidence of anything over seconds.
 * Lease metering should bill the accumulated share total, which is exact, and
 * show the rate only as a live readout.
 */
/* Must track DIFF1 exactly: hashes per difficulty-1 share = 2^256 / DIFF1.
   Hard-coding 2^32 here while DIFF1 says otherwise is how a hashrate figure
   ends up wrong by four orders of magnitude. */
const HASHES_PER_DIFF1 = 2 ** (256 - (240 + Number(SCRYPT_SHIFT) - 16));

/* Two quantities, deliberately kept apart:
 *
 *   sumDiff  — lifetime, exact, monotonic. What a lease bills against. No
 *              estimation is involved; it is a count of work proven.
 *   rolling  — per-minute buckets over a short window. Answers "is it working
 *              NOW", which a lifetime average cannot: firstSeen never moves,
 *              so a rig that dies six hours into a lease keeps reporting a
 *              healthy average forever.
 *
 * Buckets rather than a list of share timestamps, because at difficulty 1 a
 * single L9 can submit thousands of shares a second and a growing array would
 * be a memory leak with a plausible excuse. Fifteen buckets per worker, fixed.
 */
/* Which chain the primary RPC points at. Named rather than inferred: this
   server mines Dogecoin natively today and will mine Litecoin as the AuxPoW
   parent once merge mining lands, and a dashboard reading accepted blocks has
   to know which it is looking at. */
const PRIMARY_CHAIN = process.env.CHAIN_NAME || 'litecoin';

/* getblocktemplate rule set. Litecoin REQUIRES ["mweb","segwit"]; Dogecoin
   1.14 wants an empty list. Comma-separated so a package can set it without
   quoting JSON into an environment variable. */
/* Name of the merge-mined chain, for block records and logs. */
const AUX_CHAIN = process.env.AUX_CHAIN_NAME || 'dogecoin';

const GBT_RULES = (process.env.GBT_RULES ?? 'mweb,segwit')
  .split(',').map((s) => s.trim()).filter(Boolean);

const BUCKET_MS = 60_000;
const WINDOW_BUCKETS = Number(process.env.WINDOW_MINUTES || 15);

/* A second, shorter window. The 15-minute figure is billing-grade but lags
   badly: over a 14-minute run it still reported the whole-run average, 1.36
   GH/s, while the steady-state rate was 1.59. A renter asking "is it working
   now" needs the short number; an operator reconciling a lease needs the long
   one. Real pool dashboards show both for exactly this reason. */
/* Five minutes, not three. At a converged difficulty targeting 15s/share a
   3-minute window holds 5-12 shares, which straddles the gate and makes the
   readout flicker between a number and "warming" every 30 seconds. Five
   minutes holds ~20, comfortably clear, and still reacts far faster than the
   long window — which over a 17-minute run read 1.74 GH/s while the rig was
   doing 2.4. */
const SHORT_BUCKETS = Number(process.env.SHORT_WINDOW_MINUTES || 5);
const MIN_SHARES_SHORT = 8;    // +/-35%: coarse, but it is a liveness readout

/* Below this many shares in the window, publish no rate at all.
 * Relative standard error on a Poisson count is 1/sqrt(n): +/-100% at 1 share,
 * +/-22% at 20, +/-10% at 100. Showing "7.82 GH/s" off one share is not a
 * rounding problem, it is a fabricated number, and a renter cannot tell. */
const MIN_SHARES_FOR_RATE = 20;

class ShareMeter {
  constructor() { this.workers = new Map(); }

  /* `now` is threaded through every method rather than read from the clock
   * inside them, so the window logic is testable. Reading Date.now() here
   * while record() took an injected time let firstSeen sit AFTER the shares
   * being measured, which silently produced a negative span — and a negative
   * span fails the rate gate, so the symptom was a rate that never appeared
   * rather than a visibly wrong number. */
  touch(client, now = Date.now()) {
    const k = client.worker;
    if (!this.workers.has(k)) {
      this.workers.set(k, {
        worker: k, account: client.account, rig: client.rig,
        accepted: 0, rejected: 0, sumDiff: 0,
        firstSeen: now, lastShare: null,
        buckets: new Map(),   // minute index -> { diff, n }
      });
    }
    return this.workers.get(k);
  }

  /* `diff` is the difficulty the share is CREDITED at. See onSubmit: during a
     grace window this is decided per share by what the share ACHIEVED, not by
     the easier of the two settings — crediting everything at the old, easier
     figure undercounts by the whole retarget step (8x) for the entire window. */
  record(client, ok, now = Date.now(), diff = client.difficulty) {
    const w = this.touch(client, now);
    if (!ok) { w.rejected++; return; }

    w.accepted++; w.sumDiff += diff; w.lastShare = now;

    const b = Math.floor(now / BUCKET_MS);
    const cur = w.buckets.get(b) || { diff: 0, n: 0 };
    cur.diff += diff; cur.n += 1;
    w.buckets.set(b, cur);
    for (const k of w.buckets.keys()) if (k <= b - WINDOW_BUCKETS) w.buckets.delete(k);
  }

  /** Rolling rate for one worker. Returns shares === 0 .. MIN-1 with hs null. */
  static window(w, now = Date.now()) {
    const b = Math.floor(now / BUCKET_MS);
    let diff = 0, n = 0;
    for (const [k, v] of w.buckets) if (k > b - WINDOW_BUCKETS) { diff += v.diff; n += v.n; }

    // Span: from whichever is later — the window's edge or when we first saw
    // this worker — so a rig 10s old is not divided by 15 minutes.
    const edge = (b - WINDOW_BUCKETS + 1) * BUCKET_MS;
    const secs = (now - Math.max(edge, w.firstSeen)) / 1000;
    if (n < MIN_SHARES_FOR_RATE || secs <= 0) return { hs: null, shares: n, secs };
    return { hs: (diff * HASHES_PER_DIFF1) / secs, shares: n, secs, err: 1 / Math.sqrt(n) };
  }

  /* Rolled up per account, because that is the unit a lease is sold in.
   * Rolling share counts are summed across the account's rigs BEFORE the
   * confidence gate, so a fleet of slow rigs qualifies for a rate even while
   * no single rig does. */
  byAccount(now = Date.now()) {
    const out = new Map();
    for (const w of this.workers.values()) {
      const a = out.get(w.account) || {
        account: w.account, rigs: 0, accepted: 0, rejected: 0, sumDiff: 0,
        firstSeen: w.firstSeen, lastShare: null, winDiff: 0, winShares: 0, winSecs: 0,
        shortDiff: 0, shortShares: 0, accepted: 0,
      };
      a.rigs++; a.accepted += w.accepted; a.rejected += w.rejected; a.sumDiff += w.sumDiff;
      a.meanDiff = a.accepted > 0 ? a.sumDiff / a.accepted : 0;
      a.firstSeen = Math.min(a.firstSeen, w.firstSeen);
      a.lastShare = Math.max(a.lastShare || 0, w.lastShare || 0) || null;

      const b = Math.floor(now / BUCKET_MS);
      for (const [k, v] of w.buckets) {
        if (k > b - WINDOW_BUCKETS) { a.winDiff += v.diff; a.winShares += v.n; }
        if (k > b - SHORT_BUCKETS)  { a.shortDiff += v.diff; a.shortShares += v.n; }
      }
      const edge = (b - WINDOW_BUCKETS + 1) * BUCKET_MS;
      a.winSecs = Math.max(a.winSecs, (now - Math.max(edge, a.firstSeen)) / 1000);

      out.set(w.account, a);
    }
    for (const a of out.values()) {
      a.hs = (a.winShares >= MIN_SHARES_FOR_RATE && a.winSecs > 0)
        ? (a.winDiff * HASHES_PER_DIFF1) / a.winSecs : null;
      a.err = a.winShares > 0 ? 1 / Math.sqrt(a.winShares) : null;

      const shortSecs = Math.min(a.winSecs, SHORT_BUCKETS * BUCKET_MS / 1000);
      a.shortHs = (a.shortShares >= MIN_SHARES_SHORT && shortSecs > 0)
        ? (a.shortDiff * HASHES_PER_DIFF1) / shortSecs : null;
      a.shortErr = a.shortShares > 0 ? 1 / Math.sqrt(a.shortShares) : null;
    }
    return [...out.values()];
  }

  static human(hs) {
    const u = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
    let i = 0; while (hs >= 1000 && i < u.length - 1) { hs /= 1000; i++; }
    return `${hs.toFixed(hs < 10 ? 2 : 1)} ${u[i]}`;
  }

  report(now = Date.now()) {
    const rows = this.byAccount(now);
    if (rows.length === 0) return 'no workers yet';
    const lines = rows.map((a) => {
      /* No rate until the sample supports one. "warming up" is the honest
         reading of 3 shares; a number there would be invention. */
      const fmt = (hs, err, shares, gate) => hs === null
        ? `warming ${shares}/${gate}`.padStart(18)
        : `${ShareMeter.human(hs)} ±${Math.round(err * 100)}%`.padStart(18);
      const idle = a.lastShare ? `${Math.round((now - a.lastShare) / 1000)}s ago` : 'never';
      /* `acc` is directly comparable to the miner's own "Accepted" counter, and
         `avgdiff` is what turns one into the other: hashrate = acc * avgdiff *
         2^16 / elapsed. Printing all three means a miner-vs-server
         disagreement can be read off rather than reconstructed. */
      return `    ${a.account.padEnd(16)} rigs ${String(a.rigs).padStart(3)}`
           + `  acc ${String(a.accepted).padStart(5)}`
           + `  avgdiff ${String(Math.round(a.meanDiff || 0)).padStart(8)}`
           + `  billable ${String(a.sumDiff).padStart(9)}`
           + `  rej ${String(a.rejected).padStart(3)}`
           + `  now ${fmt(a.shortHs, a.shortErr, a.shortShares, MIN_SHARES_SHORT)}`
           + `  ${WINDOW_BUCKETS}m ${fmt(a.hs, a.err, a.winShares, MIN_SHARES_FOR_RATE)}`
           + `  last ${idle}`;
    });
    return `by account — billable is exact lifetime difficulty; "now" is a`
         + ` ${SHORT_BUCKETS}-min estimate, "${WINDOW_BUCKETS}m" the longer average`
         + `\n${lines.join('\n')}`;
  }
}

/* Addresses carried in the stratum username, for an operator who chose not
 * to store them on the server:
 *
 *     LTC_ADDRESS,DOGE_ADDRESS.RIG_ID
 *
 * Unambiguous to split, because no Litecoin or Dogecoin address contains a
 * comma or a dot -- base58 has neither, and bech32's charset excludes both.
 *
 * Returns null for an ordinary worker name, which is the overwhelmingly
 * common case and must stay free. Throws for something that LOOKS like this
 * form but is not valid, so a typo is refused at authorize rather than
 * discovered when a block pays nobody.
 *
 * The cost of this convenience is real, and is why it is not the default:
 * stratum v1 is plaintext, so both addresses cross the wire on every
 * reconnect, and the string runs ~85 characters with a comma in it, which
 * some Canaan/Avalon firmware refuses outright.
 */
/* What the DASHBOARD calls this miner, which is not what the miner sent.
 *
 * A supplied-payout username is ~85 characters of address, so it never
 * reaches the logs, the stats API or the page. The operator's own label goes
 * there instead: `awfulwaffle.garage` rather than `ext955e26.garage`.
 *
 * The hash is kept as a suffix ONLY when a second, different address set is
 * in play. Labelling two payees identically would misreport who mined what
 * -- it cannot misdirect money, since payouts come from the job's addresses
 * and never from a username, but a meter that merges two people is still
 * wrong. With one operator and one wallet pair, which is this package's whole
 * case, the suffix never appears.
 *
 * In stored-addresses mode the default target already exists, so a miner that
 * supplies its own addresses is by definition a second set and gets the
 * suffix. That is right: the configured name belongs to the configured
 * addresses, and a miner paying somewhere else should not wear it.
 */
function displayAccount(supplied, jobs) {
  const name = (process.env.WORKER_ACCOUNT || '').trim();
  if (!name) return supplied.account;
  return jobs.targets.size > 1
    ? `${name}-${supplied.account.slice(3, 7)}`
    : name;
}

function parseWorkerPayout(username) {
  const comma = username.indexOf(',');
  if (comma === -1) return null;
  const ltc = username.slice(0, comma).trim();
  const rest = username.slice(comma + 1);
  const dot = rest.indexOf('.');
  const doge = (dot === -1 ? rest : rest.slice(0, dot)).trim();
  const rig = dot === -1 ? '' : rest.slice(dot + 1).trim();
  if (!ltc || !doge) throw new Error('expected LTC_ADDRESS,DOGE_ADDRESS.RIG');
  // Both decode or the miner is refused. addressToScript is the same check
  // the coinbase builder would make, just made now instead of too late.
  addressToScript(ltc);
  addressToScript(doge);
  /* A short stable handle for the pair, so the dashboard groups one person's
     rigs together without showing 85 characters of address in every row. */
  const account = 'ext' + sha256(Buffer.from(`${ltc}|${doge}`)).toString('hex').slice(0, 6);
  return { target: { kind: 'fixed', ltc, doge }, rig: rig || 'rig1', account };
}

/* ── jobs ─────────────────────────────────────────────────────────────────── */

const EN1_SIZE = 4, EN2_SIZE = 4;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

class JobManager {
  /* Jobs are keyed by PAYOUT TARGET, not by worker.
   *
   * The coinbase pays the address, the coinbase is in the merkle root, and
   * the merkle root is in the header the miner hashes -- so two miners with
   * different payout addresses cannot share a job. They can share a target:
   * every rig in one household points at the same two wallets, so the common
   * case is exactly one target and exactly the RPC cost of the old code.
   *
   * Every target is a pair of addresses: either the two stored in the
   * service config, or two a miner supplied in its worker name because the
   * operator chose not to store them here.
   *
   * There is deliberately no "pay into the node's own wallet" target. The
   * Litecoin package ships no wallet -- Core stopped auto-creating the
   * default one in 0.21, and the package does not create it -- so
   * `getnewaddress` answers error -18 and there is nothing to pay. Dogecoin
   * 1.14 still auto-creates one, which makes the failure asymmetric and
   * therefore worse: half the pair would work.
   */
  /* defaultTarget may be null: in workerName mode the operator stores no
     addresses at all, so there is nothing to pay until a miner says where.
     The port still binds -- unlike 'unset', this IS a configured choice. */
  constructor(defaultTarget) {
    this.jobs = new Map(); this.seq = 0;
    this.targets = new Map();
    this.lastTemplate = null;
    this.defaultKey = defaultTarget ? this.addTarget(defaultTarget) : null;
  }

  static key(t) {
    return `${t.ltc}|${t.doge ?? ''}`;
  }

  /* Validated HERE rather than at first use. A malformed address that only
     throws once a block is found is the worst possible time to learn of it,
     and addressToScript is the same check the coinbase builder would make. */
  addTarget(t) {
    const key = JobManager.key(t);
    if (this.targets.has(key)) return key;
    addressToScript(t.ltc);                         // throws on a bad address
    if (AUX_ENABLED && !t.doge) {
      throw new Error('merge mining needs a Dogecoin address as well as a Litecoin one');
    }
    this.targets.set(key, { ...t, key, current: null });
    return key;
  }

  /* A cap, because a target costs an RPC per template on each chain and the
     worker name is attacker-controlled on any LAN the stratum is reachable
     from. One household needs one; a handful covers sharing a box. */
  static MAX_TARGETS = 8;

  async ensureTarget(t) {
    const key = JobManager.key(t);
    if (this.targets.has(key)) return key;
    if (this.targets.size >= JobManager.MAX_TARGETS) {
      throw new Error(`too many distinct payout addresses (max ${JobManager.MAX_TARGETS})`);
    }
    this.addTarget(t);
    // Give it work immediately rather than making the miner wait for the next
    // template: it has already authorized and expects a job.
    if (this.lastTemplate) await this.buildFor(this.targets.get(key), this.lastTemplate, false);
    return key;
  }

  jobFor(key) {
    if (!key) return null;
    const t = this.targets.get(key) || (this.defaultKey ? this.targets.get(this.defaultKey) : null);
    return t ? t.current : null;
  }

  async refresh() {
    /* The rule set is per-chain and NOT optional on Litecoin.
     *
     * Dogecoin 1.14 predates segwit and is happy with an empty list. Litecoin
     * 0.21 refuses outright:
     *
     *   error -8: getblocktemplate must be called with the segwit & mweb rule
     *   sets (call with {"rules": ["mweb", "segwit"]})
     *
     * so a server written against Dogecoin cannot obtain a Litecoin template
     * at all. That is a loud failure rather than a silent one, which is the
     * only good thing about it. Driven by env so one binary serves both and
     * the package sets it per chain. */
    const t = await rpc('getblocktemplate', [{ rules: GBT_RULES }]);
    const prev = this.lastTemplate;
    const unchanged = prev
      && prev.previousblockhash === t.previousblockhash
      && (prev.transactions || []).length === (t.transactions || []).length;
    /* A target with no job yet still needs one built, even when the template
       has not moved: that is how a miner which connected mid-template gets
       work without waiting for the next one. */
    const anyFresh = [...this.targets.values()].some((x) => !x.current);
    if (unchanged && !anyFresh) return null;
    if (this.targets.size === 0) { this.lastTemplate = t; return null; }

    /* Only a MOVED TIP orphans the previous jobs. A template that merely picked
     * up new transactions still builds on the same prevhash, so blocks found
     * against the old job remain perfectly valid and must stay submittable --
     * marking those stale would throw away real blocks. */
    const tipMoved = prev !== null && prev.previousblockhash !== t.previousblockhash;
    if (tipMoved) for (const j of this.jobs.values()) j.stale = true;
    this.lastTemplate = t;

    let first = null;
    for (const target of this.targets.values()) {
      try {
        const job = await this.buildFor(target, t, tipMoved);
        if (!first) first = job;
      } catch (e) {
        /* One target's failure must not cost the others their work. */
        log(`! target ${target.key}: ${e.message} — no work for it this round`);
      }
    }
    return first;
  }

  async buildFor(target, t, tipMoved) {
    const { ltc, doge } = target;
    const payoutScript = addressToScript(ltc);
    const txs = t.transactions || [];
    /* Supplied by chains with segwit active, absent on Dogecoin 1.14. Taken
       from the template rather than computed here: it commits to the wtxid
       merkle root of THIS transaction set, which is the set we are about to
       mine, so the node has already done the work correctly. Computing it
       ourselves would be a second implementation to get wrong. */
    const commitment = t.default_witness_commitment
      ? Buffer.from(t.default_witness_commitment, 'hex')
      : null;

    /* Ask the aux chain for a block to commit to. Its hash goes into the
       parent coinbase, so this MUST happen before the coinbase is built --
       and a new one is taken per template, because committing to a stale aux
       block means a solved parent header that the aux chain refuses.
       Per target, because createauxblock builds the aux coinbase around the
       address it is given. */
    let aux = null;
    if (AUX_ENABLED && doge) {
      try {
        const a = await auxRpc('createauxblock', [doge]);
        aux = {
          hash: a.hash,
          chainid: a.chainid,
          /* `target` is reported in reversed byte order (Dogecoin names the
             field `_target` on some builds for exactly that reason), so it is
             reversed here into the big-endian integer a hash compares
             against. */
          target: BigInt('0x' + rev(Buffer.from(a._target || a.target, 'hex')).toString('hex')),
          height: a.height,
          value: a.coinbasevalue,
        };
      } catch (e) {
        /* The parent chain is still perfectly mineable without the aux chain;
           losing it costs the second lottery ticket, not the first. Never let
           an aux failure stop work going out. */
        log(`! aux createauxblock: ${e.message} — mining ${PRIMARY_CHAIN} only this round`);
      }
    }

    const tail = aux
      ? Buffer.concat([mergedMiningTail(aux.hash), Buffer.from('/awm-solo/')])
      : Buffer.from('/awm-solo/');

    const { coinb1, coinb2 } = splitCoinbase({
      height: t.height, value: t.coinbasevalue, script: payoutScript,
      en1Size: EN1_SIZE, en2Size: EN2_SIZE, tail,
      commitment,
    });
    const others = txs.map((x) => rev(Buffer.from(x.txid || x.hash, 'hex')));

    const job = {
      id: (++this.seq).toString(16).padStart(8, '0'),
      height: t.height, prevhash: t.previousblockhash,
      coinb1, coinb2, branch: merkleBranch(others), others, commitment, aux,
      version: t.version, bits: t.bits, curtime: t.curtime,
      target: targetFromBits(t.bits), txs, txCount: txs.length,
      payoutScript, stale: false,
      /* Carried on the job, not read off the manager: with more than one
         target the manager has no single answer, and a block log that names
         the wrong address is worse than none. */
      payoutAddress: ltc, auxAddress: doge, targetKey: target.key,
      /* Whether the PREVIOUS work became invalid. This is what clean_jobs on
         mining.notify means, and the two cases are not the same: a moved tip
         invalidates work in progress, a template that merely picked up new
         transactions does not. */
      tipMoved,
    };
    this.jobs.set(job.id, job);
    // Keep a short history so late shares on the previous job still validate.
    // Scaled by target count so one busy target cannot evict another's job.
    const keep = 8 * Math.max(1, this.targets.size);
    while (this.jobs.size > keep) this.jobs.delete(this.jobs.keys().next().value);
    target.current = job;
    log(`job ${job.id} height ${job.height} txs ${job.txCount} branch ${job.branch.length}`
        + (this.targets.size > 1 ? ` [${target.key.slice(0, 24)}]` : ''));
    return job;
  }

  notifyParams(job, clean) {
    return [
      job.id,
      prevhashToStratum(job.prevhash),
      job.coinb1.toString('hex'),
      job.coinb2.toString('hex'),
      job.branch.map((b) => b.toString('hex')),
      (job.version >>> 0).toString(16).padStart(8, '0'),
      job.bits,
      job.curtime.toString(16).padStart(8, '0'),
      clean,
    ];
  }
}

/* ── server ───────────────────────────────────────────────────────────────── */

class StratumServer {
  constructor({ port = 3333, jobs }) {
    this.port = port; this.jobs = jobs; this.clients = new Set(); this.en1 = 0;
    this.meter = new ShareMeter();
    /* Accepted blocks, newest last. `lastBlock` below keeps only the most
       recent one, which is enough for a log line but not for a dashboard that
       has to show what this rig has ever found. Bounded because this is a
       solo miner: at the odds involved, a list that grew without limit would
       still be short, but an unbounded array fed by a loop is how a
       long-running process leaks. */
    this.blocks = [];
    /* Recent shares, for the distribution the dashboard draws. Only the
       achieved difficulty is kept -- enough to show how close each one came
       without storing a header per share. Bounded: a busy rig produces
       thousands an hour and this is a liveness view, not an archive. */
    this.shares = [];
    this.startedAt = Date.now();
    /* Converged difficulty, remembered per worker name. A reconnecting miner
       otherwise restarts at VARDIFF.start and re-climbs through every step,
       flooding us on the way up — this run showed it plainly: the rig dropped
       at 19:36:01 having reached 1048576 and began again at 4096. Miners
       reconnect constantly in production (blips, pool failover), so without
       this the climb is the normal case rather than the exception. */
    this.lastDifficulty = new Map();
  }

  start() {
    this.server = net.createServer((sock) => this.onConnect(sock));
    return new Promise((r) => this.server.listen(this.port, () => {
      log(`stratum listening on ${this.server.address().port}`); r(this.server.address().port);
    }));
  }

  stop() { for (const c of this.clients) c.sock.destroy(); return new Promise((r) => this.server.close(r)); }

  onConnect(sock) {
    const client = {
      sock, id: randomBytes(4).toString('hex'),
      en1: Buffer.alloc(4), difficulty: VARDIFF.start, authorized: false, buf: '',
      worker: null, account: null, rig: null, subscribed: false,
      vdSince: Date.now(), vdShares: 0,     // vardiff measurement window
      prevDiff: null, prevDiffUntil: 0,     // grace for work in flight at the old difficulty
      staleBlocks: 0,
    };
    /* Random, not sequential: a counter resets to 1 whenever the server
       restarts, so a reconnecting miner would be handed the same extranonce1
       it already searched — duplicating its own work. Real pools randomise. */
    client.en1 = randomBytes(4);
    this.en1++;
    this.clients.add(client);
    /* Deliberately silent until subscribe. Firmware probes its configured pool
       slots on a timer, opening and closing sockets that never speak stratum;
       logging those buries the connections that matter. Counted, not printed. */
    this.probes = this.probes || 0;

    sock.setNoDelay(true);
    sock.on('data', (d) => {
      client.buf += d.toString('utf8');
      let i;
      while ((i = client.buf.indexOf('\n')) >= 0) {
        const line = client.buf.slice(0, i).trim();
        client.buf = client.buf.slice(i + 1);
        if (line) this.onMessage(client, line).catch((e) => log(`! ${client.id}: ${e.message}`));
      }
    });
    sock.on('error', (e) => log(`! ${client.id} socket: ${e.message}`));
    sock.on('close', () => {
      this.clients.delete(client);
      if (client.subscribed) log(`- client ${client.id}`
          + (client.worker ? ` ("${client.worker}")` : '')
          + (client.staleBlocks ? ` — ${client.staleBlocks} stale` : ''));
      else if (++this.probes % 20 === 0) log(`(${this.probes} probe connections ignored)`);
    });
  }

  send(client, obj) {
    if (!client.sock.destroyed) client.sock.write(JSON.stringify(obj) + '\n');
  }

  async onMessage(client, line) {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    const { id, method, params = [] } = msg;

    switch (method) {
      case 'mining.subscribe': {
        const sid = client.id;
        this.send(client, {
          id, error: null,
          result: [[['mining.set_difficulty', sid], ['mining.notify', sid]],
                   client.en1.toString('hex'), EN2_SIZE],
        });
        client.subscribed = true;
        log(`+ ${client.id} from ${client.sock.remoteAddress} `
            + `subscribe (${params[0] || 'unknown miner'})`);
        break;
      }

      case 'mining.authorize': {
        /* The username is a WORKER NAME, not a payout address.
         *
         * Both deployments pay a single operator-configured address: on StartOS
         * the installer sets their own, and in AWM the coinbase pays AWM's
         * address while the miner relationship settles in USDC on Base. Public
         * solo pools do it the other way round, and copying them here would
         * reject every real worker name — AWM's own convention looks like
         * awm_00001.avalonmini3_001, which is not base58 and never will be.
         *
         * So accept any username, keep it for logging and per-worker stats,
         * and never let it influence where money goes. */
        const rawUser = String(params[0] || 'anonymous');

        /* A username may carry its own payout addresses, for an operator who
           chose not to store them on the server:
               LTC_ADDRESS,DOGE_ADDRESS.RIG_ID
           Both addresses are validated before the miner is accepted. A typo
           must NOT silently fall back to the configured address -- that would
           pay the operator for someone else's work, or the other way round.
           The cost of this convenience is real and is the reason it is not
           the default: stratum v1 is plaintext, so both addresses cross the
           wire on every reconnect, and the string is ~85 characters with a
           comma in it, which some Canaan/Avalon firmware refuses outright.

           The parse is INSIDE the try: it throws on a malformed address, and
           an exception escaping here would leave the miner with no response
           at all -- it sits on an unanswered authorize until it gives up,
           which looks like a dead pool rather than a typo. */
        let supplied = null;
        client.payoutKey = this.jobs.defaultKey;
        try {
          supplied = parseWorkerPayout(rawUser);
          if (supplied) client.payoutKey = await this.jobs.ensureTarget(supplied.target);
        } catch (e) {
          log(`  ${client.id} refused: ${e.message}`);
          this.send(client, { id, error: [24, `payout address refused: ${e.message}`, null], result: false });
          return;
        }
        /* Rewritten so the long form never reaches the logs, the stats API or
           the dashboard; the addresses live on the job already. Assigned only
           once the parse has succeeded, so a refused address is not carried
           around on the client either. */
        if (!supplied && !this.jobs.defaultKey) {
          /* workerName mode: the operator stores no addresses, so a username
             without them has nowhere to pay. Refusing is the only honest
             answer -- accepting would hand out work whose coinbase pays
             nobody. */
          const why = 'this server stores no payout address; authorize as'
            + ' LTC_ADDRESS,DOGE_ADDRESS.RIG';
          log(`  ${client.id} refused: no payout addresses supplied`);
          this.send(client, { id, error: [24, why, null], result: false });
          return;
        }
        client.worker = supplied
          ? `${displayAccount(supplied, this.jobs)}.${supplied.rig}`
          : rawUser;
        client.suppliedPayout = Boolean(supplied);

        /* Stratum's "account.rig" convention maps onto the lease model with no
         * extra protocol: the part before the dot identifies who is renting,
         * the part after identifies which box. Metering therefore rolls up per
         * renter without the miner having to send anything bespoke. */
        const dot = client.worker.indexOf('.');
        client.account = dot === -1 ? client.worker : client.worker.slice(0, dot);
        client.rig = dot === -1 ? '' : client.worker.slice(dot + 1);

        /* Honour a `d=N` difficulty request in the password field. This is the
         * de-facto convention across Scrypt pools, and this hardware already
         * sends it unprompted (observed: "d=1098633_lock=3"). Taking it as the
         * STARTING difficulty skips vardiff's climb entirely for a miner that
         * already knows its own rate; vardiff still corrects from there, so a
         * stale or optimistic value self-heals rather than sticking. */
        const pass = String(params[1] || '');
        const dReq = /(?:^|[_,;&])d=(\d+(?:\.\d+)?)/.exec(pass);
        if (dReq) {
          const asked = Number(dReq[1]);
          const used = Math.min(VARDIFF.max, Math.max(VARDIFF.min, pow2(asked)));
          log(`  ${client.id} requested difficulty ${asked} via password -> using ${used}`
              + (used !== asked ? ` (clamped to [${VARDIFF.min}, ${VARDIFF.max}] and rounded to a power of two)` : ''));
          client.difficulty = used;
        }

        /* Resume where this worker left off, unless it asked for a specific
           difficulty via d= (an explicit request wins over our memory). */
        if (!dReq && this.lastDifficulty.has(client.worker)) {
          const resumed = this.lastDifficulty.get(client.worker);
          if (resumed !== client.difficulty) {
            log(`  ${client.id} resuming difficulty ${resumed} for "${client.worker}"`
                + ` (was ${client.difficulty})`);
            client.difficulty = resumed;
          }
        }

        client.authorized = true;
        client.vdSince = Date.now(); client.vdShares = 0;
        this.meter.touch(client);
        this.send(client, { id, error: null, result: true });
        log(`  ${client.id} authorized worker "${client.worker}"`
            + ` (account ${client.account}${client.rig ? `, rig ${client.rig}` : ''})`);
        this.send(client, { id: null, method: 'mining.set_difficulty', params: [client.difficulty] });
        const job = this.jobs.jobFor(client.payoutKey);
        if (job) this.send(client, { id: null, method: 'mining.notify', params: this.jobs.notifyParams(job, true) });
        break;
      }

      case 'mining.submit': {
        const [, jobId, en2hex, ntimeHex, nonceHex] = params;
        const r = await this.onSubmit(client, jobId, en2hex, ntimeHex, nonceHex);
        if (client.authorized) this.meter.record(client, r.ok, Date.now(), r.diff ?? client.difficulty);
        this.send(client, r.ok
          ? { id, error: null, result: true }
          : { id, error: [r.code || 23, r.reason, null], result: false });
        break;
      }

      default:
        this.send(client, { id, error: null, result: true });
    }
  }

  async onSubmit(client, jobId, en2hex, ntimeHex, nonceHex) {
    const job = this.jobs.jobs.get(jobId);
    if (!job) return { ok: false, code: 21, reason: 'job not found' };
    if (!client.authorized) return { ok: false, code: 24, reason: 'not authorized' };

    const en2 = Buffer.from(en2hex, 'hex');
    if (en2.length !== EN2_SIZE) return { ok: false, reason: 'bad extranonce2 size' };

    const coinbase = Buffer.concat([job.coinb1, client.en1, en2, job.coinb2]);
    const merkle = foldBranch(sha256d(coinbase), job.branch);
    const header = Buffer.concat([
      u32le(job.version), rev(Buffer.from(job.prevhash, 'hex')), merkle,
      u32le(parseInt(ntimeHex, 16)), rev(Buffer.from(job.bits, 'hex')),
      u32le(parseInt(nonceHex, 16)),
    ]);

    const hash = hashToBig(scryptPoW(header));

    /* A share that would make a VALID BLOCK must never be rejected for being
       too easy. On regtest, and on testnet whenever the min-difficulty rule
       fires, the network target is easier than difficulty 1 — so a share can
       clear the chain while failing the configured share floor. Accept if it
       clears either. Larger target means easier. */
    /* Vardiff grace: work handed out before a retarget was solved against the
       OLD difficulty, and that miner cannot be blamed for our timing. Validate
       against whichever of the two is easier (lower number = easier) for a
       short window, and credit the share at that same figure. */
    const graceOn = client.prevDiff !== null && Date.now() < client.prevDiffUntil;
    const effDiff = graceOn ? Math.min(client.difficulty, client.prevDiff) : client.difficulty;

    const shareTarget = targetForDifficulty(effDiff);
    if (hash > shareTarget && hash > job.target)
      return { ok: false, code: 23, reason: 'low difficulty share' };

    client.vdShares++;

    /* What difficulty did this share actually achieve? Answers from data, not
       speculation, whether the miner is working to our set_difficulty or to
       the job's nbits — which on regtest is trivially easy and would make the
       share rate meaningless. Scaled integer division keeps BigInt precision. */
    const achieved = Number((DIFF1 * 1000000n) / hash) / 1000000;

    /* ACCEPTANCE uses the easier of the two difficulties, so a retarget never
       punishes work already in flight. CREDIT is decided per share by what it
       actually achieved: a share that clears the NEW difficulty is worth the
       new difficulty, and only one that falls short of it gets the old figure.
       Crediting every share at the grace floor undercounted the hashrate by
       the full step size for the whole 60-second window. */
    const credit = achieved >= client.difficulty ? client.difficulty : effDiff;
    client.achMax = Math.max(client.achMax || 0, achieved);
    client.achSum = (client.achSum || 0) + achieved;

    /* Snapshot BEFORE the retarget below, which mutates client.difficulty.
       Reading it afterwards mixed pre- and post-retarget state in one line and
       produced output that contradicted itself: "achieved 22728 vs 32768
       assigned, credited 4096" described a share that was assigned 4096, met
       it, and was paid for it — the 32768 had leaked in from the retarget that
       had just happened. */
    const assigned = client.difficulty;
    const shouldLog = client.vdShares <= 3 || client.vdShares % 100 === 0;

    /* Bound the burst. Fast hardware at a too-low difficulty can submit tens
       of thousands of shares per second; waiting for the 5-second vardiff timer
       would mean six figures of submissions before the first correction. */
    if (client.vdShares >= VARDIFF.minShares) this.retarget(client);

    this.shares.push({ t: Date.now(), achieved, assigned, worker: client.worker });
    if (this.shares.length > 2000) this.shares.shift();

    if (shouldLog)
      log(`  ${client.id} share achieved ${achieved.toFixed(1)}`
          + ` vs ${assigned} assigned, credited ${credit}`
          + ` (ratio 2^${(Math.log2(Math.max(achieved, 1e-12) / assigned)).toFixed(1)}`
          + `${graceOn ? `, grace floor ${effDiff}` : ''})`);

    /* THE AUX CHAIN IS CHECKED FIRST AND INDEPENDENTLY.
     *
     * This is the whole point of merge mining: one scrypt hash, two targets,
     * and they are unrelated. The aux target is usually the easier of the two
     * (Dogecoin's 60-second block against Litecoin's 150), so most wins are
     * aux-only — and gating this behind the parent check would throw away the
     * majority of what merge mining earns, silently, while the dashboard
     * showed everything working.
     *
     * A share that clears neither is just a share; one that clears both pays
     * twice from the same work. */
    if (job.aux && hash <= job.aux.target) {
      const coinbase = Buffer.concat([job.coinb1, client.en1, en2, job.coinb2]);
      try {
        const auxpow = buildAuxPow({
          coinbaseStripped: coinbase,
          branch: job.branch,
          parentHeader: header,
        });
        const res = await auxRpc('submitauxblock', [job.aux.hash, auxpow]);
        if (res === true || res === null) {
          log(`  *** AUX BLOCK ACCEPTED — ${job.aux.height} on the aux chain`
              + ` -> ${job.auxAddress} (found by "${client.worker}") ***`);
          this.blocks.push({
            chain: AUX_CHAIN, height: job.aux.height,
            address: job.auxAddress, worker: client.worker,
            foundAt: Date.now(),
          });
          if (this.blocks.length > 500) this.blocks.shift();
        } else {
          log(`  !!! aux block not accepted (${JSON.stringify(res)}) — share still credited`);
        }
      } catch (e) {
        /* Same rule as the parent chain: the SHARE was valid, it cleared the
           target we set. Never return a rejection because our submission
           failed — firmware counts rejects to decide a pool is broken. */
        log(`  !!! submitauxblock failed: ${e.message} — share still credited`);
      }
    }

    if (hash <= job.target) {
      /* A solution against a job whose tip has already moved is an orphan by
         construction — it builds on a block that is no longer the tip, so the
         daemon will answer "inconclusive" every time. Don't spend the RPC.
         The share still counts: the miner did this work before it could have
         known, and refusing to credit it would penalise our own latency. */
      if (job.stale) {
        client.staleBlocks += 1;
        if (client.staleBlocks === 1 || client.staleBlocks % 50 === 0)
          log(`  (stale solution on job ${job.id} h${job.height}, not submitted`
              + ` — ${client.staleBlocks} so far; work is arriving late)`);
        return { ok: true, diff: credit };
      }
      log(`  *** ${client.id} BLOCK at height ${job.height} ***`);
      /* The miner hashed the STRIPPED coinbase to build its merkle root, and
         that is correct: a txid is defined over the non-witness bytes. The
         block, however, must carry the witness whenever a commitment output
         is present, or the node rejects it for an unexpected witness
         commitment. Splice it in here and nowhere else. */
      const block = Buffer.concat([
        header, varint(1 + job.txs.length),
        job.commitment ? coinbaseWithWitness(coinbase) : coinbase,
        ...job.txs.map((t) => Buffer.from(t.data, 'hex')),
      ]);
      try {
        const res = await rpc('submitblock', [block.toString('hex')]);
        if (res === null) {
          /* We just moved the tip ourselves, so every outstanding job is
             orphan-producing as of NOW. Waiting for the next getblocktemplate
             poll to notice leaves a window — up to the full refresh interval —
             in which the miner keeps solving the old prevhash and we keep
             spending submitblock calls on guaranteed orphans. That window is
             exactly where the "inconclusive" flood lives. */
          for (const j of this.jobs.jobs.values()) j.stale = true;

          /* Report the address the coinbase actually pays, and credit the
             worker separately. Naming the worker here as the payee would be a
             lie that only surfaces when someone goes looking for coins. */
          log(`  *** ACCEPTED — height ${job.height} -> ${job.payoutAddress}`
              + ` (found by "${client.worker}") ***`);
          this.lastBlock = {
            height: job.height,
            address: job.payoutAddress,
            worker: client.worker,
          };
          /* Recorded for the stats API. `chain` is carried explicitly rather
             than inferred: once merge mining lands, an accepted parent block
             and an accepted aux block arrive through different submit calls
             and a dashboard must be able to tell them apart. */
          this.blocks.push({
            chain: PRIMARY_CHAIN,
            height: job.height,
            address: job.payoutAddress,
            worker: client.worker,
            foundAt: Date.now(),
          });
          if (this.blocks.length > 500) this.blocks.shift();
        } else {
          /* The SHARE was valid — it cleared the target we set. Only the BLOCK
             lost a race. Returning a share rejection here blames the miner for
             our latency, and firmware counts rejects to decide a pool is
             broken: five of these in a row is what made this miner fail over
             and reconnect every 15 seconds. Log the block, accept the share. */
          log(`  !!! block not accepted (${res}) — share still credited`);
        }
      } catch (e) { log(`  !!! submitblock failed: ${e.message}`); }
    }
    return { ok: true, diff: credit };
  }

  /* Apply a new share difficulty and immediately push clean work, so the
     setting takes effect on the next piece of work rather than whenever the
     miner happens to ask. The old difficulty stays valid during the grace
     window kept in onSubmit. */
  setDifficulty(client, next, now = Date.now()) {
    const from = client.difficulty;
    client.prevDiff = from;
    client.prevDiffUntil = now + 60_000;
    client.difficulty = next;
    this.lastDifficulty.set(client.worker, next);
    this.send(client, { id: null, method: 'mining.set_difficulty', params: [next] });
    /* clean_jobs FALSE here. The new difficulty applies to work the miner takes
       up next; forcing a discard would throw away a partially searched nonce
       range to save a few seconds, and the grace window in onSubmit already
       makes the handover fair in the other direction. */
    const job = this.jobs.jobFor(client.payoutKey);
    if (job) this.send(client, { id: null, method: 'mining.notify', params: this.jobs.notifyParams(job, false) });
    log(`  ${client.id} difficulty ${from} -> ${next}`
        + ` (targeting ${VARDIFF.target}s/share for "${client.worker}")`);
  }

  /* Retarget on whichever comes first: the time window, or enough shares to
     measure with. The share count matters for fast hardware — an ASIC starting
     at difficulty 1 would otherwise flood for a full retarget period before
     anything moved. */
  retarget(client, now = Date.now()) {
    const secs = (now - client.vdSince) / 1000;
    const next = nextDifficulty(client.difficulty, client.vdShares, secs);
    client.vdSince = now; client.vdShares = 0;
    if (next !== client.difficulty) this.setDifficulty(client, next, now);
  }

  vardiffPass(now = Date.now()) {
    for (const c of this.clients) {
      if (!c.authorized) continue;
      const secs = (now - c.vdSince) / 1000;
      if (secs < VARDIFF.retarget && c.vdShares < VARDIFF.minShares) continue;

      /* Near convergence the window holds only a handful of shares, and a rate
         estimated from 3 or 4 of them carries ±50% error — easily enough to
         breach the 30% tolerance on noise alone and set the difficulty
         oscillating around the right answer forever. Wait for a bigger sample
         instead, but never when the count is ZERO: that is a stalled miner and
         nextDifficulty steps it down deliberately. */
      if (c.vdShares > 0 && c.vdShares < 5 && secs < VARDIFF.retarget * 4) continue;

      /* An EMPTY window needs to be long enough that silence is evidence.
         Expected interval at the current difficulty is diff * 2^16 / rate, so
         wait several of those before concluding anything — using the account's
         measured rate when there is one, and a conservative floor otherwise. */
      if (c.vdShares === 0) {
        const acct = this.meter.byAccount(now).find((a) => a.account === c.account);
        const rate = (acct && (acct.hs || acct.shortHs)) || 0;
        const expected = rate > 0 ? (c.difficulty * HASHES_PER_DIFF1) / rate : VARDIFF.retarget;
        if (secs < Math.max(VARDIFF.retarget * 4, expected * 4)) continue;
      }

      this.retarget(c, now);
    }
  }

  /* `job` is only consulted for whether the previous work died; WHICH job
     each client gets depends on where that client's blocks pay. */
  broadcast(job, clean) {
    for (const c of this.clients) {
      if (!c.authorized) continue;
      const j = this.jobs.jobFor(c.payoutKey);
      if (j) this.send(c, { id: null, method: 'mining.notify', params: this.jobs.notifyParams(j, clean) });
    }
  }
}

/* ── meter selftest: pure, no daemon, injected clock ──────────────────────── */

/**
 * Runs with `--meter` alone, and as the first phase of `--selftest`.
 *
 * Every case drives an explicit `now` instead of the wall clock, which is the
 * only way to test a 15-minute window without waiting 15 minutes. The
 * dead-rig case is the one that matters: a lifetime average cannot fail it,
 * because a lifetime average of a rig that stopped an hour ago still looks
 * healthy, and that is precisely the lie a renter would be shown.
 */
function meterSelftest(check) {
  const mk = (w, d = 1) => { const i = w.indexOf('.'); return {
    worker: w, account: i === -1 ? w : w.slice(0, i),
    rig: i === -1 ? '' : w.slice(i + 1), difficulty: d }; };
  const T = 1_700_000_000_000;

  { // confidence gate
    const m = new ShareMeter(), c = mk('awm_00001.l9_001');
    m.record(c, true, T);
    check('1 share publishes no rate', m.byAccount(T + 600)[0].hs === null);
    check('1 share is still billable', m.byAccount(T + 600)[0].sumDiff === 1);
    check('report withholds BOTH rates below their gates',
          m.report(T + 600).includes(`warming 1/${MIN_SHARES_SHORT}`)
          && m.report(T + 600).includes(`warming 1/${MIN_SHARES_FOR_RATE}`),
          m.report(T + 600));
    for (let i = 1; i < MIN_SHARES_FOR_RATE; i++) m.record(c, true, T + i * 10);
    const a = m.byAccount(T + 200)[0];
    check(`${MIN_SHARES_FOR_RATE} shares publishes a rate`, a.hs !== null);
    check('error bar shown is 1/sqrt(n)', Math.round(a.err * 100) === 22, Math.round(a.err * 100));
  }

  { /* The rate is numerically right under the SCRYPT convention: 600 diff-1
       shares in 60s is 600 * 2^16 / 60 = 655.36 KH/s. This assertion read
       42.9 GH/s until the 2^32 baseline was corrected — a test can only ever
       certify the convention it was written against, so pin the arithmetic to
       HASHES_PER_DIFF1 rather than to a number typed by hand. */
    const m = new ShareMeter(), c = mk('awm_00001.l9_001');
    for (let i = 0; i < 600; i++) m.record(c, true, T + i * 100);
    const hs = m.byAccount(T + 60_000)[0].hs;
    const want = 600 * HASHES_PER_DIFF1 / 60;
    check(`600 diff-1 shares in 60s reads ~${ShareMeter.human(want)}`,
          Math.abs(hs - want) / want < 0.02, ShareMeter.human(hs));
    check('a Scrypt diff-1 share costs 2^16 hashes, not 2^32',
          HASHES_PER_DIFF1 === 65536, HASHES_PER_DIFF1);
  }

  { // a rig that dies mid-lease
    const m = new ShareMeter(), c = mk('awm_00002.mini3_001');
    for (let i = 0; i < 200; i++) m.record(c, true, T + i * 100);
    check('live rig reports a rate', m.byAccount(T + 20_000)[0].hs !== null);
    const dead = m.byAccount(T + 20_000 + 16 * 60_000)[0];
    check('rig silent 16 min: rate WITHDRAWN, not stale-high', dead.hs === null);
    check('dead rig keeps its exact billable total', dead.sumDiff === 200, dead.sumDiff);
  }

  { // memory is bounded
    const m = new ShareMeter(), c = mk('awm_00003.rig');
    for (let h = 0; h < 300; h++) m.record(c, true, T + h * 60_000);
    const w = m.workers.get('awm_00003.rig');
    check('buckets pruned to the window (no unbounded growth)',
          w.buckets.size <= WINDOW_BUCKETS, w.buckets.size);
    check('lifetime total survives pruning', w.sumDiff === 300, w.sumDiff);
  }

  { // a fleet qualifies before any single rig does
    const m = new ShareMeter();
    for (let r = 0; r < 10; r++) { const c = mk(`awm_00004.rig_${r}`);
      for (let i = 0; i < 5; i++) m.record(c, true, T + i * 1000); }
    check('each rig alone sits below the gate',
          ShareMeter.window(m.workers.get('awm_00004.rig_0'), T + 5000).hs === null);
    const a = m.byAccount(T + 5000)[0];
    check('10 rigs x 5 shares qualifies at account level', a.hs !== null);
    check('fleet counted as 10 rigs', a.rigs === 10, a.rigs);
  }

  { // vardiff: direction, clamps, bounds
    const V = { ...VARDIFF, target: 15, maxStep: 8, tolerance: 0.3, min: 1, max: 2 ** 28 };
    check('too many shares raises difficulty',
          nextDifficulty(1, 60, 60, V) > 1, nextDifficulty(1, 60, 60, V));
    check('too few shares lowers difficulty',
          nextDifficulty(1024, 1, 60, V) < 1024, nextDifficulty(1024, 1, 60, V));
    check('on-target is left alone (no churn)',
          nextDifficulty(8, 4, 60, V) === 8, nextDifficulty(8, 4, 60, V));
    check('a single step cannot exceed maxStep',
          nextDifficulty(1, 100000, 60, V) <= 8, nextDifficulty(1, 100000, 60, V));
    check('never drops below min',
          nextDifficulty(1, 0, 60, V) === 1, nextDifficulty(1, 0, 60, V));
    check('never rises above max',
          nextDifficulty(2 ** 28, 10000, 60, V) === 2 ** 28);
    /* Gently: a full maxStep cut on one empty window wrecked a healthy rig
       that was merely unlucky for 60 seconds. */
    check('zero shares steps down by 2x, not maxStep',
          nextDifficulty(512, 0, 60, V) === 256, nextDifficulty(512, 0, 60, V));
    check('a stalled client still bottoms out at min eventually',
          (() => { let d = 4096; for (let i = 0; i < 20; i++) d = nextDifficulty(d, 0, 60, V);
                   return d === V.min; })());
    check('damping cannot stall convergence one notch short',
          nextDifficulty(2 ** 21, 7, 60, V) === 2 ** 22, nextDifficulty(2 ** 21, 7, 60, V));
    check('result is always a power of two',
          [1, 3, 7, 100, 999].every((d) => { const n = nextDifficulty(d, 40, 60, V);
            return Number.isInteger(Math.log2(n)); }));
  }

  { // vardiff: it must actually converge for real hardware
    const V = { ...VARDIFF, target: 15, maxStep: 8, tolerance: 0.3, min: 1, max: 2 ** 28 };
    const settle = (hs) => {
      let d = 1;
      for (let i = 0; i < 40; i++) {
        const shares = (hs * 60) / (d * HASHES_PER_DIFF1);   // expected in 60s
        d = nextDifficulty(d, Math.round(shares), 60, V);
      }
      return d;
    };
    /* Ideal is hashrate * target / 2^32, rounded to a power of two. */
    const ideal = (hs) => pow2((hs * V.target) / HASHES_PER_DIFF1);
    for (const [name, hs] of [['580 MH/s', 580e6], ['2.2 GH/s', 2.2e9], ['9.5 GH/s', 9.5e9], ['17 GH/s', 17e9]]) {
      const got = settle(hs), want = ideal(hs);
      check(`vardiff settles for ${name} (got ${got}, ideal ${want})`,
            got === want || (got >= want / 2 && got <= want * 2), `${got} vs ${want}`);
    }
    /* The real failure this guards: under the Bitcoin baseline a 17 GH/s rig
       settled at 64, which would have handed it ~15 microseconds of work. */
    check('a 17 GH/s rig settles in the hundreds of thousands, not at 64',
          settle(17e9) >= 2 ** 18, settle(17e9));
    check('settled difficulty gives roughly the target share interval',
          Math.abs((settle(2.2e9) * HASHES_PER_DIFF1 / 2.2e9) - V.target) < V.target * 0.5,
          `${(settle(2.2e9) * HASHES_PER_DIFF1 / 2.2e9).toFixed(1)}s vs ${V.target}s`);
  }

  { // the `d=N` password convention this hardware actually sends
    const parse = (pass) => {
      const m = /(?:^|[_,;&])d=(\d+(?:\.\d+)?)/.exec(String(pass || ''));
      return m ? Math.min(VARDIFF.max, Math.max(VARDIFF.min, pow2(Number(m[1])))) : null;
    };
    check('parses the exact string the VolcMiner sends', parse('d=1098633_lock=3') === 2 ** 20,
          parse('d=1098633_lock=3'));
    /* Sanity: the hardware's own request should imply a sane share interval
       under our convention. If this drifts, the convention is wrong again. */
    check("the miner's own d= implies ~15-60s/share at ~2.3 GH/s",
          (() => { const secs = 1098633 * HASHES_PER_DIFF1 / 2.3e9; return secs > 10 && secs < 120; })(),
          `${(1098633 * HASHES_PER_DIFF1 / 2.3e9).toFixed(1)}s`);
    check('plain d=64 parses', parse('d=64') === 64, parse('d=64'));
    check('d= is rounded to a power of two', parse('d=100') === 128, parse('d=100'));
    check('a password with no d= is ignored', parse('x') === null);
    check('an absurd request is clamped to max', parse('d=999999999999') === VARDIFF.max);
    check('a zero request is clamped to min', parse('d=0') === VARDIFF.min, parse('d=0'));
    /* "id=5" must NOT match as a difficulty request: the delimiter class is
       what prevents d= matching the tail of another key. */
    check('d= inside another key is not matched', parse('uid=1234') === null, parse('uid=1234'));
  }

  { /* Grace-window crediting. The bug this pins: crediting every share at the
       grace floor after an 8x retarget undercounts hashrate 8x for 60 seconds,
       which showed up as a 2 GH/s rig reading 248 MH/s. */
    const m = new ShareMeter();
    const c = { worker: 'awm_00001.l9_001', account: 'awm_00001', rig: 'l9_001', difficulty: 32768 };
    const oldDiff = 4096;
    const creditFor = (achieved) => achieved >= c.difficulty ? c.difficulty : oldDiff;

    check('share meeting the NEW difficulty is credited at the new one',
          creditFor(45134) === 32768, creditFor(45134));
    check('share meeting only the OLD difficulty keeps the old credit',
          creditFor(9074) === 4096, creditFor(9074));
    check('share exactly at the new difficulty counts as new',
          creditFor(32768) === 32768, creditFor(32768));

    /* The observed run: 16 shares before the retarget, 7 after it, with the
       post-retarget shares all achieving well above 32768. */
    for (let i = 0; i < 16; i++) m.record({ ...c, difficulty: oldDiff }, true, T + i * 1000, oldDiff);
    for (let i = 0; i < 7; i++)  m.record(c, true, T + (16 + i) * 1000, creditFor(45134));
    const billed = m.byAccount(T + 23_000)[0].sumDiff;
    check('billable reflects the real work (16x4096 + 7x32768)',
          billed === 16 * 4096 + 7 * 32768, billed);
    check('the old floor-crediting would have undercounted ~3.1x',
          Math.abs(billed / (23 * 4096) - 3.13) < 0.05, (billed / (23 * 4096)).toFixed(2));
  }

  { /* The short window must track reality faster than the long one. Pinned
       from the observed run: 2 min at ~250 MH/s then 4 min at ~1.6 GH/s. The
       15-min average reads the blend; "now" should read the current rate. */
    const m = new ShareMeter(), c = mk('awm_00001.l9_001', 262144);
    const slow = mk('awm_00001.l9_001', 4096);
    // 2 minutes of slow shares, then 4 minutes of fast ones
    for (let i = 0; i < 30; i++) m.record(slow, true, T + i * 4000, 4096);
    for (let i = 0; i < 40; i++) m.record(c, true, T + 120_000 + i * 6000, 262144);
    const a = m.byAccount(T + 360_000)[0];
    check('short window reports a rate', a.shortHs !== null, 'null');
    check('long window reports a rate', a.hs !== null, 'null');
    check('"now" reads higher than the 15-min blend after a step up',
          a.shortHs > a.hs, `${ShareMeter.human(a.shortHs)} vs ${ShareMeter.human(a.hs)}`);
    check('short window has a wider error bar than the long one',
          a.shortErr >= a.err, `${a.shortErr} vs ${a.err}`);
    check('billable is unaffected by either window',
          a.sumDiff === 30 * 4096 + 40 * 262144, a.sumDiff);
  }

  { // difficulty weighting, and rejects kept out of both totals
    const m = new ShareMeter(), lo = mk('awm_00005.lo', 1), hi = mk('awm_00005.hi', 64);
    for (let i = 0; i < 30; i++) { m.record(lo, true, T + i * 100); m.record(hi, true, T + i * 100); }
    for (let i = 0; i < 7; i++) m.record(lo, false, T + i * 100);
    const a = m.byAccount(T + 3000)[0];
    check('billable weights difficulty, not share count', a.sumDiff === 30 + 1920, a.sumDiff);
    check('rejects counted separately', a.rejected === 7, a.rejected);
    check('rejects excluded from the rate window', a.winShares === 60, a.winShares);
  }
}

/* ── selftest: a synthetic miner drives the whole loop ────────────────────── */

async function selftest() {
  let failures = 0;
  const green = (s) => `\x1b[32m${s}\x1b[0m`, red = (s) => `\x1b[31m${s}\x1b[0m`;
  const check = (n, c, d = '') => { if (c) console.log(`  ${green('PASS')} ${n}`); else { console.log(`  ${red('FAIL')} ${n} ${d}`); failures++; } };

  /* Phase 1: pure logic, no daemon. Runs first so a meter regression is not
     buried under RPC failures from an unrelated node problem. */
  console.log('\n— meter (pure, injected clock) —');
  meterSelftest(check);
  if (failures) { console.log(`\n${red(`${failures} meter failure(s) — stopping before the chain tests.`)}\n`); process.exit(1); }

  console.log('\n— stratum loop (against regtest) —');
  const info = await rpc('getblockchaininfo');
  if (info.chain !== 'regtest') throw new Error(`regtest only, got "${info.chain}"`);

  let addr; try { addr = await rpc('getnewaddress'); }
  catch { await rpc('createwallet', ['stratum']).catch(() => {}); addr = await rpc('getnewaddress'); }
  console.log(`\nregtest height ${info.blocks}, payout ${addr}\n`);

  /* The aux payout, resolved the same way the primary one is rather than
     demanded from the environment: a selftest that needs hand-set variables
     is one people stop running. */
  let auxAddr = process.env.AUX_PAYOUT_ADDRESS || null;
  if (AUX_ENABLED && !auxAddr) {
    try { auxAddr = await auxRpc('getnewaddress'); }
    catch { await auxRpc('createwallet', ['stratum']).catch(() => {}); auxAddr = await auxRpc('getnewaddress'); }
    console.log(`aux payout ${auxAddr}`);
  }

  /* SELFTEST_PAYOUT_WORKER exercises the opt-out path: the server stores NO
     address and the miner supplies both in its username. The assertions below
     then prove the block paid what the MINER asked for, not what the server
     was configured with -- which is the whole claim of that mode. */
  const SUPPLIED = process.env.SELFTEST_PAYOUT_WORKER || '';
  const WORKER_NAME = SUPPLIED || 'awm_00001.avalonmini3_001';
  const expectPaid = SUPPLIED ? SUPPLIED.slice(0, SUPPLIED.indexOf(',')) : addr;

  const jobs = new JobManager(SUPPLIED ? null : { kind: 'fixed', ltc: addr, doge: auxAddr });
  await jobs.refresh();
  const srv = new StratumServer({ port: 0, jobs });
  const port = await srv.start();

  const result = await new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = '', en1 = null, en2size = 4, job = null, got = { sub: false, auth: false, notify: false, accepted: null };
    const to = setTimeout(() => reject(new Error('timed out')), 30000);

    sock.on('connect', () => sock.write(JSON.stringify({ id: 1, method: 'mining.subscribe', params: ['awm-selftest/1.0'] }) + '\n'));
    sock.on('data', async (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        const m = JSON.parse(line);

        if (m.id === 1 && m.result) {
          got.sub = true;
          en1 = Buffer.from(m.result[1], 'hex'); en2size = m.result[2];
          /* Authorize with AWM's real worker-name convention, NOT the payout
             address. An earlier version of this test sent `addr` here, which
             made the username and the payout address identical and so could
             not tell whether the coinbase honoured the configured address or
             the username — the two agreed by construction. A name that could
             never be an address is the only form of this test that proves
             anything. */
          sock.write(JSON.stringify({ id: 2, method: 'mining.authorize',
            params: [WORKER_NAME, 'x'] }) + '\n');
        } else if (m.id === 2) {
          got.auth = m.result === true;
        } else if (m.method === 'mining.notify') {
          got.notify = true;
          const [jid, , cb1, cb2, branch, ver, bits, ntime] = m.params;
          job = { jid, cb1: Buffer.from(cb1, 'hex'), cb2: Buffer.from(cb2, 'hex'),
                  branch: branch.map((b) => Buffer.from(b, 'hex')),
                  ver: parseInt(ver, 16), bits, ntime: parseInt(ntime, 16) };

          // Solve exactly as a miner would, from the pieces we were sent.
          const en2 = Buffer.alloc(en2size); en2.writeUInt32BE(1);
          const coinbase = Buffer.concat([job.cb1, en1, en2, job.cb2]);
          const merkle = foldBranch(sha256d(coinbase), job.branch);
          const target = targetFromBits(job.bits);
          let nonce = 0, hdr = null;
          for (; nonce <= 0xffffffff; nonce++) {
            hdr = Buffer.concat([u32le(job.ver), rev(Buffer.from(jobs.jobs.get(jid).prevhash, 'hex')), merkle,
                                 u32le(job.ntime), rev(Buffer.from(job.bits, 'hex')), u32le(nonce)]);
            if (hashToBig(scryptPoW(hdr)) <= target) break;
          }
          sock.write(JSON.stringify({ id: 3, method: 'mining.submit',
            params: [addr, jid, en2.toString('hex'),
                     job.ntime.toString(16).padStart(8, '0'),
                     nonce.toString(16).padStart(8, '0')] }) + '\n');
        } else if (m.id === 3) {
          got.accepted = m.result === true ? true : (m.error || false);
          // Negative control. Regtest's target is so easy that a random nonce
          // often clears it, so a bogus nonce proves nothing — an unknown job
          // id is the deterministic way to show the server validates at all
          // rather than rubber-stamping everything it receives.
          sock.write(JSON.stringify({ id: 4, method: 'mining.submit',
            params: [addr, 'deadbeef', '00000001', '00000000', '00000000'] }) + '\n');
        } else if (m.id === 4) {
          got.rejectedUnknownJob = m.result === false || Boolean(m.error);
          clearTimeout(to); sock.end(); resolve(got);
        }
      }
    });
    sock.on('error', reject);
  });

  check('miner subscribed and got extranonce1', result.sub);
  check('worker name that is NOT an address was accepted', result.auth);
  check('server pushed mining.notify', result.notify);
  check('share accepted', result.accepted === true, JSON.stringify(result.accepted));
  check('unknown job id refused (server actually validates)', result.rejectedUnknownJob === true);

  await new Promise((r) => setTimeout(r, 500));
  const after = await rpc('getblockchaininfo');
  check(`block landed on chain (${info.blocks} -> ${after.blocks})`, after.blocks > info.blocks);
  check(SUPPLIED
          ? 'coinbase paid the address the MINER supplied'
          : 'coinbase paid the CONFIGURED address, not the worker name',
        srv.lastBlock?.address === expectPaid, JSON.stringify(srv.lastBlock));
  /* Either way the payee and the finder are separate fields: who gets paid
     must never be inferred from who found it. */
  check('winning worker credited separately from the payee',
        Boolean(srv.lastBlock?.worker) && srv.lastBlock.worker !== srv.lastBlock.address,
        JSON.stringify(srv.lastBlock));

  /* Ask the daemon who actually got paid. Everything above this line is the
     server agreeing with itself; this is the chain's answer. */
  const won = await rpc('getblock', [(await rpc('getblockhash', [after.blocks])), 2]);
  const paidTo = won.tx?.[0]?.vout?.[0]?.scriptPubKey?.addresses?.[0]
              ?? won.tx?.[0]?.vout?.[0]?.scriptPubKey?.address;
  /* Under SELFTEST_PAYOUT_WORKER this is the assertion that matters: the
     server held NO address, so the only way the coinbase can pay this one is
     if the username carried it all the way into the block. */
  check(`chain confirms coinbase output pays ${expectPaid}`
        + (SUPPLIED ? ' (supplied by the miner, not configured)' : ''),
        paidTo === expectPaid, `daemon says ${paidTo}`);

  /* Metering: the share must be attributed to the worker that sent it, and
     roll up under the account prefix a lease would be billed against. */
  const acct = srv.meter.byAccount();
  check('meter attributed the share to its worker',
        srv.meter.workers.get(SUPPLIED ? [...srv.meter.workers.keys()][0] : WORKER_NAME)?.accepted >= 1,
        JSON.stringify([...srv.meter.workers.values()]));
  /* With supplied addresses the account is the short handle derived from the
     pair, not the username: the 85-character form must never reach the meter,
     the logs or the dashboard. */
  /* With supplied addresses the account is the operator's own label when one
     is configured, and the derived handle otherwise. Either way the
     85-character username must never reach the meter, the logs or the page. */
  const configuredLabel = (process.env.WORKER_ACCOUNT || '').trim();
  const expectAccount = SUPPLIED
    ? configuredLabel
      || 'ext' + sha256(Buffer.from(`${SUPPLIED.slice(0, SUPPLIED.indexOf(','))}|`
          + SUPPLIED.slice(SUPPLIED.indexOf(',') + 1, SUPPLIED.lastIndexOf('.')))).toString('hex').slice(0, 6)
    : 'awm_00001';
  check('meter rolled the worker up under its account prefix',
        acct.length === 1 && acct[0].account === expectAccount && acct[0].rigs === 1,
        JSON.stringify(acct));
  console.log(`\n  ${srv.meter.report()}\n`);

  await srv.stop();
  console.log(`\n${failures === 0 ? green('Full stratum loop verified end to end.') : red(`${failures} failure(s).`)}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/* ── run ──────────────────────────────────────────────────────────────────── */

/* ── stats API ────────────────────────────────────────────────────────────
 *
 * A read-only JSON snapshot for the dashboard. `node:http` is a builtin, so
 * this keeps the zero-runtime-dependency property intact.
 *
 * Bound to loopback ONLY. It is an implementation detail between two
 * processes in one container, never something a miner or a browser connects
 * to, and it reports worker names and payout state — fine for the dashboard
 * sitting beside it, not fine on a LAN.
 *
 * Everything here is derived from state the meter and server already keep.
 * Nothing is computed specially for the API, so the numbers a dashboard shows
 * and the numbers the periodic log line prints cannot drift apart. */
function statsSnapshot(srv, now = Date.now()) {
  const accounts = srv.meter.byAccount(now).map((a) => ({
    account: a.account,
    rigs: a.rigs,
    accepted: a.accepted,
    rejected: a.rejected,
    /* Exact lifetime difficulty: the billable figure, and the one a lease is
       priced from. Not an estimate. */
    billableDiff: a.sumDiff,
    meanDiff: a.meanDiff ?? 0,
    /* null, never 0, until the sample supports a rate. A zero here would read
       as "this rig is dead" when it means "we have 3 shares so far". */
    hashrate: a.hs,
    hashrateErr: a.err,
    hashrateShort: a.shortHs,
    hashrateShortErr: a.shortErr,
    windowShares: a.winShares,
    lastShareAt: a.lastShare,
  }));

  const workers = [];
  for (const w of srv.meter.workers.values()) {
    const win = ShareMeter.window(w, now);
    workers.push({
      worker: w.worker,
      account: w.account,
      rig: w.rig,
      accepted: w.accepted,
      rejected: w.rejected,
      billableDiff: w.sumDiff,
      hashrate: win.hs,
      hashrateErr: win.err ?? null,
      windowShares: win.shares,
      lastShareAt: w.lastShare,
      firstSeenAt: w.firstSeen,
    });
  }

  /* Live connections, which is not the same as known workers: a worker that
     has disconnected still has history worth showing. */
  const connected = [];
  for (const c of srv.clients) {
    if (!c.authorized) continue;
    connected.push({
      worker: c.worker,
      difficulty: c.difficulty,
      staleBlocks: c.staleBlocks,
    });
  }

  const job = srv.jobs?.current ?? null;

  return {
    ok: true,
    now,
    startedAt: srv.startedAt,
    uptimeSeconds: Math.round((now - srv.startedAt) / 1000),
    payoutMode: process.env.PAYOUT_MODE || 'unset',
    /* What the dashboard should suggest as a username. Only a suggestion:
       mining.authorize accepts any name, and the meter reports what miners
       actually sent. Carried so the Connect tab has something real to show
       before the first miner has ever connected. */
    workerAccount: process.env.WORKER_ACCOUNT || '',
    /* The addresses blocks will actually pay, read off the live job rather
       than echoed from config, so the dashboard shows what is true rather
       than what was configured.
       Loopback-only API, and a receiving address is public anyway -- it is on
       chain the moment it is paid. */
    payoutAddresses: srv.jobs
      ? [...srv.jobs.targets.values()].map((t) => ({
          key: t.key,
          kind: t.kind,
          litecoin: t.current ? t.current.payoutAddress : (t.ltc ?? null),
          dogecoin: t.current ? t.current.auxAddress : (t.doge ?? null),
          isDefault: t.key === srv.jobs.defaultKey,
        }))
      : [],
    primaryChain: PRIMARY_CHAIN,
    scryptShift: Number(SCRYPT_SHIFT),
    hashesPerDiff1: HASHES_PER_DIFF1,
    windowMinutes: WINDOW_BUCKETS,
    shortWindowMinutes: SHORT_BUCKETS,
    job: job
      ? { height: job.height, id: job.id, stale: !!job.stale }
      : null,
    accounts,
    workers,
    connected,
    blocks: srv.blocks,
    shares: srv.shares,
    /* Network difficulty for each chain at this moment, so a consumer can
       work out how close a share came WITHOUT a second RPC round trip --
       and so the two numbers cannot disagree about which target was live
       when the share arrived. */
    networkDifficulty: {
      [PRIMARY_CHAIN]: job ? Number(DIFF1 / job.target) : null,
      ...(job?.aux ? { [AUX_CHAIN]: Number(DIFF1 / job.aux.target) } : {}),
    },
  };
}

function startStatsApi(srv, port) {
  if (!port) return null;
  const server = http.createServer((req, res) => {
    const send = (code, body) => {
      const s = JSON.stringify(body);
      res.writeHead(code, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(s),
        'cache-control': 'no-store',
      });
      res.end(s);
    };
    if (req.method !== 'GET') return send(405, { ok: false, error: 'GET only' });
    const path = (req.url || '').split('?')[0];
    if (path === '/health') return send(200, { ok: true });
    if (path === '/stats') {
      try {
        return send(200, statsSnapshot(srv));
      } catch (e) {
        /* Never let a dashboard request take the stratum down. A miner losing
           work because a stats call threw would be an absurd trade. */
        return send(500, { ok: false, error: e.message });
      }
    }
    return send(404, { ok: false, error: 'not found' });
  });
  server.listen(port, '127.0.0.1', () =>
    log(`stats api on 127.0.0.1:${port}`));
  return server;
}

async function run() {
  const addr = process.env.PAYOUT_ADDRESS;

  /* PAYOUT_MODE is how a package tells this server that the operator has
     deliberately not chosen a destination yet, as distinct from having
     forgotten to set one. Default it from whether an address is present, so
     running this directly from a shell behaves exactly as it always has. */
  const mode = process.env.PAYOUT_MODE
    || (addr ? 'addresses' : 'unset');

  if (mode === 'unset') {
    /* Deliberately does NOT bind the stratum port.
       A server that accepts miners and hands out work it cannot pay for is
       worse than one that is plainly not running: the rig shows accepted
       shares, the operator believes they are mining, and the truth only
       surfaces when a block is found and there is nowhere to send it. Serve
       the stats API so the dashboard can say what is missing, and nothing
       else. */
    const idle = {
      startedAt: Date.now(),
      clients: new Set(),
      meter: new ShareMeter(),
      blocks: [],
      /* Same SHAPE as a running server, not a subset. A consumer that gets
         an array here and undefined there has to special-case the idle
         state, and whichever branch is rarer is the one that breaks. */
      shares: [],
      jobs: null,
    };
    const api = startStatsApi(idle, Number(process.env.STRATUM_API_PORT || 0));
    log('no payout destination chosen — not accepting miners.');
    log('choose one in the service settings; nothing is mined until then.');
    if (!api) {
      throw new Error(
        'set PAYOUT_ADDRESS — every block this server finds pays it, whatever\n'
        + 'usernames the miners authorize with. On StartOS that is the node\n'
        + "operator's own address; for AWM it is AWM's standard DOGE address.");
    }
    return;
  }

  const auxAddr = process.env.AUX_PAYOUT_ADDRESS || null;

  /* Two answers, and they are the only two. Either the operator stored a
     pair of addresses here, or they declined to and every miner brings its
     own. There is no third "let the node decide": see JobManager. */
  let defaultTarget;
  if (mode === 'workerName') {
    /* Distinct from 'unset'. The operator HAS chosen: they chose not to keep
       their addresses here, and will send them in the worker name instead.
       So the port binds and miners are served -- but only those that say
       where to pay. */
    defaultTarget = null;
    log('no addresses stored; miners must authorize as LTC_ADDRESS,DOGE_ADDRESS.RIG');
  } else {
    if (!addr) {
      throw new Error(
        'PAYOUT_MODE=' + mode + ' but PAYOUT_ADDRESS is empty. Set an address,\n'
        + 'or use PAYOUT_MODE=workerName and have each miner send its own.');
    }
    if (AUX_ENABLED && !auxAddr) {
      throw new Error(
        'AUX_RPC_HOST is set but AUX_PAYOUT_ADDRESS is not. Merge mining needs\n'
        + 'somewhere for the aux chain to pay: its coinbase is built by its own\n'
        + 'node, which refuses an address it cannot pay.');
    }
    defaultTarget = { kind: 'fixed', ltc: addr, doge: auxAddr };
  }

  const jobs = new JobManager(defaultTarget);  // throws now if addr is malformed
  await jobs.refresh();
  if (defaultTarget && defaultTarget.kind === 'fixed') log(`all blocks pay ${addr}`);

  const srv = new StratumServer({ port: Number(process.env.STRATUM_PORT || 3333), jobs });
  await srv.start();
  startStatsApi(srv, Number(process.env.STRATUM_API_PORT || 0));
  setInterval(async () => {
    try {
      const job = await jobs.refresh();
      /* clean_jobs ONLY when the tip actually moved. Sending it
         unconditionally orders the miner to throw away work that is still
         valid, which on mainnet happens every time the template picks up a
         transaction — several times a minute, each one discarding partial
         work for no reason. Regtest hid this because with no transactions the
         only thing that ever changes the template IS the tip. */
      if (job) srv.broadcast(job, job.tipMoved);
    } catch (e) { log(`! refresh: ${e.message}`); }
  }, Number(process.env.REFRESH_MS || 5000));

  /* Vardiff is checked often; each client's own window decides when it moves. */
  setInterval(() => srv.vardiffPass(), 5000);

  const every = Number(process.env.REPORT_SECONDS || 60);
  if (every > 0) setInterval(() => log(srv.meter.report()), every * 1000);
}

const die = (e) => { console.error(`\n\x1b[31m${e.message}\x1b[0m\n`); process.exit(1); };

if (process.argv.includes('--meter')) {
  /* Meter logic only — needs no node, no wallet, no network. */
  let f = 0;
  const g = (s) => `\x1b[32m${s}\x1b[0m`, r = (s) => `\x1b[31m${s}\x1b[0m`;
  meterSelftest((n, c, d = '') => { if (c) console.log(`  ${g('PASS')} ${n}`); else { console.log(`  ${r('FAIL')} ${n} ${d}`); f++; } });
  console.log(`\n${f === 0 ? g('meter logic verified.') : r(`${f} failure(s).`)}\n`);
  process.exit(f ? 1 : 0);
} else if (process.argv.includes('--selftest')) selftest().catch(die);
else run().catch(die);
