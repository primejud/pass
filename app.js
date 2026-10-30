"use strict";

// ---------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------
const MIN_WORDS = 2;
const MAX_WORDS = 10;
const DEFAULT_LENGTH = 2;
const HISTORY_LIMIT = 20;
const MIN_SAFE_LIST = 1000; // refuse to run with a tiny (weak) word list
const LEGACY_STORAGE_KEY = "passphraseHistory";

// ---------------------------------------------------------------------
// State (memory only: nothing is persisted)
// ---------------------------------------------------------------------
let wordList = [];
let shuffled = [];
let basket = [];
let undoStack = [];
let currentIndex = 0;
let length = DEFAULT_LENGTH;
let isFinished = false;
let fatal = false;
let historyRevealed = false;
let lastPassphrase = "";
let history = [];
let toastTimer = null;

// ---------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const wordDisplay = $("wordDisplay");
const wordMeta = $("wordMeta");
const basketCount = $("basketCount");
const basketTotal = $("basketTotal");
const dotsEl = $("dots");
const lengthValue = $("lengthValue");
const btnMinus = $("btnMinus");
const btnPlus = $("btnPlus");
const meterBar = $("meterBar");
const strengthLabel = $("strengthLabel");
const strengthBits = $("strengthBits");
const strengthHint = $("strengthHint");
const resultArea = $("resultArea");
const passphraseText = $("passphraseText");
const copyNote = $("copyNote");
const historyList = $("historyList");
const btnAdd = $("btnAdd");
const btnSkip = $("btnSkip");
const btnBack = $("btnBack");
const btnRestart = $("btnRestart");
const btnNew = $("btnNew");
const btnCopy = $("btnCopy");
const btnReveal = $("btnReveal");
const btnClear = $("btnClear");
const toastEl = $("toast");

// ---------------------------------------------------------------------
// Secure randomness (unbiased, via Web Crypto)
// ---------------------------------------------------------------------
function randInt(max) {
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  do {
    crypto.getRandomValues(buf);
  } while (buf[0] >= limit);
  return buf[0] % max;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const SYMBOLS = ["@", "#", "!"];

function pickSymbol() {
  return SYMBOLS[randInt(SYMBOLS.length)];
}

function pickNumber() {
  const digits = randInt(2) === 0 ? 3 : 4;
  const min = Math.pow(10, digits - 1);
  const max = Math.pow(10, digits) - 1;
  return randInt(max - min + 1) + min;
}

function generatePassphrase(words) {
  const capped = words.map(
    (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
  );
  return capped.join(".") + pickSymbol() + pickNumber();
}

// ---------------------------------------------------------------------
// Entropy estimate
// ---------------------------------------------------------------------
// symbol: log2(3) | digit-count coin flip: 1 bit
// number: 0.5*log2(900) + 0.5*log2(9000)
const EXTRA_BITS =
  Math.log2(SYMBOLS.length) + 1 + 0.5 * Math.log2(900) + 0.5 * Math.log2(9000);

function estimateBits(wordCount) {
  return wordCount * Math.log2(wordList.length) + EXTRA_BITS;
}

function strengthLevel(bits) {
  if (bits < 45) return { level: 1, label: "Weak" };
  if (bits < 60) return { level: 2, label: "Fair" };
  if (bits < 80) return { level: 3, label: "Strong" };
  return { level: 4, label: "Very strong" };
}

// ---------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------
function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
}

function setWord(text) {
  wordDisplay.classList.remove("error");
  wordDisplay.textContent = text;
  wordDisplay.classList.remove("swap");
  void wordDisplay.offsetWidth; // restart animation
  wordDisplay.classList.add("swap");
}

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    throw new Error("no clipboard api");
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

function buildDots() {
  dotsEl.textContent = "";
  for (let i = 0; i < length; i++) {
    const d = document.createElement("span");
    d.className = "dot";
    dotsEl.appendChild(d);
  }
}

// ---------------------------------------------------------------------
// Session history (memory only)
// ---------------------------------------------------------------------
function renderHistory() {
  historyList.textContent = "";
  btnClear.disabled = history.length === 0;
  btnReveal.disabled = history.length === 0;
  btnReveal.textContent = historyRevealed ? "Hide" : "Reveal";

  if (history.length === 0) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = "No passphrases yet. Your first one will appear here.";
    historyList.appendChild(empty);
    return;
  }

  history.forEach((item) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "history-item";
    row.title = "Click to copy";

    const time = document.createElement("span");
    time.className = "history-time";
    time.textContent = item.time;

    const pass = document.createElement("span");
    pass.className = "history-pass";
    pass.textContent = historyRevealed
      ? item.pass
      : "•".repeat(Math.min(item.pass.length, 24));

    row.append(time, pass);
    row.addEventListener("click", async () => {
      const ok = await copyToClipboard(item.pass);
      showToast(ok ? "📋 Copied from history" : "⚠️ Couldn't copy");
    });
    historyList.appendChild(row);
  });
}

