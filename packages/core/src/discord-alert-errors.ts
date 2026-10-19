export type DiscordPolicyErrorCode =
  | 'DISCORD_CURSOR_INVALID'
  | 'DISCORD_DESTINATION_NOT_FOUND'
  | 'DISCORD_FORBIDDEN'
  | 'DISCORD_INPUT_INVALID'
  | 'DISCORD_MENTION_FORBIDDEN'
  | 'DISCORD_PAYLOAD_INVALID'
  | 'DISCORD_PERSISTENCE_UNAVAILABLE'
  | 'DISCORD_STALE_VERSION'
  | 'DISCORD_WEBHOOK_INVALID';

export class DiscordPolicyError extends Error {
  readonly name = 'DiscordPolicyError';
  readonly code: DiscordPolicyErrorCode;
  readonly statusCode: number;

  constructor(code: DiscordPolicyErrorCode, statusCode: number) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
  }
}
