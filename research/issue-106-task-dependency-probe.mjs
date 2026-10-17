// Research model only. No product imports, harness, network, or process launches.
// report() inputs assume trusted identity, final-report authority, and task closure
// have already been checked by an adapter; those checks are outside this probe.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function validateDag(graph) {
  const visiting = new Set(), done = new Set();
  function visit(task) {
    assert(Object.hasOwn(graph, task), `Missing prerequisite: ${task}`);
    assert(!visiting.has(task), 'Cycle');
    if (done.has(task)) return;
    visiting.add(task);
    for (const dependency of graph[task]) visit(dependency);
    visiting.delete(task);
    done.add(task);
  }
  Object.keys(graph).forEach(visit);
}

function status(state, id) {
  const run = state.runs[id];
  if (run.outcome) return run.outcome;
  if (run.phase !== 'waiting') return run.phase;
  const dependencies = run.dependencies.map(d => d.runId ? status(state, d.runId) : 'unselected');
  if (dependencies.some(s => s === 'failed' || s === 'blocked')) return 'blocked';
  return dependencies.every(s => s === 'succeeded') ? 'ready' : 'waiting';
}

class Probe {
  constructor(path, graph) {
    this.path = path;
    this.db = new DatabaseSync(path);
    // shortcut: one JSON row keeps the research reducer small; production needs
    // versioned run/edge/event records and integration with its existing database.
    this.db.exec('CREATE TABLE IF NOT EXISTS model (id INTEGER PRIMARY KEY, state TEXT NOT NULL)');
    if (graph) {
      validateDag(graph);
      this.db.prepare('INSERT INTO model VALUES (1, ?)').run(JSON.stringify({graph, runs: {}, current: {}, events: {}}));
    }
  }
  read() { return JSON.parse(this.db.prepare('SELECT state FROM model WHERE id=1').get().state); }
  transaction(change) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state = this.read(), result = change(state);
      this.db.prepare('UPDATE model SET state=? WHERE id=1').run(JSON.stringify(state));
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  select(tasks) {
    return this.transaction(state => {
      for (const task of tasks) {
        assert(Object.hasOwn(state.graph, task));
        if (state.current[task]) continue;
        const id = `${task}/run-1`;
        state.current[task] = id;
        state.runs[id] = {task, phase: 'waiting', outcome: null, executionId: null, claims: 0,
          dependencies: state.graph[task].map(task => ({task, runId: null}))};
      }
      for (const run of Object.values(state.runs)) {
        for (const edge of run.dependencies) edge.runId ??= state.current[edge.task] ?? null;
      }
    });
  }
  view() {
    const state = this.read();
    return Object.fromEntries(Object.entries(state.current).map(([task, id]) => [task, status(state, id)]));
  }
  claim() {
    return this.transaction(state => {
      const claimed = [];
      for (const [id, run] of Object.entries(state.runs)) {
        if (status(state, id) !== 'ready') continue;
        run.phase = 'running';
        run.executionId = `${id}/exec-${++run.claims}`;
        claimed.push(run.task);
      }
      return claimed;
    });
  }
  event(task, eventId, outcome = 'succeeded') {
    const state = this.read(), runId = state.current[task];
    return {eventId, runId, executionId: state.runs[runId].executionId, outcome, evidence: 'SIMULATED evidence'};
  }
  report(event) {
    return this.transaction(state => {
      assert(['succeeded', 'failed'].includes(event.outcome));
      assert(event.eventId && event.evidence);
      const old = state.events[event.eventId];
      if (old) { assert.deepEqual(old, event, 'Event ID conflict'); return 'duplicate'; }
      const run = state.runs[event.runId];
      if (!run || !event.executionId || run.executionId !== event.executionId) return 'stale';
      if (run.outcome) return 'terminal-conflict';
      run.outcome = event.outcome;
      state.events[event.eventId] = event;
      return 'accepted';
    });
  }
  exit(task, exitCode) {
    this.transaction(state => {
      const run = state.runs[state.current[task]];
      assert(!run.outcome && run.executionId);
      run.exitCode = exitCode;
      run.phase = 'no_conclusion';
    });
  }
  retryInsideTask(task, stopVerified) {
    this.transaction(state => {
      const run = state.runs[state.current[task]];
      assert(stopVerified && !run.outcome && run.executionId, 'Retry requires verified stop and no final outcome');
      run.phase = 'running';
      run.executionId = `${state.current[task]}/exec-${++run.claims}`;
    });
  }
  restart() { this.db.close(); this.db = new DatabaseSync(this.path); }
  claims(task) { const s = this.read(); return s.runs[s.current[task]].claims; }
  close() { this.db.close(); }
}

