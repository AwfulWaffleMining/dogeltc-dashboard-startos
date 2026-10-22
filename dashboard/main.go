// scrypt-dashboard — collector and JSON API for solo merge mining.
//
// Two sources, polled on a timer:
//
//   - the stratum's loopback stats API, which already aggregates hashrate,
//     workers and accepted blocks. Nothing is recomputed here that the meter
//     has already computed, so the page and the stratum's own log line cannot
//     disagree.
//   - each chain's node RPC, over its cookie file, for height, difficulty and
//     network hashrate.
//
// What it adds is memory. The stratum keeps rolling windows and loses them on
// restart; this records samples to disk so a hashrate chart survives a
// reboot, and keeps found blocks permanently.
//
// MERGE MINING SHAPES THE DATA MODEL. There is ONE hashrate and ONE share
// stream, tested against TWO targets. Per-chain hashrate would be a fiction,
// so the same figure appears under both chains -- which is accurate, and is
// the clearest way to show that one hash buys two chances. What genuinely
// differs per chain is difficulty, network size, reward, block time, the
// resulting odds, and which blocks were found.
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	parentChain = "litecoin"
	auxChain    = "dogecoin"
)

// chainOrder fixes the display order. Parent first: it is the chain work is
// built against, and the one whose absence stops mining entirely.
var chainOrder = []string{parentChain, auxChain}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// ── stored shapes ──────────────────────────────────────────────────────────

type Sample struct {
	T int64   `json:"t"` // unix ms
	H float64 `json:"h"` // hashrate, H/s
	R float64 `json:"r"` // reject percent
}

type Worker struct {
	WorkerName  string    `json:"workerName"`
	Account     string    `json:"account"`
	Rig         string    `json:"rig"`
	Hashrate    float64   `json:"hashrate"`
	HashrateErr float64   `json:"hashrateErr"`
	Difficulty  float64   `json:"difficulty"`
	SharesValid uint64    `json:"sharesValid"`
	SharesStale uint64    `json:"sharesStale"`
	Billable    float64   `json:"billable"`
	LastShareAt time.Time `json:"lastShareAt"`
	Status      string    `json:"status"` // active | offline
}

// Block is one accepted block, on whichever chain accepted it.
//
// There is no "kind" here and no payout reconciliation. On these chains a
// share either meets the network target and is a block, or it is not --
// Quai's workshares have no analogue. What replaces that machinery is
// maturity: a coinbase is unspendable for 100 confirmations, so a freshly
// found block is real but not yet money.
type Block struct {
	Chain         string    `json:"chain"`
	Height        uint64    `json:"height"`
	Worker        string    `json:"worker"`
	Address       string    `json:"address"`
	FoundAt       time.Time `json:"foundAt"`
	Reward        float64   `json:"reward"`
	Confirmations int64     `json:"confirmations"`
	Mature        bool      `json:"mature"`
	// Orphaned when the chain no longer has our block at that height. Solo
	// mining does produce these; pretending otherwise would overstate income.
	Orphaned bool `json:"orphaned"`
}

type NodeSummary struct {
	Reachable bool   `json:"reachable"`
	Synced    bool   `json:"synced"`
	Height    uint64 `json:"height"`
	Tip       uint64 `json:"tip"`
	Behind    int64  `json:"behind"`
}

// ChainSummary is everything that genuinely differs between the two chains.
type ChainSummary struct {
	// Repeated from the shared figure, deliberately: the same work is tested
	// against both targets, so this is the hashrate aimed at this chain.
	Hashrate     float64     `json:"hashrate"`
	HashrateErr  float64     `json:"hashrateErr"`
	Difficulty   float64     `json:"difficulty"`
	NetHashrate  float64     `json:"netHashrate"`
	BlockReward  float64     `json:"blockReward"`
	BlockSeconds float64     `json:"blockSeconds"`
	BlocksFound  int         `json:"blocksFound"`
	Node         NodeSummary `json:"node"`
	// Expected days to a block at the current hashrate, and the odds over a
	// year. Honest arithmetic, not a guess: share of network times blocks per
	// day. Zero when there is no rate yet rather than a fabricated number.
	ExpectedDays float64   `json:"expectedDays"`
	OddsPerYear  float64   `json:"oddsPerYear"`
	SharesValid  uint64    `json:"sharesValid"`
	SharesStale  uint64    `json:"sharesStale"`
	Best         BestShare `json:"best"`
}

