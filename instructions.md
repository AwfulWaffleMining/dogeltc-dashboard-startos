# Quai Mining Dashboard

The dashboard starts only once your **Quai Network** service is running and fully synced. On a node syncing from genesis, that can take weeks.

## Documentation

- [Quai Network Docs](https://docs.qu.ai) — mining, workshares, lock periods and the stratum options your miners use.

## Getting set up

1. Answer the **Confirmed rewards** task. Say yes if you want the dashboard to show what each workshare actually paid; it then asks the Quai Network service to share its RPC, and you approve that on Quai Network's page by saving its **Settings**. That RPC has no password, so anything that can reach your node can query it. Say no and the dashboard shows estimates instead. It runs either way.
2. Start the service and open the **Mining Dashboard** interface.
3. Open **How to connect** and copy the pool URL, username and password for your hardware into your miners.

## Using the dashboard

- **Dashboard**: hashrate with history (1H, 24H, 7D), workers, shares, and how long a workshare should take at your hashrate. The SHA-256 / Scrypt / KawPoW buttons switch which miners the tab is about. Shares count from when you open the page, with a reset link, so you can change a miner's settings and watch what follows. Hashrate history can be exported as CSV from the chart.
- **Workers**: every worker with its hashrate, 24-hour average, reject rate and last share. Workers that stop are marked offline and drop off after 24 hours without a share.
- **Earnings**: the workshares you have minted and what they paid. SHA-256 and Scrypt hardware mints **workshares** — shares that meet a lower threshold, get included in a block, and earn part of its reward — while blocks themselves are minted by KawPoW miners. The tab shows how long since your last workshare against the typical gap for your hashrate, how close your shares are coming, your best ones, and a breakdown by lock period. A workshare that was accepted but never included in a block is marked orphaned; it paid nothing.
- **How to connect**: fills in the pool URL, username and password for your hardware, including a suggested fixed difficulty and the lock period. Password options are joined with an underscore (`d=32131_lock=3`) because Canaan and Avalon firmware reject commas.

### Actions

- **Confirmed rewards** — change your answer to the setup question. To stop sharing the node's RPC, switch it off in Quai Network's **Settings**.

## If the node stops

The dashboard keeps showing your recorded history and says the node is unreachable. It picks up again by itself when the node is back.

## What it keeps

| Kept                                      | For how long                               |
| ----------------------------------------- | ------------------------------------------ |
| Hashrate and reject rate per algorithm    | 7 days                                     |
| Per-worker averages and last-share times  | Until 24 hours after a worker's last share |
| Share difficulty history                  | Last 6000 shares per algorithm             |
| Workshares and blocks found, with payouts | Permanently, and included in backups       |
