// M8 review R-FB4: the Undo and Redo titles say what the next step will actually do. A law step keeps the
// motion that already happened; an emitter step rebuilds the scene from tick 0. Executes the production
// historyTitle from src/main.ts against a real DocumentController's history, interleaved.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createContext, runInContext } from 'node:vm';
import { beforeAll, describe, expect, it } from 'vitest';
import { DocumentController } from '../src/domain/document';
import { cloneFrozen } from '../src/domain/scene';
import { EXAMPLES, exampleDocument } from '../src/scenes/examples';
import { SimulationHost, initSimulation } from '../src/simulation/host';

beforeAll(async () => {
  await initSimulation();
});

const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const start = source.indexOf('  const historyTitle = (action');
const end = source.indexOf('\n  };\n', start) + 5;
const context = createContext({});
runInContext(`${stripTypeScriptTypes(source.slice(start, end))}\nglobalThis.historyTitle = historyTitle;`, context);
const title = (action, next) => context.historyTitle(action, next);

const LAW = 'Motion that already happened stays as it was.';
const RESET = 'rebuilds the scene from tick 0';

describe('Undo and Redo say what they will do', () => {
  it('follows an interleaved history of law edits and an emitter change', () => {
    const document = exampleDocument(EXAMPLES.find((e) => e.key === 'sideways-rain'));
    const host = new SimulationHost(cloneFrozen(document.semantic));
    const c = new DocumentController(document, host);
    const law = c.scene.fields[0];
    const strength = (v) => c.editField(law.id, 'Strength', (f) => ({ ...f, expression: { ...f.expression, strength: v } }));
    expect(title('undo', c.nextUndo)).toContain(LAW); // nothing to undo: the law wording
    strength(9); c.settle();
    c.setEmitterSchedule(c.scene.emitters[0].id, { intervalTicks: 5, lifetimeTicks: 1000 });
    strength(11); c.settle();

    const steps = [];
    for (let i = 0; i < 3; i++) {
      steps.push(title('undo', c.nextUndo));
      expect(c.undo().ok).toBe(true);
      c.settle();
    }
    expect(steps[0]).toContain(LAW);
    expect(steps[1]).toContain(RESET);
    expect(steps[1]).toMatch(/^Undo the emitter change/);
    expect(steps[2]).toContain(LAW);

    expect(title('redo', c.nextRedo)).toContain(LAW);
    c.redo(); c.settle();
    expect(title('redo', c.nextRedo)).toMatch(/^Redo the emitter change: rebuilds the scene from tick 0/);
    c.redo(); c.settle();
    expect(title('redo', c.nextRedo)).toContain(LAW);
    host.dispose();
  });
});
