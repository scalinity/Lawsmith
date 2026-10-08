"""M6A checks over the packaged app's logs and a saved run file, independent of the app's own code.

  m6aq.py checkpoints LIVE_LOG REPLAY_LOG RUN_ID  every live run-checkpoint of RUN_ID has a replay one
                                                  at the same (tick, cursor), with equal state and engine digests
  m6aq.py final REC_LOG REPLAY_LOG RUN_ID         the recording's final check equals the replay's end digests,
                                                  and the app's own verdict was a match
  m6aq.py retained LOG                            each replay entered and returned from left the authoring
                                                  world's digests, revision and history exactly as they were
  m6aq.py runfile PATH                            the saved run's structure: a multi-boundary drag in one
                                                  transaction, same-tick commands, a triangle gain and its undo,
                                                  an enable change, the frozen endpoint; prints a summary
Each prints PASS or FAIL and a short reason.
"""
import json
import sys


def events(path, kind):
    out = []
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            at = line.find("[lawsmith] ")
            if at < 0:
                continue
            try:
                e = json.loads(line[at + len("[lawsmith] "):])
            except json.JSONDecodeError:
                continue
            if e.get("kind") == kind:
                out.append(e)
    return out


def checkpoints(live_log, replay_log, run_id):
    live = {(e["tick"], e["cursor"]): e for e in events(live_log, "run-checkpoint") if e["source"] == "live" and e["runId"] == run_id}
    replay = {(e["tick"], e["cursor"]): e for e in events(replay_log, "run-checkpoint") if e["source"] == "replay" and e["runId"] == run_id}
    if not live:
        return "FAIL", "no live checkpoints for this run"
    missing = sorted(set(live) - set(replay))
    differ = [a for a in live if a in replay and (live[a]["stateSha256"], live[a]["engineSha256"]) != (replay[a]["stateSha256"], replay[a]["engineSha256"])]
    if missing or differ:
        return "FAIL", f"missing {missing[:5]}, differing {differ[:5]}"
    return "PASS", f"{len(live)} checkpoints equal at {sorted(live)}"


def final(rec_log, replay_log, run_id):
    stopped = [e for e in events(rec_log, "recording") if e.get("action") == "stopped" and e["runId"] == run_id]
    done = [e for e in events(replay_log, "replay-complete") if e["runId"] == run_id]
    if not stopped or not done:
        return "FAIL", f"stopped {len(stopped)}, replay-complete {len(done)}"
    s, d = stopped[-1], done[-1]
    fc = s["finalCheck"]
    same_address = (d["tick"], d["cursor"]) == (s["finalTick"], s["lastAppliedSequence"])
    same_digests = (d["stateSha256"], d["engineSha256"]) == (fc["stateSha256"], fc["engineSha256"])
    verdict = d["check"]["kind"] == "match"
    if same_address and same_digests and verdict:
        return "PASS", f"({s['finalTick']}, {s['lastAppliedSequence']}) state {fc['stateSha256'][:12]} engine {fc['engineSha256'][:12]}"
    return "FAIL", f"address {same_address}, digests {same_digests}, verdict {d['check']}"


def retained(log):
    switches = events(log, "context-live")
    pairs = []
    entered = None
    for e in switches:
        if e["reason"] in ("replay", "open-recording") and entered is None:
            entered = e
        elif e["reason"] == "return" and entered is not None:
            pairs.append((entered, e))
            entered = None
    if not pairs:
        return "FAIL", "no replay entered and returned from"
    keys = ("tick", "cursor", "stateSha256", "engineSha256", "revision", "generation", "canUndo", "canRedo")
    bad = [(a["t"], [k for k in keys if a[k] != b[k]]) for a, b in pairs if any(a[k] != b[k] for k in keys)]
    if bad:
        return "FAIL", f"changed across replay: {bad[:3]}"
    return "PASS", f"{len(pairs)} replays left the authoring world, revision and history identical"


def runfile(path):
    r = json.load(open(path, encoding="utf-8"))
    cmds = r["commands"]
    seq_ok = [c["sequence"] for c in cmds] == list(range(1, len(cmds) + 1))
    order_ok = all(cmds[i]["atTick"] >= cmds[i - 1]["atTick"] for i in range(1, len(cmds)))
    by_tx = {}
    for c in cmds:
        by_tx.setdefault(c["transactionId"], []).append(c)
    multi = {tx: cs for tx, cs in by_tx.items() if len({c["atTick"] for c in cs}) > 1}
    ticks = {}
    for c in cmds:
        ticks.setdefault(c["atTick"], []).append(c["sequence"])
    same_tick = {t: s for t, s in ticks.items() if len(s) > 1}
    text = [json.dumps(c["payload"], sort_keys=True) for c in cmds]
    triangle = [i for i, t in enumerate(text) if '"triangle"' in t]
    undone = bool(triangle) and any('"triangle"' not in text[j] and cmds[j]["payload"].get("field", {}).get("id") == cmds[triangle[-1]]["payload"]["field"]["id"] for j in range(triangle[-1] + 1, len(cmds)))
    enabled = [c for c in cmds if c["payload"]["kind"] == "putField" and c["payload"]["field"]["enabled"] is False]
    endpoint_ok = r["lastAppliedSequence"] == (cmds[-1]["sequence"] if cmds else 0) and all(c["atTick"] <= r["finalTick"] for c in cmds)
    summary = {
        "format": r["format"],
        "runId": r["runId"],
        "commands": len(cmds),
        "finalTick": r["finalTick"],
        "lastAppliedSequence": r["lastAppliedSequence"],
        "stopped": r["stopped"],
        "finalCheck": r.get("finalCheck"),
        "multiBoundaryTransactions": {tx: [c["atTick"] for c in cs] for tx, cs in multi.items()},
        "sameTickGroups": same_tick,
        "triangleCommands": [cmds[i]["sequence"] for i in triangle],
        "triangleUndone": undone,
        "disableCommands": [c["sequence"] for c in enabled],
        "terminalCommands": ticks.get(r["finalTick"], []),
        "rootLaws": [f["id"] for f in r["root"]["semantic"]["fields"]],
        "qualification": r["qualification"],
    }
    ok = seq_ok and order_ok and endpoint_ok and multi and same_tick and triangle and undone and enabled and r["format"] == "lawsmith.run"
    return ("PASS" if ok else "FAIL"), json.dumps(summary)


if __name__ == "__main__":
    command, *args = sys.argv[1:]
    verdict, why = {"checkpoints": checkpoints, "final": final, "retained": retained, "runfile": runfile}[command](*args)
    print(verdict, why)
