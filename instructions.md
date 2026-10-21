# Scrypt Solo Mining

Mine **Dogecoin and Litecoin at the same time**, against your own nodes, with no pool and no fee.

## What "merge mining" means

Your miner does exactly the same work it always did. The difference is where the answer gets checked.

This service builds a Litecoin block that carries a Dogecoin block's fingerprint inside it, then hands your miner a single puzzle. When your miner solves it, the solution is checked against **both** networks:

- good enough for Litecoin → you found a Litecoin block
- good enough for Dogecoin → you found a Dogecoin block
- good enough for both → you found both, from one solution

Nothing is divided. You are not splitting your miner between two coins — you are getting a second lottery ticket for free. Dogecoin's puzzle is the easier of the two, so if you ever win, it will most likely be Dogecoin first.

## Before you start

You need both the **Litecoin Core** and **Dogecoin Core** packages installed and **fully synced**, and each of them has to be letting other packages talk to it. In each node's config, turn on **Share node RPC with other packages** and save — it is off by default, and without it this service can see the node but not ask it for anything. StartOS shows both of these as tasks, and this service will not start until they are done.

Syncing matters for the same kind of reason: mining against a half-synced node means building on a chain that may not be the real one.

Syncing both takes a while — Dogecoin is the longer of the two. There is nothing to do but wait.

## Setting it up

**1. Choose where blocks pay.** The service will not start until you do — StartOS shows this as a task on the service page, and **Start stays disabled** until it is answered. Open **Payouts** in this service's settings. There is no default, on purpose: a half-finished setup that mines into nowhere looks exactly like a working one until the day you win.

- **Pay to addresses I control** — you type a Litecoin address and a Dogecoin address. Blocks pay straight to wallets you already hold, with nothing spendable sitting on this server. Both are checked by the node that would have to pay them, so a typo is caught now rather than on the day it costs you a block.
- **Don't store my addresses on this server** — nothing is kept here at all. Instead each miner sends both of your addresses in its username, in the form `LITECOIN_ADDRESS,DOGECOIN_ADDRESS.rig1`. The dashboard builds that string for you.

The second option costs you two things, and they are the reason it isn't the default. Mining traffic isn't encrypted, so both addresses cross your network every time a miner reconnects. And the username runs about 85 characters with a comma in it — **some Canaan and Avalon firmware refuses a username that long, or one containing a comma.** If a miner won't take it, switch to the first option.

Both options pay addresses you control. What differs is whether this server keeps a copy of them.

**2. Point your miners here.** Open **How to connect** in the dashboard. It shows the exact stratum address and a worker name, ready to copy.

Use **one** connection per miner. Both coins come from that single connection — adding a second would just mine the same work twice.

Your worker name has two parts: a label for this server, then a label for the machine. You can set the first part yourself in **Payouts** — leave it blank and one is generated. The second part is per rig: `yourname.rig1`, `yourname.garage`, so you can tell them apart in the dashboard.

It is only a label. Nothing about it affects where a block pays — that comes from your addresses, and the server would accept any name you typed. It exists so the dashboard reads in your words instead of a generated string.

If you chose not to store your addresses here, your miners still send the long `ADDRESS,ADDRESS.rig` username, but the dashboard shows them under your label rather than that string.

Avoid dots and commas inside either part. A dot separates the two halves, and a comma is what the other payout mode uses to separate your two addresses.

Your payout addresses are **not** part of the worker name, which is how some pools do it. They stay in settings, so they never travel over the network and never hit the character limits that make some ASIC firmware misbehave.

## What you should expect

Solo mining is a lottery. With a few gigahashes of scrypt hardware you may wait months or years between blocks, and the dashboard tells you roughly how long rather than flattering you.

When you do win, the whole block reward is yours — 10,000 DOGE or 6.25 LTC, paid directly by the network with nobody taking a cut.

A found block is **not spendable immediately.** Every coinbase is locked for 100 confirmations, which is a few hours. The dashboard shows found and matured separately so you know which you have.

Blocks are occasionally **orphaned** — two miners find one at nearly the same moment and the network keeps the other. The dashboard counts those honestly rather than hiding them.

## Reading the dashboard

**Hashrate** — what the server measures from your shares, not what your miner claims. They should agree closely. A number appears only once there are enough shares to support one; "warming up" means exactly that.

**Next block (estimate)** — both chains, with the sooner one leading, and what each pays. One hash buys both tickets, so these are not alternatives: Dogecoin's shorter estimate is simply where a first win most likely lands. It is an average, not a countdown — a long gap does not make the next one likelier.

**Closest you have come** — your luckiest share so far, shown against each chain side by side. It is **one** share: what changes between the two panels is the target it is measured against. Dogecoin's is the easier of the two, so the same work always gets further there, and the bars show that gap at a glance.

This is the number to watch, because it moves. Blocks found will read zero for a long time at solo odds, and a screen of zeroes tells you nothing about whether your miners are working. How close you have come only ever improves.

**Earnings** — blocks found and coins earned, per chain, with the blocks themselves below. Found and matured are counted separately: every coinbase is locked for 100 confirmations.

**Merged hashrate** — one figure, not one per chain. Every share is a single scrypt hash tested against both targets, so there is no Litecoin rate and Dogecoin rate to tell apart. What differs between the chains is difficulty, reward, and odds — never the hashrate.

## If something looks wrong

**"Set a payout destination before mining starts"** — step 1 above. The stratum deliberately refuses connections until you choose.

**The service will not start** — one of the two nodes is not synced yet. Check both.

**Your miner connects but shows no accepted shares** — give it a few minutes. The server starts everyone at a low difficulty and adjusts upward; the first minutes look quiet.

**Hashrate here is lower than your miner reports** — normal early on. The estimate tightens as shares accumulate. If it stays well below after an hour, check the rejected count.
