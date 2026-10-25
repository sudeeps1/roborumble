import "./ui/fonts.css";
import "./ui/style.css";
import * as THREE from "three";
import { DEFAULT_CHARACTERS, JOIN_URL, MOCK, ROOM_CODE, TYPE_EFFECT, characterById } from "./config";
import type { LeaderboardEntry, LibraryStats, Player, Sim, SimEvent, Vec3 } from "./contract";
import { Flow, other, type FlowHooks, type Phase, type Seats } from "./game/flow";
import { httpApi, type Api } from "./net/api";
import { wsRoom, type Room } from "./net/room";
import { Stage, mjToThree } from "./render/stage";
import { buildArena, ringFlare } from "./render/arena";
import { RobotView, loadG1 } from "./render/robot";
import { Effects } from "./render/effects";
import { Hud, type Seat } from "./ui/hud";
import { Screens } from "./ui/screens";
import { Narrator } from "./audio/narrator";
import { sfx } from "./audio/sfx";
import { mockBackend } from "./mock/server";
import { StubSim } from "./mock/stubSim";

const $ = (id: string) => document.getElementById(id)!;

/** Puts the room code in the address bar, so a reload or a reopened tab comes back to the same room. */
function keepRoomInUrl() {
  try {
    if (new URLSearchParams(location.search).get("room") === ROOM_CODE) return;
    // Rebuilt by hand so flags like ?mock&debug keep their look (URLSearchParams writes them as mock=&debug=).
    const rest = location.search.replace(/^\?/, "").split("&").filter((kv) => kv && !/^room(=|$)/.test(kv));
    rest.push(`room=${encodeURIComponent(ROOM_CODE)}`);
    history.replaceState(history.state, "", `${location.pathname}?${rest.join("&")}${location.hash}`);
  } catch { /* only a convenience */ }
}

