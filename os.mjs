#!/usr/bin/env node
/**
 * PersonalOS — system of record for the Open Loops capture tool.
 * Zero dependencies. Node 18+.
 *
 * Commands:
 *   node os.mjs ingest [file...]     merge export(s) from inbox/ (or given paths) into data/store.json
 *   node os.mjs sync                 ingest + build + git commit + push in one go
 *   node os.mjs build                regenerate views/, graph/graph.json and dashboard.html from the store
 *   node os.mjs writeback [out]      produce an import-ready JSON for the capture tool (round-trip)
 *   node os.mjs status               one-screen summary of the store
 *   node os.mjs search <query>       quick full-text search across everything (live + archived)
 *   node os.mjs doctor               store integrity check (duplicate ids, broken links, bad dates)
 *   node os.mjs selftest             run the built-in contract tests (ids stable, version guard, merge)
 *
 * Builds are deterministic for a given store: generated files carry no volatile
 * timestamps, so rebuilding without new data produces zero git diff.
 *
 * ═══════════════════════════ THE CONTRACT ═══════════════════════════
 * 1. IDS ARE SACRED. Every record's `id` is an opaque stable string minted
 *    by the capture tool. This script NEVER generates, rewrites or reassigns
 *    an id. Writeback emits records with their ids verbatim — the tool's
 *    merge matches by id, so a regenerated id duplicates instead of updates.
 * 2. SCHEMA VERSION. Exports carry _meta.schemaVersion. We recognise only
 *    the versions in KNOWN_SCHEMA_VERSIONS and REFUSE anything else rather
 *    than guessing at field semantics.
 * 3. data/store.json is canonical. views/, graph/ and dashboard.html are
 *    generated artifacts — never hand-edit them.
 * ════════════════════════════════════════════════════════════════════
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const KNOWN_SCHEMA_VERSIONS = [4];
const STORE_VERSION = 1;

const PATHS = {
  store: path.join(ROOT, 'data', 'store.json'),
  inbox: path.join(ROOT, 'inbox'),
  exportArchive: path.join(ROOT, 'data', 'exports'),
  views: path.join(ROOT, 'views'),
  graph: path.join(ROOT, 'graph', 'graph.json'),
  template: path.join(ROOT, 'templates', 'dashboard.html'),
  dashboard: path.join(ROOT, 'dashboard.html'),
};

/* ───────────────────────── domain constants (mirror the tool) ───────────────────────── */
const DOMAINS = {
  work: 'Work', venture: 'Venture', speaking: 'Public speaking',
  writing: 'Writing', life: 'Life ops', money: 'Money', property: 'Property',
};
const TYPES = {
  followup: { label: 'Follow-up', staleDays: 7 },
  decision: { label: 'Decision', staleDays: 14 },
  idea: { label: 'Idea', staleDays: null },
  recurring: { label: 'Recurring', staleDays: null },
};
const GROC_CATS = {
  veg: 'Vegetables & fruit', meat: 'Meat & fish', dairy: 'Dairy & eggs',
  pantry: 'Grains & pantry', frozen: 'Frozen', house: 'Household',
};
const LIB_KINDS = { recipe: 'Recipe ideas', book: 'Books to read', link: 'Read / watch later' };
const EV_STAGES = {
  attend: ['Interested', 'Going', 'Attended'],
  organize: ['Idea', 'Planning', 'Scheduled', 'Done'],
};
const PIPE_STAGES = ['Prospect', 'Preview sent', 'Call', 'Client'];

// collections whose records carry a stable `id`
const ID_COLLECTIONS = ['items', 'goals', 'habits', 'wins', 'manifest', 'pipeline', 'grocery', 'library', 'events'];
const SCALARS = ['lastSweep', 'goalMonth', 'pendingGoalReset', 'lastExport', 'theme'];

/* ───────────────────────── small helpers ───────────────────────── */
const now = () => new Date().toISOString();
const DAY = 86400000;
const fail = (msg) => { const e = new Error(msg); e.isContractError = true; return e; };
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); };
const slug = (s) => String(s).toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'unnamed';
const escMd = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const ageDays = (iso) => Math.floor((Date.now() - new Date(iso).getTime()) / DAY);
const dueDays = (due) => {
  if (!due) return null;
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((new Date(due + 'T00:00:00') - t) / DAY);
};
const isStale = (it) => {
  const sd = TYPES[it.type]?.staleDays ?? null;
  return sd !== null && ageDays(it.created) > sd;
};

/* ───────────────────────── state normalisation (mirrors the tool) ───────────────────────── */
function normalizeItem(it) {
  return Object.assign({ note: '', nextStep: '', due: null, who: '', star: false, goalId: '', doneThisWeek: false, weekKey: '' }, it);
}
function normalizeLive(s) {
  s = s || {};
  return {
    items: (s.items || []).map(normalizeItem),
    log: s.log || [],
    goals: s.goals || [],
    goalHistory: s.goalHistory || [],
    habits: s.habits || [],
    journal: s.journal || {},
    wins: s.wins || [],
    manifest: s.manifest || [],
    pipeline: s.pipeline || [],
    grocery: s.grocery || [],
    library: s.library || [],
    events: s.events || [],
    lastSweep: s.lastSweep || null,
    goalMonth: s.goalMonth || '',
    pendingGoalReset: !!s.pendingGoalReset,
    lastExport: s.lastExport || null,
    theme: s.theme || 'dark',
  };
}
function emptyArchive() {
  const a = {};
  for (const k of ID_COLLECTIONS) a[k] = [];
  return a;
}
function newStore() {
  return {
    _meta: {
      app: 'personalos-store',
      storeVersion: STORE_VERSION,
      toolSchemaVersion: 4,
      created: now(),
      lastIngest: null,
    },
    live: normalizeLive({}),
    archive: emptyArchive(),
  };
}
function loadStore(storePath = PATHS.store) {
  if (!fs.existsSync(storePath)) return newStore();
  const s = readJson(storePath);
  if (s._meta?.app !== 'personalos-store') throw fail(`${storePath} is not a PersonalOS store — refusing to touch it.`);
  if (s._meta.storeVersion !== STORE_VERSION) throw fail(`Store version ${s._meta.storeVersion} is unknown (this script knows ${STORE_VERSION}). Refusing to guess.`);
  s.live = normalizeLive(s.live);
  s.archive = Object.assign(emptyArchive(), s.archive || {});
  return s;
}

