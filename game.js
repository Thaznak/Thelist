(function initGuessWho() {
  const boardEl = document.getElementById("board");
  const questionListEl = document.getElementById("question-list");
  const modeLabelEl = document.getElementById("mode-label");
  const turnLabelEl = document.getElementById("turn-label");
  const roundLabelEl = document.getElementById("round-label");
  const remainingLabelEl = document.getElementById("remaining-label");
  const logLineEl = document.getElementById("log-line");
  const logListEl = document.getElementById("log-list");
  const secretLineEl = document.getElementById("secret-line");
  const singleBtn = document.getElementById("single-btn");
  const hotseatBtn = document.getElementById("hotseat-btn");
  const newMatchBtn = document.getElementById("new-match-btn");
  const inviteBtn = document.getElementById("invite-btn");
  const inviteLinkEl = document.getElementById("invite-link");
  const copyInviteBtn = document.getElementById("copy-invite-btn");
  const inviteStatusEl = document.getElementById("invite-status");
  const passOverlayEl = document.getElementById("pass-overlay");
  const overlayTitleEl = document.getElementById("overlay-title");
  const overlayTextEl = document.getElementById("overlay-text");
  const continueBtn = document.getElementById("continue-btn");

  const fallbackNames = [
    "Ava", "Noah", "Mila", "Liam", "Leila", "Hugo",
    "Nora", "Ethan", "Ines", "Leo", "Sofia", "Marco",
    "Iris", "Dylan", "Amelia", "Felix", "Naomi", "Victor",
    "Elise", "Rayan", "Aria", "Jonas", "Maya", "Luca"
  ];

  const pool = {
    gender: ["female", "male"],
    ageGroup: ["young", "adult", "adult", "senior"],
    hairColor: ["black", "brown", "blonde", "red", "gray"],
    hairStyle: ["short", "long", "curly", "ponytail", "bald"],
    eyeColor: ["brown", "blue", "green", "hazel"],
    glasses: [true, false, false],
    hat: [true, false, false, false],
    facialHair: ["none", "none", "mustache", "beard"]
  };

  const questions = [
    { id: "q_glasses", label: "Wears glasses?", test: (c) => !!c.attrs.glasses },
    { id: "q_hat", label: "Wearing a hat?", test: (c) => !!c.attrs.hat },
    { id: "q_facial", label: "Has facial hair?", test: (c) => c.attrs.facialHair !== "none" },
    { id: "q_blue", label: "Has blue eyes?", test: (c) => c.attrs.eyeColor === "blue" },
    { id: "q_green", label: "Has green eyes?", test: (c) => c.attrs.eyeColor === "green" },
    { id: "q_blonde", label: "Has blonde hair?", test: (c) => c.attrs.hairColor === "blonde" },
    { id: "q_dark", label: "Has dark hair?", test: (c) => c.attrs.hairColor === "black" || c.attrs.hairColor === "brown" },
    { id: "q_curly", label: "Has curly hair?", test: (c) => c.attrs.hairStyle === "curly" },
    { id: "q_long", label: "Has long hair?", test: (c) => c.attrs.hairStyle === "long" || c.attrs.hairStyle === "ponytail" },
    { id: "q_bald", label: "Is bald?", test: (c) => c.attrs.hairStyle === "bald" },
    { id: "q_senior", label: "Looks senior?", test: (c) => c.attrs.ageGroup === "senior" },
    { id: "q_male", label: "Presents masculine traits?", test: (c) => c.attrs.gender === "male" }
  ];

  const state = {
    mode: "single",
    role: 1,
    characters: [],
    gameOver: false,
    winner: null,
    logs: [],
    round: 1,
    overlayLocked: false,
    players: [],
    currentPlayerIndex: 0,
    solo: null,
    matchPackage: null
  };

  function makeRandom(seed) {
    let t = seed;
    return function next() {
      t += 0x6d2b79f5;
      let n = Math.imul(t ^ (t >>> 15), t | 1);
      n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
      return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
    };
  }

  function sample(random, list) {
    return list[Math.floor(random() * list.length)];
  }

  function normalizeAttrs(attrs) {
    return {
      gender: attrs.gender || "female",
      ageGroup: attrs.ageGroup || "adult",
      hairColor: attrs.hairColor || "brown",
      hairStyle: attrs.hairStyle || "short",
      eyeColor: attrs.eyeColor || "brown",
      glasses: !!attrs.glasses,
      hat: !!attrs.hat,
      facialHair: attrs.facialHair || "none"
    };
  }

  function loadManifestCharacters() {
    const raw = Array.isArray(window.GUESS_WHO_AVATAR_MANIFEST)
      ? window.GUESS_WHO_AVATAR_MANIFEST
      : [];

    return raw.map((entry, idx) => ({
      id: entry.id || `avatar_${idx + 1}`,
      name: entry.name || fallbackNames[idx % fallbackNames.length],
      file: entry.file || "",
      attrs: normalizeAttrs(entry.attrs || {})
    }));
  }

  function generateFallbackCharacters(count) {
    const random = makeRandom(Date.now());
    const list = [];
    for (let i = 0; i < count; i += 1) {
      const gender = sample(random, pool.gender);
      let facialHair = sample(random, pool.facialHair);
      if (gender !== "male") facialHair = "none";

      list.push({
        id: `generated_${i + 1}`,
        name: fallbackNames[i % fallbackNames.length],
        file: "",
        attrs: {
          gender,
          ageGroup: sample(random, pool.ageGroup),
          hairColor: sample(random, pool.hairColor),
          hairStyle: sample(random, pool.hairStyle),
          eyeColor: sample(random, pool.eyeColor),
          glasses: sample(random, pool.glasses),
          hat: sample(random, pool.hat),
          facialHair
        }
      });
    }
    return list;
  }

  function getCharactersForNewMatch() {
    const fromManifest = loadManifestCharacters();
    const output = [...fromManifest];
    if (output.length < 24) {
      output.push(...generateFallbackCharacters(24 - output.length));
    }
    return output.slice(0, 24);
  }

  function imageSource(character) {
    if (character.file) return `./assets/avatars/${character.file}`;
    return "";
  }

  function placeholderPhoto(name) {
    const svg = `
      <svg xmlns='http://www.w3.org/2000/svg' width='600' height='800'>
        <defs>
          <linearGradient id='g' x1='0' y1='0' x2='0' y2='1'>
            <stop offset='0%' stop-color='#466278'/>
            <stop offset='100%' stop-color='#223746'/>
          </linearGradient>
        </defs>
        <rect width='100%' height='100%' fill='url(#g)'/>
        <circle cx='300' cy='300' r='160' fill='#d6ad89'/>
        <rect x='170' y='500' width='260' height='220' rx='22' fill='#324c5f'/>
        <text x='50%' y='94%' text-anchor='middle' fill='#edf5fc' font-size='48' font-family='Trebuchet MS'>${name}</text>
      </svg>
    `;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  function createPlayer(label, secretId, allIds) {
    return {
      label,
      secretId,
      activeIds: new Set(allIds),
      usedQuestions: new Set()
    };
  }

  function pushLog(text) {
    state.logs.unshift(text);
    state.logs = state.logs.slice(0, 12);
  }

  function setMainLog(text) {
    logLineEl.textContent = text;
  }

  function renderLogList() {
    logListEl.innerHTML = "";
    for (const line of state.logs) {
      const li = document.createElement("li");
      li.textContent = line;
      logListEl.appendChild(li);
    }
  }

  function currentPlayer() {
    return state.players[state.currentPlayerIndex] || null;
  }

  function opponentPlayer() {
    if (state.mode !== "hotseat") return null;
    return state.players[(state.currentPlayerIndex + 1) % 2];
  }

  function currentLabel() {
    if (state.mode === "hotseat") return currentPlayer().label;
    return state.solo.label;
  }

  function currentActiveIds() {
    if (state.mode === "hotseat") return currentPlayer().activeIds;
    return state.solo.activeIds;
  }

  function currentUsedQuestions() {
    if (state.mode === "hotseat") return currentPlayer().usedQuestions;
    return state.solo.usedQuestions;
  }

  function currentTargetSecretId() {
    if (state.mode === "hotseat") return opponentPlayer().secretId;
    return state.solo.targetSecretId;
  }

  function renderTopbar() {
    const modeLabel =
      state.mode === "single"
        ? "Single"
        : state.mode === "hotseat"
          ? "Hotseat"
          : "Invite P2";
    modeLabelEl.textContent = modeLabel;
    turnLabelEl.textContent = currentLabel();
    roundLabelEl.textContent = String(state.round);
    remainingLabelEl.textContent = String(currentActiveIds().size);
  }

  function renderSecretLine() {
    secretLineEl.classList.remove("reveal", "fail");
    if (!state.gameOver) {
      secretLineEl.textContent = "Hidden card: ???";
      return;
    }
    const secret = state.characters.find((c) => c.id === currentTargetSecretId());
    if (state.winner === "current") secretLineEl.classList.add("reveal");
    else secretLineEl.classList.add("fail");
    secretLineEl.textContent = `Hidden card: ${secret ? secret.name : "Unknown"}`;
  }

  function renderModeButtons() {
    singleBtn.classList.toggle("active", state.mode === "single");
    hotseatBtn.classList.toggle("active", state.mode === "hotseat");
  }

  function renderQuestions() {
    const used = currentUsedQuestions();
    questionListEl.innerHTML = "";
    for (const question of questions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "question-btn";
      btn.textContent = question.label;
      btn.disabled = state.gameOver || state.overlayLocked || used.has(question.id);
      btn.addEventListener("click", () => askQuestion(question));
      questionListEl.appendChild(btn);
    }
  }

  function renderBoard() {
    const standingIds = currentActiveIds();
    const targetSecret = currentTargetSecretId();
    boardEl.innerHTML = "";

    for (const character of state.characters) {
      const standing = standingIds.has(character.id);
      const card = document.createElement("article");
      card.className =
        `card${standing ? "" : " eliminated"}` +
        `${state.gameOver && character.id === targetSecret ? " winner" : ""}`;

      const inner = document.createElement("div");
      inner.className = "card-inner";

      const photoWrap = document.createElement("div");
      photoWrap.className = "photo-wrap";

      const img = document.createElement("img");
      img.className = "photo";
      img.alt = character.name;
      img.loading = "lazy";
      const src = imageSource(character);
      img.src = src || placeholderPhoto(character.name);
      img.addEventListener("error", () => {
        img.src = placeholderPhoto(character.name);
      });
      photoWrap.appendChild(img);

      const plate = document.createElement("div");
      plate.className = "nameplate";
      plate.textContent = character.name;

      inner.append(photoWrap, plate);
      card.appendChild(inner);
      boardEl.appendChild(card);

      if (standing && !state.gameOver && !state.overlayLocked) {
        card.addEventListener("click", () => guessCard(character.id));
      }
    }
  }

  function renderAll() {
    renderTopbar();
    renderModeButtons();
    renderQuestions();
    renderBoard();
    renderSecretLine();
    renderLogList();
  }

  function lockOverlay(title, text, buttonText) {
    state.overlayLocked = true;
    overlayTitleEl.textContent = title;
    overlayTextEl.textContent = text;
    continueBtn.textContent = buttonText;
    passOverlayEl.classList.remove("hidden");
    renderAll();
  }

  function unlockOverlay() {
    state.overlayLocked = false;
    passOverlayEl.classList.add("hidden");
    renderAll();
  }

  function evaluateEndState() {
    const active = currentActiveIds();
    const secretId = currentTargetSecretId();

    if (active.size <= 0) {
      state.gameOver = true;
      state.winner = "opponent";
      const line = `${currentLabel()} has no candidates left.`;
      pushLog(line);
      setMainLog(line);
      return true;
    }

    if (active.size === 1 && active.has(secretId) && state.mode !== "hotseat") {
      state.gameOver = true;
      state.winner = "current";
      const line = `${currentLabel()} isolated the final card and wins.`;
      pushLog(line);
      setMainLog(line);
      return true;
    }

    return false;
  }

  function nextTurn() {
    if (state.mode !== "hotseat") {
      state.round += 1;
      renderAll();
      return;
    }

    state.currentPlayerIndex = (state.currentPlayerIndex + 1) % 2;
    state.round += 1;
    lockOverlay("Pass the device", `Now it's ${currentLabel()}'s turn.`, "Continue");
  }

  function askQuestion(question) {
    if (state.gameOver || state.overlayLocked) return;
    const used = currentUsedQuestions();
    if (used.has(question.id)) return;
    used.add(question.id);

    const secret = state.characters.find((c) => c.id === currentTargetSecretId());
    const answer = question.test(secret);

    let removed = 0;
    const active = currentActiveIds();
    for (const id of [...active]) {
      const candidate = state.characters.find((c) => c.id === id);
      if (question.test(candidate) !== answer) {
        active.delete(id);
        removed += 1;
      }
    }

    const yesNo = answer ? "Yes" : "No";
    const line = `${currentLabel()} asked "${question.label}" -> ${yesNo}, removed ${removed}.`;
    pushLog(line);
    setMainLog(line);

    if (!evaluateEndState()) nextTurn();
    else renderAll();
  }

  function guessCard(id) {
    if (state.gameOver || state.overlayLocked) return;
    const card = state.characters.find((c) => c.id === id);
    if (!card || !currentActiveIds().has(id)) return;

    if (id === currentTargetSecretId()) {
      state.gameOver = true;
      state.winner = "current";
      const line = `${currentLabel()} guessed ${card.name} correctly and wins.`;
      pushLog(line);
      setMainLog(line);
      renderAll();
      return;
    }

    currentActiveIds().delete(id);
    const line = `${currentLabel()} guessed ${card.name} (wrong).`;
    pushLog(line);
    setMainLog(line);

    if (!evaluateEndState()) nextTurn();
    else renderAll();
  }

  function pickTwoSecrets(characters) {
    const ids = characters.map((c) => c.id);
    const a = ids[Math.floor(Math.random() * ids.length)];
    let b = ids[Math.floor(Math.random() * ids.length)];
    while (b === a && ids.length > 1) {
      b = ids[Math.floor(Math.random() * ids.length)];
    }
    return { p1: a, p2: b };
  }

  function buildMatchPackage(chars, secrets) {
    return {
      version: 1,
      chars: chars.map((c) => ({
        id: c.id,
        name: c.name,
        file: c.file || "",
        attrs: normalizeAttrs(c.attrs)
      })),
      secrets
    };
  }

  function base64UrlEncode(str) {
    return btoa(unescape(encodeURIComponent(str)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  function base64UrlDecode(str) {
    const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
    return decodeURIComponent(escape(atob(padded)));
  }

  function parseHashParams() {
    const raw = window.location.hash || "";
    const text = raw.startsWith("#") ? raw.slice(1) : raw;
    const params = new URLSearchParams(text);
    return {
      invite: params.get("invite"),
      role: params.get("role")
    };
  }

  function tryLoadInviteFromHash() {
    const hash = parseHashParams();
    if (!hash.invite) return false;

    try {
      const payload = JSON.parse(base64UrlDecode(hash.invite));
      if (!payload || payload.version !== 1 || !Array.isArray(payload.chars) || !payload.secrets) {
        return false;
      }

      const role = hash.role === "1" ? 1 : 2;
      state.mode = "invite";
      state.role = role;
      state.characters = payload.chars.slice(0, 24).map((c) => ({
        id: c.id,
        name: c.name,
        file: c.file || "",
        attrs: normalizeAttrs(c.attrs || {})
      }));

      const allIds = state.characters.map((c) => c.id);
      const ownSecret = role === 1 ? payload.secrets.p1 : payload.secrets.p2;
      const targetSecret = role === 1 ? payload.secrets.p2 : payload.secrets.p1;

      state.solo = {
        label: `Player ${role}`,
        activeIds: new Set(allIds),
        usedQuestions: new Set(),
        ownSecretId: ownSecret,
        targetSecretId: targetSecret
      };

      state.players = [];
      state.currentPlayerIndex = 0;
      state.round = 1;
      state.gameOver = false;
      state.winner = null;
      state.matchPackage = payload;
      state.logs = [];
      pushLog(`Invitation match loaded as Player ${role}.`);
      setMainLog(`Invitation accepted. You are Player ${role}.`);
      inviteStatusEl.textContent = `Invitation loaded for Player ${role}.`;
      inviteLinkEl.value = window.location.href;
      unlockOverlay();
      return true;
    } catch (_error) {
      inviteStatusEl.textContent = "Invalid invitation link.";
      return false;
    }
  }

  function startNewMatch(mode) {
    state.mode = mode;
    state.role = 1;
    state.characters = getCharactersForNewMatch();
    const allIds = state.characters.map((c) => c.id);
    const secrets = pickTwoSecrets(state.characters);
    state.matchPackage = buildMatchPackage(state.characters, secrets);
    state.logs = [];
    state.round = 1;
    state.gameOver = false;
    state.winner = null;
    inviteLinkEl.value = "";
    inviteStatusEl.textContent = "No invitation generated yet.";
    secretLineEl.classList.remove("reveal", "fail");

    if (mode === "hotseat") {
      state.players = [
        createPlayer("Player 1", secrets.p1, allIds),
        createPlayer("Player 2", secrets.p2, allIds)
      ];
      state.solo = null;
      state.currentPlayerIndex = 0;
      setMainLog("Hotseat match ready.");
      pushLog("Hotseat match started.");
      unlockOverlay();
      lockOverlay("Hotseat setup", "Player 1, memorize your hidden card then pass the device.", "Start");
      return;
    }

    state.players = [];
    state.currentPlayerIndex = 0;
    state.solo = {
      label: "Player 1",
      activeIds: new Set(allIds),
      usedQuestions: new Set(),
      ownSecretId: secrets.p1,
      targetSecretId: secrets.p1
    };
    setMainLog("Single-player match ready.");
    pushLog("Single-player match started.");
    unlockOverlay();
  }

  function generateInvitationLink() {
    if (!state.matchPackage) return;
    const encoded = base64UrlEncode(JSON.stringify(state.matchPackage));
    const base = window.location.href.split("#")[0];
    const url = `${base}#invite=${encoded}&role=2`;
    inviteLinkEl.value = url;
    inviteStatusEl.textContent = "Invitation link generated for Player #2.";
  }

  async function copyInvitationLink() {
    const text = inviteLinkEl.value.trim();
    if (!text) {
      inviteStatusEl.textContent = "Generate a link first.";
      return;
    }

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        inviteLinkEl.focus();
        inviteLinkEl.select();
        document.execCommand("copy");
      }
      inviteStatusEl.textContent = "Invitation link copied.";
    } catch (_error) {
      inviteStatusEl.textContent = "Could not copy automatically. Copy from the box.";
    }
  }

  continueBtn.addEventListener("click", () => {
    unlockOverlay();
  });

  singleBtn.addEventListener("click", () => {
    startNewMatch("single");
    renderAll();
  });

  hotseatBtn.addEventListener("click", () => {
    startNewMatch("hotseat");
    renderAll();
  });

  newMatchBtn.addEventListener("click", () => {
    const mode = state.mode === "hotseat" ? "hotseat" : "single";
    startNewMatch(mode);
    renderAll();
  });

  inviteBtn.addEventListener("click", () => {
    generateInvitationLink();
  });

  copyInviteBtn.addEventListener("click", () => {
    copyInvitationLink();
  });

  if (!tryLoadInviteFromHash()) {
    startNewMatch("single");
  }
  renderAll();
})();