type Summary struct {
	Chains map[string]ChainSummary `json:"chains"`
	Order  []string                `json:"order"`
	// The parent chain's node, duplicated here because it gates everything:
	// without it there is no block to build and nothing to merge-mine into.
	Node        NodeSummary `json:"node"`
	StratumOK   bool        `json:"stratumOK"`
	StratumPort int         `json:"stratumPort"`
	PayoutMode  string      `json:"payoutMode"`
	// Passed through so the dashboard can show the operator what it will be
	// paid to without them opening settings. A receiving address is public
	// information; this API is loopback-only regardless.
	PayoutAddresses []PayoutTarget `json:"payoutAddresses"`
	WorkerHint      string         `json:"workerHint"`
	Merged          bool           `json:"merged"`
	Hashrate        float64        `json:"hashrate"`
	HashrateErr     float64        `json:"hashrateErr"`
	Uptime          int64          `json:"uptimeSeconds"`
}

// Best is the luckiest share ever submitted, per chain, kept permanently.
//
// This matters more here than a block count. A solo rig at these odds may
// never find a block, so a page built around blocks found is a page of
// zeroes. The closest you have ever come is always a real number, it only
// ever improves, and it is the honest measure of what the hardware is doing.
type BestShare struct {
	// Difficulty the share actually achieved. One figure: the same share is
	// tested against both chains.
	Difficulty float64 `json:"difficulty"`
	// How close that came as a fraction of THIS chain's target, in percent.
	// The same share is a different fraction of each, which is the whole
	// story of why one chain pays out sooner than the other.
	LuckPct float64   `json:"luckPct"`
	Worker  string    `json:"worker"`
	At      time.Time `json:"at"`
}

type store struct {
	History map[string][]Sample  `json:"history"`
	Blocks  []Block              `json:"blocks"`
	Best    map[string]BestShare `json:"best"`
	// Bumped when a stored field's MEANING changes, not its shape. Best was
	// recorded against the wrong difficulty scale before v1, so those records
	// are not merely stale -- they are wrong by 2^16, and because recordBest
	// only ever replaces a lower luck with a higher one, a poisoned record is
	// permanent. Blocks and History are unaffected and survive the bump.
	Version int `json:"version"`
}

const storeVersion = 1

// ── stratum stats, as the stratum serves them ──────────────────────────────

type statsAccount struct {
	Account       string   `json:"account"`
	Rigs          int      `json:"rigs"`
	Accepted      uint64   `json:"accepted"`
	Rejected      uint64   `json:"rejected"`
	BillableDiff  float64  `json:"billableDiff"`
	MeanDiff      float64  `json:"meanDiff"`
	Hashrate      *float64 `json:"hashrate"`
	HashrateErr   *float64 `json:"hashrateErr"`
	HashrateShort *float64 `json:"hashrateShort"`
	LastShareAt   *int64   `json:"lastShareAt"`
}

type statsWorker struct {
	Worker       string   `json:"worker"`
	Account      string   `json:"account"`
	Rig          string   `json:"rig"`
	Accepted     uint64   `json:"accepted"`
	Rejected     uint64   `json:"rejected"`
	BillableDiff float64  `json:"billableDiff"`
	Hashrate     *float64 `json:"hashrate"`
	HashrateErr  *float64 `json:"hashrateErr"`
	LastShareAt  *int64   `json:"lastShareAt"`
	FirstSeenAt  int64    `json:"firstSeenAt"`
}

type statsConnected struct {
	Worker      string  `json:"worker"`
	Difficulty  float64 `json:"difficulty"`
	StaleBlocks uint64  `json:"staleBlocks"`
}

type statsShare struct {
	T        int64   `json:"t"`
	Achieved float64 `json:"achieved"`
	Assigned float64 `json:"assigned"`
	Worker   string  `json:"worker"`
}

type statsBlock struct {
	Chain   string `json:"chain"`
	Height  uint64 `json:"height"`
	Address string `json:"address"`
	Worker  string `json:"worker"`
	FoundAt int64  `json:"foundAt"`
}

