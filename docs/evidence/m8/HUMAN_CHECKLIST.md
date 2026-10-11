# M8 human verification checklist

These checks need a person: what you notice, what confuses you, and what a real keyboard and trackpad do. Write down what actually happened, in your own words. A step you could not observe is UNVERIFIED, not a pass. You do not need to run any tests, and nothing here asks you to repeat earlier milestones.

Use the packaged app: `src-tauri/target/release/bundle/macos/Lawsmith.app`. It is the reviewed candidate (application `fa4e223`).

## 1. Explore on your own first (AC8)

Do this before reading the rest of the list, so the guided steps do not shape what you try.

Open the app and spend a few minutes doing what you would naturally do:
- pick any example;
- select something, change it, reset;
- save to a new file and open it again.

Use only what the interface shows you. Note every moment of confusion and how you got past it, or what stopped you. If nothing confused you, say so.

## 2. The five examples (AC1)

Open each from **Open an example…**. Each opens paused, with its law selected and a one-line suggestion. Try to make the suggested change happen in at most three obvious actions, and note whether you could, and how many actions it took:

| Example | Intended change |
| --- | --- |
| Sideways Rain | Play, then drag the box into the falling rain: the stream bends |
| Catch and Release | Play, drag the pull into the stream (bodies are caught), then drag it away |
| Drag Pocket | Play, switch Drag pocket off, then on. Clicking a landed body shows the law's shares apart from its contacts |
| Storm Bottle | Play, then drag the bottle under the stream |
| Two Futures | **Compare from here**, change Strength in B, Play: the traveler separates |

## 3. One keyboard pass, with native files, at 200% (AC3, AC4)

Set Interface Scale to 200% (⌘+ until it reads 200%, or Display → Interface scale). Then, using only the keyboard:
- Use ordinary Tab. You do not need to change macOS Keyboard navigation.
- Open an example; select its law from the Laws list.
- Change its position, rotation, extent and strength.
- Switch the law off and on.
- Play, pause, step and reset; undo.
- Save through the macOS Save panel, then open the file again.
- Type in the law's Name field and check that T, R, S, F, Space and period stay in the text.

Every focused control should show a visible ring and stay readable. Note any control you could not reach, or any focus that disappeared.

The mandatory geometry check is 1280×800 content at 200%. That needs More Space (System Settings → Displays) or an external display, because the built-in display is smaller. The exact window sizes are already measured in 30 native cases; a window you size by hand does not prove exact geometry. Judge what you see at the size you can reach.

## 4. Real trackpad (AC2, AC9)

- Move and turn a law directly in the viewport, without using the details panel. In Sideways Rain, with the box selected, choose **Move** (or press T) and drag its handle. Then choose **Rotate** (or press R) and drag the rotation handle that appears, so the box turns. (**Adjust**, S, changes its extent, not its rotation.)
- Drag the window by the empty strip along the top, at 100% and at 200%. Note whether it follows your hand exactly, and any jump. Also try clicking the window while it is inactive and dragging straight away.
- Use the red, yellow and green buttons: close, minimize, full screen and back.

## 5. Reduce motion (AC6)

Turn on System Settings → Accessibility → Display → Reduce motion. Orbit the view and let go: the camera should stop at once. Turn it off again and note the difference.

## 6. Looking carefully (AC4, AC5, AC7)

- **Examples at every scale.** All five examples at 100%, 150% and 200%, at the normal size and at the compact 900×600 minimum. For reference, the existing full-window captures are [1280×800 at 200%](attempt8/captures/m8-sideways-rain-1280x800-200.png) and [compact 900×600 at 200%](attempt8/captures/m8-sideways-rain-900x600-200.png).
- **Labels and arrows.** Law names, the underline on the selected law, "off" on a disabled law, overlapping laws (click again to reach the one behind), a long law name, and arrows near zero and at their largest.
- **Panels.** **Hide laws** and **Hide details**, alone and together.
- **Comparison.** Comparison controls and labels (Undo/Redo, Replay, New Alternate) read clearly.
- **Fault banner.** Use Open… (⌘O) to open the disposable scene `scripts/verify/scenes/m8-comparison-fault.lawsmith.json`. Choose **Compare from here**, set Strength to 200 in the details, and press Play. The comparison faults. Scroll the right-hand column up until the error banner is in view, and check that it is readable and that **New Alternate** and **Close** work. Do this at 100% and at 200%. This is a fault in that scene's comparison, not a startup fault.
- **Developer readout.** Display → Developer readout at 200%: note whether it covers anything you need.

## 7. Replay seek and Space (still required)

Record a short experiment (**Record from tick 0**, change something, **Stop recording**), then **Replay recording**, and pause the replay. Then make two separate seeks, each from a paused replay. Press only one key or button during each seek; pressing both on the same seek cancels the request.

1. **Play during a seek.** Click a point on the replay timeline, then straight away click **Play** once. While the seek is still working, the status line may add "Then playing." Note whether that wraps the status or moves the buttons beside it. When the seek finishes, the replay should play from the point you chose.
2. **Space during a seek.** Pause again. Click a different point on the timeline, then straight away press Space once on the real keyboard (do not click Play). When the seek finishes, the replay should play from the latest point you chose.

While a seek is still working, the scene keeps showing where it was until the new point is ready. A seek may finish too quickly to see this. If you could not observe either case, record it as UNVERIFIED.

## Observations template

Copy this and fill it in plainly. Unobserved items stay UNVERIFIED.

```
Date / display (built-in, More Space, external):
1 Exploration (AC8): what I tried; confusion and how I got past it; blockers:
2 Examples: Sideways Rain / Catch and Release / Drag Pocket / Storm Bottle / Two Futures — actions taken, worked?:
3 Keyboard pass at 200%: unreachable controls; lost focus; Name-field keys; Save/Open:
4 Trackpad: law move in the viewport; law rotation in the viewport; window drag 100% / 200% (any jump?); traffic lights:
5 Reduce motion: on / off:
6 Visual: examples and scales; labels; panels; comparison; fault banner 100% / 200%; readout:
7 Seek: first seek with Play (status wrap or button movement; played from the point?); second seek with one Space (played from the latest point?):
Anything else:
```

## After your observations

1. Your observations go into `docs/evidence/M8.md` as received, with nothing added.
2. Any real failure is fixed, and only the affected checks run again.
3. You decide on acceptance.
4. Merging to `main`, pushing it and cleaning up the branch each need your separate go-ahead.