async function main() {
  keepRoomInUrl();
  const screens = new Screens($("screens"));
  const hud = new Hud($("hud"));
  hud.setVisible(false);
  screens.showLoading("Waking the automatons…");

  const stage = new Stage($("c") as HTMLCanvasElement);
  const arena = buildArena(stage);
  const effects = new Effects(stage);
  const narrator = new Narrator();

  let assets;
  try {
    assets = await loadG1();
  } catch (e) {
    screens.showError(`Couldn't load the G1 robot: ${(e as Error).message}`);
    throw e;
  }

  let replaced = false; // another game screen took this room: this one stops (see net/room.ts)
  let api: Api, room: Room, help: string[] = [];
  if (MOCK) ({ api, room, help } = mockBackend(assets.model, ROOM_CODE));
  else {
    api = httpApi();
    room = wsRoom(ROOM_CODE);
    let dropped = false;
    room.onStatus((s) => {
      if (s === "closed") hud.toast("Lost the room connection, reconnecting…");
      if (s === "open" && dropped) hud.toast(`Back in room ${ROOM_CODE}`);
      if (s === "closed" || s === "open") dropped = s === "closed";
      if (s !== "replaced") return;
      replaced = true;
      flow.toLobby();
      screens.showError(`Room ${ROOM_CODE} was just opened on another screen, so this one stepped aside.`,
        "The phones now play on the other screen. To play here instead, close that one and take the room back.", "Take the room back");
    });
  }

  // TODO: swap for Sudeep's sim (src/sim) when it lands; the StubSim only plays motions kinematically.
  const sim: Sim = new StubSim(assets.model);

  const robots: Record<Player, RobotView> = {
    1: new RobotView(assets, characterById(DEFAULT_CHARACTERS[1])),
    2: new RobotView(assets, characterById(DEFAULT_CHARACTERS[2])),
  };
  stage.world.add(robots[1].root, robots[2].root);

  let stats: LibraryStats | null = null;
  let leaderboard: LeaderboardEntry[] = [];
  let slowmo = 0;   // seconds of KO slow motion left (real time)
  let koZoom = 0;   // 0..1 camera push-in
  const joinUrl = JOIN_URL.replace("{code}", encodeURIComponent(ROOM_CODE));

  const seatsForHud = (seats: Seats): Record<Player, Seat> => ({
    1: { nickname: seats[1]?.nickname ?? "Player 1", character: characterById(seats[1]?.character ?? DEFAULT_CHARACTERS[1]), connected: !!seats[1]?.connected },
    2: { nickname: seats[2]?.nickname ?? "Player 2", character: characterById(seats[2]?.character ?? DEFAULT_CHARACTERS[2]), connected: !!seats[2]?.connected },
  });
  const refreshLobby = () => {
    if (replaced || flow.phase !== "lobby") return;
    const s = flow.seats;
    const hs = seatsForHud(s);
    screens.showLobby({
      code: ROOM_CODE, joinUrl, leaderboard, stats, canStart: flow.canStart(), help,
      seats: { 1: s[1] ? hs[1] : null, 2: s[2] ? hs[2] : null },
    });
  };
  const screenAt = (v: THREE.Vector3) => stage.toScreen(v);
  const name = (p: Player) => flow.characterOf(p).name;

  const hooks: FlowHooks = {
    phase(phase: Phase) {
      if (phase === "lobby") {
        hud.setVisible(false);
        refreshLobby();
      } else if (phase === "loading") {
        screens.showLoading("The fairy ring awakens…");
      } else if (phase === "intro" || phase === "fight" || phase === "roundEnd") {
        screens.hide();
        hud.setVisible(true);
        if (phase === "intro") { slowmo = 0; koZoom = 0; }
      }
    },
    seats(seats, joined) {
      for (const p of [1, 2] as const) robots[p].setCharacter(characterById(seats[p]?.character ?? DEFAULT_CHARACTERS[p]));
      hud.setPlayers(seatsForHud(seats));
      if (joined) sfx.join();
      refreshLobby();
    },
    roundStart(round, wins) {
      hud.setRound(round, wins);
      hud.banner(`Round ${round}`, round === 1 ? "Let the duel begin" : undefined, 1600);
      sfx.roundStart();
    },
    fightStart() {
      hud.banner("Fight!", undefined, 900);
    },
    roundEnd(winner, reason, wins) {
      hud.setRound(flow.round, wins);
      hud.clearFloating(); // last-second move names would sit on top of the round banner
      hud.banner(winner ? `${name(winner)} wins the round` : "A draw!", reason === "time" ? "Time is up" : undefined, 2600);
      sfx.roundEnd();
    },
    matchEnd(winner, wins) {
      hud.setVisible(false);
      screens.showMatchEnd(winner, seatsForHud(flow.seats), wins, () => flow.rematch());
    },
    movePlayed(p, move, motion) {
      hud.flashMove(p, move);
      sfx.cast(move.type, move.kind);
      const effect = move.effect && move.effect !== "none" ? move.effect : TYPE_EFFECT[move.type];
      // live(): asked on the hit frame. A caster knocked down before it lost the move, so skip its impact visuals.
      const live = () => { const s = sim.state(p).status; return s !== "down" && s !== "ko"; };
      effects.cast({ effect, type: move.type, kind: move.kind, power: move.power }, robots[p].center(), robots[other(p)].center(), (move.hit_frame ?? 0) / (motion.fps || 30), live);
    },
    fizzle(p, why) {
      hud.fizzle(p, why);
      sfx.fizzle();
    },
    charging(p, guess, on) {
      hud.charging(p, guess, on);
      effects.charging(p, robots[p].feet(), on, robots[p].character.glow);
      sfx.charge(p, on);
    },
    simEvent(e: SimEvent) {
      onSimEvent(e);
    },
    narrate(text) {
      narrator.say(text);
      hud.caption(text);
    },
    stats(s) {
      stats = s;
      hud.setLibrary(s);
      refreshLobby();
    },
    leaderboard(l) {
      leaderboard = l;
      refreshLobby();
    },
    toast(text) {
      hud.toast(text);
      if (flow.phase === "loading" && !flow.simReady) screens.showLoading(text);
    },
  };

  // A NaN contact point would become a NaN light position and blank every lit pixel: fall back to the chest.
  const pointOr = (p: Vec3 | undefined, fallback: Player) =>
    p && Number.isFinite(p[0] + p[1] + p[2]) ? mjToThree(p) : robots[fallback].center();

  function onSimEvent(e: SimEvent) {
    switch (e.kind) {
      case "hit": {
        const at = pointOr(e.point, other(e.attacker));
        const damage = Number.isFinite(e.damage) ? e.damage : 10;
        const strength = Math.min(1.5, Math.max(0.3, damage / 14)) * (e.clean ? 1.25 : 1);
        effects.hit(at, e.type, e.clean, damage);
        ringFlare(at, Math.min(1.2, 0.4 + damage / 25)); // the fairy ring answers the blow
        stage.shake(0.012 + 0.03 * strength);
        sfx.hit(e.type, strength, e.clean);
        hud.damage(screenAt(at), damage, e.type, e.clean);
        break;
      }
      case "blocked": {
        const at = pointOr(e.point, e.defender);
        effects.blocked(at);
        sfx.block();
        hud.floatText(screenAt(at), "Blocked!");
        break;
      }
      case "dodged": {
        const at = robots[e.defender].center();
        effects.dodged(at);
        sfx.dodge();
        hud.floatText(screenAt(robots[e.defender].overhead()), "Dodged!");
        break;
      }
      case "down": {
        effects.down(robots[e.player].feet());
        sfx.down();
        stage.shake(0.04);
        hud.floatText(screenAt(robots[e.player].overhead()), "Down!");
        break;
      }
      case "ko": {
        slowmo = 1.6;
        sfx.ko();
        stage.shake(0.08);
        const loser = e.loser;
        ringFlare(robots[loser].feet(), 1.5);
        // The title waits for the fall: shown at once it sat on the finishing move's name and its
        // "invented by <nickname>" line (the credit is the point of a player-made move) and on the falling body.
        setTimeout(() => {
          if (flow.phase === "fight") hud.banner("K.O.", undefined, 1800);
          effects.ko(robots[loser].feet(), robots[loser].character.glow);
        }, 1200);
        break;
      }
      case "round":
        break;
    }
  }

  const flow = new Flow(sim, api, room, hooks);
  if (new URLSearchParams(location.search).has("debug")) Object.assign(window, { __game: { stage, sim, robots, flow, effects, hud } });
  screens.onPick((p, id) => flow.pickCharacter(p, id));
  screens.onStart(() => void flow.startMatch());

  // Keyboard: Enter starts / rematches, Esc back to the lobby (from a fight too; the room and seats stay),
  // A/D and J/L pick characters in the lobby, M mutes everything, V mutes only the narrator's voice (captions stay).
  let muted = false, voiceOff = false;
  addEventListener("keydown", (e) => {
    sfx.unlock();
    narrator.unlock();
    if (e.repeat || replaced) return;
    if (e.code === "Enter") {
      if (flow.phase === "lobby") void flow.startMatch();
      else if (flow.phase === "matchEnd") flow.rematch();
    } else if (e.code === "Escape") {
      flow.toLobby();
    } else if (e.code === "KeyM") {
      muted = !muted;
      sfx.setEnabled(!muted);
      narrator.setEnabled(!muted && !voiceOff);
      hud.toast(muted ? "Sound off (M)" : "Sound on (M)");
    } else if (e.code === "KeyV") {
      voiceOff = !voiceOff;
      narrator.setEnabled(!muted && !voiceOff);
      hud.toast(voiceOff ? "Narrator voice off, captions stay (V)" : "Narrator voice on (V)");
    } else if (flow.phase === "lobby") {
      const pick: Record<string, [Player, 1 | -1]> = { KeyA: [1, -1], KeyD: [1, 1], KeyJ: [2, -1], KeyL: [2, 1] };
      const hit = pick[e.code];
      if (hit) flow.cycleCharacter(hit[0], hit[1]);
    }
  });
  addEventListener("pointerdown", () => { sfx.unlock(); narrator.unlock(); });

  // WebGL context loss (GPU reset): the arena goes blank, so pause the fight (no sim steps, no round clock) until
  // three.js gets the context back. If it doesn't come back, say so: a reload keeps the room (code in the URL).
  let lostTimer = 0;
  stage.onContext((lost) => {
    clearTimeout(lostTimer);
    if (lost) {
      hud.toast("The arena flickered out: the duel is paused while it comes back…");
      lostTimer = window.setTimeout(() => {
        if (stage.lost && !replaced) screens.showError("The graphics card stopped drawing the arena.",
          "Reload this page. The room code is in the address bar, so both phones keep their seats.", "Reload");
      }, 5000);
    } else {
      arena.restore();
      hud.toast("The arena is back");
    }
  });

  // Main loop
  const timer = new THREE.Timer();
  timer.connect(document); // pauses cleanly when the tab is hidden
  const projectileTmp: THREE.Vector3[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  let frameErrors = 0;
  // Scheduled first: one exception in a frame (a brand-new sim, an effect) must never freeze the whole game.
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    try {
      frame(now);
    } catch (e) {
      if (frameErrors++ % 600 === 0) console.error(`frame failed (${frameErrors}x)`, e);
    }
  };
  const frame = (now: number) => {
    timer.update(now);
    if (stage.lost) { // nothing can be drawn: hold the fight still (phones still get state)
      flow.update(0, performance.now());
      return;
    }
    const realDt = Math.min(0.05, timer.getDelta());
    const t = timer.getElapsed();
    const scale = slowmo > 0 ? 0.3 : 1;
    slowmo = Math.max(0, slowmo - realDt);
    koZoom += ((slowmo > 0 ? 1 : 0) - koZoom) * Math.min(1, realDt * 2.5);
    const dt = realDt * scale;

    if (flow.simReady) {
      sim.step(dt);
      for (const p of [1, 2] as const) {
        const s = sim.state(p);
        robots[p].update(s, t, dt);
        hud.setVitals(p, s);
      }
      const ps = sim.projectiles();
      while (projectileTmp.length < ps.length) projectileTmp.push(new THREE.Vector3());
      effects.projectiles(ps.map((q, i) => ({ pos: mjToThree(q.pos, projectileTmp[i]), type: q.type, effect: q.effect, owner: q.owner })));
    }
    flow.update(realDt, performance.now());
    if (flow.tickSecond() > 0) sfx.tick();
    // Effects run on real time even during the KO slow motion: on the slowed clock the finishing hit's flashes,
    // lights and sparks (a strike's above all) washed the arena white for over a second and hid the fall.
    effects.update(realDt, t);
    arena.update(t, realDt);
    hud.setAnchors(screenAt(robots[1].overhead(a)), screenAt(robots[2].overhead(b)));
    hud.setTimer(flow.phase === "fight" || flow.phase === "intro" || flow.phase === "roundEnd" ? flow.timer : null);
    stage.render(realDt, robots[1].center(a), robots[2].center(b), koZoom);
  };
  requestAnimationFrame(loop);

  hud.setPlayers(seatsForHud(flow.seats));
  try {
    await flow.boot();
  } catch (e) { // sim.init() threw: without this the loading page would just sit there
    screens.showError(`The fight sim didn't start: ${(e as Error)?.message ?? e}`, "Open the browser console for the details, fix it, then try again.");
    throw e;
  }
}

main().catch((e) => console.error(e));