// PayoutTarget is where one set of miners' blocks pay. More than one exists
// only when a miner supplied its own addresses in its worker name.
type PayoutTarget struct {
	Key       string `json:"key"`
	Kind      string `json:"kind"`
	Litecoin  string `json:"litecoin"`
	Dogecoin  string `json:"dogecoin"`
	IsDefault bool   `json:"isDefault"`
}

type stratumStats struct {
	OK         bool   `json:"ok"`
	Now        int64  `json:"now"`
	Uptime     int64  `json:"uptimeSeconds"`
	PayoutMode string `json:"payoutMode"`
	// Share difficulty here is quoted against a difficulty-1 that is
	// 2^ScryptShift easier than the one a chain's RPC `difficulty` field uses.
	// Anything comparing the two must scale, or it is out by 65,536.
	ScryptShift int `json:"scryptShift"`
	// Only a suggestion: mining.authorize accepts any username, and the meter
	// reports what miners actually sent. Carried so the Connect tab has
	// something real to show before the first miner has ever connected.
	WorkerAccount string `json:"workerAccount"`
	// Where blocks actually pay, read off the live job rather than echoed
	// from config, so this reports what will be paid rather than what was set.
	PayoutAddresses []PayoutTarget      `json:"payoutAddresses"`
	Accounts        []statsAccount      `json:"accounts"`
	Workers         []statsWorker       `json:"workers"`
	Connected       []statsConnected    `json:"connected"`
	Blocks          []statsBlock        `json:"blocks"`
	Shares          []statsShare        `json:"shares"`
	NetDiff         map[string]*float64 `json:"networkDifficulty"`
	WindowMins      int                 `json:"windowMinutes"`
}

// ── collector ──────────────────────────────────────────────────────────────

type chainRPC struct {
	name   string
	url    string
	cookie string
}

type collector struct {
	mu      sync.RWMutex
	st      store
	stats   *stratumStats
	chains  map[string]ChainSummary
	dataDir string
	stratum string
	rpcs    []chainRPC
	port    int
	payout  string
	targets []PayoutTarget
	saving  sync.Mutex // one save at a time; two concurrent saves truncated a file once
}

func newCollector(dataDir, stratum string, rpcs []chainRPC, port int) *collector {
	c := &collector{
		dataDir: dataDir, stratum: stratum, rpcs: rpcs, port: port,
		chains: map[string]ChainSummary{},
	}
	c.st.History = map[string][]Sample{}
	c.st.Best = map[string]BestShare{}
	c.st.Version = storeVersion
	c.load()
	return c
}

func (c *collector) path() string { return filepath.Join(c.dataDir, "stats.json") }

func (c *collector) load() {
	b, err := os.ReadFile(c.path())
	if err != nil {
		return
	}
	var s store
	if err := json.Unmarshal(b, &s); err != nil {
		log.Printf("stats.json unreadable, starting fresh: %v", err)
		return
	}
	if s.History == nil {
		s.History = map[string][]Sample{}
	}
	if s.Best == nil {
		s.Best = map[string]BestShare{}
	}
	migrated := s.Version < storeVersion
	if migrated {
		if len(s.Best) > 0 {
			log.Printf("discarding %d best-share record(s) written against the old difficulty scale", len(s.Best))
		}
		s.Best = map[string]BestShare{}
		s.Version = storeVersion
	}
	c.st = s
	/* Write the bump straight back rather than waiting for the poll loop's
	   first save. Otherwise every restart before that save re-runs the
	   migration, which is harmless but means the log keeps announcing a
	   one-time event as though it were news. Safe here: load() runs in the
	   constructor, before anything else can touch the store. */
	if migrated {
		c.save()
	}
	log.Printf("loaded %d blocks, %d history series", len(s.Blocks), len(s.History))
}

// save writes atomically through a uniquely named temp file.
//
// A shared temp name truncated the history once, when shutdown triggered a
// save from both the poll loop and main at the same moment.
func (c *collector) save() {
	c.saving.Lock()
	defer c.saving.Unlock()
	c.mu.RLock()
	b, err := json.Marshal(c.st)
	c.mu.RUnlock()
	if err != nil {
		log.Printf("save: %v", err)
		return
	}
	if err := os.MkdirAll(c.dataDir, 0o755); err != nil {
		log.Printf("save: %v", err)
		return
	}
	tmp := fmt.Sprintf("%s.%d.tmp", c.path(), os.Getpid())
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		log.Printf("save: %v", err)
		return
	}
	if err := os.Rename(tmp, c.path()); err != nil {
		log.Printf("save: %v", err)
	}
}

