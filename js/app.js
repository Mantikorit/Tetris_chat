/* ============================================================
   app.js — Vue-приложение: голосование чата, таймеры, канвас
   ============================================================ */

const ACTIONS = ['left', 'right', 'rotate', 'down', 'drop'];

const ACTION_META = {
  left:   { label: 'Влево',   icon: '◀' },
  right:  { label: 'Вправо',  icon: '▶' },
  rotate: { label: 'Поворот', icon: '⟳' },
  down:   { label: 'Вниз',    icon: '▼' },
  drop:   { label: 'Сброс',   icon: '⤓' },
};

const DEFAULT_SETTINGS = {
  wsUrl: 'ws://127.0.0.1:8080/',
  baseVoteTime: 10,   // сек на голосование на 1 уровне
  minVoteTime: 5,     // минимум (задержка трансляции)
  voteTimeStep: 1,    // на сколько секунд короче голосование с каждым уровнем
  linesPerLevel: 10,  // сколько линий собрать для следующего уровня
  restartDelay: 30,   // сек до рестарта после game over
  aliases: {
    left:   'влево, left, l, л, a, а, !left, !влево',
    right:  'вправо, right, r, п, d, д, !right, !вправо',
    rotate: 'поворот, rotate, up, w, в, !rotate, !поворот',
    down:   'вниз, down, s, с, !down, !вниз',
    drop:   'сброс, drop, space, !drop, !сброс',
  },
  rewards: { left: '', right: '', rotate: '', down: '', drop: '' },
  rewardWeight: 3,    // голос через награду весит больше
  testMode: false,    // управление стрелками с клавиатуры
};

const CELL = 28;