/* ───────────────────────── export validation ───────────────────────── */
function assertValidExport(data, sourceName) {
  const m = data?._meta;
  if (!m || m.app !== 'open-loops') {
    throw fail(`${sourceName}: missing or foreign _meta envelope (expected _meta.app === "open-loops"). Refusing — this does not look like an Open Loops export.`);
  }
  if (!KNOWN_SCHEMA_VERSIONS.includes(m.schemaVersion)) {
    throw fail(`${sourceName}: _meta.schemaVersion is ${JSON.stringify(m.schemaVersion)}, but this script only recognises [${KNOWN_SCHEMA_VERSIONS.join(', ')}]. Refusing to guess at unknown field semantics — update os.mjs deliberately instead.`);
  }
  if (!Array.isArray(data.items)) throw fail(`${sourceName}: malformed export (items[] missing).`);
  for (const k of ID_COLLECTIONS) {
    for (const rec of data[k] || []) {
      if (!rec.id || typeof rec.id !== 'string') throw fail(`${sourceName}: a record in ${k}[] has no stable string id — refusing (the merge contract hangs on ids).`);
    }
  }
  return m;
}

/* ───────────────────────── ingest / merge ───────────────────────── */
/**
 * The export is the FULL live state of the device. Ingest therefore:
 *  - replaces each live collection with the export's records, ids verbatim;
 *  - moves records that disappeared (closed/dropped/deleted on the device)
 *    into store.archive with an archivedAt stamp — the OS remembers what
 *    the tool forgets;
 *  - resurrects archived records that reappear in a later export;
 *  - unions habit checks, merges journal days (export wins — the device is
 *    the source of truth for journaling), concats + dedupes log[].
 */
function mergeExport(store, data, meta, sourceName) {
  const exp = normalizeLive(data);
  const last = store._meta.lastIngest;
  if (last && meta.exported && meta.exported <= last.exported) {
    throw fail(`${sourceName}: exported ${meta.exported} is not newer than the last ingested export (${last.exported}). Refusing — ingesting an older export would archive newer records. Re-run with --force if you really mean it.`);
  }
  const prevHabits = new Map(store.live.habits.map((h) => [h.id, h]));
  const stamp = meta.exported || now();

  for (const k of ID_COLLECTIONS) {
    const nextIds = new Set(exp[k].map((r) => r.id));
    // archive what disappeared
    for (const rec of store.live[k]) {
      if (!nextIds.has(rec.id)) {
        store.archive[k] = store.archive[k].filter((a) => a.id !== rec.id);
        store.archive[k].push(Object.assign({}, rec, { archivedAt: stamp }));
      }
    }
    // resurrect what reappeared
    store.archive[k] = store.archive[k].filter((a) => !nextIds.has(a.id));
    // export wins, ids verbatim
    store.live[k] = exp[k];
  }
  // union habit checks with what we knew before (checks are append-only in the tool)
  for (const h of store.live.habits) {
    const prev = prevHabits.get(h.id);
    if (prev) h.checks = Object.assign({}, prev.checks, h.checks);
  }
  // journal: union of days, export (device) wins on conflicts
  store.live.journal = Object.assign({}, store.live.journal, exp.journal);
  // log: concat + dedupe + chronological
  const seen = new Set();
  store.live.log = store.live.log.concat(exp.log).filter((ev) => {
    const key = ev.t + '|' + ev.a + '|' + (ev.g || '');
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).sort((a, b) => new Date(a.t) - new Date(b.t));
  // goal history: dedupe by month, export wins
  const gh = new Map();
  for (const h of store.live.goalHistory.concat(exp.goalHistory)) gh.set(h.month, h);
  store.live.goalHistory = [...gh.values()].sort((a, b) => (a.month < b.month ? -1 : 1));
  // scalars follow the device
  for (const k of SCALARS) store.live[k] = exp[k];

  store._meta.lastIngest = { file: sourceName, exported: meta.exported || null, at: now() };
  return store;
}

function cmdIngest(args) {
  const force = args.includes('--force');
  let files = args.filter((a) => !a.startsWith('--'));
  if (!files.length) {
    files = fs.existsSync(PATHS.inbox)
      ? fs.readdirSync(PATHS.inbox).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(PATHS.inbox, f))
      : [];
  }
  if (!files.length) { console.log('Nothing to ingest — drop an Open Loops JSON export into inbox/ first.'); return; }

  const store = loadStore();
  for (const file of files) {
    const name = path.basename(file);
    const data = readJson(file);
    const meta = assertValidExport(data, name);
    if (force) store._meta.lastIngest = null; // bypass the staleness guard deliberately
    mergeExport(store, data, meta, name);
    // move the raw export into the permanent archive
    const stamp = (meta.exported || now()).replace(/[:]/g, '').slice(0, 15);
    const dest = path.join(PATHS.exportArchive, `${stamp}-${name}`);
    fs.mkdirSync(PATHS.exportArchive, { recursive: true });
    if (path.resolve(file) !== path.resolve(dest)) { fs.copyFileSync(file, dest); fs.rmSync(file); }
    console.log(`✓ ingested ${name} (exported ${meta.exported}) → archived as data/exports/${path.basename(dest)}`);
  }
  writeJson(PATHS.store, store);
  console.log(`✓ store updated: ${summaryLine(store)}`);
  cmdBuild();
}

