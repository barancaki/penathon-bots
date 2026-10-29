/** Telegram bridge state as the Settings screen sees it. The token itself never leaves main. */
export type TelegramStatus = {
  /** A token is stored (encrypted). */
  configured: boolean;
  /** Long polling is active. */
  running: boolean;
  enabled: boolean;
  botUsername?: string;
  pairedChat?: { id: number; name: string };
  /** Active one-time pairing code (6 digits), while pairing. */
  pairingCode?: string;
  /** i18n key of the last problem, e.g. `telegram.conflict`, `telegram.invalidToken`. */
  lastError?: string;
  /** Bot that receives Telegram messages; defaults to the Chief. */
  routeTo: string;
  notifyRoutines: boolean;
};
