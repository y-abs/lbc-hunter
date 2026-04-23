// ─────────────────────────────────────────────
//  LbC Hunter — Offscreen Audio Player
//  Runs in offscreen document for SW audio playback.
// ─────────────────────────────────────────────

import { MSG } from "@/shared/messages.js";

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== MSG.PLAY_SOUND) return;
  const id = msg.tier === "red" ? "sound-red" : "sound-orange";
  const audio = document.getElementById(id);
  if (audio) {
    audio.currentTime = 0;
    audio.play().catch(() => {}); // user gesture requirement may block in some cases
  }
});
