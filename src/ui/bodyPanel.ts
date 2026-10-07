// The explained body's readout (SPEC §11.3, §12): the sampled center and velocity, each law's share of
// the external acceleration, gravity's share and the submitted total, the shared β and λ, contacts and
// the state after the step. Quantities stay in separate rows with their own glyphs and units. Text is
// written as text, never markup (SPEC §15.2).
import type { Vec3 } from '../domain/scene';
import type { TransitionObservation } from '../simulation/observation';

export type ExplainViewMode = 'applied' | 'preview';

export interface BodyPanelState {
  explained: string;
  view: ExplainViewMode;
  playing: boolean;
  /** The explained body is in the scene now. */
  present: boolean;
  tick: number;
  /** The transition to show, already matched to the explained body and the view; null when there is none. */
  observation: TransitionObservation | null;
  lawLabel(id: string): string;
  lawColor(id: string): string;
}

const BURST = '<svg class="contact-glyph" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 1v3M7 10v3M1 7h3M10 7h3M2.8 2.8l2.1 2.1M9.1 9.1l2.1 2.1M2.8 11.2l2.1-2.1M9.1 4.9l2.1-2.1"/></svg>';

/** Fixed decimals without a negative zero; fewer for large values, so every column keeps its width. */
function num(value: number, digits = 2): string {
  const magnitude = Math.abs(value);
  const text = value.toFixed(magnitude >= 1000 ? 0 : magnitude >= 100 ? Math.min(digits, 1) : digits);
  return /^-0\.?0*$/.test(text) ? text.slice(1) : text;
}

const $ = (id: string) => document.getElementById(id)!;

function span(text: string, className?: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.textContent = text;
  if (className) s.className = className;
  s.setAttribute('role', 'cell');
  return s;
}

function glyph(kind: 'velocity' | 'acceleration' | 'share' | 'none', color?: string): HTMLSpanElement {
  const g = document.createElement('span');
  if (kind !== 'none') g.className = `${kind}-glyph`;
  if (color) g.style.setProperty('--law-color', color);
  g.setAttribute('aria-hidden', 'true');
  return g;
}

/** One row: glyph, name, magnitude (or nothing) and components. */
function fill(row: HTMLElement, mark: HTMLElement, name: string, v: Vec3 | null, magnitude: boolean, sub?: string): void {
  if (!v) {
    row.replaceChildren();
    return;
  }
  const cells: HTMLElement[] = [mark, span(name), span(magnitude ? num(Math.hypot(...v)) : ''), ...v.map((c) => span(num(c)))];
  if (sub) cells.push(span(sub, 'sub'));
  row.replaceChildren(...cells);
}

