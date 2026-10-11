// The native traffic lights of a Lawsmith window, as content-view boxes (JXA, System Events).
//   osascript -l JavaScript lights.js PID WIN_X WIN_Y → [{name, x, y, w, h}] relative to the window
// The content view fills the window (Overlay title bar), so its origin is the window's.
function run(argv) {
  const [pid, ox, oy] = argv.map(Number);
  const p = Application('System Events').processes.whose({ unixId: pid })[0];
  const w = p.windows.byName('Lawsmith');
  const out = [];
  for (const b of w.buttons()) {
    let role = '';
    try { role = b.subrole(); } catch (e) { continue; }
    if (!['AXCloseButton', 'AXMinimizeButton', 'AXZoomButton', 'AXFullScreenButton'].includes(role)) continue;
    const [x, y] = b.position();
    const [bw, bh] = b.size();
    out.push({ name: role, x: x - ox, y: y - oy, w: bw, h: bh });
  }
  return JSON.stringify(out);
}