func getJSON(url string, out interface{}) error {
	client := http.Client{Timeout: 10 * time.Second}
	r, err := client.Get(url)
	if err != nil {
		return err
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return fmt.Errorf("%s: %d", url, r.StatusCode)
	}
	return json.NewDecoder(r.Body).Decode(out)
}

// rpcCall authenticates with the node's cookie file, read FRESH each time.
// Core rewrites it on every start, so a cached value is wrong exactly when
// the node has restarted.
func (c *collector) rpcCall(ch chainRPC, method string, params []interface{}) (json.RawMessage, error) {
	cookie, err := os.ReadFile(ch.cookie)
	if err != nil {
		return nil, fmt.Errorf("cookie: %w", err)
	}
	body, _ := json.Marshal(map[string]interface{}{
		"jsonrpc": "1.0", "id": "dash", "method": method, "params": params,
	})
	req, err := http.NewRequest("POST", ch.url, strings.NewReader(string(body)))
	if err != nil {
		return nil, err
	}
	parts := strings.SplitN(strings.TrimSpace(string(cookie)), ":", 2)
	if len(parts) != 2 {
		return nil, fmt.Errorf("malformed cookie file")
	}
	req.SetBasicAuth(parts[0], parts[1])
	req.Header.Set("content-type", "application/json")
	client := http.Client{Timeout: 15 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var out struct {
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return nil, err
	}
	if out.Error != nil {
		return nil, fmt.Errorf("%s: %s", method, out.Error.Message)
	}
	return out.Result, nil
}

// chainFacts asks one node what it knows about itself and its network.
func (c *collector) chainFacts(ch chainRPC) (ChainSummary, error) {
	var cs ChainSummary

	raw, err := c.rpcCall(ch, "getblockchaininfo", nil)
	if err != nil {
		return cs, err
	}
	var info struct {
		Blocks               uint64  `json:"blocks"`
		Headers              uint64  `json:"headers"`
		Difficulty           float64 `json:"difficulty"`
		InitialBlockDownload *bool   `json:"initialblockdownload"`
	}
	if err := json.Unmarshal(raw, &info); err != nil {
		return cs, err
	}
	cs.Difficulty = info.Difficulty
	cs.Node = NodeSummary{
		Reachable: true,
		Height:    info.Blocks,
		Tip:       info.Headers,
		Behind:    int64(info.Headers) - int64(info.Blocks),
		// A missing initialblockdownload means "still syncing": treating an
		// absent field as synced would show green on a node we cannot vouch
		// for. Both packaged nodes do report it.
		Synced: info.InitialBlockDownload != nil && !*info.InitialBlockDownload,
	}

	// Network hashrate. Not fatal if the node declines it.
	if raw, err := c.rpcCall(ch, "getnetworkhashps", nil); err == nil {
		var h float64
		if json.Unmarshal(raw, &h) == nil {
			cs.NetHashrate = h
		}
	}
	return cs, nil
}

// blockSeconds and reward are chain constants, not RPC answers.
func chainConstants(name string) (blockSeconds, reward float64) {
	switch name {
	case parentChain:
		return 150, 6.25 // Litecoin: 2.5 minutes; subsidy until the next halving
	case auxChain:
		return 60, 10000 // Dogecoin: 1 minute; flat 10,000 since 2015
	}
	return 0, 0
}

func (c *collector) poll() {
	var s stratumStats
	err := getJSON(strings.TrimRight(c.stratum, "/")+"/stats", &s)

	c.mu.Lock()
	if err != nil {
		// Never blank the page on a transient miss; the previous snapshot is
		// still the truest thing we have. StratumOK below says it is stale.
		log.Printf("stratum: %v", err)
		c.stats = nil
	} else {
		c.stats = &s
		c.payout = s.PayoutMode
		c.targets = s.PayoutAddresses
	}
	c.mu.Unlock()

	// One shared hashrate, from the account rollup.
	var hs, hsErr float64
	var valid, stale uint64
	if err == nil {
		for _, a := range s.Accounts {
			if a.Hashrate != nil {
				hs += *a.Hashrate
			}
			if a.HashrateErr != nil && *a.HashrateErr > hsErr {
				hsErr = *a.HashrateErr
			}
			valid += a.Accepted
			stale += a.Rejected
		}
	}

	now := time.Now()
	chains := map[string]ChainSummary{}
	for _, ch := range c.rpcs {
		cs, ferr := c.chainFacts(ch)
		if ferr != nil {
			log.Printf("%s rpc: %v", ch.name, ferr)
			cs.Node = NodeSummary{Reachable: false}
		}
		cs.BlockSeconds, cs.BlockReward = chainConstants(ch.name)
		// The SAME hashrate under both chains. One hash, two targets.
		cs.Hashrate, cs.HashrateErr = hs, hsErr
		cs.SharesValid, cs.SharesStale = valid, stale

		if hs > 0 && cs.NetHashrate > 0 && cs.BlockSeconds > 0 {
			blocksPerDay := 86400 / cs.BlockSeconds
			share := hs / cs.NetHashrate
			perDay := blocksPerDay * share
			if perDay > 0 {
				cs.ExpectedDays = 1 / perDay
				cs.OddsPerYear = 1 - math.Exp(-365.25*perDay)
			}
		}

		c.mu.RLock()
		for _, b := range c.st.Blocks {
			if b.Chain == ch.name && !b.Orphaned {
				cs.BlocksFound++
			}
		}
		cs.Best = c.st.Best[ch.name]
		c.mu.RUnlock()

		chains[ch.name] = cs

		// History: one series per chain so the frontend's per-tab chart works,
		// carrying the same rate. Honest, and it keeps the chart meaningful
		// when a chain's node is down and only one is being mined.
		c.mu.Lock()
		key := ch.name
		rej := 0.0
		if valid+stale > 0 {
			rej = 100 * float64(stale) / float64(valid+stale)
		}
		c.st.History[key] = append(c.st.History[key], Sample{T: now.UnixMilli(), H: hs, R: rej})
		// Keep 7 days at one sample a minute.
		if cut := now.Add(-7 * 24 * time.Hour).UnixMilli(); len(c.st.History[key]) > 0 {
			kept := c.st.History[key][:0]
			for _, smp := range c.st.History[key] {
				if smp.T >= cut {
					kept = append(kept, smp)
				}
			}
			c.st.History[key] = kept
		}
		c.mu.Unlock()
	}

	c.mu.Lock()
	c.chains = chains
	c.mu.Unlock()

	if err == nil {
		c.mergeBlocks(s.Blocks)
		c.recordBest(&s, chains)
	}
	c.refreshConfirmations()
}

// mergeBlocks adds blocks the stratum reports that we have not recorded.
// The stratum's list is bounded and resets on restart; ours is permanent.
func (c *collector) mergeBlocks(found []statsBlock) {
	c.mu.Lock()
	defer c.mu.Unlock()
	seen := map[string]bool{}
	for _, b := range c.st.Blocks {
		seen[fmt.Sprintf("%s/%d", b.Chain, b.Height)] = true
	}
	for _, b := range found {
		k := fmt.Sprintf("%s/%d", b.Chain, b.Height)
		if seen[k] {
			continue
		}
		_, reward := chainConstants(b.Chain)
		c.st.Blocks = append(c.st.Blocks, Block{
			Chain: b.Chain, Height: b.Height, Worker: b.Worker,
			Address: b.Address, FoundAt: time.UnixMilli(b.FoundAt),
			Reward: reward,
		})
		log.Printf("recorded %s block %d found by %s", b.Chain, b.Height, b.Worker)
	}
	sort.Slice(c.st.Blocks, func(i, j int) bool {
		return c.st.Blocks[i].FoundAt.After(c.st.Blocks[j].FoundAt)
	})
}

// recordBest keeps the luckiest share ever seen, per chain.
//
// The stratum's buffer is bounded and resets on restart, so this is where
// "ever" actually lives. Compared on LUCK rather than raw difficulty,
// because difficulty is shared while the targets are not: the same share can
// be a personal best against Dogecoin and unremarkable against Litecoin.
/* The chain's RPC `difficulty` in the same units as a share's achieved
   difficulty.

   Bitcoin-family daemons report `difficulty` against Bitcoin's difficulty-1
   target, whatever chain they are. Scrypt stratum difficulty is quoted
   against a target 2^shift easier. Comparing them unscaled says a share
   cleared the network target when it reached 0.0015% of it — which reads as
   "you found a block" on a page whose whole job is to be honest about odds.

   Only ever a fallback: the stratum reports networkDifficulty in share units
   already, measured against the very target the share was tested on. */
func rpcDiffToShareUnits(diff float64, shift int) float64 {
	if shift <= 0 {
		shift = 16
	}
	return diff * math.Pow(2, float64(shift))
}

func (c *collector) recordBest(s *stratumStats, chains map[string]ChainSummary) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, name := range chainOrder {
		var netDiff float64
		if d, ok := s.NetDiff[name]; ok && d != nil {
			netDiff = *d
		} else if cs, ok := chains[name]; ok {
			netDiff = rpcDiffToShareUnits(cs.Difficulty, s.ScryptShift)
		}
		if netDiff <= 0 {
			continue
		}
		cur := c.st.Best[name]
		for _, sh := range s.Shares {
			luck := 100 * sh.Achieved / netDiff
			if luck > cur.LuckPct {
				cur = BestShare{
					Difficulty: sh.Achieved, LuckPct: luck,
					Worker: sh.Worker, At: time.UnixMilli(sh.T),
				}
			}
		}
		if cur.LuckPct > 0 {
			c.st.Best[name] = cur
		}
	}
}

