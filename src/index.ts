import { InPlayScanner } from './engine/inPlayScanner.js';
import { acquireSingleton, RuntimeState } from './operations.js';
import { errorDetails } from './diagnostics.js';
import { InPlayPolicy } from './engine/inPlayPolicy.js';
import { InPlayRouter } from './engine/inPlayRouter.js';
import { CatalystWs } from './connectors/catalystWs.js';
import { loadConfig } from './config.js';
import { Journal, now } from './journal.js';
import { BinanceWs, discover } from './connectors/binanceWs.js';
import { OrderBookManager } from './engine/orderBookManager.js';
import { TapeAnalyzer } from './engine/tapeAnalyzer.js';
import { StrategyStateMachine } from './engine/strategyStateMachine.js';
import { PaperBroker } from './simulator/paperBroker.js';
import type { Depth, Trade } from './types.js';

async function main(): Promise<void> {
  const releaseSingleton = await acquireSingleton();
  const config = loadConfig(); const journal = new Journal(config.logDir, config);
  const runtime = config.runtimeDir ? new RuntimeState(config.runtimeDir) : undefined;
  runtime?.write({ state: 'STARTING', mode: config.mode, journal: journal.path });
  const durationAt = process.argv.indexOf('--duration');
  const duration = durationAt >= 0 ? Number(process.argv[durationAt + 1]) : undefined;
  if (duration !== undefined && (!Number.isFinite(duration) || duration <= 0)) { await journal.close(); throw new Error('--duration requires positive seconds'); }
  const log = (type: string, data: unknown): void => journal.write(type, data);
  console.log('MASA 2 | public data only | PAPER / SIGNAL | discovering spot + perpetual universe...');
  let discovered: Awaited<ReturnType<typeof discover>>;
  try { discovered = await discover(config); } catch (error) {
    const details = { stage: 'DISCOVERY', error: errorDetails(error), journal: journal.path };
    log('STARTUP_FAILED', details); runtime?.failure(details); await journal.close(); throw error;
  }
  const { instruments, symbols } = discovered;
  log('UNIVERSE', { symbols, instruments, selection: 'liquid startup feeds plus at most 15 confirmed in-play additions' });
  log('RESEARCH_RULES', { version: 'crypto-inplay-v2', inPlay: config.inPlay, setup: 'B_ONLY', market: 'Binance crypto', status: 'UNVALIDATED_PAPER_HYPOTHESIS' });
  const manager = new OrderBookManager(config, instruments, log), tape = new TapeAnalyzer(config);
  let stopping = false, stopped = false, fatalError = false, timer: ReturnType<typeof setInterval> | undefined;
  const fail = (error: unknown, stage: string): void => {
    if (stopping) return;
    fatalError = true;
    const details = { stage, error: errorDetails(error), journal: journal.path };
    try { runtime?.failure(details); } catch (recordError) { console.error('Emergency log failed:', errorDetails(recordError)); }
    try { log('FATAL', details); } catch (recordError) { console.error('Journal failed:', errorDetails(recordError)); }
    console.error(JSON.stringify(details)); void shutdown('FATAL');
  };
  const onDepth = (d: Depth): void => {
    if (config.record) log('DEPTH', d);
    const time = now();
    if (Math.abs(time - d.time) > config.maxEventLagMs) {
      manager.book(d.market, d.symbol).synced = false;
      tape.clear(d.market, d.symbol); broker.dataGap(d.symbol, time, 'DEPTH_CLOCK_OR_LAG'); return;
    }
    manager.update(d.market, d.symbol, time);
    if (d.market === 'futures') broker.onBook(d.symbol, time);
  };
  const onTrade = (t: Trade): void => {
    if (config.record) log('TRADE', t);
    if (Math.abs(t.received - t.time) > config.maxEventLagMs) { tape.clear(t.market, t.symbol); broker.dataGap(t.symbol, t.received, 'TAPE_CLOCK_OR_LAG'); return; }
    const result = tape.add(t);
    if (result === 'duplicate' || result === 'late') return;
    if (result !== 'ok') { log('TAPE_INVALID', { market: t.market, symbol: t.symbol, result }); broker.dataGap(t.symbol, t.received, result); return; }
    manager.execution(t.market, t.symbol, t.ticks, t.qty, t.side);
    broker.onTrade(t);
  };
  const connector = new BinanceWs(manager, instruments, {
    depth: onDepth, trade: onTrade, log,
    invalid: (market, symbol, reason) => { tape.clear(market, symbol); broker.dataGap(symbol, now(), reason); log('FEED_INVALID', { market, symbol, reason }); },
    fatal: error => fail(error, 'BINANCE_CONNECTOR')
  });
  const scanner = new InPlayScanner(new Set(discovered.futureSymbols), event => {
    log(event.mode, event);
  }, log, config);
  const policy = new InPlayPolicy(config, scanner, manager, tape, log);
  const broker = new PaperBroker(config, manager, log, policy), strategy = new StrategyStateMachine(config, manager, tape, broker, log);
  const router = new InPlayRouter(symbols, discovered.catalog, scanner, symbol => connector.addSymbol(symbol, discovered.catalog), log);
  const catalysts = new CatalystWs(scanner, discovered.futureSymbols, log, error => fail(error, 'CATALYST_CALLBACK'));
  const draw = (): void => {
    const time = now(), rows = symbols.map(symbol => {
      const b = manager.book('futures', symbol), s = manager.book('spot', symbol), p = tape.pressure('futures', symbol, b.instrument.tick, time);
      return { symbol, inPlay: scanner.mode(symbol, time), state: strategy.states.get(symbol) ?? 'WARMUP', spot: s.healthy(time, config.staleMs, config.levels) ? 'OK' : 'WAIT', futures: b.healthy(time, config.staleMs, config.levels) ? 'OK' : 'WAIT', walls: manager.active(symbol).length, 'tape $/s': p.rate.toFixed(0), delta: p.delta.toFixed(2), position: broker.positions.get(symbol)?.side ?? '-' };
    });
    if (process.stdout.isTTY) console.clear();
    console.log(`MASA 2 | ${config.mode.toUpperCase()} | ${new Date(time).toISOString()} | NO REAL ORDERS`);
    console.table(rows);
    console.log(`Equity $${broker.equity(time).toFixed(2)} | realized net $${broker.realized.toFixed(4)} | fees $${broker.fees.toFixed(4)} | closed ${broker.closedCount} | open ${broker.positions.size} | spoof hypotheses ${manager.spoofCount} | signals ${strategy.signals} | rejected ${broker.rejected} (${broker.lastRejection || '-'})`);
    if (broker.positions.size) console.table([...broker.positions.values()].map(p => ({ symbol: p.symbol, qty: p.qty, entry: p.entry, strategy: p.signal.strategy, status: p.exitReason ?? 'OPEN' })));
    if (broker.closed.length) console.table(broker.closed.slice(-5));
    console.log(`Journal: ${journal.path}`);
  };
  const shutdown = async (reason: string): Promise<void> => {
    if (stopping) return; stopping = true;
    if (timer) clearInterval(timer);
    try {
      broker.halt(now(), reason);
      // Keep streams briefly for observable exits, never invent a closing fill.
      for (let n = 0; n < 20 && broker.positions.size; n++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        for (const symbol of broker.positions.keys()) broker.onBook(symbol, now());
      }
      catalysts.stop(); connector.stop();
      log('SESSION_END', { reason, realized: broker.realized, equity: broker.equity(now()), closedCount: broker.closedCount, unresolved: [...broker.positions.values()] });
      if (!config.headless) draw(); await journal.close();
      runtime?.write({ state: 'STOPPED', mode: config.mode, reason, journal: journal.path, unresolved: broker.positions.size });
    } catch (error) {
      fatalError = true; catalysts.stop(); connector.stop();
      try { runtime?.failure({ stage: 'SHUTDOWN', error: errorDetails(error), journal: journal.path }); } catch {}
      console.error('Shutdown error:', errorDetails(error));
    }
    releaseSingleton(); stopped = true; process.exitCode = fatalError ? 1 : 0;
  };
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.once('uncaughtException', error => fail(error, 'UNCAUGHT_EXCEPTION'));
  process.once('unhandledRejection', error => fail(error, 'UNHANDLED_REJECTION'));
  connector.start(); catalysts.start(); let lastDraw = 0, lastHeartbeat = 0, lastFunnelLog = 0;
  timer = setInterval(() => {
    if (stopping || stopped) return;
    try {
      const time = now();
      if (runtime && time - lastHeartbeat >= 5000) {
        const feedState = catalysts.status();
        const published = runtime.write({ state: 'RUNNING', ruleVersion: 'crypto-inplay-v2', mode: config.mode, journal: journal.path,
          operational: feedState.connected === feedState.expected ? 'CONNECTED' : 'DEGRADED',
          newsDelivery: scannerNewsStatus(feedState),
          uptimeSeconds: Math.floor(process.uptime()), symbols: symbols.length, feeds: feedState,
          signals: strategy.signals, open: broker.positions.size, closed: broker.closedCount, realized: broker.realized,
          memoryMb: Math.round(process.memoryUsage().rss / 1048576), heartbeatWriteFailures: runtime.writeFailures });
        if (!published) log('HEARTBEAT_WRITE_RETRY', { error: errorDetails(runtime.lastWriteError), failures: runtime.writeFailures });
        lastHeartbeat = time;
        if (runtime.stopRequested()) { void shutdown('OPERATOR_STOP'); return; }
      }
      if (time - lastFunnelLog >= 60000) {
        log('FUNNEL_TELEMETRY', {
          time,
          totalSignals: strategy.signals,
          rejected: broker.rejected,
          lastRejection: broker.lastRejection || 'none',
          activeWalls: symbols.reduce((acc, s) => acc + manager.active(s).length, 0),
          inPlayCandidates: scanner.candidates(time).length
        });
        lastFunnelLog = time;
      }
      router.update(time);
      for (const symbol of new Set([...symbols, ...scanner.candidates(time)])) policy.observe(symbol, time);
      for (const symbol of symbols) { strategy.evaluate(symbol, time); broker.onBook(symbol, time); }
      if (!config.headless && time - lastDraw >= config.dashboardMs) { draw(); lastDraw = time; }
    } catch (error) { fail(error, 'ENGINE_TICK'); }
  }, 100);
  if (duration !== undefined) {
    const durationTimer = setTimeout(() => { void shutdown('DURATION'); }, duration * 1000);
    durationTimer.unref();
  }
}
function scannerNewsStatus(feedState: ReturnType<CatalystWs['status']>): string {
  if (!feedState.feeds.tree?.connected) return 'DISCONNECTED';
  return (feedState.tree as { lastNewsReceived?: number }).lastNewsReceived === undefined ? 'CONNECTED_NO_NEWS_OBSERVED' : 'NEWS_OBSERVED_CHECK_CLASSIFICATION';
}
main().catch(error => { console.error(JSON.stringify(errorDetails(error))); process.exitCode = 1; });
