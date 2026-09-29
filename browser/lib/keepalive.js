(function() {
  let wakeLock = null;

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        console.log('Host Wake Lock active. System will not sleep.');
      }
    } catch (err) {
      console.warn('Wake lock failed (can happen if tab is hidden during call):', err);
    }
  }

  class BackgroundKeepAlive {
    constructor() {
      this.audioCtx = null;
      this.oscillator = null;
      this.gainNode = null;
      this.isActive = false;
      this.enabled = false;
    }

    enable() {
      this.enabled = true;
    }

    disable() {
      this.enabled = false;
      this.stop();
    }

    start() {
      if (!this.enabled) return;
      if (this.isActive) return;

      requestWakeLock();

      try {
        // 1. Create or resume the audio context
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        this.audioCtx = new AudioContextClass();

        // 2. Create an oscillator (generates a continuous tone)
        this.oscillator = this.audioCtx.createOscillator();
        this.oscillator.type = 'sine';
        this.oscillator.frequency.setValueAtTime(0.1, this.audioCtx.currentTime); // Standard A4 tone

        // 3. Create a gain node and set volume to absolute zero
        this.gainNode = this.audioCtx.createGain();
        this.gainNode.gain.setValueAtTime(0.0005, this.audioCtx.currentTime); // Completely silent

        // 4. Connect the nodes: Oscillator -> Silence -> Speakers
        this.oscillator.connect(this.gainNode);
        this.gainNode.connect(this.audioCtx.destination);

        // 5. Start the playback
        this.oscillator.start();
        this.isActive = true;
        console.log("Background keep-alive active (Silent audio loop running).");
      } catch (error) {
        console.error("Failed to initialize background keep-alive:", error);
      }
    }

    stop() {
      if (!this.isActive) return;

      if (this.oscillator) {
        this.oscillator.stop();
        this.oscillator.disconnect();
      }
      if (this.gainNode) {
        this.gainNode.disconnect();
      }
      if (this.audioCtx) {
        this.audioCtx.close();
      }

      this.isActive = false;
      console.log("Background keep-alive stopped.");
    }
  }

  // --- HOW TO USE IT ---
  window.keepAlive = new BackgroundKeepAlive();
})();