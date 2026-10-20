// Command quai-dashboard serves the solo mining dashboard for the StartOS
// go-quai package and keeps the history the node itself does not store.
//
// go-quai holds its stratum stats in memory only: workers disappear on restart,
// hashrate is a 10-minute window, and the share history is capped at 500. This
// collector polls the node and persists what a miner wants to keep — hashrate
// history, per-worker averages, shares and found blocks — on the service volume.
package main

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/big"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

var algos = []string{"sha256", "scrypt", "kawpow"}

// poll and sample intervals (overridable for tests)
var (
	sampleInterval = time.Minute
	pollInterval   = 15 * time.Second
)

const (
	// A workshare's reward arrives as a coinbase transaction a few blocks after
	// the workshare itself: 7 in the cases measured. Scan a generous window.
	// Measured payouts landed 7 and 11 blocks after the workshare. 50 is a
	// generous window; past that the workshare was almost certainly orphaned:
	// accepted by our stratum but never included in a block, so it earns nothing.
	payoutScanDepth  = 50
	payoutScanGiveUp = 3

	saveEvery     = 5 * time.Minute
	historyKeep   = 7 * 24 * 60      // 7 days of per-minute samples
	sharesKeep    = 6000             // per algorithm
	workerExpiry  = 24 * time.Hour   // offline workers drop off after this
	activeWithin  = 10 * time.Minute // a share this recent counts as active
	httpTimeout   = 8 * time.Second
	fileMode      = 0o644
	dirMode       = 0o755
	csvMaxRecords = 20000
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// ── persisted state ───────────────────────────────────────────────────────────

type Sample struct {
	T int64   `json:"t"` // unix ms
	H float64 `json:"h"` // hashrate
	R float64 `json:"r"` // reject percent
}

type Worker struct {
	Address       string    `json:"address"`
	WorkerName    string    `json:"workerName"`
	Algorithm     string    `json:"algorithm"`
	Hashrate      float64   `json:"hashrate"`
	Avg24h        float64   `json:"avg24h"`
	Difficulty    float64   `json:"difficulty"`
	SharesValid   uint64    `json:"sharesValid"`
	SharesStale   uint64    `json:"sharesStale"`
	SharesInvalid uint64    `json:"sharesInvalid"`
	LastShareAt   time.Time `json:"lastShareAt"`
	Status        string    `json:"status"` // active | offline
	Samples       []Sample  `json:"samples,omitempty"`
}

// Block is one accepted submission. go-quai's stratum calls every accepted
// submission a "block", but most are workshares: work that met the lower
// workshare threshold and was included in someone else's block, paying a ninth
// of the pool. Kind is resolved by comparing our hash with the canonical block
// at that height (needs the node RPC).
type Block struct {
	Height    uint64    `json:"height"`
	Hash      string    `json:"hash"`
	Worker    string    `json:"worker"`
	Algorithm string    `json:"algorithm"`
	FoundAt   time.Time `json:"foundAt"`
	EstReward float64   `json:"estReward"`
	Kind      string    `json:"kind"` // workshare | block | unverified
	// What the chain actually paid, found by scanning the blocks that follow
	// for a coinbase to our address. Empty until the payout lands (about 7-15
	// blocks later) or when the node RPC is not shared.
	PaidReward float64 `json:"paidReward,omitempty"`
	PaidTx     string  `json:"paidTx,omitempty"`
	PaidHeight uint64  `json:"paidHeight,omitempty"`
	PayoutMiss int     `json:"payoutMiss,omitempty"` // empty scans; we stop looking eventually
	// pending until the payout is found, paid once it is, orphaned when the
	// search window closes without one. An orphaned workshare earns nothing.
	PayoutState string `json:"payoutState,omitempty"`
	// Lock tier taken from the work object header of the workshare, as recorded
	// in the block that included it: 0 = no lock (2 weeks), 1 = 3 months,
	// 2 = 6 months, 3 = 12 months. -1 means we have not read it yet.
	Lock int `json:"lock"`
	// Whether Lock was actually read from the chain. Without it an unread value
	// (Go's zero) is indistinguishable from a genuine "no lock".
	LockRead bool `json:"lockRead,omitempty"`
}

type Share struct {
	T         int64   `json:"t"`
	Diff      float64 `json:"diff"`
	Threshold float64 `json:"threshold"`
	IsBlock   bool    `json:"isBlock"`
}

type AlgoSummary struct {
	Hashrate      float64 `json:"hashrate"`
	WorkshareDiff float64 `json:"workshareDiff"`
	SharesValid   uint64  `json:"sharesValid"`
	SharesStale   uint64  `json:"sharesStale"`
	SharesInvalid uint64  `json:"sharesInvalid"`
	BestLuck      float64 `json:"bestLuck"`
	AvgLuck       float64 `json:"avgLuck"`
}

type NodeSummary struct {
	Synced bool   `json:"synced"`
	Height uint64 `json:"height"`
	Tip    uint64 `json:"tip"`
	Behind int64  `json:"behind"`
}

type MiningSummary struct {
	EstimatedBlockReward float64 `json:"estimatedBlockReward"` // full block, ~9x a workshare
	WorkshareReward      float64 `json:"workshareReward"`
	BaseBlockReward      float64 `json:"baseBlockReward"`
	AvgBlockTime         float64 `json:"avgBlockTime"`
	// Network figures, used to show honest odds rather than guesses.
	NetHashrate   map[string]float64 `json:"netHashrate"`
	NetDifficulty map[string]float64 `json:"netDifficulty"`
	AvgShareTime  map[string]float64 `json:"avgShareTime"`
}

type Summary struct {
	Node   NodeSummary            `json:"node"`
	Mining MiningSummary          `json:"mining"`
	Algos  map[string]AlgoSummary `json:"algos"`
	// Ports miners should connect to, passed in by the package because StartOS
	// assigns them and they are not always the defaults.
	StratumPorts map[string]int `json:"stratumPorts,omitempty"`
	// False when the node's stats API has never answered: the page must say so
	// rather than reporting an unsynced node it cannot actually see.
	StratumOK bool `json:"stratumOK"`
}

// store is everything kept on disk.
type store struct {
	History map[string][]Sample `json:"history"`
	Workers map[string]*Worker  `json:"workers"`
	Blocks  []Block             `json:"blocks"`
	Shares  map[string][]Share  `json:"shares"`
	Best    map[string]float64  `json:"bestLuck"`
	LuckSum map[string]float64  `json:"luckSum"`
	LuckN   map[string]float64  `json:"luckN"`
}

type collector struct {
	mu           sync.RWMutex
	st           store
	summary      Summary
	dataDir      string
	stratum      string
	health       string
	rpc          string
	client       *http.Client
	lastSeen     map[string]time.Time // share counters for reject-rate deltas
	lastCnt      map[string][3]uint64
	stratumPorts map[string]int
	dirty        bool
	failures     int // consecutive failed polls
	// Saves must not overlap: shutdown triggers one from the collector loop and
	// one from main, and two writers sharing a temp file produced a truncated
	// stats.json that lost every recorded submission.
	saveMu sync.Mutex
}

func newCollector(dataDir, stratum, health, rpc string) *collector {
	c := &collector{
		dataDir: dataDir, stratum: stratum, health: health, rpc: rpc,
		stratumPorts: map[string]int{},
		client:       &http.Client{Timeout: httpTimeout},
		lastSeen:     map[string]time.Time{},
		lastCnt:      map[string][3]uint64{},
	}
	c.st = store{
		Blocks:  []Block{},
		History: map[string][]Sample{}, Workers: map[string]*Worker{}, Shares: map[string][]Share{},
		Best: map[string]float64{}, LuckSum: map[string]float64{}, LuckN: map[string]float64{},
	}
	c.summary.Algos = map[string]AlgoSummary{}
	c.load()
	return c
}

func (c *collector) path() string { return filepath.Join(c.dataDir, "stats.json") }

func (c *collector) load() {
	b, err := os.ReadFile(c.path())
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			log.Printf("dashboard: could not read stored stats: %v", err)
		}
		return
	}
	var s store
	if err := json.Unmarshal(b, &s); err != nil {
		// Fall back to the previous good copy before giving up: the history is
		// the whole point of this package and cannot be rebuilt from the node.
		log.Printf("dashboard: stored stats are unreadable (%v); trying the backup", err)
		if bb, berr := os.ReadFile(c.path() + ".bak"); berr == nil {
			if jerr := json.Unmarshal(bb, &s); jerr == nil {
				log.Printf("dashboard: recovered stats from the backup copy")
			} else {
				log.Printf("dashboard: the backup is unreadable too, starting fresh: %v", jerr)
				return
			}
		} else {
			log.Printf("dashboard: no backup available, starting fresh")
			return
		}
	}
	if s.History == nil {
		s.History = map[string][]Sample{}
	}
	if s.Workers == nil {
		s.Workers = map[string]*Worker{}
	}
	if s.Shares == nil {
		s.Shares = map[string][]Share{}
	}
	if s.Blocks == nil {
		s.Blocks = []Block{}
	}
	if s.Best == nil {
		s.Best = map[string]float64{}
	}
	if s.LuckSum == nil {
		s.LuckSum = map[string]float64{}
	}
	if s.LuckN == nil {
		s.LuckN = map[string]float64{}
	}
	// Versions before 1.1.0:1 stored rewards straight from the node in wei.
	// Rescale them once on load so totals are not dominated by 1e19-sized values.
	fixed := 0
	for i := range s.Blocks {
		if s.Blocks[i].EstReward >= 1e9 {
			s.Blocks[i].EstReward /= 1e18
			fixed++
		}
	}
	c.st = s
	if fixed > 0 {
		c.dirty = true
		log.Printf("dashboard: rescaled %d rewards recorded in wei", fixed)
	}
	log.Printf("dashboard: loaded %d blocks, %d workers from %s", len(s.Blocks), len(s.Workers), c.path())
}

