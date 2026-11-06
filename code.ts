// Copy Node ID plugin: main thread code.
// Sends the current selection to the UI and handles UI messages.
// Runs in Figma's sandbox; the UI lives in ui.html (see manifest.json).

interface SelectedNode {
  id: string;
  name: string;
  type: string;
}

interface SelectionMessage {
  type: 'selection';
  fileKey: string | null;
  nodes: SelectedNode[];
}

interface Settings {
  send: boolean;
  token: string;
}

interface SettingsMessage {
  type: 'settings';
  settings: Settings;
}

// Compact dump payload (spec §4.1 `detail`), built only on request-detail.
interface DetailPayload {
  v: 1;
  tier: 'A' | 'B';
  depth: number;
  maxNodes: number;
  maxTextChars: number;
  include: CompactInclude[];
  roots: CompactEntry[];
  truncated: boolean;
  buildMs: number;
}

interface DetailMessage {
  type: 'detail';
  requestId: number;
  ids: string[];
  detail: DetailPayload;
}

interface DetailErrorMessage {
  type: 'detail-error';
  requestId: number;
  message: string;
}

type PluginMessage = SelectionMessage | SettingsMessage | DetailMessage | DetailErrorMessage;

type UIMessage =
  | { type: 'notify'; message: string }
  | { type: 'close' }
  | { type: 'save-settings'; settings: Settings }
  | { type: 'request-detail'; requestId: number };

const SETTINGS_KEY = 'settings';
const DEFAULT_SETTINGS: Settings = { send: false, token: '' };

// Settings must be exactly { send: boolean, token: string } with no extra keys.
function isSettings(value: unknown): value is Settings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes('send') || !keys.includes('token')) {
    return false;
  }
  return typeof record.send === 'boolean' && typeof record.token === 'string';
}

function isUIMessage(value: unknown): value is UIMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.type === 'close') {
    return true;
  }
  if (record.type === 'notify') {
    return typeof record.message === 'string';
  }
  if (record.type === 'save-settings') {
    return isSettings(record.settings);
  }
  if (record.type === 'request-detail') {
    return typeof record.requestId === 'number' && Number.isFinite(record.requestId);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Compact dump: pure tree compaction (PLUGIN_COMPACT_DUMP_SPEC.md §2-§3).
// compactTree never touches the `figma` global. The collector (a later stage)
// resolves names, variables and styles into plain RawNode data first.
// Declared as top-level functions (no `export`): code.js is a classic script,
// and tests reach compactTree as a property of the node:vm context.
// ---------------------------------------------------------------------------

type CompactInclude = 'geometry' | 'layout' | 'paint' | 'text' | 'instance' | 'hidden';

interface CompactOptions {
  depth: number;
  maxNodes: number;
  maxTextChars: number;
  include: CompactInclude[];
}

type PropValue = string | boolean;
type PropType = 'TEXT' | 'BOOLEAN' | 'VARIANT' | 'INSTANCE_SWAP';
type Sizing = 'FIXED' | 'HUG' | 'FILL';
type Align = 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN' | 'BASELINE';
// number = pixels; string = already-resolved token name such as "$space/400".
type Dim = number | string;

interface RawProp {
  name: string;
  type: PropType;
  value: PropValue;
  defaultValue: PropValue;
}

interface RawLayout {
  mode: 'HORIZONTAL' | 'VERTICAL' | 'GRID';
  gap?: Dim;
  counterGap?: Dim;
  wrap?: boolean;
  padding?: [Dim, Dim, Dim, Dim]; // top, right, bottom, left
  primaryAlign?: Align;
  counterAlign?: Align;
}

interface RawComponent {
  // Component set name when the main component is a variant, else the main component name.
  name: string;
  variants?: Record<string, string>;
  props?: RawProp[];
  overrideText?: Record<string, string>;
  overrideInstances?: Record<string, string>;
}

// Plain input node. Paints, radius, effects and text styles are already resolved to strings.
// `children` undefined means the collector did not read them; `childCount` is the fallback count.
interface RawNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  characters?: string;
  width?: number;
  height?: number;
  layout?: RawLayout; // absent = layoutMode NONE
  sizingH?: Sizing;
  sizingV?: Sizing;
  absolute?: boolean;
  fills?: string;
  strokes?: string;
  radius?: Dim;
  opacity?: number;
  effects?: string;
  textStyle?: string;
  component?: RawComponent;
  children?: RawNode[];
  childCount?: number;
}

interface CompactRecord {
  id?: string;
  n?: string;
  t: string;
  w?: number;
  h?: number;
  L?: string;
  sz?: string;
  abs?: 1;
  f?: string;
  s?: string;
  r?: Dim;
  o?: number;
  e?: string;
  ts?: string;
  tx?: string;
  c?: string;
  v?: string;
  p?: Record<string, PropValue>;
  ot?: Record<string, string>;
  oi?: Record<string, string>;
  cn?: number;
  hid?: 1;
  ch?: CompactEntry[];
}

// Folded run of >= 3 identical siblings. items: [instanceId, ...texts] per instance.
interface CompactGroup {
  x: number;
  tpl: CompactRecord;
  items?: string[][];
}

// A string entry is an explicit truncation marker such as "…+12 nodes".
type CompactEntry = CompactRecord | CompactGroup | string;

interface CompactResult {
  roots: CompactEntry[];
  budgetUsed: number;
  truncated: boolean;
}

const COMPACT_MAX_ROOTS = 100;
const COMPACT_FOLD_MIN = 3;
const COMPACT_DEFAULTS: CompactOptions = {
  depth: 2,
  maxNodes: 60,
  maxTextChars: 60,
  include: ['geometry', 'layout', 'paint', 'text', 'instance'],
};
const COMPACT_ALIGN: Record<Align, string> = {
  MIN: 'S',
  CENTER: 'C',
  MAX: 'E',
  SPACE_BETWEEN: 'SB',
  BASELINE: 'B',
};
const COMPACT_SIZING: Record<Sizing, string> = { FIXED: 'fixed', HUG: 'hug', FILL: 'fill' };