// refreshConfirmations asks each chain how deep our blocks are.
//
// A coinbase needs 100 confirmations before it can be spent, so "found" and
// "spendable" are different states and the page says which. A block the chain
// no longer has at that height was orphaned -- which solo mining does produce,
// and hiding it would overstate income.
func (c *collector) refreshConfirmations() {
	c.mu.RLock()
	blocks := make([]Block, len(c.st.Blocks))
	copy(blocks, c.st.Blocks)
	c.mu.RUnlock()

	byChain := map[string]chainRPC{}
	for _, ch := range c.rpcs {
		byChain[ch.name] = ch
	}

	for i := range blocks {
		if blocks[i].Mature || blocks[i].Orphaned {
			continue
		}
		ch, ok := byChain[blocks[i].Chain]
		if !ok {
			continue
		}
		raw, err := c.rpcCall(ch, "getblockhash", []interface{}{blocks[i].Height})
		if err != nil {
			// A failed lookup is NOT evidence of an orphan. Leave it alone.
			continue
		}
		var hash string
		if json.Unmarshal(raw, &hash) != nil {
			continue
		}
		raw, err = c.rpcCall(ch, "getblock", []interface{}{hash})
		if err != nil {
			continue
		}
		var blk struct {
			Confirmations int64 `json:"confirmations"`
		}
		if json.Unmarshal(raw, &blk) != nil {
			continue
		}
		blocks[i].Confirmations = blk.Confirmations
		blocks[i].Mature = blk.Confirmations >= 100
	}

	c.mu.Lock()
	c.st.Blocks = blocks
	c.mu.Unlock()
}