// save writes atomically: a half-written stats file would lose the block history.
// One writer at a time, a private temp file, and fsync before the rename.
func (c *collector) save() {
	c.saveMu.Lock()
	defer c.saveMu.Unlock()

	c.mu.RLock()
	b, err := json.Marshal(c.st)
	c.mu.RUnlock()
	if err != nil {
		log.Printf("dashboard: could not encode stats: %v", err)
		return
	}
	if err := os.MkdirAll(c.dataDir, dirMode); err != nil {
		log.Printf("dashboard: could not create %s: %v", c.dataDir, err)
		return
	}
	f, err := os.CreateTemp(c.dataDir, "stats-*.json")
	if err != nil {
		log.Printf("dashboard: could not create a temp file: %v", err)
		return
	}
	tmp := f.Name()
	defer os.Remove(tmp) // no-op once the rename succeeds
	if _, err := f.Write(b); err != nil {
		f.Close()
		log.Printf("dashboard: could not write stats: %v", err)
		return
	}
	if err := f.Sync(); err != nil { // on disk before anything replaces the old copy
		f.Close()
		log.Printf("dashboard: could not flush stats: %v", err)
		return
	}
	if err := f.Close(); err != nil {
		log.Printf("dashboard: could not close stats: %v", err)
		return
	}
	if err := os.Chmod(tmp, fileMode); err != nil {
		log.Printf("dashboard: could not set permissions on stats: %v", err)
	}
	// Keep the previous good copy: if a future write is ever cut short, load()
	// falls back to this rather than starting empty.
	if prev, err := os.ReadFile(c.path()); err == nil && len(prev) > 0 {
		_ = os.WriteFile(c.path()+".bak", prev, fileMode)
	}
	if err := os.Rename(tmp, c.path()); err != nil {
		log.Printf("dashboard: could not replace stats: %v", err)
	}
}

