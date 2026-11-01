import { createHash, randomBytes } from "node:crypto";
import type { PublicUser, RegisterRequest } from "@siv/shared";
import { ApiError } from "../errors/api-error.js";
import type { PasswordHasher } from "./password-hasher.js";

export interface StoredUser extends PublicUser {
  passwordHash: string;
}

export interface AuthRepository {
  findUserByEmail(email: string): Promise<StoredUser | null>;
  createUser(input: Pick<RegisterRequest, "email" | "displayName"> & { passwordHash: string }): Promise<StoredUser>;
  createSession(userId: string, tokenHash: string, expiresAt: Date): Promise<void>;
  findActiveSession(tokenHash: string, now: Date): Promise<PublicUser | null>;
  revokeSession(tokenHash: string, revokedAt: Date): Promise<void>;
}

export interface IssuedSession {
  user: PublicUser;
  token: string;
  expiresAt: Date;
}

export class AuthService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly passwords: PasswordHasher,
    private readonly sessionTtlHours: number
  ) {}

  async register(input: RegisterRequest): Promise<IssuedSession> {
    const email = input.email.trim().toLowerCase();
    const passwordHash = await this.passwords.hash(input.password);
    let user: StoredUser;

    try {
      user = await this.repository.createUser({
        email,
        displayName: input.displayName.trim(),
        passwordHash
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new ApiError(409, "EMAIL_UNAVAILABLE", "Unable to register with these details");
      }
      throw error;
    }

    return this.createSession(user);
  }

  async login(email: string, password: string): Promise<IssuedSession> {
    const user = await this.repository.findUserByEmail(email.trim().toLowerCase());
    if (!user) {
      await this.passwords.verifyUnknownUser(password);
      throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid email or password");
    }

    const valid = await this.passwords.verify(password, user.passwordHash);
    if (!valid) {
      throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid email or password");
    }

    return this.createSession(user);
  }

  getCurrentUser(token: string): Promise<PublicUser | null> {
    return this.repository.findActiveSession(hashToken(token), new Date());
  }

  revoke(token: string): Promise<void> {
    return this.repository.revokeSession(hashToken(token), new Date());
  }

  private async createSession(user: StoredUser): Promise<IssuedSession> {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + this.sessionTtlHours * 60 * 60 * 1000);
    await this.repository.createSession(user.id, hashToken(token), expiresAt);
    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        createdAt: user.createdAt
      },
      token,
      expiresAt
    };
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isDuplicateKeyError(error: unknown): error is { code: number } {
  return typeof error === "object" && error !== null && "code" in error && error.code === 11000;
}
