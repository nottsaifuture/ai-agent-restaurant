"use strict";

// The visible restaurant: a cha chaan teng picture, with staff drawn on top.
// Where each staff member stands shows what they are doing:
//   at the counter = working on an order · in the aisle = order ready for review
//   by the cash register with "!" = waiting for your approval · dining floor = idle · "z" = hasn't checked in lately
// The picture is public/cha-chaan-teng.jpg (cream bars cropped, blank right-wall sign painted out).
// Staff feet are in the same 660×371.67 space as that picture.
window.Room = (() => {
  const VW = 660;
  const VH = 1115 / 3; // cropped image is 1980×1115, shown at 1/3

  const escX = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const layers = []; // { y, svg } painter's order, larger y in front
  const labels = [];
  const add = (y, svg) => layers.push({ y, svg });

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
    labels.push(`<text class="r-name" data-staff="${st.id}" x="${cx.toFixed(1)}" y="${(cy + 16).toFixed(1)}" text-anchor="middle">${escX(st.name)}${chief ? " ★" : ""}</text>`);
    add(cy, svg);
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

    // Feet on open floor in the picture. Cooks at the counter, ready orders in the
    // aisle (the pass), approvals beside the cash register, everyone else in the dining room.
    // Coordinates are feet on open floor tiles (measured against the picture).
    const stoves = [[258, 224], [306, 222], [338, 224]];
    const pass = [[330, 279], [400, 307], [270, 268], [366, 308]];
    const lounge = [[372, 334], [290, 268], [408, 336], [366, 308]];
    const host = [[446, 332], [390, 334], [430, 280]];
    let stoveI = 0, loungeI = 0, hostI = 0, passI = 0;
    const placed = [];
    for (const st of S.staff) {
      const mine = tasks.filter((t) => t.assignee_id === st.id);
      const doing = mine.find((t) => t.status === "doing");
      const todo = mine.find((t) => t.status === "todo");
      const ready = mine.find((t) => t.status === "review");
      const asking = pendingApprovals.some((a) => a.staff_id === st.id);
      const recent = st.last_seen && now - st.last_seen < 15 * 60 * 1000;
      let spot, mood, extra;
      if (asking && hostI < host.length) { spot = host[hostI++]; mood = "ask"; extra = "waiting for your approval"; }
      else if (doing && stoveI < stoves.length) { spot = stoves[stoveI++]; mood = "cook"; extra = `cooking order #${doing.id}: ${doing.title}`; }
      else if ((doing || todo) && passI < pass.length) { spot = pass[passI++]; mood = doing ? "cook" : "read"; extra = doing ? `working on #${doing.id}` : `has order #${todo.id} to start`; }
      else if (ready && passI < pass.length) { spot = pass[passI++]; mood = "ready"; extra = `order #${ready.id} is ready for you`; }
      else {
        spot = lounge[loungeI % lounge.length];
        const lap = Math.floor(loungeI / lounge.length);
        if (lap) spot = [spot[0] + 26 * lap, spot[1] - 8];
        loungeI++;
        mood = recent ? "idle" : "sleep";
        extra = recent ? "free for work" : st.last_seen ? "resting (hasn't checked in lately)" : "hasn't checked in yet";
      }
      character(st, spot[0], spot[1], mood, extra);
      placed.push({ id: st.id, mood, extra });
    }

    const nApprovals = pendingApprovals.length;
    // Bell sits on the cash register (your stand). The translate is on the outer
    // group so the ring animation doesn't cancel it.
    const bell = `
      <g data-go="approvals" class="r-clickable" transform="translate(468 268)">
        <title>Cash register: ${nApprovals} approval${nApprovals === 1 ? "" : "s"} waiting for you</title>
        <g class="r-bell ${nApprovals ? "ringing" : ""}"><path d="M-8 0 a8 8 0 0 1 16 0 z"/><rect x="-10" y="0" width="20" height="2.5" rx="1"/></g>
        ${nApprovals ? `<g class="r-count" transform="translate(14 -16)"><circle r="9"/><text y="4" text-anchor="middle">${nApprovals}</text></g>` : ""}
      </g>`;
    // Flag by the door stands in for the mailbox.
    const mailbox = `
      <g data-go="inbox" class="r-clickable" transform="translate(96 148)">
        <title>Door: ${unread} new notification${unread === 1 ? "" : "s"}</title>
        <g class="r-flag ${unread ? "up" : ""}"><rect x="0" y="-2" width="3" height="18"/><rect x="0" y="-2" width="13" height="8" rx="1"/></g>
        ${unread ? `<g class="r-count" transform="translate(22 -6)"><circle r="9"/><text y="4" text-anchor="middle">${unread}</text></g>` : ""}
      </g>`;
    // The pictured bookshelf and counter stay tappable, same as the old room.
    const hits = `
      <rect class="r-hit" data-go="recipes" x="112" y="96" width="52" height="82"><title>Recipe book: ${S.recipes.length} recipes</title></rect>
      <rect class="r-hit" data-go="orders" x="248" y="78" width="230" height="150"><title>Counter: ${review.length} ready, ${unclaimed.length} unclaimed</title></rect>`;

    const bg = `<image class="room-bg" href="/cha-chaan-teng.jpg" xlink:href="/cha-chaan-teng.jpg" x="0" y="0" width="${VW}" height="${VH.toFixed(2)}" preserveAspectRatio="none"><title>Cha chaan teng</title></image>`;
    const people = layers.sort((a, b) => a.y - b.y).map((l) => l.svg).join("");
    el.innerHTML = `<svg class="room-svg" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${VW} ${VH.toFixed(2)}" role="img" aria-label="Your restaurant">${bg}${hits}${bell}${mailbox}${people}${labels.join("")}</svg>`;
    if (selectedId != null) el.querySelector(`[data-staff="${selectedId}"]`)?.classList.add("selected");
    return placed;
  }

  return { render };
})();