// ── node polling ──────────────────────────────────────────────────────────────

func (c *collector) getJSON(url string, out interface{}) error {
	resp, err := c.client.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 && resp.StatusCode != http.StatusServiceUnavailable {
		return fmt.Errorf("%s: %s", url, resp.Status)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

type poolOverview struct {
	Hashrate    float64 `json:"hashrate"`
	BlockHeight uint64  `json:"blockHeight"`
	SHA256      algoRaw `json:"sha256"`
	Scrypt      algoRaw `json:"scrypt"`
	KawPoW      algoRaw `json:"kawpow"`
}

type algoRaw struct {
	Hashrate    float64 `json:"hashrate"`
	Workers     int     `json:"workers"`
	SharesValid uint64  `json:"sharesValid"`
}

type rawWorker struct {
	Address       string    `json:"address"`
	WorkerName    string    `json:"workerName"`
	Algorithm     string    `json:"algorithm"`
	Hashrate      float64   `json:"hashrate"`
	Difficulty    float64   `json:"difficulty"`
	SharesValid   uint64    `json:"sharesValid"`
	SharesStale   uint64    `json:"sharesStale"`
	SharesInvalid uint64    `json:"sharesInvalid"`
	LastShareAt   time.Time `json:"lastShareAt"`
	IsConnected   bool      `json:"isConnected"`
}

type rawShare struct {
	Timestamp          time.Time `json:"timestamp"`
	Algorithm          string    `json:"algorithm"`
	AchievedDifficulty float64   `json:"achievedDifficulty"`
	WorkshareDiff      float64   `json:"workshareDiff"`
	LuckPercent        float64   `json:"luckPercent"`
	IsBlock            bool      `json:"isBlock"`
}

type shareHistory struct {
	Shares        []rawShare `json:"shares"`
	WorkshareDiff float64    `json:"workshareDiff"`
	BestShareLuck float64    `json:"bestShareLuck"`
	AverageLuck   float64    `json:"averageLuck"`
}

type rawBlock struct {
	Height    uint64    `json:"height"`
	Hash      string    `json:"hash"`
	Worker    string    `json:"worker"`
	Algorithm string    `json:"algorithm"`
	FoundAt   time.Time `json:"foundAt"`
}

type nodeHealth struct {
	Healthy           bool   `json:"healthy"`
	LocalBlockNum     uint64 `json:"localBlockNum"`
	ReferenceBlockNum uint64 `json:"referenceBlockNum"`
	BlocksBehind      int64  `json:"blocksBehind"`
}

func workerKey(w rawWorker) string {
	return w.Address + "|" + w.WorkerName + "|" + w.Algorithm
}

func (c *collector) poll() {
	var ov poolOverview
	if err := c.getJSON(c.stratum+"/api/pool/stats", &ov); err != nil {
		c.mu.Lock()
		c.summary.StratumOK = false
		c.failures++
		n := c.failures
		c.mu.Unlock()
		if n == 1 {
			log.Printf("dashboard: stratum stats unavailable at %s: %v", c.stratum, err)
		}
		return
	}
	c.mu.Lock()
	if c.failures > 0 {
		log.Printf("dashboard: stratum stats reachable again after %d failed polls", c.failures)
	}
	c.failures = 0
	c.mu.Unlock()
	var raws []rawWorker
	if err := c.getJSON(c.stratum+"/api/pool/workers", &raws); err != nil {
		log.Printf("dashboard: stratum workers unavailable: %v", err)
	}
	// The node's health endpoint and RPC are optional. In the dashboard package
	// they are only reachable when go-quai shares them; the dependency already
	// guarantees the node is running and synced before this package starts.
	var hp nodeHealth
	nodeOK := false
	if c.health != "" {
		nodeOK = c.getJSON(c.health+"/", &hp) == nil
	}
	mining := MiningSummary{}
	if c.rpc != "" {
		mining = c.miningInfo()
	}

	var blocks []rawBlock
	if err := c.getJSON(c.stratum+"/api/pool/blocks", &blocks); err != nil {
		log.Printf("dashboard: stratum blocks unavailable: %v", err)
	}

	perAlgo := map[string]algoRaw{"sha256": ov.SHA256, "scrypt": ov.Scrypt, "kawpow": ov.KawPoW}
	now := time.Now()

	c.mu.Lock()
	defer c.mu.Unlock()

	// workers: everything reported is connected; anything previously seen and now
	// missing is offline until it ages out.
	seen := map[string]bool{}
	for _, r := range raws {
		k := workerKey(r)
		seen[k] = true
		w := c.st.Workers[k]
		if w == nil {
			w = &Worker{Address: r.Address, WorkerName: r.WorkerName, Algorithm: r.Algorithm}
			c.st.Workers[k] = w
		}
		w.Hashrate, w.Difficulty = r.Hashrate, r.Difficulty
		w.SharesValid, w.SharesStale, w.SharesInvalid = r.SharesValid, r.SharesStale, r.SharesInvalid
		w.LastShareAt = r.LastShareAt
		if !r.LastShareAt.IsZero() && now.Sub(r.LastShareAt) > activeWithin {
			w.Status = "offline"
		} else {
			w.Status = "active"
		}
		c.lastSeen[k] = now
	}
	for k, w := range c.st.Workers {
		if !seen[k] {
			w.Status = "offline"
			w.Hashrate = 0
			last := w.LastShareAt
			if last.IsZero() {
				last = c.lastSeen[k]
			}
			if !last.IsZero() && now.Sub(last) > workerExpiry {
				delete(c.st.Workers, k)
				delete(c.lastSeen, k)
			}
		}
	}

	// shares and luck
	algoSummary := map[string]AlgoSummary{}
	for _, a := range algos {
		var sh shareHistory
		if err := c.getJSON(c.stratum+"/api/pool/shares?algorithm="+a, &sh); err != nil {
			log.Printf("dashboard: stratum shares (%s) unavailable: %v", a, err)
		}
		newest := int64(0)
		for _, s := range c.st.Shares[a] {
			if s.T > newest {
				newest = s.T
			}
		}
		for _, s := range sh.Shares {
			ms := s.Timestamp.UnixMilli()
			if ms <= newest {
				continue
			}
			c.st.Shares[a] = append(c.st.Shares[a], Share{T: ms, Diff: s.AchievedDifficulty, Threshold: s.WorkshareDiff, IsBlock: s.IsBlock})
			if s.LuckPercent > c.st.Best[a] {
				c.st.Best[a] = s.LuckPercent
			}
			c.st.LuckSum[a] += s.LuckPercent
			c.st.LuckN[a]++
		}
		if n := len(c.st.Shares[a]); n > sharesKeep {
			c.st.Shares[a] = append([]Share(nil), c.st.Shares[a][n-sharesKeep:]...)
		}
		var valid, stale, invalid uint64
		for _, w := range c.st.Workers {
			if w.Algorithm == a {
				valid += w.SharesValid
				stale += w.SharesStale
				invalid += w.SharesInvalid
			}
		}
		if valid == 0 {
			valid = perAlgo[a].SharesValid
		}
		avg := 0.0
		if c.st.LuckN[a] > 0 {
			avg = c.st.LuckSum[a] / c.st.LuckN[a]
		}
		diff := sh.WorkshareDiff
		if diff == 0 {
			// fall back to the threshold carried on the most recent share
			if n := len(c.st.Shares[a]); n > 0 {
				diff = c.st.Shares[a][n-1].Threshold
			}
		}
		algoSummary[a] = AlgoSummary{
			Hashrate: perAlgo[a].Hashrate, WorkshareDiff: diff,
			SharesValid: valid, SharesStale: stale, SharesInvalid: invalid,
			BestLuck: c.st.Best[a], AvgLuck: avg,
		}
	}

	// blocks: keep every one ever seen, with the reward estimated when found
	known := map[string]bool{}
	for _, b := range c.st.Blocks {
		known[b.Hash] = true
	}
	for _, b := range blocks {
		if b.Hash == "" || known[b.Hash] {
			continue
		}
		reward := mining.WorkshareReward
		if reward == 0 {
			reward = mining.EstimatedBlockReward / 9 // ExpectedWorksharesPerBlock + 1
		}
		c.st.Blocks = append([]Block{{
			Height: b.Height, Hash: b.Hash, Worker: b.Worker, Algorithm: b.Algorithm,
			FoundAt: b.FoundAt, EstReward: reward, Kind: "unverified", Lock: -1,
		}}, c.st.Blocks...)
		known[b.Hash] = true
		log.Printf("dashboard: recorded block %d (%s) found by %s", b.Height, b.Algorithm, b.Worker)
	}
	sort.SliceStable(c.st.Blocks, func(i, j int) bool { return c.st.Blocks[i].FoundAt.After(c.st.Blocks[j].FoundAt) })

	node := NodeSummary{Synced: nodeOK && hp.Healthy, Height: hp.LocalBlockNum, Tip: hp.ReferenceBlockNum, Behind: hp.BlocksBehind}
	if c.health == "" {
		// No health endpoint to ask: the node is synced or this package would
		// not be running, so report the chain height the stratum API gives us.
		node = NodeSummary{Synced: true, Height: ov.BlockHeight, Tip: ov.BlockHeight}
	}
	if node.Height == 0 {
		node.Height = ov.BlockHeight
	}
	if node.Tip < node.Height {
		node.Tip = node.Height
	}
	c.summary = Summary{Node: node, Mining: mining, Algos: algoSummary, StratumPorts: c.stratumPorts, StratumOK: true}
	c.dirty = true
}

// miningInfo asks the node's zone RPC for reward and difficulty figures.
func (c *collector) miningInfo() MiningSummary {
	body := strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"quai_getMiningInfo","params":[true]}`)
	req, err := http.NewRequest(http.MethodPost, c.rpc, body)
	if err != nil {
		return MiningSummary{}
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.client.Do(req)
	if err != nil {
		return MiningSummary{}
	}
	defer resp.Body.Close()
	var out struct {
		Result map[string]interface{} `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return MiningSummary{}
	}
	num := func(k string) float64 {
		switch v := out.Result[k].(type) {
		case float64:
			return v
		case string:
			f, err := strconv.ParseFloat(strings.TrimPrefix(v, "0x"), 64)
			if err == nil {
				return f
			}
		}
		return 0
	}
	// Reward fields come back in wei (18 decimals). A node that already reports
	// whole QUAI would give a small number, so only scale values big enough to
	// be wei.
	quai := func(k string) float64 {
		v := num(k)
		if v >= 1e9 {
			return v / 1e18
		}
		return v
	}
	return MiningSummary{
		EstimatedBlockReward: quai("estimatedBlockReward"),
		WorkshareReward:      quai("workshareReward"),
		BaseBlockReward:      quai("baseBlockReward"),
		AvgBlockTime:         num("avgBlockTime"),
		NetHashrate: map[string]float64{
			"sha256": num("shaHashRate"), "scrypt": num("scryptHashRate"), "kawpow": num("kawpowHashRate"),
		},
		NetDifficulty: map[string]float64{
			"sha256": num("shaDifficulty"), "scrypt": num("scryptDifficulty"), "kawpow": num("kawpowDifficulty"),
		},
		AvgShareTime: map[string]float64{
			"sha256": num("avgShaShareTime"), "scrypt": num("avgScryptShareTime"), "kawpow": num("avgKawpowShareTime"),
		},
	}
}