/* ───────────────────────── writeback ───────────────────────── */
function buildWriteback(store) {
  // live state only, ids verbatim — the tool's import-merge matches by id
  return Object.assign(
    { _meta: { app: 'open-loops', schemaVersion: 4, exported: now(), source: 'personalos-writeback' } },
    store.live,
  );
}
function cmdWriteback(args) {
  const store = loadStore();
  const out = args[0] || path.join(ROOT, `writeback-${new Date().toISOString().slice(0, 10)}.json`);
  writeJson(out, buildWriteback(store));
  console.log(`✓ wrote ${out} — import it in the capture tool (choose MERGE). Ids are verbatim; the tool updates matching records.`);
}

/* ───────────────────────── knowledge graph ───────────────────────── */
const TAG_RE = /#([\p{L}\p{N}_-]+)/gu;
function extractTags(...texts) {
  const tags = new Set();
  for (const t of texts) {
    if (!t) continue;
    for (const m of String(t).matchAll(TAG_RE)) tags.add(m[1].toLowerCase());
  }
  return [...tags];
}

function buildGraph(store) {
  const nodes = new Map(); // id -> node
  const edges = [];
  const addNode = (id, type, label, extra = {}) => {
    if (!nodes.has(id)) nodes.set(id, Object.assign({ id, type, label }, extra));
    return nodes.get(id);
  };
  const addEdge = (source, target, rel) => {
    if (nodes.has(source) && nodes.has(target)) edges.push({ source, target, rel });
  };
  const personId = (who) => 'person:' + slug(who);
  const tagId = (t) => 'topic:' + t;
  const withArchive = (k) => store.live[k].map((r) => ({ ...r, _archived: false }))
    .concat(store.archive[k].map((r) => ({ ...r, _archived: true })));

  for (const [k, label] of Object.entries(DOMAINS)) addNode('domain:' + k, 'domain', label);

  for (const g of withArchive('goals')) {
    if (!g.yearly && !g.monthly && !g.weekly) continue;
    addNode('goal:' + g.id, 'goal', g.yearly || g.monthly || g.weekly, { archived: g._archived });
  }
  for (const it of withArchive('items')) {
    addNode('loop:' + it.id, 'loop', it.text, { archived: it._archived, domain: it.domain, itemType: it.type, star: !!it.star, due: it.due || null });
    addEdge('loop:' + it.id, 'domain:' + it.domain, 'in');
    if (it.goalId) addEdge('loop:' + it.id, 'goal:' + it.goalId, 'supports');
    if (it.who) {
      addNode(personId(it.who), 'person', it.who.trim());
      addEdge('loop:' + it.id, personId(it.who), 'waiting-on');
    }
    for (const t of extractTags(it.text, it.note, it.nextStep)) {
      addNode(tagId(t), 'topic', '#' + t);
      addEdge('loop:' + it.id, tagId(t), 'tagged');
    }
  }
  for (const h of withArchive('habits')) {
    addNode('habit:' + h.id, 'habit', h.name, { archived: h._archived });
    if (h.goalId) addEdge('habit:' + h.id, 'goal:' + h.goalId, 'supports');
    for (const t of extractTags(h.name)) { addNode(tagId(t), 'topic', '#' + t); addEdge('habit:' + h.id, tagId(t), 'tagged'); }
  }
  for (const p of withArchive('pipeline')) {
    addNode('pipeline:' + p.id, 'pipeline', p.name, { archived: p._archived, stage: PIPE_STAGES[p.stage] || p.stage });
    addEdge('pipeline:' + p.id, 'domain:venture', 'in');
  }
  for (const ev of withArchive('events')) {
    addNode('event:' + ev.id, 'event', ev.title, { archived: ev._archived, mode: ev.mode, date: ev.date || null, stage: (EV_STAGES[ev.mode] || [])[ev.stage] ?? ev.stage });
    for (const t of extractTags(ev.title, ev.note)) { addNode(tagId(t), 'topic', '#' + t); addEdge('event:' + ev.id, tagId(t), 'tagged'); }
  }
  for (const l of withArchive('library')) {
    addNode('library:' + l.id, 'library', l.title, { archived: l._archived, kind: l.kind, url: l.url || null, done: !!l.done });
    for (const t of extractTags(l.title, l.note)) { addNode(tagId(t), 'topic', '#' + t); addEdge('library:' + l.id, tagId(t), 'tagged'); }
  }
  for (const m of withArchive('manifest')) {
    addNode('manifest:' + m.id, 'manifest', m.text, { archived: m._archived, realized: m.realized || null });
    for (const t of extractTags(m.text, m.why)) { addNode(tagId(t), 'topic', '#' + t); addEdge('manifest:' + m.id, tagId(t), 'tagged'); }
  }
  for (const w of withArchive('wins')) {
    addNode('win:' + w.id, 'win', w.text, { archived: w._archived, t: w.t });
    for (const t of extractTags(w.text)) { addNode(tagId(t), 'topic', '#' + t); addEdge('win:' + w.id, tagId(t), 'tagged'); }
    // wins minted by the tool carry a recognisable prefix — link them to their source
    const link = (prefix, coll, field, type) => {
      if (!w.text.startsWith(prefix)) return false;
      const rest = w.text.slice(prefix.length);
      const src = withArchive(coll).find((r) => r[field] === rest);
      if (src) addEdge('win:' + w.id, type + ':' + src.id, 'celebrates');
      return true;
    };
    link('New client: ', 'pipeline', 'name', 'pipeline')
      || link('Realized: ', 'manifest', 'text', 'manifest')
      || link('Organized: ', 'events', 'title', 'event');
  }
  // people also appear as free text in notes once known — connect mentions
  const people = [...nodes.values()].filter((n) => n.type === 'person');
  for (const it of withArchive('items')) {
    for (const p of people) {
      if (p.label && p.label.length > 2 && (it.note || '').toLowerCase().includes(p.label.toLowerCase()) && (!it.who || slug(it.who) !== slug(p.label))) {
        addEdge('loop:' + it.id, p.id, 'mentions');
      }
    }
  }
  // drop unconnected empty domains
  const used = new Set(edges.flatMap((e) => [e.source, e.target]));
  for (const n of [...nodes.values()]) {
    if (n.type === 'domain' && !used.has(n.id)) nodes.delete(n.id);
  }
  // no volatile timestamp here: builds must be deterministic for a given store,
  // so rebuilds without data changes produce zero git diff
  return { asOf: store._meta.lastIngest?.exported ?? null, nodes: [...nodes.values()], edges };
}

