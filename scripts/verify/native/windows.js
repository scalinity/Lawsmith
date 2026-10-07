// On-screen window readback for native QA (CoreGraphics through JXA; nothing to compile).
//   osascript -l JavaScript windows.js hit X Y [IDS]  → the topmost on-screen window at (X, Y), any layer,
//                                                       skipping the comma-separated window IDS
//   osascript -l JavaScript windows.js list PID       → that process's on-screen windows, front to back
//   osascript -l JavaScript windows.js overlays       → IDs of on-screen windows above layer 1000 that
//                                                       cover the whole main display
// A window capture shows a covered window as if visible, so only this hit test proves what is on top.
ObjC.import('CoreGraphics');
function windows() {
  // kCGWindowListOptionOnScreenOnly (1) | kCGWindowListExcludeDesktopElements (16), front to back.
  return ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(17, 0))) || [];
}
const describe = (w) => ({ owner: w.kCGWindowOwnerName, pid: w.kCGWindowOwnerPID, layer: w.kCGWindowLayer, id: w.kCGWindowNumber, name: w.kCGWindowName || '', bounds: w.kCGWindowBounds });
function run(argv) {
  const all = windows();
  if (argv[0] === 'overlays') {
    const main = $.CGDisplayBounds($.CGMainDisplayID());
    return all
      .filter((w) => w.kCGWindowLayer > 1000 && w.kCGWindowBounds.X <= 0 && w.kCGWindowBounds.Y <= 0 && w.kCGWindowBounds.Width >= main.size.width && w.kCGWindowBounds.Height >= main.size.height)
      .map((w) => w.kCGWindowNumber)
      .join(',');
  }
  if (argv[0] === 'hit') {
    const x = Number(argv[1]);
    const y = Number(argv[2]);
    const skip = new Set((argv[3] || '').split(',').filter(Boolean).map(Number));
    for (const w of all) {
      if (skip.has(w.kCGWindowNumber)) continue;
      const b = w.kCGWindowBounds;
      if ((w.kCGWindowAlpha ?? 1) === 0) continue;
      // The pointer's own image is a window at the pointer; it never receives a click.
      if (w.kCGWindowOwnerName === 'Window Server' && w.kCGWindowName === 'Cursor') continue;
      if (x >= b.X && x < b.X + b.Width && y >= b.Y && y < b.Y + b.Height) return JSON.stringify(describe(w));
    }
    return JSON.stringify({ owner: null, pid: null });
  }
  return JSON.stringify(all.filter((w) => w.kCGWindowOwnerPID === Number(argv[1])).map(describe));
}
