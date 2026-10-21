/** A problem the user can fix. Printed without a stack trace, exit code 1. */
export class UserError extends Error {
  readonly exitCode = 1;
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = "UserError";
  }
}