/* ───────────────────────── markdown views ───────────────────────── */
const GEN_HEADER = (title) => `<!-- GENERATED by os.mjs — do not edit. Edit data/store.json (keep ids!) and run: node os.mjs build -->\n\n# ${title}\n\n`;

function mdLoops(store) {
  const files = {};
  for (const [k, label] of Object.entries(DOMAINS)) {
    const live = store.live.items.filter((i) => i.domain === k);
    const gone = store.archive.items.filter((i) => i.domain === k);
    if (!live.length && !gone.length) continue;
    let md = GEN_HEADER(`Loops — ${label}`);
    if (live.length) {
      md += `## Open (${live.length})\n\n`;
      for (const it of live.sort((a, b) => new Date(a.created) - new Date(b.created))) {
        const bits = [TYPES[it.type]?.label || it.type, `${ageDays(it.created)}d open`];
        if (isStale(it)) bits.push('**stale**');
        const dd = dueDays(it.due);
        if (dd !== null) bits.push(dd < 0 ? `**overdue ${-dd}d**` : `due in ${dd}d`);
        if (it.who) bits.push(`waiting on ${it.who}`);
        if (it.star) bits.push('★ priority');
        const goal = store.live.goals.find((g) => g.id === it.goalId);
        if (goal?.yearly) bits.push(`↳ ${goal.yearly}`);
        md += `- **${escMd(it.text)}** \`${it.id}\` — ${bits.join(' · ')}\n`;
        if (it.nextStep) md += `  - next: ${escMd(it.nextStep)}\n`;
        if (it.note) md += `  - note: ${escMd(it.note)}\n`;
      }
      md += '\n';
    }
    if (gone.length) {
      md += `## Closed / dropped (${gone.length})\n\n`;
      for (const it of gone.sort((a, b) => new Date(b.archivedAt) - new Date(a.archivedAt))) {
        md += `- ${escMd(it.text)} \`${it.id}\` — archived ${(it.archivedAt || '').slice(0, 10)}\n`;
      }
    }
    files[`loops/${k}.md`] = md;
  }
  return files;
}

function mdGoals(store) {
  let md = GEN_HEADER('Goals');
  const goals = store.live.goals.filter((g) => g.yearly || g.monthly || g.weekly);
  if (!goals.length) md += '_No goals set yet._\n';
  for (const g of goals) {
    md += `## ${escMd(g.yearly || '(untitled)')} \`${g.id}\`\n\n`;
    if (g.monthly) md += `- **This month:** ${escMd(g.monthly)}\n`;
    if (g.weekly) md += `- **This week:** ${escMd(g.weekly)}\n`;
    const loops = store.live.items.filter((i) => i.goalId === g.id);
    const habits = store.live.habits.filter((h) => h.goalId === g.id);
    const closed = store.archive.items.filter((i) => i.goalId === g.id);
    if (loops.length) md += `- **Open loops (${loops.length}):** ${loops.map((l) => escMd(l.text)).join(' · ')}\n`;
    if (habits.length) md += `- **Habits:** ${habits.map((h) => escMd(h.name)).join(' · ')}\n`;
    if (closed.length) md += `- **Cleared loops that supported this:** ${closed.length}\n`;
    md += '\n';
  }
  if (store.live.goalHistory.length) {
    md += '## Cascade history\n\n| Month | Yearly | Monthly | Weekly |\n|---|---|---|---|\n';
    for (const h of [...store.live.goalHistory].reverse()) {
      for (const g of h.goals) md += `| ${h.month} | ${escMd(g.yearly)} | ${escMd(g.monthly)} | ${escMd(g.weekly)} |\n`;
    }
  }
  return { 'goals.md': md };
}

function mdHabits(store) {
  let md = GEN_HEADER('Habits');
  if (!store.live.habits.length) md += '_No habits yet._\n';
  for (const h of store.live.habits) {
    const days = Object.keys(h.checks || {}).sort();
    const goal = store.live.goals.find((g) => g.id === h.goalId);
    md += `## ${escMd(h.name)} \`${h.id}\`\n\n`;
    md += `- Target: ${h.target || '—'}/week${goal?.yearly ? ` · supports **${escMd(goal.yearly)}**` : ''}\n`;
    md += `- Checks: ${days.length} total${days.length ? ` (${days[0]} → ${days[days.length - 1]})` : ''}\n\n`;
  }
  return { 'habits.md': md };
}

