/* ============================================================
   streamerbot.js — подключение к WebSocket-серверу Streamer.bot
   Подписывается на сообщения чата и награды за баллы канала.
   ============================================================ */

class StreamerbotClient {
  /**
   * @param {Object} opts
   * @param {Function} opts.onChat    ({ userId, userName, text })
   * @param {Function} opts.onReward  ({ userId, userName, rewardTitle, input })
   * @param {Function} opts.onStatus  ('connected' | 'connecting' | 'disconnected')
   */
  constructor(opts) {
    this.opts = opts;
    this.ws = null;
    this.url = null;
    this.shouldReconnect = false;
    this._reconnectTimer = null;
  }

  connect(url) {
    this.url = url;
    this.shouldReconnect = true;
    this._open();
  }

  disconnect() {
    this.shouldReconnect = false;
    clearTimeout(this._reconnectTimer);
    if (this.ws) { this.ws.close(); this.ws = null; }
    this.opts.onStatus('disconnected');
  }

  _open() {
    clearTimeout(this._reconnectTimer);
    this.opts.onStatus('connecting');
    try {
      this.ws = new WebSocket(this.url);
    } catch (e) {
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.opts.onStatus('connected');
      // Подписка на события Twitch
      this.ws.send(JSON.stringify({
        request: 'Subscribe',
        id: 'chat-tetris-subscribe',
        events: {
          Twitch: ['ChatMessage', 'RewardRedemption'],
        },
      }));
    };

    this.ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg.event) return;

      const src = msg.event.source;
      const type = msg.event.type;
      const d = msg.data || {};

      if (src === 'Twitch' && type === 'ChatMessage') {
        // Структура data.message отличается между версиями Streamer.bot —
        // парсим с запасом прочности.
        const m = d.message || {};
        const text = (typeof m === 'string' ? m : (m.message || m.text || '')).trim();
        const userId = String(
          m.userId ?? m.username ?? d.user?.id ?? d.user?.login ?? 'anon'
        );
        const userName = m.displayName || m.username || d.user?.display_name || 'viewer';
        if (text) this.opts.onChat({ userId, userName, text });
      }

      if (src === 'Twitch' && type === 'RewardRedemption') {
        const rewardTitle =
          d.reward?.title ?? d.redemption?.reward?.title ?? d.title ?? '';
        const userId = String(
          d.user_id ?? d.user?.id ?? d.userId ?? d.user_login ?? 'anon'
        );
        const userName =
          d.user_name ?? d.user?.display_name ?? d.userName ?? 'viewer';
        const input = (d.user_input ?? d.input ?? '').trim();
        if (rewardTitle) this.opts.onReward({ userId, userName, rewardTitle, input });
      }
    };

    this.ws.onclose = () => {
      this.opts.onStatus('disconnected');
      this._scheduleReconnect();
    };
    this.ws.onerror = () => { /* onclose сработает следом */ };
  }

  _scheduleReconnect() {
    if (!this.shouldReconnect) return;
    this._reconnectTimer = setTimeout(() => this._open(), 3000);
  }
}

window.StreamerbotClient = StreamerbotClient;
