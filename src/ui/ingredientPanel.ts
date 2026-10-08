// The ingredient editor (M5): a compound law's ingredients as a short list inside its details, and the
// focused ingredient's own parameters, gain and masks below it. It is a view of the law's expression
// tree. Every control yields one edit of that tree, which the caller validates and applies as one
// ordinary law put and one undo entry; nothing here holds law state of its own. A nested sum is a
// group, opened in place. Text is written as text, never markup (SPEC §15.2).
import { Euler, Quaternion } from 'three/webgpu';
import {
  DEFAULT_TRIANGLE,
  addIngredient,
  ingredientLabels,
  ingredientsOf,
  isCompound,
  removeIngredient,
  unwrapModifier,
  wrapIngredient,
  type Edited,
  type Ingredient,
  type Modifier,
} from '../domain/ingredients';
import { EDGE_FADE, type FieldDefinition, type FieldExpression, type Gain, type MaskExpression, type Primitive, type Quat, type Vec3 } from '../domain/scene';
import { GAIN_BOUNDS, gainAt, nodeAt, pathText, replaceAt, type ExprPath } from '../fields/expression';
import { PRIMITIVES, REGIONS, primitiveDescriptor, regionDescriptor, type PrimitiveKind, type RegionKind, type ScalarControl } from '../fields/registry';

export interface IngredientPanelOptions {
  /**
   * Applies one authored change to the selected law's expression, computed from its current value:
   * validated, one law put, one undo entry. Returns the edit on success, null when it was refused.
   */
  edit(label: string, change: (law: FieldDefinition) => Edited, input?: HTMLInputElement): Edited | null;
  /** The focused ingredient changed: the viewport's masks and handles follow it. */
  onFocus(): void;
}

const DEGREES = 180 / Math.PI;
const $ = (id: string) => document.getElementById(id)!;
const fmt = (value: number, digits: number) => String(Math.round(value * 10 ** digits) / 10 ** digits);
const short = (v: number) => fmt(v, 2);
const samePath = (a: ExprPath | null, b: ExprPath | null) => a !== null && b !== null && a.length === b.length && a.every((s, i) => s === b[i]);

function element<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { dataset?: Record<string, string> } = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const { dataset, ...rest } = props;
  const e = Object.assign(document.createElement(tag), rest);
  if (dataset) Object.assign(e.dataset, dataset);
  e.append(...children);
  return e;
}

/** A labeled numeric field (SPEC §11.3): bounded, keyboard-editable, one edit on change. */
function numberField(label: string, unit: string, value: number, bounds: { min: number; max: number; step: number }, key: string, context: string, digits = 3): HTMLLabelElement {
  const input = element('input', { type: 'number', step: String(bounds.step), min: String(bounds.min), max: String(bounds.max), value: fmt(value, digits), dataset: { key } });
  // Named in context ("Drag mask radius"), so it is never confused with the law's own field of that name.
  input.setAttribute('aria-label', `${context} ${label.toLowerCase()}`);
  const name = element('label', {}, `${label} `);
  if (unit) name.append(element('span', { className: 'unit', textContent: unit }));
  name.append(input);
  return name;
}

/** Three numeric fields under one legend: a mask's local position or rotation. */
function tripleField(legend: string, unit: string, values: readonly number[], step: number, key: string, digits: number, context: string): HTMLFieldSetElement {
  const set = element('fieldset', { className: 'triple' });
  const title = element('legend', {}, `${legend} `, element('span', { className: 'unit', textContent: unit }));
  set.append(title);
  values.forEach((v, axis) => {
    const input = element('input', { type: 'number', step: String(step), value: fmt(v, digits), dataset: { key: `${key}.${axis}` } });
    input.setAttribute('aria-label', `${context} ${legend.toLowerCase()} ${'xyz'[axis]}`);
    set.append(input);
  });
  return set;
}

function segmented(label: string, options: readonly [string, string][], current: string, action: string): HTMLDivElement {
  const group = element('div', { className: 'segmented compact' });
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', label);
  for (const [value, text] of options) {
    const b = element('button', { type: 'button', textContent: text, dataset: { action, value } });
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(value === current));
    group.append(b);
  }
  return group;
}