function mdJournal(store) {
  const files = {};
  const byMonth = {};
  for (const [day, e] of Object.entries(store.live.journal)) {
    if (!e || (!e.mood && !e.energy && !e.mind && !e.track)) continue;
    (byMonth[day.slice(0, 7)] ||= []).push([day, e]);
  }
  for (const [month, entries] of Object.entries(byMonth)) {
    let md = GEN_HEADER(`Journal — ${month}`);
    for (const [day, e] of entries.sort((a, b) => (a[0] < b[0] ? 1 : -1))) {
      md += `## ${day}\n\n`;
      const dial = [e.mood ? `mood ${e.mood}/5` : '', e.energy ? `energy ${e.energy}/5` : ''].filter(Boolean).join(' · ');
      if (dial) md += `_${dial}_\n\n`;
      if (e.mind) md += `**How I was:** ${e.mind}\n\n`;
      if (e.track) md += `**On track:** ${e.track}\n\n`;
    }
    files[`journal/${month}.md`] = md;
  }
  return files;
}

function mdSimpleLists(store) {
  const files = {};
  // wins
  let md = GEN_HEADER('Wins — the record');
  const wins = [...store.live.wins].sort((a, b) => new Date(b.t) - new Date(a.t));
  if (!wins.length) md += '_The record starts here._\n';
  for (const w of wins) md += `- **${escMd(w.text)}** — ${(w.t || '').slice(0, 10)} \`${w.id}\`\n`;
  files['wins.md'] = md;
  // manifest
  md = GEN_HEADER('Manifest');
  const active = store.live.manifest.filter((m) => !m.realized);
  const realized = store.live.manifest.filter((m) => m.realized);
  if (active.length) { md += '## Active\n\n'; for (const m of active) md += `- **${escMd(m.text)}**${m.why ? ` — because ${escMd(m.why)}` : ''} \`${m.id}\`\n`; md += '\n'; }
  if (realized.length) { md += '## Realized\n\n'; for (const m of realized) md += `- ${escMd(m.text)} — realized ${(m.realized || '').slice(0, 10)} \`${m.id}\`\n`; }
  if (!active.length && !realized.length) md += '_Nothing declared yet._\n';
  files['manifest.md'] = md;
  // pipeline
  md = GEN_HEADER('Venture pipeline');
  for (const [i, label] of PIPE_STAGES.entries()) {
    const list = store.live.pipeline.filter((p) => p.stage === i);
    if (!list.length) continue;
    md += `## ${label} (${list.length})\n\n`;
    for (const p of list) md += `- **${escMd(p.name)}** — ${ageDays(p.since)}d in stage \`${p.id}\`\n`;
    md += '\n';
  }
  if (store.archive.pipeline.length) {
    md += `## Removed\n\n`;
    for (const p of store.archive.pipeline) md += `- ${escMd(p.name)} — was at "${PIPE_STAGES[p.stage] ?? p.stage}", archived ${(p.archivedAt || '').slice(0, 10)}\n`;
  }
  if (!store.live.pipeline.length && !store.archive.pipeline.length) md += '_Empty pipeline._\n';
  files['pipeline.md'] = md;
  // events
  md = GEN_HEADER('Events');
  for (const [mode, label] of [['attend', 'To attend'], ['organize', 'To organize']]) {
    const list = store.live.events.filter((e) => e.mode === mode);
    if (!list.length) continue;
    md += `## ${label}\n\n`;
    for (const ev of list) {
      md += `- **${escMd(ev.title)}** — ${(EV_STAGES[mode] || [])[ev.stage] ?? ev.stage}${ev.date ? `, ${ev.date}` : ''}${ev.url ? `, ${ev.url}` : ''}${ev.note ? ` _(${escMd(ev.note)})_` : ''} \`${ev.id}\`\n`;
    }
    md += '\n';
  }
  if (!store.live.events.length) md += '_No events yet._\n';
  files['events.md'] = md;
  // library
  md = GEN_HEADER('Library');
  for (const [kind, label] of Object.entries(LIB_KINDS)) {
    const list = store.live.library.filter((l) => l.kind === kind);
    if (!list.length) continue;
    md += `## ${label}\n\n`;
    for (const l of list) md += `- ${l.done ? '~~' : '**'}${escMd(l.title)}${l.done ? '~~' : '**'}${l.url ? ` — ${l.url}` : ''}${l.note ? ` _(${escMd(l.note)})_` : ''} \`${l.id}\`\n`;
    md += '\n';
  }
  if (!store.live.library.length) md += '_Empty inbox._\n';
  files['library.md'] = md;
  return files;
}

function mdPeople(store, graph) {
  const files = {};
  const people = graph.nodes.filter((n) => n.type === 'person');
  if (!people.length) return files;
  let index = GEN_HEADER('People');
  for (const p of people.sort((a, b) => a.label.localeCompare(b.label))) {
    const connected = graph.edges.filter((e) => e.source === p.id || e.target === p.id)
      .map((e) => graph.nodes.find((n) => n.id === (e.source === p.id ? e.target : e.source)))
      .filter(Boolean);
    index += `## ${escMd(p.label)}\n\n`;
    for (const c of connected) index += `- ${c.type}: ${escMd(c.label)}${c.archived ? ' _(archived)_' : ''}\n`;
    index += '\n';
  }
  files['people.md'] = index;
  return files;
}