func (c *collector) run() {
	tick := time.NewTicker(30 * time.Second)
	saveTick := time.NewTicker(2 * time.Minute)
	c.poll()
	for {
		select {
		case <-tick.C:
			c.poll()
		case <-saveTick.C:
			c.save()
		}
	}
}

// ── HTTP ───────────────────────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("content-type", "application/json")
	w.Header().Set("cache-control", "no-store")
	_ = json.NewEncoder(w).Encode(v)
}

func rangeMillis(r string) int64 {
	switch r {
	case "1h":
		return 3600e3
	case "7d":
		return 7 * 86400e3
	default:
		return 86400e3
	}
}

func (c *collector) handleSummary(w http.ResponseWriter, r *http.Request) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	s := Summary{
		Chains:          c.chains,
		Order:           chainOrder,
		StratumOK:       c.stats != nil,
		StratumPort:     c.port,
		PayoutMode:      c.payout,
		PayoutAddresses: c.targets,
		Merged:          true,
	}
	if cs, ok := c.chains[parentChain]; ok {
		s.Node = cs.Node
		s.Hashrate = cs.Hashrate
		s.HashrateErr = cs.HashrateErr
	}
	// Merged only when BOTH nodes are usable. Saying so plainly beats showing
	// two chains when one of them is not actually being mined.
	for _, name := range chainOrder {
		if cs, ok := c.chains[name]; !ok || !cs.Node.Reachable || !cs.Node.Synced {
			s.Merged = false
		}
	}
	if c.stats != nil {
		s.Uptime = c.stats.Uptime
		/* Prefer an account a miner has actually used -- that is ground truth
		   about what works. Before any miner has connected, fall back to the
		   name the operator configured, so the Connect tab can be followed on
		   a fresh install instead of saying "waiting". */
		if len(c.stats.Accounts) > 0 {
			s.WorkerHint = c.stats.Accounts[0].Account + ".rig1"
		} else if c.stats.WorkerAccount != "" {
			s.WorkerHint = c.stats.WorkerAccount + ".rig1"
		}
	}
	writeJSON(w, s)
}