// rpcCall makes a JSON-RPC request to the node and returns the raw result.
func (c *collector) rpcCall(method string, params string) (json.RawMessage, error) {
	if c.rpc == "" {
		return nil, errors.New("no rpc configured")
	}
	body := strings.NewReader(fmt.Sprintf(`{"jsonrpc":"2.0","id":1,"method":%q,"params":%s}`, method, params))
	req, err := http.NewRequest(http.MethodPost, c.rpc, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var out struct {
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	if out.Error != nil {
		return nil, errors.New(out.Error.Message)
	}
	return out.Result, nil
}

// verifyKinds resolves whether each recorded submission was a genuine block or
// a workshare: the canonical block at that height either has our hash or it
// doesn't. Only possible when the node shares its RPC.
func (c *collector) verifyKinds() {
	if c.rpc == "" {
		return
	}
	c.mu.RLock()
	mining := c.summary.Mining
	c.mu.RUnlock()
	c.mu.RLock()
	type todo struct {
		height uint64
		hash   string
		kind   string
	}
	var pending []todo
	for _, b := range c.st.Blocks {
		// Needs its kind resolved, or its lock tier read: anything recorded
		// before 1.1.0:13 has no lock stored, whatever its kind.
		if b.Kind == "" || b.Kind == "unverified" || !b.LockRead {
			pending = append(pending, todo{b.Height, b.Hash, b.Kind})
		}
	}
	c.mu.RUnlock()
	// note: still run the repair pass below even when nothing needs classifying
	if len(pending) > 20 { // a few per poll is plenty; they are not going anywhere
		pending = pending[:20]
	}

	kinds := map[string]string{}
	locks := map[string]int{}
	c.mu.RLock()
	addrs := map[string]bool{}
	for _, w := range c.st.Workers {
		if w.Address != "" {
			addrs[strings.ToLower(w.Address)] = true
		}
	}
	c.mu.RUnlock()

	for _, t := range pending {
		// A workshare is listed in the block that included it, which is its own
		// height or a block or two later, with the lock tier in its header.
		for off := uint64(0); off <= 3; off++ {
			res, err := c.rpcCall("quai_getBlockByNumber", fmt.Sprintf(`["0x%x",false]`, t.height+off))
			if err != nil || len(res) == 0 || string(res) == "null" {
				continue
			}
			var blk struct {
				WoHeader struct {
					Hash string `json:"hash"`
				} `json:"woHeader"`
				Workshares []struct {
					PrimaryCoinbase string `json:"primaryCoinbase"`
					Lock            string `json:"lock"`
					Hash            string `json:"hash"`
				} `json:"workshares"`
			}
			if err := json.Unmarshal(res, &blk); err != nil {
				continue
			}
			if off == 0 && blk.WoHeader.Hash != "" && (t.kind == "" || t.kind == "unverified") {
				if strings.EqualFold(blk.WoHeader.Hash, t.hash) {
					kinds[t.hash] = "block"
				} else {
					kinds[t.hash] = "workshare"
				}
			}
			for _, w := range blk.Workshares {
				if !addrs[strings.ToLower(w.PrimaryCoinbase)] {
					continue
				}
				if w.Hash != "" && !strings.EqualFold(w.Hash, t.hash) {
					continue // a different workshare of ours in the same block
				}
				if n, err := strconv.ParseUint(strings.TrimPrefix(w.Lock, "0x"), 16, 8); err == nil {
					locks[t.hash] = int(n)
				}
			}
			if _, ok := locks[t.hash]; ok {
				break
			}
		}
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	// Submissions classified by an earlier version kept the reward they were
	// recorded with, which before the workshare/block split was always the full
	// block reward. Correct any workshare still carrying one.
	if mining.WorkshareReward > 0 {
		repaired := 0
		for i := range c.st.Blocks {
			if c.st.Blocks[i].Kind == "workshare" && c.st.Blocks[i].EstReward > 3*mining.WorkshareReward {
				c.st.Blocks[i].EstReward = mining.WorkshareReward
				repaired++
			}
		}
		if repaired > 0 {
			c.dirty = true
			log.Printf("dashboard: corrected %d workshare rewards that were recorded as block rewards", repaired)
		}
	}

	for i := range c.st.Blocks {
		if l, ok := locks[c.st.Blocks[i].Hash]; ok {
			c.st.Blocks[i].Lock = l
			c.st.Blocks[i].LockRead = true
			c.dirty = true
		}
		k, ok := kinds[c.st.Blocks[i].Hash]
		if !ok {
			continue
		}
		c.st.Blocks[i].Kind = k
		// Correct the reward to match what this actually was. Submissions
		// recorded before 1.1.0:0 all carried the full block reward, because
		// the package had no way to tell a workshare from a block.
		switch {
		case k == "block" && mining.EstimatedBlockReward > 0:
			c.st.Blocks[i].EstReward = mining.EstimatedBlockReward
			log.Printf("dashboard: block %d was won outright by %s", c.st.Blocks[i].Height, c.st.Blocks[i].Worker)
		case k == "workshare" && mining.WorkshareReward > 0:
			c.st.Blocks[i].EstReward = mining.WorkshareReward
		}
	}
	c.dirty = true
}

// findPayouts looks for the coinbase transaction that actually paid each
// recorded workshare, so the dashboard can show the real amount and link to it
// rather than showing an estimate.
func (c *collector) findPayouts() {
	if c.rpc == "" {
		return
	}
	c.mu.RLock()
	tip := c.summary.Node.Height
	var pending []Block
	addrs := map[string]bool{}
	for _, b := range c.st.Blocks {
		if b.PaidTx == "" && b.PayoutMiss < payoutScanGiveUp && b.Height > 0 {
			pending = append(pending, b)
		}
	}
	for _, w := range c.st.Workers {
		if w.Address != "" {
			addrs[strings.ToLower(w.Address)] = true
		}
	}
	c.mu.RUnlock()
	if len(pending) == 0 || len(addrs) == 0 {
		return
	}
	if len(pending) > 3 { // a few per poll: each one costs up to 25 RPC calls
		pending = pending[:3]
	}

	type payout struct {
		amount float64
		tx     string
		height uint64
	}
	found := map[string]payout{}
	misses := map[string]bool{}

	for _, b := range pending {
		if tip > 0 && b.Height+payoutScanDepth > tip {
			continue // the payout may simply not have been mined yet
		}
		hit := false
		/* A lookup that FAILS is not evidence of anything. Count them, and if any
		   failed, leave the workshare pending rather than recording a miss: three
		   misses condemn it permanently, and "you earned nothing" is the worst
		   thing this dashboard can say wrongly. */
		failed := 0
		for i := uint64(1); i <= payoutScanDepth && !hit; i++ {
			res, err := c.rpcCall("quai_getBlockByNumber", fmt.Sprintf(`["0x%x",true]`, b.Height+i))
			if err != nil || len(res) == 0 || string(res) == "null" {
				failed++
				continue
			}
			var blk struct {
				Transactions []struct {
					To    string `json:"to"`
					Value string `json:"value"`
					Hash  string `json:"hash"`
				} `json:"transactions"`
			}
			if err := json.Unmarshal(res, &blk); err != nil {
				failed++
				continue
			}
			for _, t := range blk.Transactions {
				if !addrs[strings.ToLower(t.To)] {
					continue
				}
				v := new(big.Int)
				if _, ok := v.SetString(strings.TrimPrefix(t.Value, "0x"), 16); !ok {
					continue
				}
				amount, _ := new(big.Float).Quo(new(big.Float).SetInt(v), big.NewFloat(1e18)).Float64()
				found[b.Hash] = payout{amount: amount, tx: t.Hash, height: b.Height + i}
				hit = true
				break
			}
		}
		if !hit && failed > 0 {
			log.Printf("dashboard: payout scan for %d incomplete (%d/%d lookups failed) — leaving it pending",
				b.Height, failed, payoutScanDepth)
		}
		if !hit && failed == 0 {
			misses[b.Hash] = true
		}
	}
	if len(found) == 0 && len(misses) == 0 {
		return
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	for i := range c.st.Blocks {
		if p, ok := found[c.st.Blocks[i].Hash]; ok {
			c.st.Blocks[i].PaidReward = p.amount
			c.st.Blocks[i].PaidTx = p.tx
			c.st.Blocks[i].PaidHeight = p.height
			c.st.Blocks[i].PayoutState = "paid"
			log.Printf("dashboard: workshare %d paid %.4f QUAI in block %d", c.st.Blocks[i].Height, p.amount, p.height)
		} else if misses[c.st.Blocks[i].Hash] {
			c.st.Blocks[i].PayoutMiss++
			if c.st.Blocks[i].PayoutMiss >= payoutScanGiveUp {
				c.st.Blocks[i].PayoutState = "orphaned"
				log.Printf("dashboard: workshare %d was not rewarded (no payout within %d blocks)", c.st.Blocks[i].Height, payoutScanDepth)
			} else {
				c.st.Blocks[i].PayoutState = "pending"
			}
		}
	}
	c.dirty = true
}

/*
Records marked orphaned before the scan-accounting fix were condemned by a

	rule that counted RPC failures as missing payouts. Give them one more chance
	under the corrected logic — a new rule has to be applied to the records
	written under the old one, or the bug outlives the fix.
*/
func (c *collector) reopenOrphans() {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for i := range c.st.Blocks {
		if c.st.Blocks[i].PayoutState == "orphaned" && c.st.Blocks[i].PaidTx == "" {
			c.st.Blocks[i].PayoutState = "pending"
			c.st.Blocks[i].PayoutMiss = 0
			n++
		}
	}
	if n > 0 {
		log.Printf("dashboard: re-checking %d workshare(s) previously marked not rewarded", n)
		c.dirty = true
	}
}

// sample appends one hashrate point per algorithm, with the reject rate over
// the interval rather than since the node started.
func (c *collector) sample() {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now().UnixMilli()
	for _, a := range algos {
		s := c.summary.Algos[a]
		prev := c.lastCnt[a]
		cur := [3]uint64{s.SharesValid, s.SharesStale, s.SharesInvalid}
		rej := 0.0
		if d := float64((cur[0] - prev[0]) + (cur[1] - prev[1]) + (cur[2] - prev[2])); d > 0 && cur[0] >= prev[0] {
			rej = 100 * float64((cur[1]-prev[1])+(cur[2]-prev[2])) / d
		}
		c.lastCnt[a] = cur
		c.st.History[a] = append(c.st.History[a], Sample{T: now, H: s.Hashrate, R: rej})
		if n := len(c.st.History[a]); n > historyKeep {
			c.st.History[a] = append([]Sample(nil), c.st.History[a][n-historyKeep:]...)
		}
	}
	// per-worker 24h averages, from the worker's own samples
	for _, w := range c.st.Workers {
		w.Samples = append(w.Samples, Sample{T: now, H: w.Hashrate})
		cut := time.Now().Add(-24 * time.Hour).UnixMilli()
		kept := w.Samples[:0]
		var sum float64
		for _, s := range w.Samples {
			if s.T >= cut {
				kept = append(kept, s)
				sum += s.H
			}
		}
		w.Samples = kept
		if len(kept) > 0 {
			w.Avg24h = sum / float64(len(kept))
		}
	}
	c.dirty = true
}

func (c *collector) run(ctx context.Context) {
	c.poll()
	c.verifyKinds()
	pollT, sampleT, saveT := time.NewTicker(pollInterval), time.NewTicker(sampleInterval), time.NewTicker(saveEvery)
	defer pollT.Stop()
	defer sampleT.Stop()
	defer saveT.Stop()
	reopened := false
	for {
		select {
		case <-ctx.Done():
			c.save()
			return
		case <-pollT.C:
			c.poll()
			c.verifyKinds()
			if !reopened {
				c.reopenOrphans()
				reopened = true
			}
			c.findPayouts()
		case <-sampleT.C:
			c.sample()
		case <-saveT.C:
			c.mu.RLock()
			d := c.dirty
			c.mu.RUnlock()
			if d {
				c.save()
				c.mu.Lock()
				c.dirty = false
				c.mu.Unlock()
			}
		}
	}
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

func rangeMillis(r string) int64 {
	switch r {
	case "1h":
		return 3600 * 1000
	case "7d":
		return 7 * 24 * 3600 * 1000
	default:
		return 24 * 3600 * 1000
	}
}

func writeJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("dashboard: response failed: %v", err)
	}
}

func (c *collector) handleSummary(w http.ResponseWriter, r *http.Request) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	writeJSON(w, c.summary)
}

func (c *collector) handleWorkers(w http.ResponseWriter, r *http.Request) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := make([]Worker, 0, len(c.st.Workers))
	for _, x := range c.st.Workers {
		cp := *x
		cp.Samples = nil
		out = append(out, cp)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Hashrate > out[j].Hashrate })
	writeJSON(w, out)
}

