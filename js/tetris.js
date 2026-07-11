/* ============================================================
   tetris.js — чистый игровой движок (без UI и без сети)
   ============================================================ */

const TETROMINOES = {
  I: { color: '#4DD9E8', shape: [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]] },
  O: { color: '#FFD34D', shape: [[1,1],[1,1]] },
  T: { color: '#B14DE8', shape: [[0,1,0],[1,1,1],[0,0,0]] },
  S: { color: '#5FE86B', shape: [[0,1,1],[1,1,0],[0,0,0]] },
  Z: { color: '#E8544D', shape: [[1,1,0],[0,1,1],[0,0,0]] },
  J: { color: '#4D7BE8', shape: [[1,0,0],[1,1,1],[0,0,0]] },
  L: { color: '#E89A4D', shape: [[0,0,1],[1,1,1],[0,0,0]] },
};

const LINE_SCORES = [0, 100, 300, 500, 800];

class Tetris {
  constructor(cols = 10, rows = 20) {
    this.cols = cols;
    this.rows = rows;
    this.linesPerLevel = 10; // сколько линий нужно собрать для следующего уровня
    this.reset();
  }

  reset() {
    this.board = Array.from({ length: this.rows }, () => Array(this.cols).fill(null));
    this.bag = [];
    this.score = 0;
    this.lines = 0;
    this.gameOver = false;
    this.next = this._takeFromBag();
    this.spawn();
  }

  get level() {
    return Math.floor(this.lines / Math.max(1, this.linesPerLevel)) + 1;
  }

  /* --- генератор "7-bag": честная раздача фигур --- */
  _takeFromBag() {
    if (this.bag.length === 0) {
      this.bag = Object.keys(TETROMINOES).sort(() => Math.random() - 0.5);
    }
    return this.bag.pop();
  }

  spawn() {
    const type = this.next;
    this.next = this._takeFromBag();
    const shape = TETROMINOES[type].shape.map(r => [...r]);
    this.piece = {
      type,
      shape,
      x: Math.floor((this.cols - shape[0].length) / 2),
      y: 0,
    };
    if (this._collides(this.piece.shape, this.piece.x, this.piece.y)) {
      this.gameOver = true;
    }
  }

  _collides(shape, px, py) {
    for (let y = 0; y < shape.length; y++) {
      for (let x = 0; x < shape[y].length; x++) {
        if (!shape[y][x]) continue;
        const bx = px + x, by = py + y;
        if (bx < 0 || bx >= this.cols || by >= this.rows) return true;
        if (by >= 0 && this.board[by][bx]) return true;
      }
    }
    return false;
  }

  /* --- действия игрока (возвращают true, если ход удался) --- */
  move(dx) {
    if (this.gameOver) return false;
    const { shape, x, y } = this.piece;
    if (!this._collides(shape, x + dx, y)) {
      this.piece.x += dx;
      return true;
    }
    return false;
  }

  rotate() {
    if (this.gameOver) return false;
    const s = this.piece.shape;
    const rotated = s[0].map((_, i) => s.map(row => row[i]).reverse());
    // простые wall kicks: пробуем сдвиги от стены
    for (const kick of [0, -1, 1, -2, 2]) {
      if (!this._collides(rotated, this.piece.x + kick, this.piece.y)) {
        this.piece.shape = rotated;
        this.piece.x += kick;
        return true;
      }
    }
    return false;
  }

  /* Один шаг гравитации. Возвращает { locked, cleared } */
  step() {
    if (this.gameOver) return { locked: false, cleared: 0 };
    const { shape, x, y } = this.piece;
    if (!this._collides(shape, x, y + 1)) {
      this.piece.y += 1;
      return { locked: false, cleared: 0 };
    }
    return this._lock();
  }

  hardDrop() {
    if (this.gameOver) return { locked: false, cleared: 0 };
    let dist = 0;
    while (!this._collides(this.piece.shape, this.piece.x, this.piece.y + 1)) {
      this.piece.y += 1;
      dist++;
    }
    this.score += dist * 2;
    return this._lock();
  }

  _lock() {
    const { shape, x, y, type } = this.piece;
    for (let sy = 0; sy < shape.length; sy++) {
      for (let sx = 0; sx < shape[sy].length; sx++) {
        if (shape[sy][sx] && y + sy >= 0) {
          this.board[y + sy][x + sx] = type;
        }
      }
    }
    const cleared = this._clearLines();
    this.spawn();
    return { locked: true, cleared };
  }

  _clearLines() {
    let cleared = 0;
    this.board = this.board.filter(row => {
      if (row.every(cell => cell)) { cleared++; return false; }
      return true;
    });
    while (this.board.length < this.rows) {
      this.board.unshift(Array(this.cols).fill(null));
    }
    if (cleared > 0) {
      this.score += LINE_SCORES[cleared] * this.level;
      this.lines += cleared;
    }
    return cleared;
  }

  /* Y-координата "призрака" — куда упадёт фигура */
  ghostY() {
    let gy = this.piece.y;
    while (!this._collides(this.piece.shape, this.piece.x, gy + 1)) gy++;
    return gy;
  }
}

window.Tetris = Tetris;
window.TETROMINOES = TETROMINOES;