func (c *collector) handleWorkers(w http.ResponseWriter, r *http.Request) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := []Worker{}
	if c.stats == nil {
		writeJSON(w, out)
		return
	}
	diff := map[string]float64{}
	for _, cn := range c.stats.Connected {
		diff[cn.Worker] = cn.Difficulty
	}
	for _, sw := range c.stats.Workers {
		wk := Worker{
			WorkerName: sw.Worker, Account: sw.Account, Rig: sw.Rig,
			SharesValid: sw.Accepted, SharesStale: sw.Rejected,
			Billable: sw.BillableDiff, Difficulty: diff[sw.Worker],
			Status: "offline",
		}
		if sw.Hashrate != nil {
			wk.Hashrate = *sw.Hashrate
		}
		if sw.HashrateErr != nil {
			wk.HashrateErr = *sw.HashrateErr
		}
		if sw.LastShareAt != nil {
			wk.LastShareAt = time.UnixMilli(*sw.LastShareAt)
			if time.Since(wk.LastShareAt) < 10*time.Minute {
				wk.Status = "active"
			}
		}
		out = append(out, wk)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].WorkerName < out[j].WorkerName })
	writeJSON(w, out)
}

func (c *collector) handleBlocks(w http.ResponseWriter, r *http.Request) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := c.st.Blocks
	if out == nil {
		out = []Block{}
	}
	writeJSON(w, out)
}

func (c *collector) handleHistory(w http.ResponseWriter, r *http.Request) {
	span := rangeMillis(r.URL.Query().Get("range"))
	cut := time.Now().UnixMilli() - span
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := map[string][][3]float64{}
	for _, name := range chainOrder {
		rows := [][3]float64{}
		for _, s := range c.st.History[name] {
			if s.T >= cut {
				rows = append(rows, [3]float64{float64(s.T), s.H, s.R})
			}
		}
		out[name] = rows
	}
	writeJSON(w, out)
}

// handleShares reports how close each recent share came, PER CHAIN.
//
// The same share is tested against two different targets, so one share has
// two luck figures -- a submission that is 0.3% of Dogecoin's target is a
// smaller fraction of Litecoin's, because Litecoin's is harder. Serving a
// single number would hide exactly the asymmetry that makes merge mining
// worth doing.
func (c *collector) handleShares(w http.ResponseWriter, r *http.Request) {
	span := rangeMillis(r.URL.Query().Get("range"))
	cut := time.Now().UnixMilli() - span

	c.mu.RLock()
	defer c.mu.RUnlock()

	out := map[string][]map[string]interface{}{}
	for _, name := range chainOrder {
		rows := []map[string]interface{}{}
		if c.stats != nil {
			// Network difficulty for this chain, preferring what the stratum
			// saw when the share arrived over anything re-derived here.
			var netDiff float64
			if d, ok := c.stats.NetDiff[name]; ok && d != nil {
				netDiff = *d
			} else if cs, ok := c.chains[name]; ok {
				netDiff = rpcDiffToShareUnits(cs.Difficulty, c.stats.ScryptShift)
			}
			for _, sh := range c.stats.Shares {
				if sh.T < cut {
					continue
				}
				rows = append(rows, map[string]interface{}{
					"t":         sh.T,
					"diff":      sh.Achieved,
					"threshold": netDiff,
					"isBlock":   netDiff > 0 && sh.Achieved >= netDiff,
					"worker":    sh.Worker,
				})
			}
		}
		out[name] = rows
	}
	writeJSON(w, out)
}

