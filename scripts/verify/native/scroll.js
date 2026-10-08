// Posts one pixel-unit scroll-wheel event, delivered to the window under the pointer: the harness
// moves the pointer there first and hit-tests it, as for a click. A negative DY scrolls content up.
//   osascript -l JavaScript scroll.js DY
ObjC.import('CoreGraphics');
function run(argv) {
  const dy = Number(argv[0]);
  const event = $.CGEventCreateScrollWheelEvent2(null, 0, 1, dy, 0, 0);
  $.CGEventPost(0, event);
  return 'scrolled';
}
