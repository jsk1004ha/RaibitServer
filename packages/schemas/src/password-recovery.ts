import { z } from 'zod';

export const PasswordRecoveryRequestSchema = z.object({ email: z.email() }).strict();
export const PasswordRecoveryCompleteSchema = z.object({
  email: z.email(),
  code: z.string().regex(/^\d{6}$/),
  newPassword: z.string().min(8).max(1024),
}).strict();
export const PasswordRecoveryAcceptedSchema = z.object({ accepted: z.literal(true) }).strict();
export const PasswordRecoveryCompletedSchema = z.object({ reset: z.literal(true) }).strict();

export type PasswordRecoveryRequest = z.input<typeof PasswordRecoveryRequestSchema>;
export type PasswordRecoveryComplete = z.input<typeof PasswordRecoveryCompleteSchema>;
export type PasswordRecoveryAccepted = z.output<typeof PasswordRecoveryAcceptedSchema>;
export type PasswordRecoveryCompleted = z.output<typeof PasswordRecoveryCompletedSchema>;
