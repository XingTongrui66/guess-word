/* 相关性分析逻辑 —— 评分由本地代理调用模型实时计算 */
(function () {
  "use strict";

  // ---------- 调用后端打分 ----------
  async function scoreFromServer(target, guess) {
    const res = await fetch("/api/score", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target, guess }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "服务异常");
    return data;
  }

  // ---------- 状态 ----------
  const state = {
    answer: null,
    guesses: [],      // { word, score, reason }
    finished: false,
    busy: false,
    cache: {},
  };

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const input = $("guessInput");
  const guessBtn = $("guessBtn");
  const resultList = $("resultList");
  const emptyState = $("emptyState");
  const sampleCount = $("sampleCount");
  const taskId = $("taskId");
  const message = $("message");
  const winBanner = $("winBanner");
  const winText = $("winText");
  const connPill = $("connPill");
  const connText = $("connText");

  // ---------- 工具 ----------
  function pickAnswer() {
    return ANSWER_POOL[Math.floor(Math.random() * ANSWER_POOL.length)];
  }

  function scoreColor(score) {
    // 偏企业风的渐变：低分灰蓝 -> 高分绿
    const hue = Math.round(210 - (score / 100) * 80); // 210蓝 -> 130绿
    const sat = 45 + Math.round((score / 100) * 20);
    return `hsl(${hue}, ${sat}%, 48%)`;
  }

  function showMessage(text, type) {
    message.textContent = text || "";
    message.className = "message" + (type ? " " + type : "");
  }

  function setBusy(b) {
    state.busy = b;
    guessBtn.disabled = b;
    guessBtn.textContent = b ? "分析中…" : "分析";
  }

  function genTaskId() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    const seq = String(Math.floor(Math.random() * 9999)).padStart(4, "0");
    return `TASK-${stamp}-${seq}`;
  }

  function setConn(online) {
    connText.textContent = online ? "服务在线" : "服务离线";
    connPill.classList.toggle("offline", !online);
  }

  // ---------- 渲染 ----------
  function render(lastGuessWord) {
    sampleCount.textContent = state.guesses.length;
    emptyState.style.display = state.guesses.length ? "none" : "block";

    const sorted = [...state.guesses].sort((a, b) => b.score - a.score);
    resultList.innerHTML = "";

    sorted.forEach((g, i) => {
      const li = document.createElement("li");
      li.className = "result-item";
      if (g.word === lastGuessWord) li.classList.add("latest");
      if (g.score >= 100) li.classList.add("correct");

      const rank = document.createElement("span");
      rank.className = "col-rank";
      rank.textContent = String(i + 1).padStart(2, "0");

      const name = document.createElement("span");
      name.className = "word";
      name.textContent = g.word;
      if (g.reason) name.title = g.reason;

      const bar = document.createElement("div");
      bar.className = "bar";
      const fill = document.createElement("div");
      fill.className = "bar-fill";
      fill.style.width = g.score + "%";
      fill.style.background = scoreColor(g.score);
      bar.appendChild(fill);

      const score = document.createElement("span");
      score.className = "score";
      score.textContent = g.score.toFixed(2);
      score.style.color = scoreColor(g.score);

      li.appendChild(rank);
      li.appendChild(name);
      li.appendChild(bar);
      li.appendChild(score);
      resultList.appendChild(li);
    });
  }

  // ---------- 操作 ----------
  async function submitGuess() {
    if (state.finished || state.busy) return;
    const word = input.value.trim();
    if (!word) return;

    const existing = state.guesses.find((g) => g.word === word);
    if (existing) {
      showMessage(`关键词「${word}」已存在于当前样本集`, "warn");
      input.value = "";
      render(word);
      return;
    }

    setBusy(true);
    showMessage("正在计算语义匹配度…", "hint");
    try {
      let result = state.cache[word];
      if (!result) {
        result = await scoreFromServer(state.answer, word);
        state.cache[word] = result;
      }
      setConn(true);

      state.guesses.push({ word, score: result.score, reason: result.reason });
      input.value = "";
      showMessage("");

      if (result.score >= 100) {
        state.finished = true;
        render(word);
        done();
      } else {
        render(word);
      }
    } catch (e) {
      setConn(false);
      showMessage("计算失败：" + e.message + "（请确认分析服务已启动）", "warn");
    } finally {
      setBusy(false);
      input.focus();
    }
  }

  function done() {
    winText.textContent = `目标向量已被「${state.answer}」完全匹配，共处理 ${state.guesses.length} 个样本。`;
    winBanner.classList.remove("hidden");
  }

  function giveUp() {
    if (state.finished) return;
    state.finished = true;
    showMessage(`任务已终止。目标向量为「${state.answer}」。`, "warn");
  }

  function hint() {
    if (state.finished) return;
    const a = state.answer;
    showMessage(`参数：目标向量长度 ${a.length}，首字符「${a[0]}」`, "hint");
  }

  // ---------- 场外求助 ----------
  const helpModal = $("helpModal");
  const helpAskRow = $("helpAskRow");
  const helpInput = $("helpInput");
  const helpList = $("helpList");
  const helpEmpty = $("helpEmpty");
  const HELP_LABEL = { length: "是几个字？", related: "跟什么相关？" };
  const HELP_EMPTY_TEXT = helpEmpty.textContent;
  let helpBusy = false;

  function openHelp() {
    helpModal.classList.remove("hidden");
  }

  function closeHelp() {
    helpModal.classList.add("hidden");
    input.focus();
  }

  function resetHelp() {
    helpList.innerHTML = "";
    helpEmpty.textContent = HELP_EMPTY_TEXT;
    helpEmpty.style.display = "block";
    helpInput.value = "";
    helpAskRow.classList.add("hidden");
  }

  async function askHelp(type, question) {
    if (helpBusy) return;
    if (state.finished) {
      helpEmpty.style.display = "block";
      helpEmpty.textContent = "本局已结束，新建任务后再求助吧。";
      return;
    }
    helpBusy = true;
    helpEmpty.style.display = "none";

    const li = document.createElement("li");
    li.className = "help-item";
    const q = document.createElement("div");
    q.className = "help-q";
    q.textContent = "问：" + (question || HELP_LABEL[type]);
    const a = document.createElement("div");
    a.className = "help-a pending";
    a.textContent = "答：思考中…";
    li.appendChild(q);
    li.appendChild(a);
    helpList.prepend(li);

    try {
      const res = await fetch("/api/help", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: state.answer, type, question }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "服务异常");
      a.className = "help-a";
      a.textContent = "答：" + data.answer;
    } catch (e) {
      a.className = "help-a error";
      a.textContent = "答：求助失败（" + e.message + "）";
    } finally {
      helpBusy = false;
    }
  }

  document.querySelectorAll("[data-help]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const type = btn.dataset.help;
      if (type === "ask") {
        helpAskRow.classList.remove("hidden");
        helpInput.focus();
      } else {
        askHelp(type);
      }
    });
  });

  function sendQuestion() {
    const text = helpInput.value.trim();
    if (!text || helpBusy) return;
    helpInput.value = "";
    askHelp("ask", text);
  }

  $("helpBtn").addEventListener("click", openHelp);
  $("helpClose").addEventListener("click", closeHelp);
  $("helpSend").addEventListener("click", sendQuestion);
  helpInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) sendQuestion();
  });
  helpModal.addEventListener("click", (e) => {
    if (e.target === helpModal) closeHelp();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !helpModal.classList.contains("hidden")) closeHelp();
  });

  function newGame() {
    state.answer = pickAnswer();
    state.guesses = [];
    state.finished = false;
    state.cache = {};
    resetHelp();
    input.value = "";
    taskId.textContent = genTaskId();
    showMessage("已新建分析任务，请输入候选关键词。", "hint");
    winBanner.classList.add("hidden");
    render(null);
    input.focus();
    console.log("[debug] 目标向量：", state.answer);
  }

  // ---------- 事件 ----------
  guessBtn.addEventListener("click", submitGuess);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitGuess();
  });
  $("hintBtn").addEventListener("click", hint);
  $("giveupBtn").addEventListener("click", giveUp);
  $("newGameBtn").addEventListener("click", newGame);
  $("winNewGame").addEventListener("click", newGame);

  newGame();
})();
