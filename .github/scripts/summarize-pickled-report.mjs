#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';

const file = process.argv[2];

if (!file) {
  console.error('Usage: summarize-pickled-report.mjs <report.json>');
  process.exit(1);
}

if (!existsSync(file)) {
  console.log(`Pickled report not written: ${file}`);
  process.exit(0);
}

let report;
try {
  report = JSON.parse(readFileSync(file, 'utf8'));
} catch (error) {
  console.log(`Pickled report could not be parsed: ${String(error)}`);
  process.exit(0);
}

const kind = report.kind === 'builds' ? 'builds' : 'questions';
const summary = report.summary ?? {};
const threshold = typeof report.threshold === 'number' ? report.threshold : undefined;
const isPlan = Boolean(report.plan?.cells && !report.questions && !report.builds);
const gate = isPlan
  ? 'plan only'
  : threshold === undefined
    ? 'no threshold'
    : summary.errors > 0 || summary.score < threshold
      ? 'run fails'
      : 'run passes';

console.log(`Pickled ${kind} report`);
console.log(
  `Overall: ${summary.score ?? 0} / 100` + (threshold === undefined ? '' : `, threshold ${threshold}`) + `, ${gate}`,
);
console.log(
  `Cells: ${summary.total ?? 0} total, ${summary.yes ?? 0} yes, ${
    summary.partial ?? 0
  } partial, ${summary.no ?? 0} no, ${summary.errors ?? 0} errors`,
);

if (isPlan) {
  console.log(
    `Plan: ${report.plan.selectedCells} of ${report.plan.expandedCells} cells, ` +
      `${report.plan.selectedExecutions} executions`,
  );
  process.exit(0);
}

if (kind === 'questions') {
  for (const task of report.questions ?? []) {
    console.log(`\nQuestion: ${task.id}`);
    for (const cell of task.cells ?? []) {
      printQuestionCell(cell);
    }
  }
} else {
  for (const task of report.builds ?? []) {
    console.log(`\nBuild: ${task.id}`);
    for (const cell of task.cells ?? []) {
      printBuildCell(cell);
    }
  }
}

function printQuestionCell(cell) {
  const coord = formatCoord(cell);
  const rate = `${cell.passedTrials ?? 0}/${cell.totalTrials ?? 0}`;
  const coverage = typeof cell.meanCoverage === 'number' ? `, ${cell.meanCoverage}% facts` : '';
  console.log(`  [${coord}] ${cell.verdict ?? 'UNKNOWN'} ${rate}${coverage}`);

  if (cell.reason) console.log(`    reason: ${cell.reason}`);
  if (cell.error) console.log(`    error: ${cell.error}`);

  const tools = unique((cell.trials ?? []).flatMap((trial) => (Array.isArray(trial.toolsUsed) ? trial.toolsUsed : [])));
  if (tools.length > 0) console.log(`    tools: ${tools.join(', ')}`);

  const missed = unique(
    (cell.trials ?? []).flatMap((trial) => (Array.isArray(trial.factsMissed) ? trial.factsMissed : [])),
  );
  if (missed.length > 0) console.log(`    missing facts: ${missed.join(', ')}`);

  const misstatements = unique(
    (cell.trials ?? []).flatMap((trial) => (Array.isArray(trial.misstatementsHit) ? trial.misstatementsHit : [])),
  );
  if (misstatements.length > 0) {
    console.log(`    misstatements: ${misstatements.join(', ')}`);
  }

  if ((cell.trials ?? []).some((trial) => trial.status === 'scored' && trial.provenanceOk === false)) {
    console.log('    provenance: required tool path was not used');
  }
}

function printBuildCell(cell) {
  const coord = formatCoord(cell);
  const rate = `${cell.passedAttempts ?? 0}/${cell.totalAttempts ?? 0}`;
  const proof = cell.verifierProof ? `, verifierProof=${cell.verifierProof}` : '';
  console.log(`  [${coord}] ${cell.verdict ?? 'UNKNOWN'} ${rate}${proof}`);

  if (cell.reason) console.log(`    reason: ${cell.reason}`);
  if (cell.error) console.log(`    error: ${cell.error}`);

  for (const [index, attempt] of (cell.attempts ?? []).entries()) {
    const suffix = attempt.reason ? `, ${attempt.reason}` : '';
    console.log(`    attempt ${index + 1}: ${attempt.status}${suffix}`);

    const changedFiles = (attempt.changedFiles ?? []).map((file) => file.path ?? file.oldPath).filter(Boolean);
    if (changedFiles.length > 0) {
      console.log(`      changed: ${changedFiles.join(', ')}`);
    }

    const failedCommands = (attempt.commands ?? []).filter((command) => command.passed === false);
    for (const command of failedCommands) {
      const group = command.group ? ` (${command.group})` : '';
      const exit = typeof command.exitCode === 'number' ? `, exit ${command.exitCode}` : '';
      console.log(`      failed command: ${command.name}${group}${exit}`);
    }
  }
}

function formatCoord(cell) {
  const agent = cell.coord?.agent ?? cell.agent ?? 'unknown-agent';
  const context = cell.coord?.context ?? cell.context ?? 'unknown-context';
  return `${agent} / ${context}`;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
