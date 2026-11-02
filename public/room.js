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

  function character(st, cx, cy, mood, extra) {
    const hue = [...st.name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0);
    const color = `hsl(${hue} 55% 48%)`;
    const chief = st.role === "chief";
    const hatH = chief ? 20 : 12;
    const q = st.quota;
    const battery = q == null ? "" :
      `<g transform="translate(14 -44)"><rect class="r-batt" width="14" height="7" rx="1.5"/><rect class="r-batt-fill ${q < 20 ? "low" : q < 50 ? "mid" : ""}" x="1" y="1" width="${Math.max(1, (12 * q) / 100).toFixed(1)}" height="5" rx="1"/></g>`;
    const bubble = {
      cook: `<text class="r-bubble-emoji" y="${-58 - hatH}">🍳</text>`,
      ask: `<g class="r-ask" transform="translate(0 ${-62 - hatH})"><circle r="10"/><text y="5" text-anchor="middle">!</text></g>`,
      sleep: `<text class="r-zzz" x="10" y="${-50 - hatH}">z z</text>`,
      ready: `<text class="r-bubble-emoji" y="${-58 - hatH}">🔔</text>`,
      read: `<text class="r-bubble-emoji" y="${-58 - hatH}">📄</text>`,
      idle: "",
    }[mood];
    const svg = `
      <g class="r-staff ${mood}" data-staff="${st.id}" transform="translate(${cx.toFixed(1)} ${cy.toFixed(1)})" tabindex="0" role="button" aria-label="${escX(st.name)}">
        <title>${escX(st.name)}: ${escX(extra)}</title>
        <ellipse class="r-shadow" rx="15" ry="6"/>
        <g class="r-body">
          <rect x="-11" y="-30" width="22" height="26" rx="9" fill="${color}"/>
          <rect class="r-apron" x="-7" y="-22" width="14" height="16" rx="3"/>
          <circle class="r-face" cy="-38" r="10"/>
          <circle class="r-eye" cx="-3.5" cy="-39" r="1.4"/><circle class="r-eye" cx="3.5" cy="-39" r="1.4"/>
          <rect class="r-hat" x="-8" y="${-47 - hatH}" width="16" height="${hatH + 1}" rx="2"/>
          <circle class="r-hat" cx="-6" cy="${-48 - hatH}" r="6"/><circle class="r-hat" cx="0" cy="${-51 - hatH}" r="7"/><circle class="r-hat" cx="6" cy="${-48 - hatH}" r="6"/>
          ${battery}
          ${bubble}
        </g>
      </g>`;
    // Names go on a top layer so nobody stands in front of a name.
    // paint-order="stroke" draws the cream outline first so it does not eat the glyphs.
    labels.push(`<text class="r-name" data-staff="${st.id}" x="${cx.toFixed(1)}" y="${(cy + 16).toFixed(1)}" text-anchor="middle" paint-order="stroke">${escX(st.name)}${chief ? " ★" : ""}</text>`);
    add(cy, st.id, svg);
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
    el.innerHTML = `<svg class="room-svg" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${VW} ${vh}" role="img" aria-label="Your restaurant">${bg}${hits}${bell}${mailbox}${figures}<g class="r-names">${labels.join("")}</g></svg>`;
    if (selectedId != null) el.querySelector(`[data-staff="${selectedId}"]`)?.classList.add("selected");
    return placed;
  }

  return { render, floorSpots, minSep: MIN_SEP, viewBox: { width: VW, height: VH }, obstacles };
})();
