# M8 human verification checklist

The earlier version of this list was paused after your first exploration of the `fa4e223` app. You found that deleting a law was hard to find, three examples did nothing until moved or retuned, the screen was crowded above 100%, and the trail and replay steps were confusing. Those findings are recorded in `docs/evidence/M8.md`. This list replaces it, for the repaired app.

Write down what actually happens, in your own words. A step you could not observe is UNVERIFIED, not a pass. Nothing here asks you to run tests or repeat earlier milestones.

**The new candidate is built** (application `8595013`, with the emitter-lock fix and Hide HUD). Before you start:
1. Save anything you want to keep in the Lawsmith window that is open now, then quit it (⌘Q). That window is an older build; please stop testing it.
2. Open exactly `/Users/danny/Documents/Apps/Lawsmith/src-tauri/target/release/bundle/macos/Lawsmith.app`.

Its identity and hashes are in `docs/evidence/M8.md` under the current status.

## 1. Explore again (AC8)

Before reading further, spend a few minutes doing what you would naturally do: pick an example, select, change, delete and reset a law, change how often the emitter drops bodies and how long it keeps them, save and reopen. Note any confusion and how you got past it, or what stopped you.

## 2. The five examples (AC1)

Open each from **Open an example…** and follow its one-line suggestion. Note whether the change happened within three obvious actions:

| Example | What should happen |
| --- | --- |
| Sideways Rain | Play, then drag the box into the rain: the stream bends |
| Catch and Release | Play: the pull catches the falling stream. Switch Pull off: the bodies fall |
| Drag Pocket | Play: bodies slow in the pocket. Switch Drag pocket off and on to compare |
| Storm Bottle | Play: the bottle holds a swirling storm. Drag it aside: the stream falls past |
| Two Futures | **Compare from here**, set Strength to 2, Play: the futures split |

## 3. Keyboard and files at 200% (AC3, AC4)

Set Interface Scale to 200% (⌘+). Every section now sits in one scrolling column on the left. A bar at its top jumps to Laws, Details, Scene or Recording and puts the keyboard there. Using only the keyboard, with ordinary Tab:
- open an example and select its law;
- change its position, rotation, extent and strength;
- switch it off and on;
- play, pause, step, reset and undo;
- save, then open the file again.

Note any control you could not reach, or any focus that disappeared.

## 4. Trackpad (AC2, AC9)

- In Sideways Rain, move the box with **Move** (T) and turn it with **Rotate** (R), directly in the view.
- Drag the window by the empty top strip at 100% and at 200%. Note any jump.
- Try the red, yellow and green window buttons.

## 5. Reduce motion (AC6)

Turn on System Settings → Accessibility → Display → Reduce motion. Orbit the view and let go: the camera should stop at once. Turn it off again.

## 6. Looking carefully (AC4, AC5, AC7)

- At 100%, 150% and 200%: is there room to see the scene? Use the section bar, **More** on the Recording card, and **Draw options**, which starts folded and stays as you leave it.
- **Delete** under the Laws list names the selected law. Undo brings the law back.
- **Emitter** (in the Scene section): set a spawn rate and how many seconds to keep each body, then **Apply and reset**. The line below shows the exact result. Typed values stay while you do other things, until you apply or **Revert**. Undo brings back the previous rate, and its tooltip says it resets the scene.
- **Emitter lock:** with the app freshly started, change the Emitter's rate before doing anything else; it should be editable. Press **Record from tick 0**: the Emitter block should say why it is locked and offer **Stop recording**. Do the same during a replay (**Return to authoring**) and a comparison (**Close comparison**).
- **Hide HUD:** press <kbd>H</kbd>, or **Hide HUD** at the bottom right. Only the scene should remain; play with <kbd>Space</kbd> and orbit. Press <kbd>H</kbd> or <kbd>Esc</kbd>: everything returns as it was, including folded cards and the selected law. Try typing an h in a number field: it types and hides nothing. Start dragging a law with Move and press <kbd>H</kbd> mid-drag: nothing should hide until you let go, and the move should stay undoable. Press <kbd>H</kbd> after letting go: it hides.
- **Swirl:** add a Swirl law on its own. Its details suggest adding Pull and Drag to keep bodies circling; try it.
- **Trails:** choose Selected body, click a moving body, and watch its path. Then try Up to 32 bodies.
- **Fault:** open `scripts/verify/scenes/m8-comparison-fault.lawsmith.json` (⌘O), choose **Compare from here**, set Strength to 200, and Play. A red error naming a speed of about 350 m/s should appear. That is the expected fault, and it is different from the amber "Acceleration limit reached" line. Scroll to the red error and use **New Alternate** and **Close**. Note whether they work.

## 7. Replay (ordinary use)

Press **Record from tick 0**, change something for a few seconds, then **Stop recording** and **Replay recording**. Pause, click or drag along the timeline, and press Space to play and pause. Note anything confusing.

The fleeting moment while a seek is still working is not yours to catch: a later automated check covers it, and it stays UNVERIFIED until then.

## Observations template

```
Date / display:
1 Exploration: what I tried; confusion and how I got past it; blockers:
2 Examples (each): did it work within three actions?:
3 Keyboard and files at 200%: unreachable controls; lost focus; save/open:
4 Trackpad: move and rotate in the view; window drag 100% / 200%; window buttons:
5 Reduce motion:
6 Looking: room at 100/150/200%; Delete; Emitter rate and lifetime (and Undo); emitter lock reasons; Hide HUD and restore; trails; fault error and its buttons:
7 Replay:
Anything else:
```

## After your observations

1. Your observations go into `docs/evidence/M8.md` as received.
2. Real failures are fixed, and only the affected checks run again.
3. Finishing this list does not make M8 ready to accept. These are still needed first:
   - one declared native batch for what the repair changed (examples, layout, default visuals, emitter controls), with your go-ahead once before it starts;
   - current performance (P0–P3), because the default visuals changed;
   - your observations here recorded, and any real failure fixed and its checks rerun.
4. Only then do you decide on acceptance. After acceptance, one explicit close-out instruction from you covers merge, push and safe branch cleanup.
