// The main display's mode, for checks that need a larger content area (P0 at 1600×1000).
//   display.js get                → "WIDTHxHEIGHT@HZ" of the current mode, in points
//   display.js set WIDTH HEIGHT   → switches to that HiDPI mode at the current refresh rate, for this
//                                   login session only: the saved display preference is untouched
ObjC.import('CoreGraphics');
ObjC.bindFunction('CGDisplayModeGetWidth', ['unsigned long', ['void *']]);
ObjC.bindFunction('CGDisplayModeGetHeight', ['unsigned long', ['void *']]);
ObjC.bindFunction('CGDisplayModeGetPixelWidth', ['unsigned long', ['void *']]);
ObjC.bindFunction('CGDisplayModeGetRefreshRate', ['double', ['void *']]);
ObjC.bindFunction('CGDisplayCopyDisplayMode', ['void *', ['unsigned int']]);
ObjC.bindFunction('CGBeginDisplayConfiguration', ['int', ['void **']]);
ObjC.bindFunction('CGConfigureDisplayWithDisplayMode', ['int', ['void *', 'unsigned int', 'void *', 'void *']]);
ObjC.bindFunction('CGCompleteDisplayConfiguration', ['int', ['void *', 'unsigned int']]);
const KCG_CONFIGURE_FOR_SESSION = 1;
function describe(m) {
  return `${$.CGDisplayModeGetWidth(m)}x${$.CGDisplayModeGetHeight(m)}@${Math.round($.CGDisplayModeGetRefreshRate(m))}`;
}
function run(argv) {
  const display = $.CGMainDisplayID();
  const current = $.CGDisplayCopyDisplayMode(display);
  if (argv[0] === 'get') return describe(current);
  const [width, height] = [Number(argv[1]), Number(argv[2])];
  const hz = Math.round(Number($.CGDisplayModeGetRefreshRate(current)));
  const options = $.NSDictionary.dictionaryWithObjectForKey($.NSNumber.numberWithBool(true), ObjC.castRefToObject($.kCGDisplayShowDuplicateLowResolutionModes));
  const modes = ObjC.castRefToObject($.CGDisplayCopyAllDisplayModes(display, options));
  for (let i = 0; i < modes.count; i++) {
    const m = ObjC.castObjectToRef(modes.objectAtIndex(i));
    // The bridge can return boxed numbers; compare plain values.
    const w = Number($.CGDisplayModeGetWidth(m));
    const h = Number($.CGDisplayModeGetHeight(m));
    const hidpi = Number($.CGDisplayModeGetPixelWidth(m)) === 2 * w;
    if (w === width && h === height && hidpi && Math.round(Number($.CGDisplayModeGetRefreshRate(m))) === hz) {
      const config = Ref();
      if ($.CGBeginDisplayConfiguration(config) !== 0) return 'begin failed';
      if ($.CGConfigureDisplayWithDisplayMode(config[0], display, m, null) !== 0) return 'configure failed';
      const done = $.CGCompleteDisplayConfiguration(config[0], KCG_CONFIGURE_FOR_SESSION);
      return done === 0 ? `set ${describe(m)}` : `complete failed ${done}`;
    }
  }
  return `no ${width}x${height} HiDPI mode at ${hz} Hz`;
}