export function createBodyPanel() {
  const panel = $('explain');
  const id = $('explain-id');
  const transition = $('explain-transition');
  const empty = $('explain-empty');
  const detail = $('explain-detail');
  const applied = $('explain-applied') as HTMLButtonElement;
  const preview = $('explain-preview') as HTMLButtonElement;
  const center = $('explain-center');
  const velocity = $('explain-velocity');
  const shares = $('explain-shares');
  const submitted = $('explain-submitted');
  const instantaneous = $('explain-instantaneous');
  const factors = $('explain-factors');
  const limiter = $('explain-limiter');
  const contact = $('explain-contact');
  const after = $('explain-after');
  let shown: unknown[] = [];

  function render(state: BodyPanelState | null): void {
    panel.hidden = state === null;
    if (!state) {
      shown = [];
      return;
    }
    // Rebuilt only when what it shows changed: a new observation object, view, body or play state.
    const key = [state.explained, state.view, state.playing, state.present, state.observation, state.observation ? null : state.tick];
    if (key.length === shown.length && key.every((k, i) => k === shown[i])) return;
    shown = key;

    id.textContent = state.explained;
    applied.setAttribute('aria-checked', String(state.view === 'applied'));
    preview.setAttribute('aria-checked', String(state.view === 'preview'));
    preview.disabled = state.playing;
    const o = state.observation;
    detail.hidden = o === null;
    empty.hidden = o !== null;
    if (!o) {
      transition.textContent = '';
      empty.textContent = !state.present
        ? `${state.explained} is not in the scene at tick ${state.tick}.`
        : state.view === 'preview'
          ? 'A preview needs the simulation paused.'
          : `No step recorded for this body yet. Press Step or Play to record one${state.playing ? '' : ', or see Next step for what it would get now'}.`;
      return;
    }

    transition.textContent =
      `${o.kind === 'applied' ? 'Step' : 'Next step'} from tick ${o.fromTick} to ${o.toTick}, ${o.cursor === 0 ? 'laws as loaded' : `laws after ${o.cursor} applied edit${o.cursor === 1 ? '' : 's'}`}${o.kind === 'preview' ? ', if nothing changes first' : ''}`;
    fill(center, glyph('none'), 'Center, m', o.center, false);
    fill(velocity, glyph('velocity'), 'Velocity, m/s', o.velocity, true);

    // Laws whose sample at the center is exactly zero did not reach the body; they are named, not listed.
    const rows: HTMLElement[] = [];
    const idle: string[] = [];
    for (const c of o.contributions) {
      if (c.drag === 0 && c.drive[0] === 0 && c.drive[1] === 0 && c.drive[2] === 0) {
        idle.push(state.lawLabel(c.id));
        continue;
      }
      const row = document.createElement('div');
      row.className = 'readout-row';
      row.setAttribute('role', 'row');
      fill(row, glyph('share', state.lawColor(c.id)), state.lawLabel(c.id), c.applied, true, c.drag > 0 ? `drag ${num(c.drag)} s⁻¹ against the sampled velocity` : undefined);
      rows.push(row);
    }
    const gravity = document.createElement('div');
    gravity.className = 'readout-row';
    gravity.setAttribute('role', 'row');
    fill(gravity, glyph('share', 'var(--text-tertiary)'), 'Gravity', o.gravityApplied, true);
    rows.push(gravity);
    if (idle.length) {
      const note = document.createElement('div');
      note.className = 'readout-row';
      note.setAttribute('role', 'row');
      note.append(glyph('none'), span(`Not acting here: ${idle.join(', ')}`, 'sub'));
      rows.push(note);
    }
    shares.replaceChildren(...rows);
    fill(submitted, glyph('acceleration'), 'Submitted', o.submitted, true, 'force ÷ mass, the total of the shares above');
    const scaled = o.beta !== 1 || o.lambda !== 1;
    fill(instantaneous, glyph('none'), 'A − Kv', scaled ? o.instantaneous : null, true, scaled ? 'before β and λ' : undefined);

    factors.textContent = o.drag > 0 ? `β = ${num(o.beta, 4)} for drag K = ${num(o.drag)} s⁻¹ over one step` : 'β = 1: no drag at the center';
    const limited = o.lambda < 1;
    limiter.dataset.active = String(limited);
    limiter.textContent = limited
      ? `Limited: λ = ${num(o.lambda, 3)}. The total would have been ${num(Math.hypot(...o.submitted) / o.lambda, 1)} m/s², above the ${num(o.maxApplied, 0)} m/s² limit, so every share is scaled by λ.`
      : `Limiter not active: λ = 1 (limit ${num(o.maxApplied, 0)} m/s²)`;

    const partners = o.contacts;
    contact.dataset.contact = String(Boolean(partners?.length));
    if (partners === null) contact.textContent = 'Contacts are known once the step has run.';
    else if (!partners.length) contact.textContent = 'No contact impulse in this step.';
    else {
      contact.innerHTML = BURST;
      contact.append(`Contact with ${partners.join(', ')} in this step. Its impulse is not part of the law acceleration.`);
    }
    fill(after, glyph('velocity'), 'Velocity after', o.after?.velocity ?? null, true, o.after ? `at tick ${o.toTick}, contacts included` : undefined);
  }

  return { render };
}
