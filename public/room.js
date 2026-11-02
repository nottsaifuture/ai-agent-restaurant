"use strict";

// The visible restaurant: a cha chaan teng picture, with staff drawn on top.
// Where each staff member stands shows what they are doing:
//   at the counter = working on an order · in the aisle = order ready for review
//   by the cash register with "!" = waiting for your approval · dining floor = idle · "z" = hasn't checked in lately
// The picture is public/cha-chaan-teng-1320.webp (JPEG fallback). Cream bars are cropped.
// Staff feet are in the same 660×371.67 space as that picture.
window.Room = (() => {
  const VW = 660;
  const VH = 1115 / 3; // source frame is 1980×1115, drawn at 1/3

  // Two staff never share a point, and never stand within one body-width of each other.
  const MIN_SEP = 36;
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  // Feet must stay off the cash-register bell and the door mailbox.
  // `r` is the exclusion around the feet. The sprite box is checked separately
  // so a tall figure cannot cover the bell or the flag.
  const obstacles = [
    { name: "bell", x: 468, y: 268, r: 52, sprite: [452, 240, 498, 276] },
    { name: "door", x: 96, y: 148, r: 44, sprite: [70, 120, 130, 176] },
  ];

  // One shared list. Measured on open floor tiles in the picture:
  // stoves = in front of the cooking line, pass = the aisle, host = in front of
  // the cash register (clear of the bell), lounge = the dining floor.
  const floorSpots = dedupe([
    { zone: "stove", x: 298, y: 202 },
    { zone: "stove", x: 320, y: 236 },
    { zone: "stove", x: 366, y: 242 },
    { zone: "pass", x: 228, y: 202 },
    { zone: "pass", x: 262, y: 224 },
    { zone: "pass", x: 292, y: 268 },
    { zone: "pass", x: 402, y: 262 },
    { zone: "host", x: 410, y: 334 },
    { zone: "host", x: 348, y: 278 },
    { zone: "lounge", x: 172, y: 300 },
    { zone: "lounge", x: 138, y: 324 },
    { zone: "lounge", x: 104, y: 302 },
    { zone: "lounge", x: 384, y: 298 },
  ]);

  function dedupe(spots) {
    const out = [];
    for (const s of spots) {
      if (s.x < 0 || s.y < 0 || s.x > VW || s.y > VH) continue;
      if (blocked(s.x, s.y)) continue;
      if (out.some((o) => dist(o, s) < MIN_SEP)) continue;
      out.push(s);
    }
    return out;
  }

  function clamp(x, y) {
    const m = 20;
    return [
      Math.min(VW - m, Math.max(m, x)),
      Math.min(VH - m, Math.max(m, y)),
    ];
  }

  function tooClose(x, y, occupied, sep = MIN_SEP) {
    return occupied.some(([ox, oy]) => (ox - x) ** 2 + (oy - y) ** 2 < sep * sep);
  }

  function blocked(x, y) {
    for (const o of obstacles) {
      if ((o.x - x) ** 2 + (o.y - y) ** 2 < o.r * o.r) return true;
      // The figure rises above its feet. Keep that box off the bell and the door.
      const sx0 = x - 18, sy0 = y - 78, sx1 = x + 34, sy1 = y + 8;
      const [bx0, by0, bx1, by1] = o.sprite;
      if (sx0 < bx1 && sx1 > bx0 && sy0 < by1 && sy1 > by0) return true;
    }
    return false;
  }

  function firstFree(zone, occupied) {
    for (const s of floorSpots) {
      if (s.zone !== zone) continue;
      if (tooClose(s.x, s.y, occupied)) continue;
      return [s.x, s.y];
    }
    return null;
  }

  // When a zone is full, walk to a new row toward the front of the floor (+y)
  // instead of sliding up/right onto the bell, the door, or off the 660-wide frame.
  // Laps are capped; after that a grid inside the viewBox is used.
  function overflow(occupied) {
    const tryPoint = (x, y) => {
      const p = clamp(x, y);
      if (blocked(p[0], p[1]) || tooClose(p[0], p[1], occupied)) return null;
      return p;
    };
    const MAX_LAPS = 3;
    const ROW = 28;
    for (let lap = 1; lap <= MAX_LAPS; lap++) {
      for (const s of floorSpots) {
        const y = s.y + ROW * lap;
        for (const x of [s.x, s.x - MIN_SEP, s.x + MIN_SEP]) {
          const p = tryPoint(x, y);
          if (p) return p;
        }
      }
    }
    for (let y = 220; y <= VH - 20; y += MIN_SEP) {
      for (let x = 36; x <= VW - 36; x += MIN_SEP) {
        const p = tryPoint(x, y);
        if (p) return p;
      }
    }
    // Still packed: stay inside the frame and off the bell/door, a little closer.
    for (let i = 0; i < 240; i++) {
      const x = 40 + ((i * 47) % (VW - 80));
      const y = 200 + ((i * 29) % Math.floor(VH - 230));
      if (!blocked(x, y) && !tooClose(x, y, occupied, 28)) return clamp(x, y);
    }
    return clamp(VW / 2, VH - 24);
  }

  function prefsFor(flags) {
    const prefs = [];
    if (flags.asking) prefs.push("host");
    if (flags.doing) prefs.push("stove");
    if (flags.doing || flags.todo) prefs.push("pass");
    if (flags.ready) prefs.push("pass");
    prefs.push("lounge");
    return prefs;
  }

  function moodFor(zone, flags, recent, st) {
    if (zone === "host") return ["ask", "waiting for your approval"];
    if (zone === "stove") return ["cook", `cooking order #${flags.doing.id}: ${flags.doing.title}`];
    if (zone === "pass" && flags.doing) return ["cook", `working on #${flags.doing.id}`];
    if (zone === "pass" && flags.todo) return ["read", `has order #${flags.todo.id} to start`];
    if (zone === "pass" && flags.ready) return ["ready", `order #${flags.ready.id} is ready for you`];
    const extra = recent ? "free for work" : st.last_seen ? "resting (hasn't checked in lately)" : "hasn't checked in yet";
    return [recent ? "idle" : "sleep", extra];
  }

  // Assign every staff member a spot. Zone spots are handed out first (so a cook
  // is not left standing on an idle person's overflow), then overflow fills the rest.
  function placeStaff(people) {
    const occupied = [];
    const placed = new Array(people.length);
    const waiting = [];
    people.forEach((p, order) => {
      let spot = null;
      let zone = null;
      for (const z of p.prefs) {
        spot = firstFree(z, occupied);
        if (spot) { zone = z; break; }
      }
      if (spot) {
        occupied.push(spot);
        placed[order] = { ...p, spot, zone };
      } else waiting.push(order);
    });
    for (const order of waiting) {
      const spot = overflow(occupied);
      occupied.push(spot);
      placed[order] = { ...people[order], spot, zone: "lounge" };
    }
    return placed;
  }

  const escX = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // "0" and "9" sit in a circle. "10" and above use a pill so the glyphs are not clipped.
  function countLabel(n) {
    const v = Math.max(0, Math.floor(Number(n) || 0));
    return v > 99 ? "99+" : String(v);
  }
  function badge(n, x, y) {
    const label = countLabel(n);
    const v = Math.max(0, Math.floor(Number(n) || 0));
    const wide = label.length > 1;
    const w = 12 + label.length * 7;
    const shape = wide
      ? `<rect x="${(-w / 2).toFixed(1)}" y="-9" width="${w}" height="18" rx="9"/>`
      : `<circle r="9"/>`;
    return `<g class="r-count${v === 0 ? " zero" : ""}${wide ? " wide" : ""}" transform="translate(${x} ${y})" aria-hidden="true">${shape}<text y="4" text-anchor="middle">${label}</text></g>`;
  }

  let bgHrefCache = "";
  function backgroundHref() {
    if (bgHrefCache) return bgHrefCache;
    let href = "/cha-chaan-teng-1320.jpg";
    try {
      if (typeof document !== "undefined") {
        const c = document.createElement("canvas");
        if (c.toDataURL("image/webp").startsWith("data:image/webp")) href = "/cha-chaan-teng-1320.webp";
      }
    } catch { /* JPEG fallback when WebP cannot be detected */ }
    bgHrefCache = href;
    return href;
  }

  const layers = []; // { y, id, svg } painter's order, larger y in front
  const labels = [];
  const add = (y, id, svg) => layers.push({ y, id, svg });

  // Everyday cha chaan teng floor staff, not a hotel waiter.
  // White shirt for the chief, a plain polo in each helper's own hue, dark
  // trousers, a short waist apron. A pen sits behind the ear. Someone carrying
  // an order holds a steel tray with a thick milk-tea cup; someone taking an
  // order holds a chit and a pen. No waistcoat, bow tie, pocket square or jacket.
  function character(st, cx, cy, mood, extra) {
    const kit = uniformOf(st);
    const top = -56; // top of the hair
    const prop = mood === "cook" || mood === "ready" ? "tray" : mood === "read" || mood === "ask" ? "pad" : "rest";
    const q = st.quota;
    const battery = q == null ? "" :
      `<g transform="translate(-30 -50)"><rect class="r-batt" width="14" height="7" rx="1.5"/><rect class="r-batt-fill ${q < 20 ? "low" : q < 50 ? "mid" : ""}" x="1" y="1" width="${Math.max(1, (12 * q) / 100).toFixed(1)}" height="5" rx="1"/></g>`;
    const bubble = {
      cook: `<text class="r-bubble-emoji" y="${top - 6}">🍳</text>`,
      ask: `<g class="r-ask" transform="translate(0 ${top - 12})"><circle r="10"/><text y="5" text-anchor="middle">!</text></g>`,
      sleep: `<text class="r-zzz" x="12" y="${top - 12}">z z</text>`,
      ready: `<text class="r-bubble-emoji" y="${top - 6}">🔔</text>`,
      read: `<text class="r-bubble-emoji" y="${top - 6}">📄</text>`,
      idle: "",
    }[mood];
    const svg = `
      <g class="r-staff ${mood}${kit.chief ? " chief" : ""}" data-staff="${st.id}" transform="translate(${cx.toFixed(1)} ${cy.toFixed(1)})" tabindex="0" role="button" aria-label="${escX(st.name)}">
        <title>${escX(st.name)}: ${escX(extra)}</title>
        <ellipse class="r-shadow" rx="15" ry="6"/>
        <g class="r-body">
          ${floorBody(kit, { legs: true, prop })}
          ${staffHead(false)}
          ${penBehindEar(1)}
          ${battery}
          ${bubble}
        </g>
      </g>`;
    // Names go on a top layer so nobody stands in front of a name.
    // paint-order="stroke" draws the cream outline first so it does not eat the glyphs.
    labels.push(`<text class="r-name" data-staff="${st.id}" x="${cx.toFixed(1)}" y="${(cy + 16).toFixed(1)}" text-anchor="middle" paint-order="stroke">${escX(st.name)}${kit.chief ? " ★" : ""}</text>`);
    add(cy, st.id, svg);
  }

  // Chief keeps the classic white short-sleeve shirt plus a plastic name badge.
  // Helpers wear a simple polo in their own hue (collar a shade darker) so the
  // floor is easy to tell apart without a suit.
  function uniformOf(st) {
    const hue = [...st.name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0);
    const chief = st.role === "chief";
    return {
      chief,
      polo: chief ? "#f7f5f0" : `hsl(${hue} 38% 44%)`,
      collar: chief ? `hsl(${hue} 42% 36%)` : `hsl(${hue} 36% 28%)`,
    };
  }

  // Feet at 0,0. Polo covers the chest; the apron hangs from the waist over
  // dark trousers and stops above the shoes, so it cannot be read as a waistcoat.
  function floorBody(kit, { legs, prop }) {
    const { polo, collar, chief } = kit;
    return `
          ${legs ? `<rect class="r-trousers" x="-8" y="-14" width="7.2" height="12" rx="2"/><rect class="r-trousers" x="0.8" y="-14" width="7.2" height="12" rx="2"/>
          <rect class="r-shoe" x="-9" y="-2.6" width="8.2" height="3.1" rx="1.5"/><rect class="r-shoe" x="0.8" y="-2.6" width="8.2" height="3.1" rx="1.5"/>` : ""}
          ${shortSleeve(polo, collar, -1)}
          <rect class="r-polo" fill="${polo}" x="-11" y="-34" width="22" height="18.2" rx="3"/>
          <path class="r-collar" fill="${collar}" d="M-7.2 -32.8 C-4.6 -36.2 4.6 -36.2 7.2 -32.8 L5.2 -31.8 C3.2 -34.2 -3.2 -34.2 -5.2 -31.8 Z"/>
          <path class="r-collar" fill="${collar}" d="M-2.2 -32.6 L0 -29.2 L2.2 -32.6 Z"/>
          <circle class="r-button" cx="0" cy="-27.6" r=".65"/><circle class="r-button" cx="0" cy="-25.4" r=".65"/>
          ${chief ? "" : `<rect class="r-chest-pocket" x="-8.2" y="-30.6" width="5" height="3.4" rx=".45"/>`}
          ${legs ? `<path class="r-apron" d="M-4.4 -15.4 H4.4 L4.8 -11.4 Q0 -10.6 -4.8 -11.4 Z"/>
          <rect class="r-apron-band" x="-7.8" y="-16.8" width="15.6" height="2" rx=".6"/>
          <path class="r-apron-fold" d="M0 -15.2 V-11.2"/>
          <path class="r-apron-tie" d="M-7.8 -16 q-3.2.4 -3 1.8"/>
          <path class="r-apron-tie" d="M7.8 -16 q3.2.4 3 1.8"/>` : ""}
          ${chief ? `<g class="r-badge" transform="translate(2.6 -29.4)"><rect class="r-badge-clip" x="2.2" y="-1.1" width="3.4" height="1.3" rx=".35"/><rect width="8" height="5.4" rx=".6"/><path class="r-badge-line" d="M1.1 1.5 H6.8 M1.1 2.7 H5.4 M1.1 3.9 H3.8"/></g>` : ""}
          ${prop === "tray" ? trayArm(polo, collar) : prop === "pad" ? padArm(polo, collar) : shortSleeve(polo, collar, 1)}`;
  }

  // Short sleeve, cuff and a forearm so the hand stays attached. side -1 is the left arm.
  function shortSleeve(polo, collar, side) {
    const x = side < 0 ? -16.2 : 9.6;
    const hand = side < 0 ? -12.9 : 12.9;
    return `
          <rect class="r-sleeve" fill="${polo}" x="${x}" y="-33.4" width="6.6" height="8.6" rx="2.2"/>
          <rect class="r-collar" fill="${collar}" x="${x}" y="-26.2" width="6.6" height="2" rx=".7"/>
          <rect class="r-face" x="${(hand - 1.45).toFixed(2)}" y="-25.4" width="2.9" height="5.4" rx="1.3"/>
          <circle class="r-face" cx="${hand}" cy="-19.6" r="2.35"/>`;
  }

  // Round steel tray, thick white cup, green band, silk-stocking milk tea.
  function trayArm(polo, collar) {
    // Sleeve first, tray next, hand last so the fingers sit on the rim.
    return `
          <g class="r-tray-arm" transform="translate(6.2 -31.5) rotate(-122)">
            <rect class="r-sleeve" fill="${polo}" x="-3" y="0" width="6" height="5.2" rx="2"/>
            <rect class="r-collar" fill="${collar}" x="-3" y="4" width="6" height="1.6" rx=".55"/>
            <rect class="r-face" x="-1.3" y="4.8" width="2.6" height="2.2" rx="1.1"/>
          </g>
          <g class="r-tray-arm">
            <ellipse class="r-tray" cx="19.4" cy="-36.8" rx="8" ry="2.35"/>
            <ellipse class="r-tray-shine" cx="17.6" cy="-37.3" rx="4" ry=".8"/>
            <rect class="r-cup" x="16" y="-45.4" width="7.4" height="8.2" rx="1.9"/>
            <rect class="r-tea" x="16.9" y="-45" width="5.6" height="1.6" rx=".55"/>
            <rect class="r-cup-band" x="16" y="-42.6" width="7.4" height="2"/>
            <path class="r-cup-handle" d="M23.4 -43.2 q2.6 1.6 0 3.4"/>
          </g>
          <g class="r-tray-arm" transform="translate(6.2 -31.5) rotate(-122)">
            <circle class="r-face" cy="8" r="2.25"/>
          </g>`;
  }

  // The little order chit and a ballpoint, the other thing a floor staff carries.
  function padArm(polo, collar) {
    return `
          <g class="r-pad-arm" transform="translate(8 -33) rotate(-41)">
            <rect class="r-sleeve" fill="${polo}" x="-3.1" y="0" width="6.2" height="6" rx="2"/>
            <rect class="r-collar" fill="${collar}" x="-3.1" y="4.8" width="6.2" height="1.6" rx=".6"/>
            <rect class="r-face" x="-1.35" y="5.6" width="2.7" height="2.6" rx="1.2"/>
          </g>
          <g transform="translate(11.2 -35) rotate(-6)">
            <rect class="r-pad" width="8" height="10.6" rx=".8"/>
            <path class="r-pad-line" d="M1.2 2.6 H6.7 M1.2 4.6 H6.7 M1.2 6.6 H4.5"/>
            <g transform="translate(4.6 2.2) rotate(28)">
              <rect class="r-pen" x="-.7" y="-1" width="1.4" height="7.2" rx=".35"/>
              <rect class="r-pen-cap" x="-.7" y="-1" width="1.4" height="1.6" rx=".3"/>
            </g>
          </g>
          <g class="r-pad-arm" transform="translate(8 -33) rotate(-41)">
            <circle class="r-face" cy="9.2" r="2.3"/>
          </g>`;
  }

  // Ballpoint clipped behind the ear, cap sticking up past the hair. side +1 is the figure's right.
  function penBehindEar(side) {
    const s = side < 0 ? -1 : 1;
    return `
          <g class="r-ear-pen" transform="translate(${(s * 9.4).toFixed(1)} -45.5) rotate(${s * 14})">
            <rect class="r-pen" x="-.75" y="-8" width="1.55" height="8.4" rx=".4"/>
            <rect class="r-pen-cap" x="-.75" y="-8" width="1.55" height="2" rx=".35"/>
          </g>`;
  }

  // Short dark hair. The cashier keeps the parted quiff and the bigger smile.
  function staffHead(handsome) {
    const hair = handsome
      ? `<path class="r-hair" d="M-10.5 -42 Q-12 -55 -2 -57 Q4 -60 9 -56 Q12 -53 10.5 -43 Q9 -49 4 -50 Q-1 -48.5 -4 -51 Q-7 -48 -10.5 -42 Z"/>
         <path class="r-hair-part" d="M-4 -51 Q-3 -55 1 -57"/>`
      : `<path class="r-hair" d="M-10.3 -42 Q-11 -54 0 -55 Q11 -54 10.3 -42 Q8 -48 0 -48.5 Q-8 -48 -10.3 -42 Z"/>`;
    const smile = handsome
      ? `<path class="r-smile" d="M-4 -38 Q0 -34 4 -38"/>
         <path class="r-brow" d="M-6 -45 l4 -1"/><path class="r-brow" d="M2 -46 l4 1"/>
         <circle class="r-blush" cx="-6.5" cy="-38.5" r="1.6"/><circle class="r-blush" cx="6.5" cy="-38.5" r="1.6"/>`
      : `<path class="r-smile" d="M-2.5 -38 Q0 -36 2.5 -38"/>`;
    return `
          <circle class="r-face" cy="-42" r="10"/>
          <circle class="r-eye" cx="-3.5" cy="-42.5" r="1.4"/><circle class="r-eye" cx="3.5" cy="-42.5" r="1.4"/>
          ${smile}
          ${hair}`;
  }

  // The young man at the till. Same casual uniform as the floor (white polo,
  // pen behind the ear), scenery only: he is not a staff member, takes no
  // clicks, and is drawn behind the bell, its badge and every name.
  // x 493 sat him in the aisle by the green chair; 460, 258 is behind the till,
  // above the bell and the approval badge. No apron, so nothing hangs onto the bell.
  const CASHIER = { x: 460, y: 258 };
  function cashier() {
    const kit = { chief: false, polo: "#f7f5f0", collar: "#1e3a5f" };
    return `
      <g class="r-cashier" transform="translate(${CASHIER.x} ${CASHIER.y}) scale(1.2)" aria-hidden="true">
        <g class="r-body">
          ${floorBody(kit, { legs: false, prop: "rest" })}
          ${staffHead(true)}
          ${penBehindEar(-1)}
        </g>
      </g>`;
  }

  function hotspot(go, label, x, y, inner, w = 88, h = 88) {
    return `
      <g data-go="${go}" class="r-clickable" role="button" tabindex="0" aria-label="${escX(label)}" transform="translate(${x} ${y})">
        <title>${escX(label)}</title>
        <rect class="r-target" x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="10"/>
        ${inner}
      </g>`;
  }

  function render(S, el, selectedId) {
    layers.length = 0;
    labels.length = 0;
    const now = Date.now();
    const open = (t) => t.status !== "done";
    const tasks = S.tasks.filter(open);
    const pendingApprovals = S.approvals.filter((a) => a.status === "pending");
    const unread = S.events.filter((e) => !e.read_at).length;
    const review = tasks.filter((t) => t.status === "review");
    const unclaimed = tasks.filter((t) => t.status === "todo" && !t.assignee_id);
    const cooking = tasks.filter((t) => t.status === "doing");
    const recipeCount = S.recipes.length;

    const people = [];
    for (const st of S.staff) {
      const mine = tasks.filter((t) => t.assignee_id === st.id);
      const doing = mine.find((t) => t.status === "doing");
      const todo = mine.find((t) => t.status === "todo");
      const ready = mine.find((t) => t.status === "review");
      const asking = pendingApprovals.some((a) => a.staff_id === st.id);
      const recent = st.last_seen && now - st.last_seen < 15 * 60 * 1000;
      const flags = { doing, todo, ready, asking };
      people.push({ st, flags, recent, prefs: prefsFor(flags) });
    }
    const standing = placeStaff(people);

    const placed = [];
    for (const p of standing) {
      const [mood, extra] = moodFor(p.zone, p.flags, p.recent, p.st);
      character(p.st, p.spot[0], p.spot[1], mood, extra);
      placed.push({ id: p.st.id, mood, extra });
    }

    const nApprovals = pendingApprovals.length;
    const bellLabel = `Cash register, ${nApprovals} approval${nApprovals === 1 ? "" : "s"} waiting`;
    const mailLabel = `Door, ${unread} new notification${unread === 1 ? "" : "s"}`;
    const bookLabel = `Bookshelf, ${recipeCount} recipe${recipeCount === 1 ? "" : "s"}`;
    const counterLabel = `Counter, ${unclaimed.length} unclaimed, ${review.length} ready, ${cooking.length} cooking`;

    // Bell sits on the cash register. The translate is on the outer group so the
    // ring animation does not cancel it. The clear rect is the 44px+ tap target.
    const bell = hotspot("approvals", bellLabel, 468, 268, `
        <g class="r-bell ${nApprovals ? "ringing" : ""}"><path d="M-8 0 a8 8 0 0 1 16 0 z"/><rect x="-10" y="0" width="20" height="2.5" rx="1"/></g>
        ${nApprovals ? badge(nApprovals, 18, -18) : ""}`);
    const mailbox = hotspot("inbox", mailLabel, 96, 148, `
        <g class="r-flag ${unread ? "up" : ""}"><rect x="0" y="-2" width="3" height="18"/><rect x="0" y="-2" width="13" height="8" rx="1"/></g>
        ${unread ? badge(unread, 24, -8) : ""}`);

    // Bookshelf and counter stay tappable. Badges show the counts at a glance,
    // including 0, and widen for 10+.
    const hits = `
      <g data-go="recipes" class="r-clickable" role="button" tabindex="0" aria-label="${escX(bookLabel)}">
        <title>${escX(bookLabel)}</title>
        <rect class="r-hit" x="146" y="90" width="92" height="102" rx="8"/>
        ${badge(recipeCount, 216, 104)}
      </g>
      <g data-go="orders" class="r-clickable" role="button" tabindex="0" aria-label="${escX(counterLabel)}">
        <title>${escX(counterLabel)}</title>
        <rect class="r-hit" x="230" y="78" width="220" height="132" rx="8"/>
        ${badge(cooking.length, 360, 100)}
        ${badge(unclaimed.length, 424, 128)}
      </g>`;

    const vh = VH.toFixed(2);
    const href = backgroundHref();
    const bg = `
      <rect class="room-fallback" x="0" y="0" width="${VW}" height="${vh}"/>
      <image class="room-bg" href="${href}" xlink:href="${href}" x="0" y="0" width="${VW}" height="${vh}" preserveAspectRatio="xMidYMid slice"><title>Cha chaan teng</title></image>`;
    const idKey = (v) => (typeof v === "number" ? v : String(v));
    const figures = layers
      .sort((a, b) => a.y - b.y || (idKey(a.id) < idKey(b.id) ? -1 : idKey(a.id) > idKey(b.id) ? 1 : 0))
      .map((l) => l.svg)
      .join("");
    el.innerHTML = `<svg class="room-svg" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${VW} ${vh}" role="img" aria-label="Your restaurant">${bg}${cashier()}${hits}${bell}${mailbox}${figures}<g class="r-names">${labels.join("")}</g></svg>`;
    if (selectedId != null) el.querySelector(`[data-staff="${selectedId}"]`)?.classList.add("selected");
    return placed;
  }

  return { render, cashier: CASHIER, floorSpots, minSep: MIN_SEP, viewBox: { width: VW, height: VH }, obstacles };
})();
