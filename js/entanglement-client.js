/**
 * entanglement-client.js — WebSocket client for A-B entanglement.
 *
 * Connects to the relay server and:
 *   - Sends local collapse events to partner display
 *   - Receives partner collapse events and applies them locally
 *
 * Usage:
 *   const client = new EntanglementClient('A', tileSystem);
 *   client.connect();
 */

export class EntanglementClient {
  /**
   * @param {string} role  'A' or 'B'
   * @param {object} tileSystem  QuantumTileSystem instance
   * @param {object} [opts]
   * @param {string} [opts.url]  WebSocket URL (auto-detected if omitted)
   * @param {function} [opts.onStatusChange]  (connected: boolean) => void
   */
  constructor(role, tileSystem, opts = {}) {
    this.role = role.toUpperCase();
    this.tileSystem = tileSystem;
    this.ws = null;
    this.connected = false;
    this.partnerConnected = false;
    this.onStatusChange = opts.onStatusChange || (() => {});

    // Auto-detect WebSocket URL from current page location
    const loc = window.location;
    const protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    this.url = opts.url || `${protocol}//${loc.host}/ws?role=${this.role}`;

    // Batch collapse events to reduce message frequency
    this._pendingCollapses = [];
    this._batchInterval = null;
  }

  /**
   * Connect to the relay server.
   */
  connect() {
    if (this.ws) {
      this.ws.close();
    }

    console.log(`[entanglement] Connecting as ${this.role} → ${this.url}`);
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.log(`[entanglement] Connected as ${this.role}`);
      this.connected = true;
      this.onStatusChange(true);

      // Start batch sending interval (every 100ms)
      this._batchInterval = setInterval(() => this._flushBatch(), 100);
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this._handleMessage(msg);
      } catch (e) {
        console.error('[entanglement] Parse error:', e);
      }
    };

    this.ws.onclose = () => {
      console.log('[entanglement] Disconnected');
      this.connected = false;
      this.partnerConnected = false;
      this.onStatusChange(false);
      clearInterval(this._batchInterval);

      // Reconnect after delay
      setTimeout(() => this.connect(), 2000);
    };

    this.ws.onerror = (err) => {
      console.error('[entanglement] WebSocket error:', err);
    };
  }

  /**
   * Handle incoming message from server.
   */
  _handleMessage(msg) {
    switch (msg.type) {
      case 'assigned':
        console.log(`[entanglement] Role confirmed: ${msg.role}, partner: ${msg.partnerConnected ? 'yes' : 'no'}`);
        this.partnerConnected = msg.partnerConnected;
        this.onStatusChange(true);  // update status dot
        break;

      case 'partner_connected':
        console.log('[entanglement] Partner connected');
        this.partnerConnected = true;
        this.onStatusChange(true);
        break;

      case 'partner_disconnected':
        console.log('[entanglement] Partner disconnected');
        this.partnerConnected = false;
        this.onStatusChange(true);
        break;

      case 'collapse':
        // Single collapse from partner
        this._applyPartnerCollapse(msg.tileIdx);
        break;

      case 'collapse_batch':
        // Batch of collapses from partner
        if (Array.isArray(msg.events)) {
          for (const ev of msg.events) {
            this._applyPartnerCollapse(ev.tileIdx);
          }
        }
        break;
    }
  }

  /**
   * Apply partner's collapse to local tile system.
   * Bell state model: partner's measurement collapses our tile too,
   * but our OUTCOME depends on our local pattern (basis).
   *
   * We only need to mark the tile as collapsed — the cellOutcome
   * snapshot in animate() will fill in +/− from our own pattern.
   */
  _applyPartnerCollapse(tileIdx) {
    if (tileIdx < 0 || tileIdx >= this.tileSystem.numTiles) return;

    // Only collapse if tile is still in superposition
    if (this.tileSystem.collapsed[tileIdx] !== 0) return;

    // Mark as collapsed (outcome 1 = arbitrary, cellOutcome will override visually)
    this.tileSystem.collapsed[tileIdx] = 1;
    this.tileSystem.collapseTime[tileIdx] = this.tileSystem.time;
    this.tileSystem.fadeProgress[tileIdx] = 0.0;
  }

  /**
   * Queue a local collapse event for sending to partner.
   * Only sends tile index — partner determines its own outcome from local pattern.
   */
  sendCollapse(tileIdx) {
    if (!this.connected) return;
    this._pendingCollapses.push({ tileIdx });
  }

  /**
   * Flush batched collapse events.
   */
  _flushBatch() {
    if (this._pendingCollapses.length === 0) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const count = this._pendingCollapses.length;
    console.log(`[entanglement] → sending ${count} collapse(s)`);

    if (count === 1) {
      const ev = this._pendingCollapses[0];
      this.ws.send(JSON.stringify({
        type: 'collapse',
        tileIdx: ev.tileIdx,
        outcome: ev.outcome,
      }));
    } else {
      this.ws.send(JSON.stringify({
        type: 'collapse_batch',
        events: this._pendingCollapses,
      }));
    }

    this._pendingCollapses = [];
  }

  /**
   * Disconnect gracefully.
   */
  disconnect() {
    clearInterval(this._batchInterval);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
