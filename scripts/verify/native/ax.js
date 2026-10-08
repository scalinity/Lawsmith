// Accessibility automation of a Lawsmith process's native panels and alerts (JXA, System Events).
// The deepest open sheet is searched first, so a Go to Folder or Replace sheet wins over its parent.
//   ax.js depth PID              → how many sheets are stacked on the front window (0, 1, 2)
//   ax.js fields PID             → the text fields of the deepest sheet: name and value
//   ax.js set PID NAME VALUE     → sets a text field ("*" for the first one) in the deepest sheet
//   ax.js press PID NAME         → presses the button NAME in the deepest sheet, else in the window
//   ax.js itempos PID NAME       → screen point of the item named NAME in the deepest sheet (a file)
//   ax.js value PID NAME         → the value of the element named NAME (the Save panel's "Where:")
//   ax.js choose PID POPUP ITEM  → opens the popup named POPUP and chooses its menu item ITEM
//   ax.js buttons PID            → the button names of the deepest sheet, one per line (which alert is up)
function containers(p) {
  const out = [];
  const w = p.windows[0];
  let level = w;
  const chain = [w];
  for (;;) {
    let next = null;
    try { if (level.sheets.length > 0) next = level.sheets[0]; } catch (e) {}
    if (!next) break;
    chain.push(next);
    level = next;
  }
  for (let i = chain.length - 1; i >= 0; i--) out.push(chain[i]);
  return out;
}
function find(container, role, name) {
  for (const e of container.entireContents()) {
    try {
      if (e.role() === role && (name === '*' || e.name() === name || e.description() === name)) return e;
    } catch (x) {}
  }
  return null;
}
function run(argv) {
  const [command, pid, name, value] = argv;
  const p = Application('System Events').processes.whose({ unixId: Number(pid) })[0];
  const stack = containers(p);
  if (command === 'depth') return String(stack.length - 1);
  if (command === 'itempos') {
    for (const e of stack[0].entireContents()) {
      try {
        if (e.name() === name || e.description() === name || String(e.value()) === name) {
          const [x, y] = e.position();
          const [w, h] = e.size();
          if (w > 0 && h > 0) return `${Math.round(x + w / 2)} ${Math.round(y + h / 2)}`;
        }
      } catch (x) {}
    }
    return 'not found';
  }
  if (command === 'choose') {
    const popup = find(stack[0], 'AXPopUpButton', name);
    if (!popup) return 'no popup';
    popup.actions['AXPress'].perform();
    delay(0.6);
    for (const e of popup.entireContents()) {
      try {
        if (e.role() === 'AXMenuItem' && e.name() === value) {
          e.actions['AXPress'].perform();
          return 'chosen';
        }
      } catch (x) {}
    }
    try { popup.actions['AXCancel'].perform(); } catch (x) {}
    return 'no item';
  }
  if (command === 'buttons') {
    const names = [];
    for (const e of stack[0].entireContents()) {
      try {
        if (e.role() === 'AXButton') names.push(e.name() || e.description());
      } catch (x) {}
    }
    return names.join('\n');
  }
  if (command === 'value') {
    for (const e of stack[0].entireContents()) {
      try {
        if (e.role() !== 'AXStaticText' && (e.name() === name || e.description() === name)) return String(e.value());
      } catch (x) {}
    }
    return 'not found';
  }
  for (const container of command === 'press' ? stack : [stack[0]]) {
    if (command === 'set') {
      const field = find(container, 'AXTextField', name) || find(container, 'AXComboBox', name);
      if (!field) continue;
      field.focused = true;
      field.value = value;
      return 'set';
    }
    if (command === 'press') {
      const button = find(container, 'AXButton', name);
      if (!button) continue;
      button.actions['AXPress'].perform();
      return 'pressed';
    }
  }
  return 'not found';
}