function mdOverview(store) {
  const L = store.live;
  const open = L.items.length;
  const stale = L.items.filter(isStale).length;
  const overdue = L.items.filter((i) => { const d = dueDays(i.due); return d !== null && d < 0; }).length;
  let md = GEN_HEADER('PersonalOS — overview');
  md += `_Data as of: ${store._meta.lastIngest ? `${store._meta.lastIngest.file} (exported ${store._meta.lastIngest.exported})` : 'nothing ingested yet'}_\n\n`;
  md += `| Open loops | Stale | Overdue | Wins | Habits | Journal days | Closed/dropped (archive) |\n|---|---|---|---|---|---|---|\n`;
  md += `| ${open} | ${stale} | ${overdue} | ${L.wins.length} | ${L.habits.length} | ${Object.keys(L.journal).length} | ${store.archive.items.length} |\n\n`;
  md += '## Open loops by domain\n\n';
  for (const [k, label] of Object.entries(DOMAINS)) {
    const n = L.items.filter((i) => i.domain === k).length;
    if (n) md += `- [${label}](loops/${k}.md): ${n}\n`;
  }
  md += '\n## Sections\n\n';
  md += ['[Goals](goals.md)', '[Habits](habits.md)', '[Wins](wins.md)', '[Manifest](manifest.md)', '[Pipeline](pipeline.md)', '[Events](events.md)', '[Library](library.md)', '[People](people.md)'].join(' · ') + '\n\n';
  const attention = L.items.filter((i) => { const d = dueDays(i.due); return i.star || isStale(i) || (d !== null && d <= 2); });
  if (attention.length) {
    md += '## Needs attention\n\n';
    for (const it of attention) {
      const d = dueDays(it.due);
      const why = d !== null && d < 0 ? `overdue ${-d}d` : d !== null && d <= 2 ? `due in ${d}d` : it.star ? 'priority' : 'stale';
      md += `- **${escMd(it.text)}** (${DOMAINS[it.domain]}) — ${why}\n`;
    }
  }
  return { 'README.md': md };
}