function addToHistory(pass) {
  history.unshift({
    time: new Date().toLocaleString("en-US", { hour12: false }),
    pass,
  });
  history = history.slice(0, HISTORY_LIMIT);
  renderHistory();
}

// ---------------------------------------------------------------------
// Word list loading & validation
// ---------------------------------------------------------------------
function loadWordList() {
  if (typeof DEFAULT_WORDS === "undefined" || !Array.isArray(DEFAULT_WORDS)) {
    return [];
  }
  const clean = DEFAULT_WORDS.map((w) => String(w).trim()).filter(
    (w) => w.length > 0 && /^[\p{L}'-]+$/u.test(w),
  );
  return [...new Set(clean)];
}

function showFatal(msg) {
  fatal = true;
  wordDisplay.textContent = msg;
  wordDisplay.classList.add("error");
  [btnAdd, btnSkip, btnBack, btnRestart, btnMinus, btnPlus].forEach(
    (b) => (b.disabled = true),
  );
  wordMeta.textContent = "";
}

// ---------------------------------------------------------------------
// Game logic
// ---------------------------------------------------------------------
function startGame() {
  if (fatal) return;
  shuffled = shuffle(wordList.slice());
  basket = [];
  undoStack = [];
  currentIndex = 0;
  isFinished = false;
  lastPassphrase = "";
  passphraseText.textContent = "";
  resultArea.hidden = true;
  render();
  setWord(shuffled[currentIndex]);
}

function render() {
  lengthValue.textContent = length;
  basketCount.textContent = basket.length;
  basketTotal.textContent = length;

  if (dotsEl.children.length !== length) buildDots();
  Array.from(dotsEl.children).forEach((d, i) =>
    d.classList.toggle("filled", i < basket.length),
  );

  btnMinus.disabled = length <= MIN_WORDS;
  btnPlus.disabled = length >= MAX_WORDS;
  btnAdd.disabled = isFinished;
  btnSkip.disabled = isFinished;
  btnBack.disabled = isFinished || undoStack.length === 0;

  const bits = estimateBits(length);
  const s = strengthLevel(bits);
  meterBar.dataset.level = s.level;
  strengthLabel.textContent = s.label;
  strengthBits.textContent = `~${Math.round(bits)} bits`;
  strengthHint.textContent =
    length < 4
      ? "Tip: use 4+ words for important accounts."
      : "Good length. Accept words without cherry-picking to keep this strength.";

  const remaining = Math.max(shuffled.length - currentIndex - 1, 0);
  wordMeta.textContent = isFinished
    ? ""
    : `${remaining.toLocaleString("en-US")} more word${remaining === 1 ? "" : "s"} in this deck`;
}

function advance() {
  currentIndex++;
  if (currentIndex >= shuffled.length) {
    const remaining = wordList.filter((w) => !basket.includes(w));
    shuffled = shuffle(remaining);
    currentIndex = 0;
    showToast("🔀 Reshuffled the deck");
  }
  render();
  setWord(shuffled[currentIndex]);
}

function addWord() {
  if (isFinished || fatal) return;
  basket.push(shuffled[currentIndex]);
  undoStack.push({ type: "add", index: currentIndex, deck: shuffled });
  if (basket.length >= length) finishGame();
  else advance();
}

function skipWord() {
  if (isFinished || fatal) return;
  undoStack.push({ type: "skip", index: currentIndex, deck: shuffled });
  advance();
}

function undo() {
  if (isFinished || fatal) return;
  const last = undoStack.pop();
  if (!last) {
    showToast("👀 Nothing to undo");
    return;
  }
  if (last.type === "add") basket.pop();
  shuffled = last.deck;
  currentIndex = last.index;
  render();
  setWord(shuffled[currentIndex]);
}

function changeLength(delta) {
  if (fatal) return;
  const next = Math.min(MAX_WORDS, Math.max(MIN_WORDS, length + delta));
  if (next === length) return;
  length = next;

  if (isFinished) {
    // New length after finishing starts a fresh round
    startGame();
  } else if (basket.length >= length) {
    // Already have enough words for the new, shorter length
    render();
    finishGame();
  } else {
    render();
  }
}

async function finishGame() {
  isFinished = true;
  const pass = generatePassphrase(basket);
  lastPassphrase = pass;
  passphraseText.textContent = pass;
  wordDisplay.classList.remove("error");
  wordDisplay.textContent = "Done! 🎉";
  resultArea.hidden = false;
  render();
  resultArea.scrollIntoView({ behavior: "smooth", block: "nearest" });
  btnNew.focus({ preventScroll: true });

  addToHistory(pass);

  const ok = await copyToClipboard(pass);
  if (lastPassphrase !== pass) return; // user already moved on
  copyNote.textContent = ok
    ? "📋 Copied to clipboard automatically"
    : "⚠️ Auto-copy was blocked. Use the Copy button.";
  if (ok) showToast("📋 Copied to clipboard");
}

// ---------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------
btnAdd.addEventListener("click", addWord);
btnSkip.addEventListener("click", skipWord);
btnBack.addEventListener("click", undo);
btnRestart.addEventListener("click", () => {
  startGame();
  showToast("🔄 Restarted");
});
btnNew.addEventListener("click", startGame);
btnMinus.addEventListener("click", () => changeLength(-1));
btnPlus.addEventListener("click", () => changeLength(1));

btnCopy.addEventListener("click", async () => {
  const ok = await copyToClipboard(lastPassphrase);
  showToast(ok ? "📋 Copied!" : "⚠️ Couldn't copy");
});

btnReveal.addEventListener("click", () => {
  historyRevealed = !historyRevealed;
  renderHistory();
});

btnClear.addEventListener("click", () => {
  history = [];
  historyRevealed = false;
  renderHistory();
  showToast("🗑️ History cleared");
});

// Shortcuts: Y add · N skip · B undo · R restart · +/- length · Enter new
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  const tag = (e.target.tagName || "").toLowerCase();
  if (["input", "textarea", "select"].includes(tag)) return;

  const key = e.key.toLowerCase();
  if (key === "y") btnAdd.click();
  else if (key === "n") btnSkip.click();
  else if (key === "b") btnBack.click();
  else if (key === "r") btnRestart.click();
  else if (key === "+" || key === "=") btnPlus.click();
  else if (key === "-" || key === "_") btnMinus.click();
  else if (key === "enter" && isFinished && e.target === document.body) {
    btnNew.click();
  }
});

// Wipe the old localStorage history from earlier versions
try {
  localStorage.removeItem(LEGACY_STORAGE_KEY);
} catch {
  /* storage blocked: nothing to wipe */
}

// ---------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------
wordList = loadWordList();
renderHistory();
buildDots();

if (wordList.length < MIN_SAFE_LIST) {
  render();
  showFatal("Word list missing or too small. Check words.js.");
} else {
  startGame();
}
