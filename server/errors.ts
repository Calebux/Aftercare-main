export class RecoveryError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}