// 'node' = a real record (has id, tx, ot). 'template' = a folded group's tpl (no id, tx, ot).
// 'signature' = folding key (no id, tx, ot, text-typed prop values; names normalized).
type CompactMode = 'node' | 'template' | 'signature';

interface CompactContext {
  opts: CompactOptions;
  signatures: Map<RawNode, string>;
}

// A pending expansion of one emitted record's children, consumed BFS-level by level.
interface CompactTask {
  record: CompactRecord;
  node: RawNode;
  childDepth: number;
  units: CompactUnit[];
  next: number;
}

type CompactUnit =
  | { kind: 'record'; node: RawNode; cost: number }
  | { kind: 'group'; members: RawNode[]; tpl: CompactRecord; cost: number };

function compactClampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function normalizeCompactOptions(options: Partial<CompactOptions>): CompactOptions {
  return {
    depth: compactClampInt(options.depth, 0, 6, COMPACT_DEFAULTS.depth),
    maxNodes: compactClampInt(options.maxNodes, 1, 300, COMPACT_DEFAULTS.maxNodes),
    maxTextChars: compactClampInt(options.maxTextChars, 0, 200, COMPACT_DEFAULTS.maxTextChars),
    include: Array.isArray(options.include) ? options.include.slice() : COMPACT_DEFAULTS.include.slice(),
  };
}

function compactHas(ctx: CompactContext, part: CompactInclude): boolean {
  return ctx.opts.include.includes(part);
}

function isCompactShown(ctx: CompactContext, node: RawNode): boolean {
  return node.visible !== false || compactHas(ctx, 'hidden');
}

function shownChildren(ctx: CompactContext, node: RawNode): RawNode[] {
  return (node.children ?? []).filter((child) => isCompactShown(ctx, child));
}

function visibleChildCount(ctx: CompactContext, node: RawNode): number {
  return node.children !== undefined ? shownChildren(ctx, node).length : (node.childCount ?? 0);
}

// Instances never expand their children by default (§2.4 rule 3).
function canExpandCompact(ctx: CompactContext, node: RawNode, depth: number): boolean {
  return depth < ctx.opts.depth && node.type !== 'INSTANCE' && shownChildren(ctx, node).length > 0;
}

function subtreeSize(ctx: CompactContext, node: RawNode): number {
  return shownChildren(ctx, node).reduce((sum, child) => sum + subtreeSize(ctx, child), 1);
}

function isZeroDim(value: Dim | undefined): boolean {
  return value === undefined || value === 0 || value === '0';
}

function normalizeCompactName(name: string): string {
  return name.replace(/\d+$/, '#');
}

function truncateCompactText(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) {
    return text;
  }
  return `${chars.slice(0, max).join('')}…(+${chars.length - max})`;
}

// §2.2 padding shorthand: all four equal -> "p16"; vertical/horizontal -> "p0,16"; else "p0,80,80,80".
function formatCompactPadding(padding: [Dim, Dim, Dim, Dim]): string | undefined {
  const [top, right, bottom, left] = padding;
  if (isZeroDim(top) && isZeroDim(right) && isZeroDim(bottom) && isZeroDim(left)) {
    return undefined;
  }
  const t = String(top);
  const r = String(right);
  const b = String(bottom);
  const l = String(left);
  if (t === r && r === b && b === l) {
    return t;
  }
  if (t === b && r === l) {
    return `${t},${r}`;
  }
  return `${t},${r},${b},${l}`;
}

// §2.2 layout grammar: <H|V|G> [g<gap>] [p<padding>] [a<primary>,<counter>] [wrap] [cg<counterGap>].
function formatCompactLayout(layout: RawLayout): string {
  const parts: string[] = [layout.mode === 'HORIZONTAL' ? 'H' : layout.mode === 'VERTICAL' ? 'V' : 'G'];
  if (!isZeroDim(layout.gap)) {
    parts.push(`g${String(layout.gap)}`);
  }
  const padding = layout.padding ? formatCompactPadding(layout.padding) : undefined;
  if (padding !== undefined) {
    parts.push(`p${padding}`);
  }
  const primary = layout.primaryAlign ?? 'MIN';
  const counter = layout.counterAlign ?? 'MIN';
  if (primary !== 'MIN' || counter !== 'MIN') {
    parts.push(`a${COMPACT_ALIGN[primary]},${COMPACT_ALIGN[counter]}`);
  }
  if (layout.wrap) {
    parts.push('wrap');
  }
  if (!isZeroDim(layout.counterGap)) {
    parts.push(`cg${String(layout.counterGap)}`);
  }
  return parts.join(' ');
}

// Props whose value equals the default are dropped (§2.4 rule 1).
function compactChangedProps(props: RawProp[] | undefined, mode: CompactMode): Record<string, PropValue> | undefined {
  if (props === undefined) {
    return undefined;
  }
  const changed: Record<string, PropValue> = {};
  let any = false;
  for (const prop of props) {
    if (prop.value === prop.defaultValue) {
      continue;
    }
    if (mode === 'signature' && prop.type === 'TEXT') {
      continue;
    }
    changed[prop.name] = prop.value;
    any = true;
  }
  return any ? changed : undefined;
}