func (c *collector) handleCSV(w http.ResponseWriter, r *http.Request) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	w.Header().Set("content-type", "text/csv")
	w.Header().Set("content-disposition", `attachment; filename="blocks.csv"`)
	fmt.Fprintln(w, "chain,height,worker,address,foundAt,reward,confirmations,mature,orphaned")
	for _, b := range c.st.Blocks {
		fmt.Fprintf(w, "%s,%d,%s,%s,%s,%g,%d,%t,%t\n",
			b.Chain, b.Height, b.Worker, b.Address,
			b.FoundAt.UTC().Format(time.RFC3339), b.Reward,
			b.Confirmations, b.Mature, b.Orphaned)
	}
}

const version = "dogeltc-dashboard"

const usage = `dogeltc-dashboard — collector and JSON API for the Dogecoin + Litecoin merge-mining dashboard.

Configured entirely by environment, because that is how StartOS starts it:

  DASH_ADDR           listen address            (default :8080)
  DASH_ASSETS         directory holding index.html and fonts
  DASH_DATA           directory for stats.json
  DASH_STRATUM        stratum stats API base url
  DASH_STRATUM_PORT   stratum port to report to miners
  DASH_LTC_RPC        Litecoin RPC url      DASH_LTC_COOKIE   path to its .cookie
  DASH_DOGE_RPC       Dogecoin RPC url      DASH_DOGE_COOKIE  path to its .cookie

Takes no flags other than --help and --version.
`

func main() {
	/* Answer --help and --version and EXIT.
	 *
	 * Without this the binary ignores its arguments entirely and falls
	 * through to ListenAndServe, so `scrypt-dashboard --help` starts a
	 * server and blocks forever. The Dockerfile ran exactly that as a smoke
	 * test and hung the image build until CI gave up -- a `;` ignores a bad
	 * exit status, but nothing saves you from a process that never exits.
	 * A binary that silently swallows a flag it does not understand is
	 * unfriendly anyway; it should say what it takes. */
	for _, a := range os.Args[1:] {
		switch a {
		case "-h", "--help", "help":
			fmt.Print(usage)
			return
		case "-v", "--version", "version":
			fmt.Println(version)
			return
		default:
			fmt.Fprintf(os.Stderr, "unknown argument %q\n\n%s", a, usage)
			os.Exit(2)
		}
	}

	addr := env("DASH_ADDR", ":8080")
	assets := env("DASH_ASSETS", "/opt/dashboard")
	data := env("DASH_DATA", "/data/dashboard")
	stratum := env("DASH_STRATUM", "http://127.0.0.1:3311")
	port, _ := strconv.Atoi(env("DASH_STRATUM_PORT", "3310"))

	rpcs := []chainRPC{
		{name: parentChain, url: env("DASH_LTC_RPC", ""), cookie: env("DASH_LTC_COOKIE", "")},
		{name: auxChain, url: env("DASH_DOGE_RPC", ""), cookie: env("DASH_DOGE_COOKIE", "")},
	}
	usable := rpcs[:0]
	for _, r := range rpcs {
		if r.url != "" && r.cookie != "" {
			usable = append(usable, r)
		} else {
			log.Printf("%s rpc not configured; its panel will show as unreachable", r.name)
		}
	}

	c := newCollector(data, stratum, usable, port)
	go c.run()

	mux := http.NewServeMux()
	mux.HandleFunc("/dash/summary", c.handleSummary)
	mux.HandleFunc("/dash/workers", c.handleWorkers)
	mux.HandleFunc("/dash/blocks", c.handleBlocks)
	mux.HandleFunc("/dash/history", c.handleHistory)
	mux.HandleFunc("/dash/shares", c.handleShares)
	mux.HandleFunc("/dash/export.csv", c.handleCSV)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]bool{"ok": true})
	})
	mux.Handle("/", http.FileServer(http.Dir(assets)))

	log.Printf("dashboard on %s, assets %s, stratum %s", addr, assets, stratum)
	srv := &http.Server{Addr: addr, Handler: mux}
	if err := srv.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}