let passed = 0;
function check(name, graph, run) {
  const directory = mkdtempSync(join(tmpdir(), 'issue-106-probe-'));
  let probe;
  try {
    probe = new Probe(join(directory, 'model.sqlite'), graph);
    run(probe);
    console.log(`PASS ${++passed}: ${name}`);
  } finally { probe?.close(); rmSync(directory, {recursive: true, force: true}); }
}

const graph = {A: [], B: ['A'], C: []};
console.log(`Node ${process.version}; standalone SQLite state model; no product runtime`);
check('A -> B 与独立 C：只在 A 显式成功后领取 B', graph, p => {
  p.select(['A', 'B', 'C']);
  assert.deepEqual(p.claim(), ['A', 'C']);
  assert.equal(p.view().B, 'waiting');
  p.report(p.event('A', 'A-success'));
  assert.deepEqual(p.claim(), ['B']);
});
check('未选前置不启动；后来明确选择 A 才绑定并执行', graph, p => {
  p.select(['B', 'C']);
  assert.deepEqual(p.claim(), ['C']);
  assert.equal(p.read().current.A, undefined);
  assert.equal(p.view().B, 'waiting');
  p.select(['A']);
  assert.deepEqual(p.claim(), ['A']);
  p.report(p.event('A', 'A-success'));
  assert.deepEqual(p.claim(), ['B']);
});
check('多前置 AND：A 与 C 都成功才放行 B', {A: [], B: ['A', 'C'], C: []}, p => {
  p.select(['A', 'B', 'C']); p.claim();
  p.report(p.event('A', 'A-success'));
  assert.equal(p.view().B, 'waiting');
  p.report(p.event('C', 'C-success'));
  assert.deepEqual(p.claim(), ['B']);
});
check('进程退出码 0，无业务结论，B 仍等待', graph, p => {
  p.select(['A', 'B', 'C']); p.claim(); p.exit('A', 0);
  assert.equal(p.view().A, 'no_conclusion');
  assert.equal(p.view().B, 'waiting');
  assert.deepEqual(p.claim(), []);
});
check('最终失败只阻塞 B 及其后代 D；独立 C 仍可领取', {...graph, D: ['B']}, p => {
  p.select(['A', 'B', 'D']); p.claim();
  p.report(p.event('A', 'A-failure', 'failed')); p.select(['C']);
  assert.deepEqual(p.view(), {A: 'failed', B: 'blocked', D: 'blocked', C: 'ready'});
  assert.deepEqual(p.claim(), ['C']);
});
check('任务内重试不是最终失败；旧 execution 迟到报告无效', graph, p => {
  p.select(['A', 'B']); p.claim();
  const old = p.event('A', 'late-success');
  p.exit('A', 7); p.retryInsideTask('A', true);
  assert.equal(p.report(old), 'stale');
  assert.equal(p.view().B, 'waiting');
  p.report(p.event('A', 'new-success'));
  assert.deepEqual(p.claim(), ['B']);
});
check('重复完成回同一结果；事件冲突/终态改写不能二次领取 B', graph, p => {
  p.select(['A', 'B']); p.claim();
  const event = p.event('A', 'success');
  assert.equal(p.report(event), 'accepted'); p.claim();
  assert.equal(p.report(event), 'duplicate');
  assert.throws(() => p.report({...event, outcome: 'failed'}), /Event ID conflict/);
  assert.equal(p.report({...event, eventId: 'contradiction', outcome: 'failed'}), 'terminal-conflict');
  assert.deepEqual(p.claim(), []); assert.equal(p.claims('B'), 1);
});
check('结论提交后、调度前重开数据库：重算 B 就绪，去重记录仍在', graph, p => {
  p.select(['A', 'B']); p.claim(); const event = p.event('A', 'durable-success');
  p.report(event); p.restart();
  assert.equal(p.view().B, 'ready');
  assert.equal(p.report(event), 'duplicate');
  assert.deepEqual(p.claim(), ['B']); p.restart();
  assert.deepEqual(p.claim(), []); assert.equal(p.claims('B'), 1);
});
check('无结论退出后重开数据库：不会补造成功', graph, p => {
  p.select(['A', 'B']); p.claim(); p.exit('A', 0); p.restart();
  assert.equal(p.view().A, 'no_conclusion');
  assert.equal(p.view().B, 'waiting'); assert.deepEqual(p.claim(), []);
});
assert.throws(() => validateDag({A: ['B'], B: ['A']}), /Cycle/);
assert.throws(() => validateDag({A: ['absent']}), /Missing prerequisite/);
console.log(`PASS ${++passed}: 环和不存在的前置引用被拒绝`);
console.log(`${passed}/${passed} passed. Database reopen is not crash/harness/exactly-once acceptance.`);