func (c *collector) handleBlocks(w http.ResponseWriter, r *http.Request) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	// An empty Go slice marshals to null, which breaks JSON consumers that
	// expect a list. Always send [].
	if c.st.Blocks == nil {
		writeJSON(w, []Block{})
		return
	}
	writeJSON(w, c.st.Blocks)
}

func (c *collector) handleHistory(w http.ResponseWriter, r *http.Request) {
	cut := time.Now().UnixMilli() - rangeMillis(r.URL.Query().Get("range"))
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := map[string][][3]float64{}
	for _, a := range algos {
		pts := make([][3]float64, 0, 64)
		for _, s := range c.st.History[a] {
			if s.T >= cut {
				pts = append(pts, [3]float64{float64(s.T), s.H, s.R})
			}
		}
		out[a] = pts
	}
	writeJSON(w, out)
}

func (c *collector) handleShares(w http.ResponseWriter, r *http.Request) {
	cut := time.Now().UnixMilli() - rangeMillis(r.URL.Query().Get("range"))
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := map[string][]Share{}
	for _, a := range algos {
		list := make([]Share, 0, 64)
		for _, s := range c.st.Shares[a] {
			if s.T >= cut {
				list = append(list, s)
			}
		}
		out[a] = list
	}
	writeJSON(w, out)
}