// Builds the record fields for one node, applying the §2.4 omission defaults.
function compactFields(node: RawNode, ctx: CompactContext, mode: CompactMode): CompactRecord {
  const rec: CompactRecord = { t: node.type };

  // TEXT whose name equals its characters omits n (§2.1).
  const omitName = node.type === 'TEXT' && node.name === node.characters;
  if (!omitName) {
    rec.n = mode === 'node' ? node.name : normalizeCompactName(node.name);
  }

  if (compactHas(ctx, 'geometry')) {
    if (node.width !== undefined) {
      rec.w = Math.round(node.width);
    }
    if (node.height !== undefined) {
      rec.h = Math.round(node.height);
    }
  }

  if (compactHas(ctx, 'layout')) {
    if (node.layout !== undefined) {
      rec.L = formatCompactLayout(node.layout);
    }
    const sizing = `${COMPACT_SIZING[node.sizingH ?? 'FIXED']},${COMPACT_SIZING[node.sizingV ?? 'FIXED']}`;
    if (sizing !== 'fixed,fixed') {
      rec.sz = sizing;
    }
    if (node.absolute === true) {
      rec.abs = 1;
    }
  }

  if (compactHas(ctx, 'paint')) {
    if (node.fills) {
      rec.f = node.fills;
    }
    if (node.strokes) {
      rec.s = node.strokes;
    }
    if (!isZeroDim(node.radius)) {
      rec.r = node.radius;
    }
    if (node.opacity !== undefined) {
      const opacity = Math.round(node.opacity * 100) / 100;
      if (opacity !== 1) {
        rec.o = opacity;
      }
    }
    if (node.effects) {
      rec.e = node.effects;
    }
  }

  if (compactHas(ctx, 'text')) {
    if (node.textStyle) {
      rec.ts = node.textStyle;
    }
    if (mode === 'node' && node.characters !== undefined && node.characters !== '') {
      rec.tx = truncateCompactText(node.characters, ctx.opts.maxTextChars);
    }
  }

  if (compactHas(ctx, 'instance') && node.component !== undefined) {
    const component = node.component;
    rec.c = component.name;
    if (component.variants !== undefined) {
      const variant = Object.entries(component.variants)
        .map(([key, value]) => `${key}=${value}`)
        .join(', ');
      if (variant !== '') {
        rec.v = variant;
      }
    }
    const props = compactChangedProps(component.props, mode);
    if (props !== undefined) {
      rec.p = props;
    }
    if (mode === 'node' && component.overrideText !== undefined && Object.keys(component.overrideText).length > 0) {
      rec.ot = component.overrideText;
    }
    if (component.overrideInstances !== undefined && Object.keys(component.overrideInstances).length > 0) {
      rec.oi = component.overrideInstances;
    }
  }

  if (node.visible === false) {
    rec.hid = 1;
  }
  return rec;
}

// Folding key for a node: its fields plus its shown children's keys, independent of depth.
function compactSignature(ctx: CompactContext, node: RawNode): string {
  const cached = ctx.signatures.get(node);
  if (cached !== undefined) {
    return cached;
  }
  const childKeys = shownChildren(ctx, node).map((child) => compactSignature(ctx, child));
  const key = JSON.stringify([compactFields(node, ctx, 'signature'), visibleChildCount(ctx, node), childKeys]);
  ctx.signatures.set(node, key);
  return key;
}

function compactTemplateCost(rec: CompactRecord): number {
  return (rec.ch ?? []).reduce((sum, entry) => sum + compactEntryCost(entry), 1);
}

// Budget cost: a record costs 1; a group costs 1 + the records of its template (§3).
function compactEntryCost(entry: CompactEntry): number {
  if (typeof entry === 'string') {
    return 0;
  }
  if (isCompactGroup(entry)) {
    return 1 + compactTemplateCost(entry.tpl);
  }
  return compactTemplateCost(entry);
}

function isCompactGroup(entry: CompactEntry): entry is CompactGroup {
  return typeof entry !== 'string' && 'x' in entry;
}

// Template record for a folded run: same fields as the first member, no id/tx/ot.
function compactTemplate(ctx: CompactContext, node: RawNode, depth: number): CompactRecord {
  const rec = compactFields(node, ctx, 'template');
  if (canExpandCompact(ctx, node, depth)) {
    rec.ch = compactUnits(ctx, shownChildren(ctx, node), depth + 1).map((unit): CompactEntry => {
      if (unit.kind === 'group') {
        return { x: unit.members.length, tpl: unit.tpl };
      }
      return compactTemplate(ctx, unit.node, depth + 1);
    });
  } else if (visibleChildCount(ctx, node) > 0) {
    rec.cn = visibleChildCount(ctx, node);
  }
  return rec;
}

// Splits sibling nodes into single records and folded groups (runs of >= COMPACT_FOLD_MIN).
function compactUnits(ctx: CompactContext, children: RawNode[], childDepth: number): CompactUnit[] {
  const units: CompactUnit[] = [];
  let start = 0;
  while (start < children.length) {
    const key = compactSignature(ctx, children[start]);
    let end = start + 1;
    while (end < children.length && compactSignature(ctx, children[end]) === key) {
      end++;
    }
    const run = children.slice(start, end);
    if (run.length >= COMPACT_FOLD_MIN) {
      const tpl = compactTemplate(ctx, run[0], childDepth);
      units.push({ kind: 'group', members: run, tpl, cost: 1 + compactTemplateCost(tpl) });
    } else {
      for (const node of run) {
        units.push({ kind: 'record', node, cost: 1 });
      }
    }
    start = end;
  }
  return units;
}

function collectCompactTexts(ctx: CompactContext, node: RawNode, out: string[]): void {
  if (node.type === 'TEXT' && node.characters !== undefined) {
    out.push(truncateCompactText(node.characters, ctx.opts.maxTextChars));
  }
  for (const child of shownChildren(ctx, node)) {
    collectCompactTexts(ctx, child, out);
  }
}

// Record for a node that is emitted into the output (not a template).
function compactNodeRecord(ctx: CompactContext, node: RawNode, depth: number): CompactRecord {
  const rec: CompactRecord = { id: node.id, ...compactFields(node, ctx, 'node') };
  const count = visibleChildCount(ctx, node);
  if (!canExpandCompact(ctx, node, depth) && count > 0) {
    rec.cn = count;
  }
  return rec;
}

function compactTaskFor(ctx: CompactContext, node: RawNode, record: CompactRecord, depth: number): CompactTask | undefined {
  if (!canExpandCompact(ctx, node, depth)) {
    return undefined;
  }
  return {
    record,
    node,
    childDepth: depth + 1,
    units: compactUnits(ctx, shownChildren(ctx, node), depth + 1),
    next: 0,
  };
}

