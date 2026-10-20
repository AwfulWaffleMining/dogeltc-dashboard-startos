import { createHash } from 'node:crypto'
const sha256d = (b) => createHash('sha256').update(createHash('sha256').update(b).digest()).digest()
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
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


import { readFileSync } from 'node:fs'
let pass = 0, fail = 0
const check = (l, fn) => { try { fn(); console.log(`  PASS ${l}`); pass++ } catch (e) { console.log(`  FAIL ${l}: ${e.message}`); fail++ } }
console.log('  --- against litecoind\'s own scriptPubKey ---')
for (const line of readFileSync('/tmp/addrcases.txt','utf8').trim().split('\n')) {
  const [kind, addr, want] = line.split('|')
  check(`${kind.padEnd(13)}`, () => {
    const got = addressToScript(addr).toString('hex')
    if (got !== want) throw new Error(`node ${want} != ours ${got}`)
  })
}
console.log('  --- version bytes regtest cannot reach ---')
for (const line of readFileSync('/tmp/genaddrs.txt','utf8').trim().split('\n')) {
  const [label, addr, ver] = line.split('|')
  const wantP2SH = ['5','22','50','58','196'].includes(ver)
  check(`${label.padEnd(22)} -> ${wantP2SH ? 'P2SH' : 'P2PKH'}`, () => {
    const s = addressToScript(addr).toString('hex')
    const isP2SH = s.startsWith('a914') && s.endsWith('87')
    if (isP2SH !== wantP2SH) throw new Error(`got ${s.slice(0,8)}… which is ${isP2SH?'P2SH':'P2PKH'}`)
  })
}
console.log(`\n  ${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)
