#!/usr/bin/env node
import React, { useState, useEffect, useCallback } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';

const HOME = process.env.HOME ?? '';
const BAYESIAN_FILE = `${HOME}/.claude/knowledge/handoffs/hydra-bayesian.json`;
const WATCHER_LOG = `${HOME}/.config/agents/logs/hydra-watcher.jsonl`;
const PENDING_DIR = `${HOME}/.claude/knowledge/handoffs/pending`;
const IN_PROGRESS_DIR = `${HOME}/.claude/knowledge/handoffs/in-progress`;

// ─── Provider color map ───────────────────────────────────────────────────────
const PROVIDER_COLORS: Record<string, string> = {
  codex: 'blue',
  kimi: 'yellow',
  gemini: 'green',
  minimax: 'magenta',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function safeExec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 5000, stdio: 'pipe' }).trim();
  } catch {
    return '';
  }
}

/** Laplace-smoothed win rate: (successes + 1) / (total + 2) */
function laplace(successes: number, total: number): number {
  return (successes + 1) / (total + 2);
}

interface ProviderStats {
  name: string;
  score: number;
  successes: number;
  failures: number;
  total: number;
}

function loadProviderStats(): ProviderStats[] {
  if (!existsSync(BAYESIAN_FILE)) return [];
  try {
    const raw = JSON.parse(readFileSync(BAYESIAN_FILE, 'utf8')) as {
      providers?: Record<string, { successes: number; failures: number; total: number }>;
      scores?: Record<string, number>;
    };
    // v1.1+ format: { providers: { name: { successes, failures, total } } }
    if (raw.providers) {
      return Object.entries(raw.providers).map(([name, p]) => ({
        name,
        score: laplace(p.successes, p.total),
        successes: p.successes,
        failures: p.failures,
        total: p.total,
      })).sort((a, b) => b.score - a.score);
    }
    // Legacy flat scores format
    if (raw.scores) {
      return Object.entries(raw.scores).map(([name, score]) => ({
        name, score: score as number, successes: 0, failures: 0, total: 0,
      })).sort((a, b) => b.score - a.score);
    }
  } catch {
    /* ignore */
  }
  return [];
}

function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  try {
    return parseInt(safeExec(`ls "${dir}"/*.md 2>/dev/null | wc -l`), 10) || 0;
  } catch {
    return 0;
  }
}

// ─── Components ──────────────────────────────────────────────────────────────

/** Unicode block bar chart */
function Bar({ value, width = 12 }: { value: number; width?: number }) {
  const filled = Math.round(value * width);
  const empty = width - filled;
  const pct = Math.round(value * 100).toString().padStart(3);
  return (
    <Text>
      <Text color="cyan">{'█'.repeat(filled)}</Text>
      <Text color="gray">{'░'.repeat(empty)}</Text>
      <Text> {pct}%</Text>
    </Text>
  );
}

/** Provider scores panel */
function ProvidersPanel({ stats }: { stats: ProviderStats[] }) {
  if (stats.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">PROVIDERS</Text>
        <Text color="gray">No data</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">PROVIDERS</Text>
      {stats.map((p) => (
        <Box key={p.name} marginTop={0}>
          <Text color={PROVIDER_COLORS[p.name] ?? 'white'}>{p.name.padEnd(8)}</Text>
          <Bar value={p.score} />
          {p.total > 0 && (
            <Text color="gray"> {p.successes}/{p.total}</Text>
          )}
        </Box>
      ))}
    </Box>
  );
}

/** systemd service status panel */
const SERVICES = [
  'hydra-dispatch',
  'hydra-watcher',
  'hydra-ambient',
  'devbot',
  'cloudflared',
  'apex-dashboard',
];