function appendCompactEntry(record: CompactRecord, entry: CompactEntry): void {
  if (record.ch === undefined) {
    record.ch = [];
  }
  record.ch.push(entry);
}

// Pure compaction of raw selection data into compact entries (see spec §2.4, §3).
// Rules: hidden nodes are skipped unless include has 'hidden'; roots are always emitted
// (up to 100) and count toward maxNodes; the rest of the budget is spent BFS-level by
// level, round-robin across parents; any cut is marked explicitly ("…+N nodes", "…+N roots").
function compactTree(roots: readonly RawNode[], options: Partial<CompactOptions> = {}): CompactResult {
  const ctx: CompactContext = { opts: normalizeCompactOptions(options), signatures: new Map() };
  const shown = roots.filter((node) => isCompactShown(ctx, node));
  const kept = shown.slice(0, COMPACT_MAX_ROOTS);
  const out: CompactEntry[] = [];
  let budget = Math.max(0, ctx.opts.maxNodes - kept.length);
  let used = kept.length;
  let truncated = false;

  let level: CompactTask[] = [];
  for (const node of kept) {
    const record = compactNodeRecord(ctx, node, 0);
    out.push(record);
    const task = compactTaskFor(ctx, node, record, 0);
    if (task !== undefined) {
      level.push(task);
    }
  }

  while (level.length > 0) {
    const nextLevel: CompactTask[] = [];
    let progress = true;
    while (progress) {
      progress = false;
      for (const task of level) {
        if (task.next >= task.units.length) {
          continue;
        }
        const unit = task.units[task.next];
        if (unit.cost > budget) {
          continue; // this parent's remaining children are cut below
        }
        budget -= unit.cost;
        used += unit.cost;
        task.next++;
        progress = true;
        if (unit.kind === 'group') {
          appendCompactEntry(task.record, {
            x: unit.members.length,
            tpl: unit.tpl,
            items: unit.members.map((member) => {
              const texts: string[] = [];
              if (compactHas(ctx, 'text')) {
                collectCompactTexts(ctx, member, texts);
              }
              return [member.id, ...texts];
            }),
          });
        } else {
          const record = compactNodeRecord(ctx, unit.node, task.childDepth);
          appendCompactEntry(task.record, record);
          const child = compactTaskFor(ctx, unit.node, record, task.childDepth);
          if (child !== undefined) {
            nextLevel.push(child);
          }
        }
      }
    }
    for (const task of level) {
      if (task.next < task.units.length) {
        const dropped = task.units
          .slice(task.next)
          .reduce((sum, unit) => sum + (unit.kind === 'group'
            ? unit.members.reduce((inner, member) => inner + subtreeSize(ctx, member), 0)
            : subtreeSize(ctx, unit.node)), 0);
        task.record.cn = visibleChildCount(ctx, task.node);
        appendCompactEntry(task.record, `…+${dropped} nodes`);
        truncated = true;
      }
    }
    level = nextLevel;
  }

  if (shown.length > COMPACT_MAX_ROOTS) {
    out.push(`…+${shown.length - COMPACT_MAX_ROOTS} roots`);
    truncated = true;
  }
  return { roots: out, budgetUsed: used, truncated };
}

// ---------------------------------------------------------------------------
// Compact dump: collector (spec §6). Reads real Figma nodes into the RawNode data
// that compactTree consumes. Variable, style and instance-swap names are resolved
// here through the async dynamic-page API. Name lookups are cached as promises
// (parallel lookups share one request), capped at NAME_CACHE_LIMIT entries.
// Reads are BFS: each parent's children are read in batches of DETAIL_BATCH, and
// the visit cap and the time box are checked between batches. A cut leaves the
// parent unexpanded (its count stays in `cn`) and is reported as a root marker.
// ---------------------------------------------------------------------------

const DETAIL_TIMEBOX_MS = 150;
const DETAIL_BATCH = 25;
const DETAIL_VISIT_CAP_FACTOR = 4; // visitCap = maxNodes × 4 (spec §3)
const DETAIL_TIER_B_NODES = 300; // tier B when the captured tree has at most this many nodes
const DETAIL_OVERRIDE_LIMIT = 200;
const DETAIL_TEXT_CHARS = 200;
const NAME_CACHE_LIMIT = 2000;
const DETAIL_INCLUDE: CompactInclude[] = ['geometry', 'layout', 'paint', 'text', 'instance'];
const DETAIL_TIER_A: CompactOptions = { depth: 2, maxNodes: 60, maxTextChars: 60, include: DETAIL_INCLUDE };
const DETAIL_TIER_B: CompactOptions = { depth: 6, maxNodes: 300, maxTextChars: 120, include: DETAIL_INCLUDE };
const ALIGN_VALUES: readonly string[] = ['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN', 'BASELINE'];
const SIZING_VALUES: readonly string[] = ['FIXED', 'HUG', 'FILL'];
const CORNER_FIELDS = ['topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius'];
const COMPONENT_ID_SUFFIX = /#\d+:\d+$/;
const ITALIC_SUFFIX = /\s+italic$/i;
const FONT_WEIGHTS: Record<string, number> = {
  thin: 100,
  'extra light': 200,
  extralight: 200,
  ultralight: 200,
  light: 300,
  regular: 400,
  normal: 400,
  medium: 500,
  'semi bold': 600,
  semibold: 600,
  demibold: 600,
  bold: 700,
  'extra bold': 800,
  extrabold: 800,
  ultrabold: 800,
  black: 900,
  heavy: 900,
};

type Bag = Record<string, unknown>;
type NameCache = Map<string, Promise<string | null>>;

const variableNames: NameCache = new Map();
const styleNames: NameCache = new Map();
const nodeNames: NameCache = new Map();