func (c *collector) handleCSV(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	rng := q.Get("range")
	algo := q.Get("algo")
	if algo == "" {
		algo = "sha256"
	}
	cut := time.Now().UnixMilli() - rangeMillis(rng)
	c.mu.RLock()
	rows := make([][]string, 0, 64)
	for _, s := range c.st.History[algo] {
		if s.T < cut {
			continue
		}
		rows = append(rows, []string{
			time.UnixMilli(s.T).UTC().Format(time.RFC3339),
			strconv.FormatFloat(s.H, 'f', 2, 64),
			strconv.FormatFloat(s.R, 'f', 3, 64),
		})
		if len(rows) >= csvMaxRecords {
			break
		}
	}
	c.mu.RUnlock()
	w.Header().Set("Content-Type", "text/csv")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=quai-%s-%s.csv", algo, rng))
	cw := csv.NewWriter(w)
	_ = cw.Write([]string{"timestamp_utc", "hashrate_hs", "reject_percent"})
	_ = cw.WriteAll(rows)
	cw.Flush()
}

func main() {
	log.SetFlags(0)
	var (
		addr    = env("DASH_ADDR", ":8080")
		assets  = env("DASH_ASSETS", "/opt/dashboard")
		dataDir = env("DASH_DATA", "/data/dashboard")
		stratum = env("DASH_STRATUM", "http://127.0.0.1:3306")
		// Optional: only set when go-quai shares them. Empty disables the probe.
		health = os.Getenv("DASH_HEALTH")
		rpc    = os.Getenv("DASH_RPC")
	)
	c := newCollector(dataDir, stratum, health, rpc)
	// DASH_STRATUM_PORTS is "sha256=60862,scrypt=3334,kawpow=3335": the external
	// ports StartOS assigned, so How to connect shows the truth.
	for _, pair := range strings.Split(os.Getenv("DASH_STRATUM_PORTS"), ",") {
		k, v, ok := strings.Cut(pair, "=")
		if !ok {
			continue
		}
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.stratumPorts[strings.TrimSpace(k)] = n
		}
	}
	for _, o := range []struct {
		env string
		dst *time.Duration
	}{{"DASH_SAMPLE_SECONDS", &sampleInterval}, {"DASH_POLL_SECONDS", &pollInterval}} { // tests only
		if n, err := strconv.Atoi(os.Getenv(o.env)); err == nil && n > 0 {
			*o.dst = time.Duration(n) * time.Second
		}
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	go c.run(ctx)

	mux := http.NewServeMux()
	mux.HandleFunc("/dash/summary", c.handleSummary)
	mux.HandleFunc("/dash/workers", c.handleWorkers)
	mux.HandleFunc("/dash/blocks", c.handleBlocks)
	mux.HandleFunc("/dash/history", c.handleHistory)
	mux.HandleFunc("/dash/shares", c.handleShares)
	mux.HandleFunc("/dash/export.csv", c.handleCSV)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.Handle("/", http.FileServer(http.Dir(assets)))

	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      30 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutCtx)
	}()
	log.Printf("dashboard: serving %s on %s (stratum %s)", assets, addr, stratum)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("dashboard: %v", err)
	}
	c.save()
	log.Printf("dashboard: stopped")
}