function ServicesPanel() {
  const [statuses, setStatuses] = useState<Record<string, boolean>>({});

  const refresh = useCallback(() => {
    const updated: Record<string, boolean> = {};
    for (const svc of SERVICES) {
      updated[svc] = safeExec(`systemctl --user is-active ${svc}.service 2>/dev/null`) === 'active';
    }
    setStatuses(updated);
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 10000);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="cyan">SERVICES</Text>
      {SERVICES.map((svc) => {
        const active = statuses[svc] ?? false;
        return (
          <Box key={svc}>
            <Text color={active ? 'green' : 'red'}>{active ? '● ' : '○ '}</Text>
            <Text color={active ? 'white' : 'gray'}>{svc}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

/** Queue stats */
function QueuePanel() {
  const [pending, setPending] = useState(0);
  const [inProgress, setInProgress] = useState(0);

  const refresh = useCallback(() => {
    setPending(countFiles(PENDING_DIR));
    setInProgress(countFiles(IN_PROGRESS_DIR));
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="cyan">QUEUE</Text>
      <Box>
        <Text color="gray">Pending:     </Text>
        <Text color={pending > 0 ? 'yellow' : 'white'}>{pending}</Text>
      </Box>
      <Box>
        <Text color="gray">In-progress: </Text>
        <Text color={inProgress > 0 ? 'green' : 'white'}>{inProgress}</Text>
      </Box>
    </Box>
  );
}

/** Hydra HTTP health */
function HydraPanel() {
  const [status, setStatus] = useState<string>('checking…');
  const [color, setColor] = useState<string>('gray');

  const refresh = useCallback(() => {
    const raw = safeExec(
      `python3 -c "import urllib.request,json; r=urllib.request.urlopen('http://127.0.0.1:8742/health',timeout=3); d=json.loads(r.read()); print(d.get('status','?'))" 2>/dev/null`
    );
    if (raw === 'healthy') { setStatus('healthy'); setColor('green'); }
    else if (raw === 'degraded') { setStatus('degraded'); setColor('yellow'); }
    else if (raw === 'critical') { setStatus('critical'); setColor('red'); }
    else { setStatus('offline'); setColor('gray'); }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 15000);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="cyan">HYDRA API :8742</Text>
      <Box>
        <Text color={color}>{'● '}</Text>
        <Text color={color}>{status}</Text>
      </Box>
    </Box>
  );
}

interface LogLine {
  ts: string;
  event?: string;
  message?: string;
  task_id?: string;
  node?: string;
  status?: string;
  rc?: number;
}

/** Live log tail */
function LiveLogPanel() {
  const [lines, setLines] = useState<LogLine[]>([]);

  const refresh = useCallback(() => {
    if (!existsSync(WATCHER_LOG)) return;
    try {
      const content = readFileSync(WATCHER_LOG, 'utf8');
      const all = content.trim().split('\n').filter(Boolean);
      const last = all.slice(-10);
      const parsed: LogLine[] = last.map((l: string) => {
        try { return JSON.parse(l) as LogLine; }
        catch { return { ts: '', message: l.slice(0, 80) }; }
      });
      setLines(parsed);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">LIVE LOG  hydra-watcher.jsonl</Text>
      {lines.length === 0 && <Text color="gray">No log entries</Text>}
      {lines.map((line, i) => {
        const ts = (line.ts ?? '').slice(11, 19);
        const evt = line.event ?? line.message ?? '';
        const detail = line.task_id ? ` [${line.task_id.slice(0, 8)}]` : '';
        const node = line.node ? ` ${line.node}` : '';
        const st = line.status ? `:${line.status}` : '';
        const failed = line.rc !== undefined && line.rc !== 0;
        return (
          <Box key={i}>
            <Text color="gray">{ts} </Text>
            <Text color={failed ? 'red' : 'white'}>{evt}</Text>
            <Text color="gray">{node}{st}{detail}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────
function Dashboard() {
  const { exit } = useApp();
  const [providerStats, setProviderStats] = useState<ProviderStats[]>([]);
  const [clock, setClock] = useState(new Date().toLocaleTimeString('en-GB'));
  const [tick, setTick] = useState(0);

  // Clock + provider stats refresh
  useEffect(() => {
    const refresh = () => {
      setClock(new Date().toLocaleTimeString('en-GB'));
      setProviderStats(loadProviderStats());
    };
    refresh();
    const id = setInterval(() => {
      setClock(new Date().toLocaleTimeString('en-GB'));
      setTick((t) => t + 1);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Refresh provider stats every 30s
  useEffect(() => {
    if (tick % 30 === 0) setProviderStats(loadProviderStats());
  }, [tick]);

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) exit();
    if (input === 'r') setTick((t) => t + 1);
  });

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      {/* ── Header ── */}
      <Box justifyContent="space-between" borderStyle="single" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">APEX Command Center</Text>
        <Text color="gray">pop-os · {clock} · v1.0.0</Text>
        <Text color="gray">dashboard.nadavc.ai</Text>
      </Box>

      {/* ── Body ── */}
      <Box marginTop={0}>
        {/* Left column */}
        <Box flexDirection="column" width={30} paddingX={1} borderStyle="single" borderColor="gray" marginRight={1}>
          <ProvidersPanel stats={providerStats} />
          <ServicesPanel />
          <QueuePanel />
          <HydraPanel />
        </Box>

        {/* Right column — live log */}
        <Box flexDirection="column" flexGrow={1} paddingX={1} borderStyle="single" borderColor="gray">
          <LiveLogPanel />
        </Box>
      </Box>

      {/* ── Footer ── */}
      <Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="space-between">
        <Text color="gray">[q] quit  [r] refresh</Text>
        <Text color="gray">auto-refresh: 3s log · 10s services · 30s providers</Text>
      </Box>
    </Box>
  );
}

render(<Dashboard />);