interface CollectState {
  startedAt: number;
  visitCap: number;
  visited: number;
  stopped?: 'timeout' | 'visitCap';
  include: CompactInclude[];
}

// A read node whose children still have to be read (BFS queue entry).
interface Expansion {
  raw: RawNode;
  node: SceneNode;
  depth: number;
}

interface OverrideReading {
  kind: 'text' | 'instance';
  path: string;
  value: string;
}

interface TextReading {
  textStyle?: string;
  fills?: string;
}

function bagOf(node: object): Bag {
  return node as unknown as Bag;
}

function numberOf(bag: Bag, key: string): number | undefined {
  const value = bag[key];
  return typeof value === 'number' ? value : undefined;
}

function stringOf(bag: Bag, key: string): string | undefined {
  const value = bag[key];
  return typeof value === 'string' ? value : undefined;
}

function aliasIdOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const alias = value as Bag;
  return alias.type === 'VARIABLE_ALIAS' && typeof alias.id === 'string' ? alias.id : undefined;
}

// Id of the variable bound to `field` of `holder` (a node or a paint), if any.
function boundIdOf(holder: unknown, field: string): string | undefined {
  if (typeof holder !== 'object' || holder === null) {
    return undefined;
  }
  const bound = (holder as Bag).boundVariables;
  if (typeof bound !== 'object' || bound === null) {
    return undefined;
  }
  return aliasIdOf((bound as Bag)[field]);
}

function errorText(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const message = (error as Bag).message;
    if (typeof message === 'string') {
      return message;
    }
  }
  return String(error);
}

function isDetailShown(node: SceneNode, include: CompactInclude[]): boolean {
  return node.visible !== false || include.includes('hidden');
}

function childNodesOf(node: SceneNode, include: CompactInclude[]): SceneNode[] {
  if (!('children' in node)) {
    return [];
  }
  return node.children.filter((child) => isDetailShown(child, include));
}

// Caches the promise, so parallel lookups of one id share a single request.
function cachedName(cache: NameCache, id: string, load: () => Promise<string | null>): Promise<string | null> {
  const hit = cache.get(id);
  if (hit !== undefined) {
    return hit;
  }
  if (cache.size >= NAME_CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) {
      cache.delete(oldest.value);
    }
  }
  const pending = load().catch((): string | null => null);
  cache.set(id, pending);
  return pending;
}

function variableNameOf(id: string): Promise<string | null> {
  return cachedName(variableNames, id, async () => {
    const variable = await figma.variables.getVariableByIdAsync(id);
    return variable ? variable.name : null;
  });
}

function styleNameOf(id: string): Promise<string | null> {
  return cachedName(styleNames, id, async () => {
    const style = await figma.getStyleByIdAsync(id);
    return style ? style.name : null;
  });
}

function nodeNameOf(id: string): Promise<string | null> {
  return cachedName(nodeNames, id, async () => {
    const node = await figma.getNodeByIdAsync(id);
    return node ? node.name : null;
  });
}

// A numeric value, or "$name" when its variable binding resolves.
async function tokenOr(value: number, variableId: string | undefined): Promise<Dim> {
  if (variableId !== undefined) {
    const name = await variableNameOf(variableId);
    if (name !== null) {
      return `$${name}`;
    }
  }
  return value;
}

function toHex(channel: number): string {
  return Math.round(channel * 255).toString(16).padStart(2, '0').toUpperCase();
}

// Hex for solid paints (with alpha as a percent), a short tag for other paint kinds.
function paintFallback(paint: Paint): string {
  if (paint.type === 'SOLID') {
    const hex = `#${toHex(paint.color.r)}${toHex(paint.color.g)}${toHex(paint.color.b)}`;
    const alpha = paint.opacity ?? 1;
    return alpha < 1 ? `${hex}/${Math.round(alpha * 100)}` : hex;
  }
  if (paint.type.startsWith('GRADIENT_')) {
    return 'grad';
  }
  if (paint.type === 'IMAGE') {
    return 'img';
  }
  if (paint.type === 'VIDEO') {
    return 'video';
  }
  return paint.type.toLowerCase();
}