const app = Vue.createApp({
  data() {
    return {
      phase: 'idle', // idle | voting | gameover
      wsStatus: 'disconnected',
      settings: this.loadSettings(),
      showSettings: false,

      // зеркало состояния игры для реактивности
      score: 0, level: 1, lines: 0,

      votes: {},          // userId -> { action, weight, userName }
      timeLeft: 0,        // сек до конца голосования
      restartLeft: 0,     // сек до рестарта
      lastAction: null,   // последний применённый ход
      lastVoters: 0,
      feed: [],           // последние голоса для ленты
      history: [],        // ходы, применённые к фигуре
      paused: false,
    };
  },

  computed: {
    tally() {
      // строим из ACTIONS, чтобы новые действия не выпадали из подсчёта
      const t = {};
      for (const a of ACTIONS) t[a] = 0;
      for (const v of Object.values(this.votes)) {
        if (t[v.action] !== undefined) t[v.action] += v.weight;
      }
      return t;
    },
    totalVotes() {
      return Object.values(this.tally).reduce((a, b) => a + b, 0);
    },
    voteDuration() {
      const s = this.settings;
      return Math.max(s.minVoteTime, s.baseVoteTime - (this.level - 1) * s.voteTimeStep);
    },
    connected() { return this.wsStatus === 'connected'; },
    canPlay() { return this.connected || this.settings.testMode; },
    anyRewards() {
      return ACTIONS.some(a => (this.settings.rewards[a] || '').trim());
    },
    aliasMap() {
      const map = {};
      for (const a of ACTIONS) {
        for (const raw of (this.settings.aliases[a] || '').split(',')) {
          const key = raw.trim().toLowerCase();
          // при дублях побеждает более раннее действие в списке
          if (key && !(key in map)) map[key] = a;
        }
      }
      return map;
    },
    actionMeta() { return ACTION_META; },
    actionList() { return ACTIONS; },
  },

  mounted() {
    this.game = new Tetris(10, 20);
    this.game.linesPerLevel = Math.max(1, this.settings.linesPerLevel);
    this.canvas = this.$refs.board;
    this.ctx = this.canvas.getContext('2d');
    this.nextCanvas = this.$refs.nextPiece;
    this.nextCtx = this.nextCanvas.getContext('2d');

    this.client = new StreamerbotClient({
      onChat: (m) => this.handleChat(m),
      onReward: (m) => this.handleReward(m),
      onStatus: (s) => this.handleStatus(s),
    });
    this.client.connect(this.settings.wsUrl);

    this._lastTick = performance.now();
    this._loop = setInterval(() => this.tick(), 100);

    window.addEventListener('keydown', (e) => this.handleKey(e));
    this.draw();
  },

  methods: {
    /* ---------- настройки ---------- */
    loadSettings() {
      try {
        const saved = JSON.parse(localStorage.getItem('chatTetrisSettings'));
        return {
          ...DEFAULT_SETTINGS,
          ...saved,
          aliases: { ...DEFAULT_SETTINGS.aliases, ...(saved?.aliases || {}) },
          rewards: { ...DEFAULT_SETTINGS.rewards, ...(saved?.rewards || {}) },
        };
      } catch { return { ...DEFAULT_SETTINGS }; }
    },
    saveSettings() {
      localStorage.setItem('chatTetrisSettings', JSON.stringify(this.settings));
      this.game.linesPerLevel = Math.max(1, this.settings.linesPerLevel);
      this.syncStats();
      this.showSettings = false;
      this.client.disconnect();
      this.client.connect(this.settings.wsUrl);
    },

    /* ---------- жизненный цикл игры ---------- */
    startGame() {
      if (!this.canPlay) return;
      this.game.reset();
      this.syncStats();
      this.lastAction = null;
      this.feed = [];
      this.history = [];
      this.paused = false;
      this.startRound();
      this.draw();
    },
    togglePause() {
      this.paused = !this.paused;
    },
    resetGame() {
      // полный сброс: возврат в режим ожидания с чистым полем
      this.phase = 'idle';
      this.paused = false;
      this.votes = {};
      this.game.reset();
      this.syncStats();
      this.draw();
    },
    startRound() {
      this.votes = {};
      this.timeLeft = this.voteDuration;
      this.phase = 'voting';
    },

    tick() {
      const now = performance.now();
      const dt = (now - this._lastTick) / 1000;
      this._lastTick = now;

      if (this.paused) return;

      if (this.phase === 'voting') {
        // Нет подключения (и не тест-режим) — голосование на паузе
        if (!this.canPlay) return;
        this.timeLeft -= dt;
        if (this.timeLeft <= 0) this.resolveVote();
      }

      if (this.phase === 'gameover') {
        this.restartLeft -= dt;
        if (this.restartLeft <= 0) {
          if (this.canPlay) this.startGame();
          else this.phase = 'idle';
        }
      }
    },

    resolveVote() {
      const tally = this.tally;
      const max = Math.max(...Object.values(tally));
      let action = null;

      if (max > 0) {
        const leaders = ACTIONS.filter(a => tally[a] === max);
        // при ничьей — случайный из лидеров
        action = leaders[Math.floor(Math.random() * leaders.length)];
      }

      this.lastAction = action;
      this.lastVoters = this.totalVotes;

      if (action) {
        this.history.unshift({ action, count: tally[action], id: Math.random() });
        if (this.history.length > 12) this.history.pop();
      }

      let result = { locked: false, cleared: 0 };
      if (action === 'left') this.game.move(-1);
      if (action === 'right') this.game.move(1);
      if (action === 'rotate') this.game.rotate();

      if (action === 'drop') {
        result = this.game.hardDrop();
      } else if (action === 'down') {
        // «вниз» = дополнительная клетка сверх обычной гравитации (итого 2)
        result = this.game.step();
        if (!result.locked) result = this.game.step();
      } else {
        // после хода фигура опускается на одну клетку
        result = this.game.step();
      }

      this.syncStats();
      this.draw();

      if (this.game.gameOver) {
        this.phase = 'gameover';
        this.restartLeft = this.settings.restartDelay;
      } else {
        this.startRound();
      }
    },

    syncStats() {
      this.score = this.game.score;
      this.level = this.game.level;
      this.lines = this.game.lines;
    },

    /* ---------- входящие события ---------- */
    handleStatus(s) { this.wsStatus = s; },

    handleChat({ userId, userName, text }) {
      if (this.phase !== 'voting') return;
      const action = this.aliasMap[text.toLowerCase().split(/\s+/)[0]];
      if (!action) return;
      this.castVote(userId, userName, action, 1);
    },

    handleReward({ userId, userName, rewardTitle }) {
      if (this.phase !== 'voting') return;
      const title = rewardTitle.toLowerCase();
      for (const a of ACTIONS) {
        const cfg = this.settings.rewards[a].trim().toLowerCase();
        if (cfg && cfg === title) {
          this.castVote(userId, userName, a, this.settings.rewardWeight);
          return;
        }
      }
    },

    castVote(userId, userName, action, weight) {
      // один голос на зрителя, последний вариант заменяет предыдущий
      this.votes = { ...this.votes, [userId]: { action, weight, userName } };
      this.feed.unshift({ userName, action, id: Math.random() });
      if (this.feed.length > 6) this.feed.pop();
    },

    /* ---------- тест с клавиатуры ---------- */
    handleKey(e) {
      if (!this.settings.testMode || this.showSettings) return;
      const map = {
        ArrowLeft: 'left', ArrowRight: 'right',
        ArrowUp: 'rotate', ArrowDown: 'down', ' ': 'drop',
      };
      const action = map[e.key];
      if (!action || this.phase !== 'voting') return;
      e.preventDefault();
      this.castVote('keyboard-test', 'ТЕСТ', action, 1);
    },

    /* ---------- отрисовка ---------- */
    draw() {
      const g = this.game, ctx = this.ctx;
      const W = g.cols * CELL, H = g.rows * CELL;
      ctx.clearRect(0, 0, W, H);

      // сетка
      ctx.strokeStyle = 'rgba(122, 138, 190, 0.10)';
      ctx.lineWidth = 1;
      for (let x = 0; x <= g.cols; x++) {
        ctx.beginPath(); ctx.moveTo(x * CELL + .5, 0); ctx.lineTo(x * CELL + .5, H); ctx.stroke();
      }
      for (let y = 0; y <= g.rows; y++) {
        ctx.beginPath(); ctx.moveTo(0, y * CELL + .5); ctx.lineTo(W, y * CELL + .5); ctx.stroke();
      }

      // уложенные блоки
      for (let y = 0; y < g.rows; y++) {
        for (let x = 0; x < g.cols; x++) {
          if (g.board[y][x]) this.drawCell(ctx, x, y, TETROMINOES[g.board[y][x]].color, CELL);
        }
      }

      if (!g.gameOver && g.piece) {
        // призрак — куда упадёт фигура
        const gy = g.ghostY();
        this.eachCell(g.piece, (x, y, sy) => {
          this.drawGhost(ctx, x, gy + sy, TETROMINOES[g.piece.type].color);
        });
        // текущая фигура
        this.eachCell(g.piece, (x, y) => {
          this.drawCell(ctx, x, y, TETROMINOES[g.piece.type].color, CELL, true);
        });
      }

      this.drawNext();
    },

    eachCell(piece, fn) {
      for (let sy = 0; sy < piece.shape.length; sy++) {
        for (let sx = 0; sx < piece.shape[sy].length; sx++) {
          if (piece.shape[sy][sx]) fn(piece.x + sx, piece.y + sy, sy);
        }
      }
    },

    drawCell(ctx, x, y, color, size, glow = false) {
      const px = x * size, py = y * size;
      ctx.save();
      if (glow) { ctx.shadowColor = color; ctx.shadowBlur = 10; }
      ctx.fillStyle = color;
      ctx.fillRect(px + 1, py + 1, size - 2, size - 2);
      // блик сверху и тень снизу — "пиксельный" объём
      ctx.fillStyle = 'rgba(255,255,255,0.28)';
      ctx.fillRect(px + 1, py + 1, size - 2, 4);
      ctx.fillStyle = 'rgba(0,0,0,0.30)';
      ctx.fillRect(px + 1, py + size - 5, size - 2, 4);
      ctx.restore();
    },

    drawGhost(ctx, x, y, color) {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 2;
      ctx.strokeRect(x * CELL + 3, y * CELL + 3, CELL - 6, CELL - 6);
      ctx.restore();
    },

    drawNext() {
      const ctx = this.nextCtx;
      ctx.clearRect(0, 0, 112, 112);
      const t = TETROMINOES[this.game.next];
      const shape = t.shape;
      const size = 24;
      // реальные границы фигуры для центрирования
      let minX = 9, maxX = -1, minY = 9, maxY = -1;
      shape.forEach((row, y) => row.forEach((c, x) => {
        if (c) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
      }));
      const w = (maxX - minX + 1) * size, h = (maxY - minY + 1) * size;
      const ox = (112 - w) / 2 - minX * size, oy = (112 - h) / 2 - minY * size;
      shape.forEach((row, y) => row.forEach((c, x) => {
        if (!c) return;
        const px = ox + x * size, py = oy + y * size;
        ctx.fillStyle = t.color;
        ctx.fillRect(px + 1, py + 1, size - 2, size - 2);
        ctx.fillStyle = 'rgba(255,255,255,0.28)';
        ctx.fillRect(px + 1, py + 1, size - 2, 3);
        ctx.fillStyle = 'rgba(0,0,0,0.30)';
        ctx.fillRect(px + 1, py + size - 4, size - 2, 3);
      }));
    },

    /* ---------- утилиты шаблона ---------- */
    barWidth(action) {
      if (this.totalVotes === 0) return 0;
      return Math.round((this.tally[action] / this.totalVotes) * 100);
    },
    firstAlias(action) {
      return this.settings.aliases[action].split(',')[0].trim();
    },
    shortAliases(action) {
      return this.settings.aliases[action]
        .split(',').map(s => s.trim()).filter(Boolean).slice(0, 3);
    },
    fmtTime(t) { return Math.max(0, t).toFixed(1); },
  },
});

app.mount('#app');
