# Room WebSocket

`ws(s)://<server>/room/{code}?role=game` for the game screen, `?role=phone` for phones (also under
`/api`). One game screen and two phone seats per room. Every message is a JSON object with a `type`.
The server relays; it never computes game state.

## Phone -> server
| Message | Meaning |
| --- | --- |
| `{"type":"join", "nickname":"Pip", "phone_id":"<random id kept in localStorage>", "player"?:1, "character"?:"bramble"}` | Take a seat. The same `phone_id` gets its old seat back after a reconnect. `player` is a preference. |
| `{"type":"tap", "action":"jump" \| "dodge_left" \| "dodge_right" \| "block"}` | Instant defense. Ignored before `join`. |
| `{"type":"ping"}` | Keepalive; answered with `pong`. |

Shouts don't go over the WebSocket: hold-to-talk audio goes to `POST /voice` (contract/api.md).

## Server -> phone
| Message | Meaning |
| --- | --- |
| `{"type":"joined", "room":"ABCD", "player":1, "nickname":"Pip"}` | Seated. Use `player` in `POST /voice`. |
| `{"type":"full", "room":"ABCD"}` | Both seats are taken by connected phones. |
| `state`, `event` | Relayed from the game screen (below). The last `state` is sent right after `joined`. |

## Server -> game
| Message | Meaning |
| --- | --- |
| `{"type":"join", "player":1, "nickname":"Pip", "character"?:"bramble"}` | A phone took a seat. Sent again for every seated phone when the game screen (re)connects. |
| `{"type":"tap", "player":1, "action":"dodge_left"}` | Relayed tap. |
| `{"type":"leave", "player":1}` | That phone disconnected. Its seat waits for the same `phone_id`. |
| `{"type":"play", "player":1, "move":Move, "loudness":0.8, "transcript":"thorn punch", "motion":Motion}` | Play a library move now. `motion` is inline, so no fetch is needed. `move.signature` is set. |
| `{"type":"charge", "player":2, "job":"job_...", "guess":{"name","type"}, "transcript":"..."}` | A live wildcard is generating. Always arrives before its `ready`. |
| `{"type":"ready", "player":2, "job":"job_...", "move":Move, "loudness":0.8, "motion":Motion}` | The wildcard is done. **Always carries a move**: if generation was rejected, it's the closest library move instead. `/job/{id}` agrees once this is sent. |
| `{"type":"narrate", "text":"And lo, Hush falls!"}` | A storybook narrator line to speak. |

## Game -> server (relayed to both phones)
| Message | Meaning |
| --- | --- |
| `{"type":"state", "round", "timer", "wins", "players":{1:{hp,energy,cooldowns,status},2:...}, "seats":{1:{nickname,character},2:...}}` | About 10 per second. The narrator reads `seats` for character names. |
| `{"type":"event", "event":GameEvent}` | Sim events (`hit`, `blocked`, `dodged`, `down`, `ko`, `round`) plus `round_start {round}` and `match_end {winner}`. They drive the narrator. |