// Paint priority (spec §2.3): variable > paint style > hex. figma.mixed becomes "mixed".
async function describePaints(value: unknown, styleId: string | undefined): Promise<string | undefined> {
  if (value === figma.mixed) {
    return 'mixed';
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const visible = (value as Paint[]).filter((paint) => paint.visible !== false);
  if (visible.length === 0) {
    return undefined;
  }
  const style = styleId !== undefined && styleId !== '' ? await styleNameOf(styleId) : null;
  const parts: string[] = [];
  let styleUsed = false;
  for (const paint of visible) {
    const variableId = boundIdOf(paint, 'color');
    const variable = variableId !== undefined ? await variableNameOf(variableId) : null;
    if (variable !== null) {
      parts.push(`$${variable}`);
    } else if (style !== null) {
      // A paint style covers all of the node's paints, so it is written once.
      if (!styleUsed) {
        parts.push(`@${style}`);
        styleUsed = true;
      }
    } else {
      parts.push(paintFallback(paint));
    }
  }
  return parts.join('+');
}

// Uniform weight, or "t,r,b,l" when the sides differ (spec §2.3).
function strokeWeightOf(bag: Bag): string {
  const sides = [bag.strokeTopWeight, bag.strokeRightWeight, bag.strokeBottomWeight, bag.strokeLeftWeight];
  if (sides.every((side) => typeof side === 'number') && sides.some((side) => side !== sides[0])) {
    return sides.map((side) => String(side)).join(',');
  }
  const weight = bag.strokeWeight;
  if (weight === figma.mixed) {
    return 'mixed';
  }
  return typeof weight === 'number' ? String(weight) : '';
}

async function describeStrokes(bag: Bag): Promise<string | undefined> {
  const paints = await describePaints(bag.strokes, stringOf(bag, 'strokeStyleId'));
  if (paints === undefined) {
    return undefined;
  }
  const weight = strokeWeightOf(bag);
  return weight === '' ? paints : `${paints} ${weight}`;
}

// Single value when all corners agree, else "tl,tr,br,bl" (spec §6, figma.mixed radius).
async function radiusOf(bag: Bag): Promise<Dim | undefined> {
  if (!CORNER_FIELDS.some((key) => typeof bag[key] === 'number')) {
    return undefined;
  }
  const corners: Dim[] = [];
  for (const key of CORNER_FIELDS) {
    corners.push(await tokenOr(numberOf(bag, key) ?? 0, boundIdOf(bag, key)));
  }
  return corners.every((corner) => corner === corners[0]) ? corners[0] : corners.join(',');
}

async function effectsOf(bag: Bag): Promise<string | undefined> {
  const styleId = stringOf(bag, 'effectStyleId');
  if (styleId !== undefined && styleId !== '') {
    const name = await styleNameOf(styleId);
    if (name !== null) {
      return `@${name}`;
    }
  }
  const effects = bag.effects;
  if (!Array.isArray(effects)) {
    return undefined;
  }
  const count = effects.filter((effect: unknown) => (effect as Bag).visible !== false).length;
  return count > 0 ? `${count} fx` : undefined;
}

function sizingOf(value: unknown): Sizing | undefined {
  return typeof value === 'string' && SIZING_VALUES.includes(value) ? (value as Sizing) : undefined;
}

function alignOf(value: unknown): Align | undefined {
  return typeof value === 'string' && ALIGN_VALUES.includes(value) ? (value as Align) : undefined;
}

// Auto-layout record; undefined when the node has layoutMode NONE.
async function layoutOf(bag: Bag): Promise<RawLayout | undefined> {
  const mode = stringOf(bag, 'layoutMode');
  if (mode !== 'HORIZONTAL' && mode !== 'VERTICAL' && mode !== 'GRID') {
    return undefined;
  }
  const layout: RawLayout = { mode };
  const gap = numberOf(bag, 'itemSpacing');
  if (gap !== undefined) {
    layout.gap = await tokenOr(gap, boundIdOf(bag, 'itemSpacing'));
  }
  if (bag.layoutWrap === 'WRAP') {
    layout.wrap = true;
    const counterGap = numberOf(bag, 'counterAxisSpacing');
    if (counterGap !== undefined) {
      layout.counterGap = await tokenOr(counterGap, boundIdOf(bag, 'counterAxisSpacing'));
    }
  }
  const padding: Dim[] = [];
  for (const key of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) {
    padding.push(await tokenOr(numberOf(bag, key) ?? 0, boundIdOf(bag, key)));
  }
  layout.padding = [padding[0], padding[1], padding[2], padding[3]];
  layout.primaryAlign = alignOf(bag.primaryAxisAlignItems);
  layout.counterAlign = alignOf(bag.counterAxisAlignItems);
  return layout;
}

function weightLabel(style: string): string {
  const italic = ITALIC_SUFFIX.test(style);
  const base = style.replace(ITALIC_SUFFIX, '');
  const weight: number | undefined = FONT_WEIGHTS[base.toLowerCase()];
  const label = weight !== undefined ? String(weight) : base;
  return italic ? `${label} italic` : label;
}

function lineHeightLabel(lineHeight: unknown): string {
  if (typeof lineHeight !== 'object' || lineHeight === null) {
    return 'auto';
  }
  const line = lineHeight as Bag;
  if (line.unit === 'PIXELS' || line.unit === 'PERCENT') {
    return `${String(line.value)}${line.unit === 'PERCENT' ? '%' : ''}`;
  }
  return 'auto';
}

// Text without a style, e.g. "Inter 14/20 600" (spec §2.1).
function fontLabel(font: unknown, size: unknown, lineHeight: unknown): string | undefined {
  if (typeof font !== 'object' || font === null || typeof size !== 'number') {
    return undefined;
  }
  const family = stringOf(font as Bag, 'family');
  const style = stringOf(font as Bag, 'style');
  if (family === undefined || style === undefined) {
    return undefined;
  }
  return `${family} ${size}/${lineHeightLabel(lineHeight)} ${weightLabel(style)}`;
}

// Text style name, or the font label; with mixed styling, the first segment plus "~mixed".
async function readText(node: TextNode): Promise<TextReading> {
  const bag = bagOf(node);
  const styleId = stringOf(bag, 'textStyleId');
  const fillStyleId = stringOf(bag, 'fillStyleId');
  const mixed = [bag.fills, bag.textStyleId, bag.fontName, bag.fontSize, bag.lineHeight].some(
    (value) => value === figma.mixed,
  );
  if (!mixed) {
    const styleName = styleId !== undefined && styleId !== '' ? await styleNameOf(styleId) : null;
    return {
      textStyle: styleName ?? fontLabel(bag.fontName, bag.fontSize, bag.lineHeight),
      fills: await describePaints(bag.fills, fillStyleId),
    };
  }
  const segments = node.getStyledTextSegments(['textStyleId', 'fontName', 'fontSize', 'lineHeight', 'fills']);
  const first = segments[0];
  if (first === undefined) {
    return {};
  }
  const segment = bagOf(first);
  const segmentStyle = stringOf(segment, 'textStyleId');
  const segmentStyleName = segmentStyle !== undefined && segmentStyle !== '' ? await styleNameOf(segmentStyle) : null;
  const label = segmentStyleName ?? fontLabel(segment.fontName, segment.fontSize, segment.lineHeight);
  const fills = await describePaints(segment.fills, undefined);
  return {
    textStyle: label === undefined ? undefined : `${label} ~mixed`,
    fills: bag.fills === figma.mixed ? (fills === undefined ? undefined : `${fills} ~mixed`) : await describePaints(bag.fills, fillStyleId),
  };
}

// Path of names from the instance's child down to `target` ("Tab 1/Label"); undefined when outside.
function instancePath(instance: InstanceNode, target: BaseNode): string | undefined {
  const names: string[] = [];
  let current: BaseNode | null = target;
  while (current !== null && current.id !== instance.id) {
    names.unshift(current.name);
    current = current.parent;
  }
  return current === null || names.length === 0 ? undefined : names.join('/');
}

// "State=Active" for a variant instance, else the main component name.
async function instanceLabel(node: InstanceNode): Promise<string> {
  const variants = node.variantProperties;
  if (variants !== null && Object.keys(variants).length > 0) {
    return Object.entries(variants)
      .map(([key, value]) => `${key}=${value}`)
      .join(', ');
  }
  const main = await node.getMainComponentAsync();
  return main ? main.name : 'missing component';
}

async function readOverrides(instance: InstanceNode): Promise<OverrideReading[]> {
  const overrides = instance.overrides.slice(0, DETAIL_OVERRIDE_LIMIT);
  const readings = await Promise.all(
    overrides.map(async (override): Promise<OverrideReading | undefined> => {
      const target = await figma.getNodeByIdAsync(override.id);
      if (target === null) {
        return undefined;
      }
      const path = instancePath(instance, target);
      if (path === undefined) {
        return undefined;
      }
      const fields: string[] = override.overriddenFields;
      if (target.type === 'TEXT' && fields.includes('characters')) {
        return { kind: 'text', path, value: truncateCompactText(target.characters, DETAIL_TEXT_CHARS) };
      }
      if (target.type === 'INSTANCE' && (fields.includes('componentProperties') || fields.includes('mainComponent'))) {
        return { kind: 'instance', path, value: await instanceLabel(target) };
      }
      return undefined;
    }),
  );
  return readings.filter((reading): reading is OverrideReading => reading !== undefined);
}

// Main component, variant props, changed props (no #id suffix) and overrides of an instance.
async function readComponent(node: InstanceNode, include: CompactInclude[]): Promise<RawComponent> {
  const main = await node.getMainComponentAsync();
  if (main === null) {
    return { name: 'missing component' };
  }
  const parent = main.parent;
  const set = parent !== null && parent.type === 'COMPONENT_SET' ? (parent as ComponentSetNode) : null;
  const component: RawComponent = { name: set !== null ? set.name : main.name };
  if (set !== null && node.variantProperties !== null) {
    component.variants = { ...node.variantProperties };
  }
  if (include.includes('instance')) {
    const owner: ComponentNode | ComponentSetNode = set ?? main;
    const definitions = owner.componentPropertyDefinitions;
    const props: RawProp[] = [];
    for (const [key, prop] of Object.entries(node.componentProperties)) {
      if (prop.type === 'VARIANT' || prop.type === 'SLOT') {
        continue; // variants are already in `v`
      }
      const definition = definitions[key];
      if (definition === undefined) {
        continue;
      }
      let value: PropValue = prop.value;
      let defaultValue: PropValue = definition.defaultValue;
      if (prop.type === 'INSTANCE_SWAP') {
        value = (await nodeNameOf(String(prop.value))) ?? String(prop.value);
        defaultValue = (await nodeNameOf(String(definition.defaultValue))) ?? String(definition.defaultValue);
      }
      props.push({ name: key.replace(COMPONENT_ID_SUFFIX, ''), type: prop.type, value, defaultValue });
    }
    component.props = props;
    const overrides = await readOverrides(node);
    const text: Record<string, string> = {};
    const instances: Record<string, string> = {};
    for (const reading of overrides) {
      if (reading.kind === 'text') {
        text[reading.path] = reading.value;
      } else {
        instances[reading.path] = reading.value;
      }
    }
    component.overrideText = text;
    component.overrideInstances = instances;
  }
  return component;
}

// One raw node with its own fields; children are attached by collectTree.
async function readNode(node: SceneNode, state: CollectState): Promise<RawNode> {
  const bag = bagOf(node);
  const include = state.include;
  const raw: RawNode = { id: node.id, name: node.name, type: node.type, visible: node.visible };
  if (include.includes('geometry')) {
    raw.width = numberOf(bag, 'width');
    raw.height = numberOf(bag, 'height');
  }
  if (include.includes('layout')) {
    raw.layout = await layoutOf(bag);
    raw.sizingH = sizingOf(bag.layoutSizingHorizontal);
    raw.sizingV = sizingOf(bag.layoutSizingVertical);
    raw.absolute = bag.layoutPositioning === 'ABSOLUTE';
  }
  if (include.includes('paint')) {
    raw.opacity = numberOf(bag, 'opacity');
    raw.radius = await radiusOf(bag);
    raw.strokes = await describeStrokes(bag);
    raw.effects = await effectsOf(bag);
  }
  if (node.type === 'TEXT') {
    raw.characters = node.characters;
    if (include.includes('text') || include.includes('paint')) {
      const text = await readText(node);
      if (include.includes('text')) {
        raw.textStyle = text.textStyle;
      }
      if (include.includes('paint')) {
        raw.fills = text.fills;
      }
    }
  } else if (include.includes('paint')) {
    raw.fills = await describePaints(bag.fills, stringOf(bag, 'fillStyleId'));
  }
  if (node.type === 'INSTANCE' && include.includes('instance')) {
    raw.component = await readComponent(node, include);
  }
  if ('children' in node) {
    raw.childCount = childNodesOf(node, include).length;
  }
  return raw;
}

// Reads nodes in chunks of DETAIL_BATCH. Returns undefined when a cut happens (not forced).
async function readBatch(nodes: readonly SceneNode[], state: CollectState, forced: boolean): Promise<RawNode[] | undefined> {
  const out: RawNode[] = [];
  for (let start = 0; start < nodes.length; start += DETAIL_BATCH) {
    const chunk = nodes.slice(start, start + DETAIL_BATCH);
    if (!forced) {
      if (state.stopped !== undefined) {
        return undefined;
      }
      if (Date.now() - state.startedAt > DETAIL_TIMEBOX_MS) {
        state.stopped = 'timeout';
        return undefined;
      }
      if (state.visited + chunk.length > state.visitCap) {
        state.stopped = 'visitCap';
        return undefined;
      }
    }
    state.visited += chunk.length;
    out.push(...(await Promise.all(chunk.map((node) => readNode(node, state)))));
  }
  return out;
}

// BFS over the selection roots (at most COMPACT_MAX_ROOTS are read; the rest only count).
async function collectTree(roots: readonly SceneNode[], state: CollectState, depthLimit: number): Promise<RawNode[]> {
  const shown = roots.filter((node) => isDetailShown(node, state.include));
  const kept = shown.slice(0, COMPACT_MAX_ROOTS);
  const rest: RawNode[] = shown.slice(COMPACT_MAX_ROOTS).map((node) => ({
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible,
  }));
  const keptRaw = (await readBatch(kept, state, true)) ?? [];
  let current: Expansion[] = keptRaw.map((raw, i) => ({ raw, node: kept[i], depth: 0 }));
  while (current.length > 0) {
    const next: Expansion[] = [];
    for (const task of current) {
      // Instances never expand their children (spec §2.4 rule 3).
      if (task.depth >= depthLimit || task.node.type === 'INSTANCE') {
        continue;
      }
      const children = childNodesOf(task.node, state.include);
      if (children.length === 0) {
        continue;
      }
      const read = await readBatch(children, state, false);
      if (read === undefined) {
        continue; // stays unexpanded; its count is in `childCount`
      }
      task.raw.children = read;
      read.forEach((raw, i) => next.push({ raw, node: children[i], depth: task.depth + 1 }));
    }
    current = next;
  }
  return [...keptRaw, ...rest];
}

// Builds the detail payload for the current selection (roots). Tier B when the captured tree
// fits 300 nodes, else tier A. A cut by the time box or the visit cap is a root marker.
async function buildDetail(roots: readonly SceneNode[]): Promise<DetailPayload> {
  const startedAt = Date.now();
  const state: CollectState = {
    startedAt,
    visitCap: DETAIL_TIER_B.maxNodes * DETAIL_VISIT_CAP_FACTOR,
    visited: 0,
    include: DETAIL_TIER_B.include,
  };
  const raws = await collectTree(roots, state, DETAIL_TIER_B.depth);
  const isTierB = state.visited <= DETAIL_TIER_B_NODES;
  const tier = isTierB ? DETAIL_TIER_B : DETAIL_TIER_A;
  const result = compactTree(raws, tier);
  const entries: CompactEntry[] = result.roots.slice();
  if (state.stopped !== undefined) {
    entries.push(`…${state.stopped}`);
  }
  return {
    v: 1,
    tier: isTierB ? 'B' : 'A',
    depth: tier.depth,
    maxNodes: tier.maxNodes,
    maxTextChars: tier.maxTextChars,
    include: tier.include.slice(),
    roots: entries,
    truncated: result.truncated || state.stopped !== undefined,
    buildMs: Date.now() - startedAt,
  };
}

function postDetailError(requestId: number, message: string): void {
  const reply: DetailErrorMessage = { type: 'detail-error', requestId, message };
  try {
    figma.ui.postMessage(reply);
  } catch {
    // The UI is gone; there is nobody left to report to.
  }
}

// Answers request-detail only (never on selectionchange). Never throws.
async function handleRequestDetail(requestId: number): Promise<void> {
  try {
    const roots = [...figma.currentPage.selection];
    if (roots.length === 0) {
      postDetailError(requestId, 'Нічого не вибрано');
      return;
    }
    const detail = await buildDetail(roots);
    const message: DetailMessage = {
      type: 'detail',
      requestId,
      ids: roots.map((node) => node.id),
      detail,
    };
    figma.ui.postMessage(message);
  } catch (error) {
    postDetailError(requestId, `Не вдалося зібрати деталі: ${errorText(error)}`);
  }
}

function postSelection(): void {
  const nodes: SelectedNode[] = figma.currentPage.selection.map((node) => ({
    id: node.id,
    name: node.name,
    type: node.type,
  }));
  const message: SelectionMessage = {
    type: 'selection',
    fileKey: figma.fileKey ?? null,
    nodes,
  };
  figma.ui.postMessage(message);
}

async function loadSettings(): Promise<Settings> {
  try {
    const stored: unknown = await figma.clientStorage.getAsync(SETTINGS_KEY);
    if (isSettings(stored)) {
      return { send: stored.send, token: stored.token };
    }
  } catch {
    // Storage unavailable: fall back to defaults.
  }
  return { ...DEFAULT_SETTINGS };
}

async function saveSettings(settings: Settings): Promise<void> {
  try {
    await figma.clientStorage.setAsync(SETTINGS_KEY, { send: settings.send, token: settings.token });
  } catch {
    figma.notify('Не вдалося зберегти налаштування');
  }
}

// Stays false until the stored settings have been sent to the UI, so the first
// selection the UI sees always comes after the settings it depends on.
let ready = false;

figma.showUI(__html__, { width: 320, height: 520 });

figma.ui.onmessage = (msg: unknown) => {
  if (!isUIMessage(msg)) {
    return;
  }
  switch (msg.type) {
    case 'notify':
      figma.notify(msg.message);
      break;
    case 'close':
      figma.closePlugin();
      break;
    case 'save-settings':
      void saveSettings(msg.settings);
      break;
    case 'request-detail':
      void handleRequestDetail(msg.requestId);
      break;
  }
};

figma.on('selectionchange', () => {
  if (ready) {
    postSelection();
  }
});

async function start(): Promise<void> {
  try {
    // Invisible instance children are not loaded: faster traversal, and hidden nodes are skipped anyway.
    figma.skipInvisibleInstanceChildren = true;
  } catch {
    // Older hosts may not allow the flag; the collector skips hidden nodes itself.
  }
  const settings = await loadSettings();
  const message: PluginMessage = { type: 'settings', settings };
  figma.ui.postMessage(message);
  ready = true;
  postSelection();
}

void start();
