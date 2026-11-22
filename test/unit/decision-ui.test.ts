import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createDecisionCard, shortcutAllowed, summary, SWITCH_GUARD_MS } from '../../ui/decision.js';

/** A tiny DOM: enough for the card, and it throws if anything sets innerHTML. */
class FakeEl {
  tag: string;
  children: FakeEl[] = [];
  className = '';
  hidden = false;
  title = '';
  placeholder = '';
  maxLength = 0;
  type = '';
  disabled = false;
  value = '';
  dataset: Record<string, string> = {};
  #text = '';
  listeners: Record<string, (() => void)[]> = {};
  classList = { toggle: (c: string, on?: boolean) => { const has = this.className.split(' ').includes(c); if (on ?? !has) { if (!has) this.className += ` ${c}`; } else this.className = this.className.split(' ').filter((x) => x !== c).join(' '); } };
  constructor(tag: string) {
    this.tag = tag.toLowerCase();
  }
  get textContent(): string {
    return this.#text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.#text = v;
    this.children = [];
  }
  set innerHTML(_v: string) {
    throw new Error('innerHTML used');
  }
  append(...nodes: (FakeEl | string)[]): void {
    for (const n of nodes) {
      if (typeof n === 'string') {
        const t = new FakeEl('#text');
        t.textContent = n;
        this.children.push(t);
      } else this.children.push(n);
    }
  }
  prepend(n: FakeEl): void {
    this.children.unshift(n);
  }
  replaceChildren(...nodes: FakeEl[]): void {
    this.#text = '';
    this.children = [];
    this.append(...nodes);
  }
  addEventListener(ev: string, fn: () => void): void {
    (this.listeners[ev] ??= []).push(fn);
  }
  click(): void {
    for (const fn of this.listeners.click ?? []) fn();
  }
  all(): FakeEl[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
  querySelectorAll(sel: string): FakeEl[] {
    return this.all().filter((e) => e.tag === sel);
  }
  querySelector(): null {
    return null;
  }
}

function withDom<T>(fn: () => T): T {
  const doc = { createElement: (t: string) => new FakeEl(t), addEventListener: () => {} };
  Object.assign(globalThis, { document: doc });
  try {
    return fn();
  } finally {
    Reflect.deleteProperty(globalThis, 'document');
  }
}

const evil = '<img src=x onerror=alert(1)>';
const base = { id: 'aaaa0001', name: 'x', cwd: '/w', createdAt: 0, workspace: { mode: 'inplace' }, paused: false, state: { status: 'needs_you', need: 'permission', since: 0 } };

test('cards render request text as text, never as HTML', () => {
  withDom(() => {
    const host = new FakeEl('section');
    const card = createDecisionCard(host as any, { onError: () => {}, focusTerminal: () => {} });
    const kinds = [
      { id: 'd1', kind: 'permission', tool: 'Bash', createdAt: 0, command: evil, description: evil, risk: { level: 'low', rule: evil }, canAlways: true },
      { id: 'd2', kind: 'question', tool: 'AskUserQuestion', createdAt: 0, questions: [{ question: evil, header: evil, multiSelect: false, options: [{ label: evil, description: evil }] }] },
      { id: 'd3', kind: 'plan', tool: 'ExitPlanMode', createdAt: 0, plan: evil },
    ];
    for (const d of kinds) {
      card.update({ ...base, id: d.id, decisions: [d] } as any);
      assert.equal(host.hidden, false);
      assert.ok(host.textContent.includes(evil), d.kind);
      assert.ok(!host.all().some((e) => e.tag === 'img'), d.kind);
    }
  });
});

test('high risk: Allow needs a second click, has no shortcut key and no "always"', () => {
  withDom(() => {
    const host = new FakeEl('section');
    const card = createDecisionCard(host as any, { onError: () => {}, focusTerminal: () => {} });
    card.update({ ...base, decisions: [{ id: 'd1', kind: 'permission', tool: 'Bash', createdAt: 0, command: 'rm -rf /', risk: { level: 'high', rule: 'Recursive delete' } }] } as any);
    const buttons = host.querySelectorAll('button');
    const allow = buttons.find((b) => b.textContent.startsWith('Allow'))!;
    assert.equal(allow.textContent, 'Allow…');
    assert.ok(buttons.every((b) => !b.dataset.key), 'no shortcut keys on a high-risk card');
    assert.ok(!buttons.some((b) => /Always/.test(b.textContent)));
    allow.click(); // first click only arms it
    assert.equal(allow.textContent, 'Confirm allow');
    assert.ok(host.textContent.includes('High risk · Recursive delete'));
  });
});

test('needs-you without a held request (after a restart) says: answer in the terminal', () => {
  withDom(() => {
    const host = new FakeEl('section');
    const card = createDecisionCard(host as any, { onError: () => {}, focusTerminal: () => {} });
    card.update(base as any);
    assert.equal(host.hidden, false);
    assert.match(host.textContent, /waiting for you in the terminal/);
    card.update({ ...base, state: { status: 'working', since: 0 } } as any);
    assert.equal(host.hidden, true);
  });
});

test('shortcuts never act on high risk, inside inputs or the terminal, or right after a switch', () => {
  const later = SWITCH_GUARD_MS + 1;
  assert.equal(shortcutAllowed({ target: null, risk: 'low', sinceSelect: later }), true);
  assert.equal(shortcutAllowed({ target: null, risk: 'high', sinceSelect: later }), false);
  assert.equal(shortcutAllowed({ target: null, risk: 'low', sinceSelect: SWITCH_GUARD_MS - 1 }), false);
  class HTMLElementFake {
    inside: boolean;
    isContentEditable = false;
    constructor(inside: boolean) {
      this.inside = inside;
    }
    closest() {
      return this.inside ? {} : null;
    }
  }
  Object.assign(globalThis, { HTMLElement: HTMLElementFake });
  try {
    assert.equal(shortcutAllowed({ target: new HTMLElementFake(true) as any, risk: 'low', sinceSelect: later }), false);
    assert.equal(shortcutAllowed({ target: new HTMLElementFake(false) as any, risk: 'low', sinceSelect: later }), true);
  } finally {
    Reflect.deleteProperty(globalThis, 'HTMLElement');
  }
});

test('row summaries name what Claude wants', () => {
  assert.equal(summary({ id: 'x', kind: 'permission', tool: 'Bash', createdAt: 0, command: 'npm test' }), 'Wants to run npm test');
  assert.equal(summary({ id: 'x', kind: 'permission', tool: 'Write', createdAt: 0, filePath: 'a.txt' }), 'Wants to write a.txt');
  assert.equal(summary({ id: 'x', kind: 'permission', tool: 'mcp__x', createdAt: 0 }), 'Wants to use mcp__x: mcp__x');
  assert.equal(summary({ id: 'x', kind: 'plan', tool: 'ExitPlanMode', createdAt: 0 }), 'Plan ready for approval');
  assert.equal(summary({ id: 'x', kind: 'question', tool: 'AskUserQuestion', createdAt: 0, questions: [{ question: 'Red?', header: '', multiSelect: false, options: [] }] }), 'Red?');
});

test('decision code never types into tmux', () => {
  const root = join(import.meta.dirname, '..', '..');
  for (const f of ['src/decisions.ts', 'ui/decision.js']) {
    const text = readFileSync(join(root, f), 'utf8');
    assert.ok(!/send-?keys|sendKeys|\/keys/i.test(text), `${f} must not send keys`);
  }
  assert.ok(readdirSync(join(root, 'src')).includes('decisions.ts'));
});
