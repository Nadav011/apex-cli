#!/usr/bin/env node
import { execSync } from 'child_process';

const HOME = process.env.HOME;
const SCRIPTS = `${HOME}/.claude/scripts`;

const REPOS = [
  'Mexicani', 'chance-pro', 'nadavai', 'design-system', 'signature-pro',
  'Z', 'cash', 'mexicani-shifts', 'hatumdigital', 'brain',
  'sportchat-ultimate', 'vibechat', 'my-video', 'israeli-finance-app',
];

const SERVICES = [
  'hydra-dispatch', 'hydra-watcher', 'hydra-ambient',
  'devbot', 'cloudflared', 'apex-dashboard',
];

function exec(cmd, capture = false) {
  try {
    const result = execSync(cmd, {
      encoding: 'utf8',
      timeout: 30000,
      stdio: capture ? 'pipe' : 'inherit',
    });
    return result || '';
  } catch (e) {
    return e.stdout || '';
  }
}

const commands = {
  health: {
    desc: 'System health check (all projects)',
    run: () => exec(`bash ${SCRIPTS}/project-health.sh all`),
  },
  hydra: {
    desc: 'Hydra v2 status — services + HTTP health',
    run: () => {
      exec('systemctl --user status hydra-dispatch hydra-watcher hydra-ambient 2>&1 | head -30');
      console.log('\n--- Hydra HTTP Health ---');
      const health = exec(
        `python3 -c "import urllib.request,json; r=urllib.request.urlopen('http://127.0.0.1:8742/health',timeout=5); print(json.dumps(json.loads(r.read()),indent=2))" 2>&1`,
        true
      );
      console.log(health.trim() || '(hydra-dispatch not responding on :8742)');
    },
  },
  deploy: {
    desc: 'Deploy project  [usage: apex deploy <project>]',
    run: (args) => {
      const project = args[0];
      if (!project) { console.log('Usage: apex deploy <project>'); return; }
      exec(`cd ${HOME}/Desktop/${project} && git push origin HEAD 2>&1`);
    },
  },
  ci: {
    desc: 'CI status for all repos',
    run: () => {
      console.log('\nCI Status — all repos\n');
      for (const r of REPOS) {
        const raw = exec(
          `gh run list --repo Nadav011/${r} --limit 1 --json conclusion --jq '.[0].conclusion // "pending"' 2>/dev/null`,
          true
        ).trim();
        const dot = raw === 'success' ? '●' : raw === 'failure' ? '●' : '○';
        const label = raw === 'success' ? 'OK' : raw === 'failure' ? 'FAIL' : raw || 'pending';
        console.log(`  ${dot} ${r.padEnd(22)} ${label}`);
      }
      console.log('');
    },
  },
  sync: {
    desc: 'Sync APEX config → MSI',
    run: () => exec(`bash ${SCRIPTS}/sync-settings-to-msi.sh`),
  },
  fix: {
    desc: 'Dispatch self-healing CI fix  [usage: apex fix <project>]',
    run: (args) => {
      const project = args[0];
      if (!project) { console.log('Usage: apex fix <project>'); return; }
      console.log(`Dispatching fix for ${project}…`);
      exec(`bash ${SCRIPTS}/ci-budget-check.sh`);
    },
  },
  skills: {
    desc: 'List all installed skills',
    run: () => {
      const count = exec(`find ${HOME}/.claude/skills/ -name 'SKILL.md' | wc -l`, true).trim();
      console.log(`\n${count} skills installed\n`);
      exec(`find ${HOME}/.claude/skills/ -name 'SKILL.md' -exec dirname {} \\; | xargs -n1 basename | sort | column`);
      console.log('');
    },
  },
  changelog: {
    desc: 'Generate weekly changelog',
    run: () => exec(`bash ${SCRIPTS}/weekly-changelog.sh`),
  },
  services: {
    desc: 'Show status of all APEX systemd services',
    run: () => {
      console.log('\nAPEX Services\n');
      for (const s of SERVICES) {
        const status = exec(
          `systemctl --user is-active ${s}.service 2>/dev/null || echo inactive`,
          true
        ).trim();
        const dot = status === 'active' ? '●' : '○';
        console.log(`  ${dot} ${s.padEnd(20)} ${status}`);
      }
      console.log('');
    },
  },
  dashboard: {
    desc: 'Open APEX dashboard',
    run: () => {
      const url = 'https://dashboard.nadavc.ai';
      exec(`xdg-open ${url} 2>/dev/null || true`);
      console.log(url);
    },
  },
  agents: {
    desc: 'Show agent health summary',
    run: () => exec(`bash ${SCRIPTS}/agent-health-monitor.sh 2>&1 | head -40`),
  },
  version: {
    desc: 'Show CLI version',
    run: () => console.log('apex v1.0.0'),
  },
  help: {
    desc: 'Show this help',
    run: () => showHelp(),
  },
};

function showHelp() {
  console.log('\nAPEX CLI v1.0.0 — Command Center for 18 Projects\n');
  console.log('Commands:\n');
  for (const [name, { desc }] of Object.entries(commands)) {
    console.log(`  apex ${name.padEnd(14)} ${desc}`);
  }
  console.log('\nhttps://dashboard.nadavc.ai\n');
}

// ─── Main ───────────────────────────────────────────────────────────────────
const [cmd, ...args] = process.argv.slice(2);

if (!cmd || cmd === '--help' || cmd === '-h') {
  showHelp();
  process.exit(0);
}

if (commands[cmd]) {
  commands[cmd].run(args);
} else {
  console.log(`\nUnknown command: "${cmd}"\nRun 'apex help' for available commands.\n`);
  process.exit(1);
}