/** A short, honest description of what wraps an ingredient: its gains and masks, outermost first. */
function modifierSummary(modifiers: Ingredient['modifiers']): string {
  return modifiers
    .map(({ node }) => (node.kind === 'mask' ? 'masked' : node.gain.kind === 'constant' ? `×${short(node.gain.value)}` : `pulsing ${short(node.gain.min)}–${short(node.gain.max)}`))
    .join(' · ');
}

function coreSummary(core: Ingredient['core']['node']): string {
  if (core.kind === 'sum') return `${core.terms.length} ingredients`;
  return primitiveDescriptor(core.kind).summary(core);
}

const eulerOf = (q: Quat) => {
  const e = new Euler().setFromQuaternion(new Quaternion(...q), 'XYZ');
  return [e.x * DEGREES, e.y * DEGREES, e.z * DEGREES];
};

export function createIngredientPanel(o: IngredientPanelOptions) {
  const root = $('ingredients');
  const shelf = $('ingredient-shelf');
  const note = $('ingredients-note');
  const crumbs = $('ingredient-crumbs');
  const levelText = $('ingredient-level');
  const list = $('ingredient-list');
  const detail = $('ingredient-detail');

  let lawId: string | null = null;
  let law: FieldDefinition | null = null;
  /** The open group (a nested sum's path), or null for the law's own list. */
  let level: ExprPath | null = null;
  /** The focused ingredient's path, or null. */
  let focus: ExprPath | null = null;
  let listSignature = '';
  let detailSignature = '';
  let structureSignature = '';

  for (const [kind, d] of Object.entries(PRIMITIVES)) {
    const b = element('button', { type: 'button', textContent: d.verb, title: `Add a ${d.title.toLowerCase()} ingredient to this law`, dataset: { add: kind } });
    b.style.setProperty('--law-color', d.color);
    shelf.append(b);
  }

  const setFocus = (path: ExprPath | null) => {
    if (samePath(path, focus) || (path === null && focus === null)) return;
    focus = path;
    o.onFocus();
  };

  const apply = (label: string, change: (law: FieldDefinition) => Edited, input?: HTMLInputElement, refocus?: (edited: Edited & { ok: true }) => ExprPath | null) => {
    const edited = o.edit(label, change, input);
    if (edited && edited.ok && refocus) setFocus(refocus(edited));
    return edited;
  };

  /** A node of the current law replaced through a typed edit, as one Edited result. */
  const setNode = (path: ExprPath, make: (node: FieldExpression) => FieldExpression) => (l: FieldDefinition): Edited => {
    const node = nodeAt(l.expression, path);
    if (!node) return { ok: false, reason: 'that part of the law no longer exists' };
    return { ok: true, expression: replaceAt(l.expression, path, make(node)), path };
  };

  // ---- adding, focusing, removing and opening ingredients
  shelf.addEventListener('click', (event) => {
    const kind = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-add]')?.dataset.add as PrimitiveKind | undefined;
    if (!kind) return;
    const verb = PRIMITIVES[kind].verb;
    apply(`Add ${verb.toLowerCase()}`, (l) => addIngredient(l.expression, level, kind), undefined, (e) => e.path);
  });
  list.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-path]');
    if (!button) return;
    const path = JSON.parse(button.dataset.path!) as ExprPath;
    if (button.dataset.action === 'remove') {
      apply('Remove ingredient', (l) => removeIngredient(l.expression, path), undefined, () => null);
    } else setFocus(samePath(path, focus) ? null : path);
  });
  $('ingredient-up').addEventListener('click', () => {
    level = level ? parentLevel(level) : null;
    setFocus(null);
    render(law ?? undefined, lastTick);
  });

  /**
   * The level holding the group whose sum is at `group`: past the group's own gains and masks to its
   * ingredient, then past that ingredient's term index to the sum holding it; the law's list at the top.
   */
  function parentLevel(group: ExprPath): ExprPath | null {
    const p = [...group];
    while (p[p.length - 1] === 'child') p.pop();
    p.pop();
    return p.length ? p : null;
  }

  // ---- the focused ingredient's controls
  detail.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
    if (!button || !law || !focus) return;
    const at = button.closest<HTMLElement>('[data-node]');
    const path = at ? (JSON.parse(at.dataset.node!) as ExprPath) : focus;
    const ingredient = focus;
    switch (button.dataset.action) {
      case 'add-gain':
        apply('Add gain', (l) => wrapIngredient(l.expression, ingredient, 'gain', l.region));
        return;
      case 'add-mask':
        apply('Add mask', (l) => wrapIngredient(l.expression, ingredient, 'mask', l.region));
        return;
      case 'unwrap':
        apply(button.dataset.label!, (l) => unwrapModifier(l.expression, path));
        return;
      case 'gain-kind': {
        const kind = button.dataset.value as Gain['kind'];
        apply('Change gain', setNode(path, (node) => {
          const g = node as Extract<FieldExpression, { kind: 'gain' }>;
          if (g.gain.kind === kind) return g;
          // A triangle starts at its default swing; a constant from a triangle keeps its average, the midpoint.
          const gain: Gain = g.gain.kind === 'constant' ? DEFAULT_TRIANGLE : { kind: 'constant', value: (g.gain.min + g.gain.max) / 2 };
          return { ...g, gain };
        }));
        return;
      }
      case 'mask-kind': {
        const kind = button.dataset.value as RegionKind;
        apply('Change mask shape', setNode(path, (node) => {
          const m = node as MaskExpression;
          return m.region.kind === kind ? m : { ...m, region: REGIONS[kind].fromBounds(regionDescriptor(m.region.kind).bounds(m.region)) };
        }));
        return;
      }
      case 'open-group': {
        // The group's sum sits beneath the ingredient's own gains and masks: open that sum.
        const node = nodeAt(law.expression, focus);
        let at: ExprPath = focus;
        for (let n = node; n && (n.kind === 'gain' || n.kind === 'mask'); n = n.child) at = [...at, 'child'];
        level = at;
        setFocus(null);
        render(law ?? undefined, lastTick);
        return;
      }
    }
  });

  detail.addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement;
    const at = input.closest<HTMLElement>('[data-node]');
    if (!at || !input.dataset.key || !law) return;
    const path = JSON.parse(at.dataset.node!) as ExprPath;
    const value = input.value.trim() === '' ? NaN : Number(input.value);
    const [part, ...rest] = input.dataset.key.split('.');
    const node = nodeAt(law.expression, path);
    if (!node) return;
    if (part === 'primitive') {
      const control = primitiveDescriptor((node as Primitive).kind).controls.find((c) => c.key === rest.join('.'))!;
      apply(control.edit, setNode(path, (n) => control.set(n as Primitive, value)), input);
    } else if (part === 'gain') {
      apply('Change gain', setNode(path, (n) => ({ ...(n as Extract<FieldExpression, { kind: 'gain' }>), gain: { ...(n as Extract<FieldExpression, { kind: 'gain' }>).gain, [rest[0]!]: value } as Gain })), input);
    } else if (part === 'position') {
      const axis = Number(rest[0]);
      apply('Move mask', setNode(path, (n) => {
        const m = n as MaskExpression;
        return { ...m, pose: { ...m.pose, position: m.pose.position.map((c, i) => (i === axis ? value : c)) as unknown as Vec3 } };
      }), input);
    } else if (part === 'rotation') {
      const axis = Number(rest[0]);
      apply('Rotate mask', setNode(path, (n) => {
        const m = n as MaskExpression;
        // Only the edited angle changes; the others keep full precision from the stored rotation.
        const euler = new Euler().setFromQuaternion(new Quaternion(...m.pose.rotation), 'XYZ');
        euler[(['x', 'y', 'z'] as const)[axis]!] = value / DEGREES;
        const q = new Quaternion().setFromEuler(euler);
        return { ...m, pose: { ...m.pose, rotation: [q.x, q.y, q.z, q.w] } };
      }), input);
    } else if (part === 'region') {
      const m = node as MaskExpression;
      const control = regionDescriptor(m.region.kind).controls.find((c) => c.key === rest.join('.'))!;
      apply('Resize mask', setNode(path, (n) => ({ ...(n as MaskExpression), region: control.set((n as MaskExpression).region, value) })), input);
    } else if (part === 'edgeFade') {
      apply('Change mask fade', setNode(path, (n) => ({ ...(n as MaskExpression), edgeFade: value })), input);
    }
  });

  // ---- rendering
  let lastTick = 0;

  function primitiveFields(core: Primitive, path: ExprPath, context: string): HTMLElement {
    const d = primitiveDescriptor(core.kind);
    const fields = element('div', { className: 'param-fields', dataset: { node: JSON.stringify(path) } });
    for (const c of d.controls as readonly ScalarControl<Primitive>[]) fields.append(numberField(c.label, c.unit, c.get(core), c, `primitive.${c.key}`, context));
    return fields;
  }

  function gainBlock(modifier: { path: ExprPath; node: Extract<Modifier, { kind: 'gain' }> }, ingredient: string): HTMLElement {
    const context = `${ingredient} gain`;
    const { path, node } = modifier;
    const block = element('div', { className: 'modifier', dataset: { node: JSON.stringify(path) } });
    const remove = element('button', { type: 'button', className: 'modifier-remove', textContent: 'Remove', title: 'Remove this gain; what it scaled stays', dataset: { action: 'unwrap', label: 'Remove gain' } });
    block.append(element('div', { className: 'modifier-head' }, element('span', { textContent: 'Gain, on drive and drag' }), segmented('Gain kind', [['constant', 'Constant'], ['triangle', 'Triangle']], node.gain.kind, 'gain-kind'), remove));
    const fields = element('div', { className: 'param-fields' });
    const bound = { min: GAIN_BOUNDS.min, max: GAIN_BOUNDS.max, step: 0.1 };
    const g = node.gain;
    if (g.kind === 'constant') fields.append(numberField('Value', '×', g.value, bound, 'gain.value', context));
    else {
      fields.append(
        numberField('Min', '×', g.min, bound, 'gain.min', context),
        numberField('Max', '×', g.max, bound, 'gain.max', context),
        numberField('Period', 'ticks', g.periodTicks, { min: 2, max: Number.MAX_SAFE_INTEGER, step: 1 }, 'gain.periodTicks', context, 0),
        numberField('Phase', 'ticks', g.phaseTicks, { min: 0, max: g.periodTicks - 1, step: 1 }, 'gain.phaseTicks', context, 0),
      );
    }
    block.append(fields);
    if (g.kind === 'triangle') block.append(element('p', { className: 'live', dataset: { live: JSON.stringify(path) } }));
    return block;
  }

  function maskBlock(modifier: { path: ExprPath; node: MaskExpression }, index: number, count: number, ingredient: string): HTMLElement {
    const { path, node } = modifier;
    const context = count > 1 ? `${ingredient} mask ${index + 1}` : `${ingredient} mask`;
    const block = element('div', { className: 'modifier', dataset: { node: JSON.stringify(path) } });
    const remove = element('button', { type: 'button', className: 'modifier-remove', textContent: 'Remove', title: 'Remove this mask; what it limited acts in the whole law again', dataset: { action: 'unwrap', label: 'Remove mask' } });
    const name = count > 1 ? `Mask ${index + 1} of ${count}` : 'Mask';
    block.append(element('div', { className: 'modifier-head' }, element('span', { textContent: name }), segmented('Mask shape', Object.entries(REGIONS).map(([k, d]) => [k, d.title]), node.region.kind, 'mask-kind'), remove));
    block.append(element('p', { className: 'note', textContent: 'Placed in the law’s frame. It changes where the ingredient acts, not which way it pushes.' }));
    block.append(tripleField('Position', 'm', node.pose.position, 0.1, 'position', 3, context), tripleField('Rotation', '°', eulerOf(node.pose.rotation), 5, 'rotation', 1, context));
    const fields = element('div', { className: 'param-fields' });
    const region = regionDescriptor(node.region.kind);
    for (const c of region.controls) fields.append(numberField(c.label, c.unit, c.get(node.region), c, `region.${c.key}`, context));
    fields.append(numberField('Fade', '', node.edgeFade, EDGE_FADE, 'edgeFade', context));
    block.append(fields);
    return block;
  }

  /** The focused ingredient's controls: what it is, its primitive's parameters, then its gains and masks. */
  function renderDetail(ingredient: Ingredient | null, label: string) {
    detail.hidden = ingredient === null;
    const signature = JSON.stringify(ingredient && [ingredient.path, ingredient.modifiers.map((m) => m.node), ingredient.core.node, label]);
    if (signature === detailSignature) return;
    detailSignature = signature;
    if (!ingredient) {
      detail.replaceChildren();
      structureSignature = '';
      return;
    }
    // A structural change (another ingredient, a gain or mask added, removed or switched) rebuilds the
    // controls; a value change only refreshes the fields not being typed in.
    const shape = JSON.stringify([ingredient.path, ingredient.core.node.kind, ingredient.modifiers.map((m) => (m.node.kind === 'gain' ? m.node.gain.kind : m.node.region.kind))]);
    if (shape !== structureSignature) {
      structureSignature = shape;
      const focused = document.activeElement instanceof HTMLInputElement && detail.contains(document.activeElement) ? `${document.activeElement.closest<HTMLElement>('[data-node]')?.dataset.node}|${document.activeElement.dataset.key}` : null;
      const parts: HTMLElement[] = [];
      const core = ingredient.core.node;
      if (core.kind === 'sum') {
        parts.push(element('p', { className: 'kind', textContent: `${label}: a group of ${core.terms.length} ingredients, added in order.` }));
        parts.push(element('button', { type: 'button', textContent: 'Open group', dataset: { action: 'open-group' } }));
      } else {
        const d = primitiveDescriptor(core.kind);
        parts.push(element('p', { className: 'kind', textContent: `${label} · ${d.title.toLowerCase()}: ${d.describe(core)}` }));
        parts.push(primitiveFields(core, ingredient.core.path, label));
      }
      const masks = ingredient.modifiers.filter((m) => m.node.kind === 'mask');
      for (const m of ingredient.modifiers) {
        if (m.node.kind === 'gain') parts.push(gainBlock(m as { path: ExprPath; node: Extract<Modifier, { kind: 'gain' }> }, label));
        else parts.push(maskBlock(m as { path: ExprPath; node: MaskExpression }, masks.indexOf(m), masks.length, label));
      }
      const actions = element('div', { className: 'modifier-actions' });
      if (!ingredient.modifiers.some((m) => m.node.kind === 'gain')) actions.append(element('button', { type: 'button', textContent: 'Add gain', title: 'Scale this ingredient’s drive and drag, constantly or with a triangle over ticks', dataset: { action: 'add-gain' } }));
      actions.append(element('button', { type: 'button', textContent: ingredient.modifiers.some((m) => m.node.kind === 'mask') ? 'Add another mask' : 'Add mask', title: 'Limit where this ingredient acts inside the law', dataset: { action: 'add-mask' } }));
      parts.push(actions);
      detail.replaceChildren(...parts);
      if (focused) detail.querySelector<HTMLInputElement>(`[data-node='${focused.split('|')[0]}'] input[data-key='${focused.split('|')[1]}']`)?.focus();
    }
    refreshValues();
    refreshLive(lastTick);
  }

  /** Every field's value from the law, except the one being typed in. */
  function refreshValues() {
    if (!law) return;
    for (const input of detail.querySelectorAll<HTMLInputElement>('input[data-key]')) {
      const holder = input.closest<HTMLElement>('[data-node]');
      if (!holder || input === document.activeElement) continue;
      const node = nodeAt(law.expression, JSON.parse(holder.dataset.node!) as ExprPath);
      const value = node ? valueOf(node, input.dataset.key!) : null;
      if (value !== null) input.value = value;
    }
  }

  function valueOf(node: FieldExpression, key: string): string | null {
    const [part, ...rest] = key.split('.');
    if (part === 'primitive') {
      const control = primitiveDescriptor((node as Primitive).kind).controls.find((c) => c.key === rest.join('.'));
      return control ? fmt(control.get(node as Primitive), 3) : null;
    }
    if (part === 'gain' && node.kind === 'gain') return fmt((node.gain as unknown as Record<string, number>)[rest[0]!]!, 3);
    if (node.kind !== 'mask') return null;
    if (part === 'position') return fmt(node.pose.position[Number(rest[0])]!, 3);
    if (part === 'rotation') return fmt(eulerOf(node.pose.rotation)[Number(rest[0])]!, 1);
    if (part === 'region') {
      const control = regionDescriptor(node.region.kind).controls.find((c) => c.key === rest.join('.'));
      return control ? fmt(control.get(node.region), 3) : null;
    }
    if (part === 'edgeFade') return fmt(node.edgeFade, 3);
    return null;
  }

  /** A triangle gain's value at the host's tick: what the next step will use. */
  function refreshLive(tick: number) {
    lastTick = tick;
    if (!law) return;
    for (const p of detail.querySelectorAll<HTMLElement>('[data-live]')) {
      const node = nodeAt(law.expression, JSON.parse(p.dataset.live!) as ExprPath);
      if (node?.kind !== 'gain') continue;
      const text = `Now ×${fmt(gainAt(node.gain, tick), 3)} at tick ${tick}; it depends on the tick alone, so a pause holds it.`;
      if (p.textContent !== text) p.textContent = text;
    }
  }

  function render(selected: FieldDefinition | undefined, tick: number) {
    lastTick = tick;
    root.hidden = !selected;
    if (!selected) {
      law = null;
      lawId = null;
      return;
    }
    if (selected.id !== lawId) {
      lawId = selected.id;
      level = null;
      focus = null;
      o.onFocus();
    }
    law = selected;
    const compound = isCompound(selected.expression);
    if (level !== null && nodeAt(selected.expression, level)?.kind !== 'sum') level = null;
    const ingredients = compound ? ingredientsOf(selected.expression, level) : [];
    if (focus !== null && !ingredients.some((i) => samePath(i.path, focus))) {
      focus = null;
      o.onFocus();
    }
    note.textContent = compound
      ? level === null
        ? 'Added in this order, each at the bottle’s center and turned with it. The law’s support applies once, to all of them.'
        : 'A group’s ingredients are added in this order, then its own gains and masks apply.'
      : 'One primitive. Add another and both act inside this one law, which still moves, turns and resizes as a whole.';
    crumbs.hidden = level === null;
    levelText.textContent = level === null ? '' : `Inside a group (${pathText(level)})`;
    const labels = ingredientLabels(ingredients);
    const signature = JSON.stringify([selected.id, level, focus, ingredients.map((i, k) => [labels[k], coreSummary(i.core.node), modifierSummary(i.modifiers), i.path]), ingredients.length]);
    if (signature !== listSignature) {
      listSignature = signature;
      list.replaceChildren(
        ...ingredients.map((ingredient, k) => {
          const core = ingredient.core.node;
          const color = core.kind === 'sum' ? 'var(--text-tertiary)' : primitiveDescriptor(core.kind).color;
          const row = element('li', { className: 'ingredient-row' });
          row.style.setProperty('--law-color', color);
          const meta = [coreSummary(core), modifierSummary(ingredient.modifiers)].filter(Boolean).join(' · ');
          const select = element('button', { type: 'button', className: 'ingredient-select', dataset: { path: JSON.stringify(ingredient.path), action: 'focus' } }, element('span', { className: 'law-name', textContent: labels[k]! }), element('span', { className: 'law-meta', textContent: meta }));
          select.setAttribute('aria-pressed', String(samePath(ingredient.path, focus)));
          const remove = element('button', { type: 'button', className: 'ingredient-remove', textContent: 'Remove', title: 'Take this ingredient out of the law (Undo puts it back)', dataset: { path: JSON.stringify(ingredient.path), action: 'remove' } });
          remove.setAttribute('aria-label', `Remove ${labels[k]}`);
          remove.disabled = ingredients.length === 1;
          row.append(select, remove);
          return row;
        }),
      );
    }
    const focused = ingredients.findIndex((i) => samePath(i.path, focus));
    renderDetail(focused < 0 ? null : ingredients[focused]!, focused < 0 ? '' : labels[focused]!);
  }

  return {
    render,
    refreshLive,
    /** The focused ingredient's path in the selected law, for its masks and handles in the viewport. */
    get focus(): ExprPath | null {
      return focus;
    },
    /** Readback for the layout report: the focused ingredient and the open group. */
    state: () => ({ law: lawId, level, focus }),
  };
}
