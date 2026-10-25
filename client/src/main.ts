import "./ui/style.css";
import * as THREE from "three";
import { JOIN_URL, MOCK, ROOM_CODE, TYPE_EFFECT, characterById } from "./config";
import type { LeaderboardEntry, LibraryStats, Player, Sim, SimEvent } from "./contract";
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

async function main() {
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

  let api: Api, room: Room, help: string[] = [];
  if (MOCK) ({ api, room, help } = mockBackend(assets.model, ROOM_CODE));
  else {
    api = httpApi();
    room = wsRoom(ROOM_CODE);
    room.onStatus((s) => s === "closed" && hud.toast("Lost the room connection, reconnecting…"));
  }

  // TODO: swap for Sudeep's sim (src/sim) when it lands; the StubSim only plays motions kinematically.
  const sim: Sim = new StubSim(assets.model);

  const robots: Record<Player, RobotView> = {
    1: new RobotView(assets, characterById("bramble")),
    2: new RobotView(assets, characterById("hush")),
  };
  stage.world.add(robots[1].root, robots[2].root);

  let stats: LibraryStats | null = null;
  let leaderboard: LeaderboardEntry[] = [];
  let slowmo = 0;   // seconds of KO slow motion left (real time)
  let koZoom = 0;   // 0..1 camera push-in
  const joinUrl = JOIN_URL.replace("{code}", encodeURIComponent(ROOM_CODE));

  const seatsForHud = (seats: Seats): Record<Player, Seat> => ({
    1: { nickname: seats[1]?.nickname ?? "Player 1", character: characterById(seats[1]?.character ?? "bramble"), connected: !!seats[1]?.connected },
    2: { nickname: seats[2]?.nickname ?? "Player 2", character: characterById(seats[2]?.character ?? "hush"), connected: !!seats[2]?.connected },
  });
  const refreshLobby = () => {
    if (flow.phase !== "lobby") return;
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
      for (const p of [1, 2] as const) robots[p].setCharacter(characterById(seats[p]?.character ?? (p === 1 ? "bramble" : "hush")));
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
      effects.cast({ effect, type: move.type, kind: move.kind, power: move.power }, robots[p].center(), robots[other(p)].center(), (move.hit_frame ?? 0) / (motion.fps || 30));
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

  function onSimEvent(e: SimEvent) {
    switch (e.kind) {
      case "hit": {
        const at = mjToThree(e.point);
        const strength = Math.min(1.5, Math.max(0.3, e.damage / 14)) * (e.clean ? 1.25 : 1);
        effects.hit(at, e.type, e.clean, e.damage);
        ringFlare(at, Math.min(1.2, 0.4 + e.damage / 25)); // the fairy ring answers the blow
        stage.shake(0.012 + 0.03 * strength);
        sfx.hit(e.type, strength, e.clean);
        hud.damage(screenAt(at), e.damage, e.type, e.clean);
        break;
      }
      case "blocked": {
        const at = mjToThree(e.point);
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
        hud.banner("K.O.", undefined, 2200);
        const loser = e.loser;
        ringFlare(robots[loser].feet(), 1.5);
        setTimeout(() => effects.ko(robots[loser].feet(), robots[loser].character.glow), 1200);
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

  // Keyboard: Enter starts / rematches, Esc back to the lobby, A/D and J/L pick characters in the lobby, M mutes.
  let muted = false;
  addEventListener("keydown", (e) => {
    sfx.unlock();
    narrator.unlock();
    if (e.repeat) return;
    if (e.code === "Enter") {
      if (flow.phase === "lobby") void flow.startMatch();
      else if (flow.phase === "matchEnd") flow.rematch();
    } else if (e.code === "Escape" && (flow.phase === "matchEnd" || flow.phase === "roundEnd")) {
      flow.toLobby();
    } else if (e.code === "KeyM") {
      muted = !muted;
      sfx.setEnabled(!muted);
      narrator.setEnabled(!muted);
      hud.toast(muted ? "Sound off (M)" : "Sound on (M)");
    } else if (flow.phase === "lobby") {
      const pick: Record<string, [Player, 1 | -1]> = { KeyA: [1, -1], KeyD: [1, 1], KeyJ: [2, -1], KeyL: [2, 1] };
      const hit = pick[e.code];
      if (hit) flow.cycleCharacter(hit[0], hit[1]);
    }
  });
  addEventListener("pointerdown", () => { sfx.unlock(); narrator.unlock(); });

  // Main loop
  const timer = new THREE.Timer();
  timer.connect(document); // pauses cleanly when the tab is hidden
  const projectileTmp: THREE.Vector3[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  const loop = (now: number) => {
    timer.update(now);
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
    effects.update(dt, t);
    arena.update(t, realDt);
    hud.setAnchors(screenAt(robots[1].overhead(a)), screenAt(robots[2].overhead(b)));
    hud.setTimer(flow.phase === "fight" || flow.phase === "intro" || flow.phase === "roundEnd" ? flow.timer : null);
    stage.render(realDt, robots[1].center(a), robots[2].center(b), koZoom);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  hud.setPlayers(seatsForHud(flow.seats));
  await flow.boot();
}

main().catch((e) => console.error(e));