/* ───────────────────────── build ───────────────────────── */
function cmdBuild() {
  const store = loadStore();
  if (!fs.existsSync(PATHS.store)) writeJson(PATHS.store, store);
  const graph = buildGraph(store);
  // views/ is fully generated — wipe and rewrite
  fs.rmSync(PATHS.views, { recursive: true, force: true });
  const files = Object.assign(
    {}, mdOverview(store), mdLoops(store), mdGoals(store), mdHabits(store),
    mdJournal(store), mdSimpleLists(store), mdPeople(store, graph),
  );
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(PATHS.views, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  writeJson(PATHS.graph, graph);
  // dashboard: inject data into the template
  if (fs.existsSync(PATHS.template)) {
    const payload = { live: store.live, archive: store.archive, graph, lastIngest: store._meta.lastIngest };
    const html = fs.readFileSync(PATHS.template, 'utf8')
      .replace('/*__OS_DATA__*/null', () => JSON.stringify(payload).replace(/</g, '\\u003c'));
    fs.writeFileSync(PATHS.dashboard, html);
  }
  console.log(`✓ built ${Object.keys(files).length} views, graph (${graph.nodes.length} nodes, ${graph.edges.length} edges), dashboard.html`);
}

/* ───────────────────────── status & search ───────────────────────── */
function summaryLine(store) {
  const L = store.live;
  return `${L.items.length} open loops · ${L.wins.length} wins · ${Object.keys(L.journal).length} journal days · ${store.archive.items.length} archived loops`;
}
function cmdStatus() {
  const store = loadStore();
  console.log(`PersonalOS store — ${summaryLine(store)}`);
  console.log(`last ingest: ${store._meta.lastIngest ? `${store._meta.lastIngest.file} exported ${store._meta.lastIngest.exported}` : 'never'}`);
}

function* allDocs(store) {
  const A = (k) => store.live[k].map((r) => [r, false]).concat(store.archive[k].map((r) => [r, true]));
  for (const [r, arch] of A('items')) yield { kind: 'loop', id: r.id, title: r.text, body: [r.note, r.nextStep, r.who].join(' '), arch, extra: DOMAINS[r.domain] };
  for (const [r, arch] of A('goals')) yield { kind: 'goal', id: r.id, title: r.yearly, body: [r.monthly, r.weekly].join(' '), arch };
  for (const [r, arch] of A('habits')) yield { kind: 'habit', id: r.id, title: r.name, body: '', arch };
  for (const [r, arch] of A('wins')) yield { kind: 'win', id: r.id, title: r.text, body: '', arch, extra: (r.t || '').slice(0, 10) };
  for (const [r, arch] of A('manifest')) yield { kind: 'manifest', id: r.id, title: r.text, body: r.why || '', arch };
  for (const [r, arch] of A('pipeline')) yield { kind: 'pipeline', id: r.id, title: r.name, body: '', arch };
  for (const [r, arch] of A('library')) yield { kind: 'library', id: r.id, title: r.title, body: [r.url, r.note].join(' '), arch };
  for (const [r, arch] of A('events')) yield { kind: 'event', id: r.id, title: r.title, body: [r.url, r.note].join(' '), arch, extra: r.date || '' };
  for (const [r, arch] of A('grocery')) yield { kind: 'grocery', id: r.id, title: r.text, body: '', arch };
  for (const [day, e] of Object.entries(store.live.journal)) yield { kind: 'journal', id: day, title: day, body: [e.mind, e.track].join(' '), arch: false };
}
function cmdSearch(args) {
  const q = args.join(' ').toLowerCase().trim();
  if (!q) { console.log('usage: node os.mjs search <query>'); return; }
  const store = loadStore();
  const hits = [];
  for (const d of allDocs(store)) {
    const inTitle = (d.title || '').toLowerCase().includes(q);
    const inBody = (d.body || '').toLowerCase().includes(q);
    if (inTitle || inBody) hits.push({ ...d, score: (inTitle ? 3 : 0) + (inBody ? 1 : 0) });
  }
  hits.sort((a, b) => b.score - a.score);
  if (!hits.length) { console.log(`No matches for "${q}".`); return; }
  for (const h of hits.slice(0, 30)) {
    console.log(`[${h.kind}${h.arch ? '·archived' : ''}] ${h.title}${h.extra ? ` (${h.extra})` : ''}  id=${h.id}`);
  }
  if (hits.length > 30) console.log(`… and ${hits.length - 30} more. Open dashboard.html for full search.`);
}

/* ───────────────────────── doctor (store integrity) ───────────────────────── */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function analyzeStore(store) {
  const errors = [], warnings = [];
  const seen = new Map(); // id -> where first seen
  for (const k of ID_COLLECTIONS) {
    for (const scope of ['live', 'archive']) {
      for (const r of store[scope][k] || []) {
        if (!r.id || typeof r.id !== 'string') { errors.push(`${scope}.${k}: record without a string id (${JSON.stringify(r).slice(0, 60)}…)`); continue; }
        const where = `${scope}.${k}`;
        if (seen.has(r.id)) errors.push(`duplicate id "${r.id}" in ${where} and ${seen.get(r.id)} — a duplicated id corrupts every future merge`);
        else seen.set(r.id, where);
      }
    }
  }
  const goalIds = new Set([...store.live.goals, ...store.archive.goals].map((g) => g.id));
  for (const scope of ['live', 'archive']) {
    for (const k of ['items', 'habits']) {
      for (const r of store[scope][k]) {
        if (r.goalId && !goalIds.has(r.goalId)) warnings.push(`${scope}.${k} "${(r.text || r.name || '').slice(0, 40)}" references missing goal ${r.goalId}`);
      }
    }
  }
  for (const it of store.live.items) {
    if (!DOMAINS[it.domain]) warnings.push(`item ${it.id} has unknown domain "${it.domain}"`);
    if (!TYPES[it.type]) warnings.push(`item ${it.id} has unknown type "${it.type}"`);
    if (it.due && !DATE_RE.test(it.due)) errors.push(`item ${it.id} has malformed due date "${it.due}"`);
  }
  for (const day of Object.keys(store.live.journal)) if (!DATE_RE.test(day)) errors.push(`journal key "${day}" is not YYYY-MM-DD`);
  for (const h of store.live.habits) for (const day of Object.keys(h.checks || {})) if (!DATE_RE.test(day)) errors.push(`habit ${h.id} check key "${day}" is not YYYY-MM-DD`);
  return { errors, warnings };
}
function cmdDoctor() {
  const store = loadStore();
  const { errors, warnings } = analyzeStore(store);
  const leftovers = fs.existsSync(PATHS.inbox) ? fs.readdirSync(PATHS.inbox).filter((f) => f.endsWith('.json')) : [];
  if (leftovers.length) warnings.push(`inbox/ has ${leftovers.length} un-ingested export(s): ${leftovers.join(', ')} — run: node os.mjs ingest`);
  for (const e of errors) console.log(`✗ ${e}`);
  for (const w of warnings) console.log(`△ ${w}`);
  if (!errors.length && !warnings.length) console.log(`✓ store is healthy — ${summaryLine(store)}`);
  else console.log(`${errors.length} error(s), ${warnings.length} warning(s).`);
  if (errors.length) process.exit(1);
}

/* ───────────────────────── sync (ingest + build + commit + push) ───────────────────────── */
function cmdSync(args) {
  const sh = (cmd) => execSync(cmd, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const inboxFiles = fs.existsSync(PATHS.inbox) ? fs.readdirSync(PATHS.inbox).filter((f) => f.endsWith('.json')) : [];
  if (inboxFiles.length) cmdIngest(args.filter((a) => a.startsWith('--')));
  else cmdBuild();
  if (!sh('git status --porcelain')) { console.log('✓ nothing to commit — already in sync'); return; }
  sh('git add -A');
  const store = loadStore();
  execSync(`git commit -m ${JSON.stringify('sync: ' + summaryLine(store))}`, { cwd: ROOT, stdio: 'inherit' });
  const branch = sh('git rev-parse --abbrev-ref HEAD');
  for (let i = 0, wait = 2; ; i++, wait *= 2) {
    try { execSync(`git push -u origin ${branch}`, { cwd: ROOT, stdio: 'inherit' }); break; }
    catch (e) {
      if (i >= 4) throw fail('git push failed after 5 attempts — check your connection and push manually.');
      console.log(`push failed — retrying in ${wait}s…`);
      execSync(`sleep ${wait}`);
    }
  }
  console.log('✓ synced');
}
/* ───────────────────────── selftest ───────────────────────── */
function cmdSelftest() {
  let n = 0;
  const ok = (cond, msg) => { n++; if (!cond) throw new Error(`SELFTEST FAIL #${n}: ${msg}`); console.log(`  ✓ ${msg}`); };
  const exportA = {
    _meta: { app: 'open-loops', schemaVersion: 4, exported: '2026-07-01T10:00:00.000Z' },
    items: [
      { id: 'aaa11', text: 'Call the notary #property', domain: 'property', type: 'followup', created: '2026-06-20T09:00:00.000Z', who: 'Anna', goalId: 'g0001' },
      { id: 'bbb22', text: 'Decide on workshop pricing', domain: 'venture', type: 'decision', created: '2026-06-25T09:00:00.000Z' },
    ],
    log: [{ t: '2026-06-20T09:00:00.000Z', a: 'added', g: '' }],
    goals: [{ id: 'g0001', yearly: 'Buy the apartment', monthly: 'Financing sorted', weekly: 'Notary call' }],
    goalHistory: [], habits: [{ id: 'h0001', name: 'Morning pages', goalId: '', target: 5, checks: { '2026-06-30': true } }],
    journal: { '2026-06-30': { mood: 4, energy: 3, mind: 'fine', track: 'yes' } },
    wins: [], manifest: [], pipeline: [], grocery: [], library: [], events: [],
    lastSweep: null, goalMonth: '2026-07', pendingGoalReset: false, lastExport: '2026-07-01T10:00:00.000Z', theme: 'dark',
  };
  console.log('Contract selftest:');
  // 1. version guard
  for (const bad of [{ ...exportA, _meta: { app: 'open-loops', schemaVersion: 5 } }, { ...exportA, _meta: undefined }, { ...exportA, _meta: { app: 'other', schemaVersion: 4 } }]) {
    let threw = false;
    try { assertValidExport(bad, 'bad.json'); } catch (e) { threw = e.isContractError; }
    ok(threw, `refuses export with ${bad._meta ? `_meta ${JSON.stringify(bad._meta)}` : 'no _meta'}`);
  }
  ok(assertValidExport(exportA, 'a.json').schemaVersion === 4, 'accepts schemaVersion 4');
  // 2. ingest keeps ids verbatim
  let store = newStore();
  mergeExport(store, exportA, exportA._meta, 'a.json');
  ok(store.live.items.map((i) => i.id).join(',') === 'aaa11,bbb22', 'ids survive ingest verbatim');
  // 3. second export: bbb22 closed (gone), new item ccc33, aaa11 edited
  const exportB = JSON.parse(JSON.stringify(exportA));
  exportB._meta.exported = '2026-07-05T10:00:00.000Z';
  exportB.items = [
    { ...exportA.items[0], nextStep: 'Book Thursday slot' },
    { id: 'ccc33', text: 'Draft talk outline', domain: 'speaking', type: 'idea', created: '2026-07-03T09:00:00.000Z' },
  ];
  exportB.habits[0].checks = { '2026-07-02': true }; // device pruned nothing really, but test the union
  mergeExport(store, exportB, exportB._meta, 'b.json');
  ok(store.live.items.find((i) => i.id === 'aaa11')?.nextStep === 'Book Thursday slot', 'edited record updated in place (same id)');
  ok(store.live.items.some((i) => i.id === 'ccc33'), 'new record ingested');
  ok(!store.live.items.some((i) => i.id === 'bbb22') && store.archive.items.some((i) => i.id === 'bbb22' && i.archivedAt), 'disappeared record moved to archive, not lost');
  ok(store.live.habits[0].checks['2026-06-30'] && store.live.habits[0].checks['2026-07-02'], 'habit checks are unioned across ingests');
  // 4. stale export refused
  let threw = false;
  try { mergeExport(store, exportA, exportA._meta, 'a.json'); } catch (e) { threw = e.isContractError; }
  ok(threw, 'refuses to ingest an export older than the last one');
  // 5. writeback round-trip: ids verbatim, valid shape, passes its own validation
  const wb = buildWriteback(store);
  assertValidExport(wb, 'writeback');
  ok(wb.items.map((i) => i.id).join(',') === store.live.items.map((i) => i.id).join(','), 'writeback emits live ids verbatim');
  ok(wb._meta.schemaVersion === 4, 'writeback stamped schemaVersion 4');
  // 6. graph builds and links
  const graph = buildGraph(store);
  ok(graph.edges.some((e) => e.source === 'loop:aaa11' && e.target === 'goal:g0001' && e.rel === 'supports'), 'graph links loop → goal');
  ok(graph.nodes.some((nn) => nn.id === 'person:anna'), 'graph extracts people from who-fields');
  ok(graph.nodes.some((nn) => nn.id === 'topic:property'), 'graph extracts #tags as topics');
  ok(graph.nodes.some((nn) => nn.id === 'loop:bbb22' && nn.archived), 'archived records stay in the graph, flagged');
  // 7. doctor catches corruption
  ok(analyzeStore(store).errors.length === 0, 'doctor: healthy store has no errors');
  const sick = JSON.parse(JSON.stringify(store));
  sick.live.items.push({ ...sick.live.items[0] }); // duplicate id
  sick.live.items[0].due = '07/10/2026'; // malformed date
  sick.live.habits[0].goalId = 'g-gone'; // dangling goal link
  const diag = analyzeStore(sick);
  ok(diag.errors.some((e) => e.includes('duplicate id')), 'doctor: detects duplicate ids');
  ok(diag.errors.some((e) => e.includes('malformed due date')), 'doctor: detects malformed dates');
  ok(diag.warnings.some((w) => w.includes('missing goal')), 'doctor: flags dangling goal links');
  console.log(`All ${n} contract checks passed.`);
}

/* ───────────────────────── main ───────────────────────── */
const [, , cmd, ...args] = process.argv;
try {
  switch (cmd) {
    case 'ingest': cmdIngest(args); break;
    case 'build': cmdBuild(); break;
    case 'writeback': cmdWriteback(args); break;
    case 'status': cmdStatus(); break;
    case 'search': cmdSearch(args); break;
    case 'doctor': cmdDoctor(); break;
    case 'sync': cmdSync(args); break;
    case 'selftest': cmdSelftest(); break;
    default:
      console.log(`PersonalOS — usage: node os.mjs <command>

  ingest [file...]   merge export(s) from inbox/ (or given paths), archive raws, rebuild everything
  sync               ingest (if inbox has files) + build + git commit + push, in one go
  build              regenerate views/, graph/graph.json and dashboard.html from the store
  writeback [out]    produce import-ready JSON for the capture tool (choose MERGE when importing)
  status             one-line store summary
  search <query>     full-text search from the terminal, live + archived
  doctor             check store integrity (duplicate ids, broken goal links, malformed dates)
  selftest           run the data-contract tests (run after any change to os.mjs)`);
      process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
