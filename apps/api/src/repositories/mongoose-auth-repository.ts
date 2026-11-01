import { AuthSession } from "../models/auth-session.js";
import { User } from "../models/user.js";
import type { AuthRepository, StoredUser } from "../services/auth-service.js";
import type { PublicUser, RegisterRequest } from "@siv/shared";

export class MongooseAuthRepository implements AuthRepository {
  async findUserByEmail(email: string): Promise<StoredUser | null> {
    const user = await User.findOne({ email }).select("+passwordHash").exec();
    if (!user) return null;

    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      createdAt: user.createdAt.toISOString(),
      passwordHash: user.passwordHash
    };
  }

  async createUser(input: Pick<RegisterRequest, "email" | "displayName"> & { passwordHash: string }): Promise<StoredUser> {
    const user = await User.create(input);
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      createdAt: user.createdAt.toISOString(),
      passwordHash: input.passwordHash
    };
  }

  async createSession(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await AuthSession.create({ userId, tokenHash, expiresAt });
  }

  async findActiveSession(tokenHash: string, now: Date): Promise<PublicUser | null> {
    const session = await AuthSession.findOne({
      tokenHash,
      revokedAt: null,
      expiresAt: { $gt: now }
    }).select("+tokenHash").exec();

    if (!session) return null;
    const user = await User.findById(session.userId).exec();
    if (!user) return null;

    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      createdAt: user.createdAt.toISOString()
    };
  }

  async revokeSession(tokenHash: string, revokedAt: Date): Promise<void> {
    await AuthSession.updateOne(
      { tokenHash, revokedAt: null },
      { $set: { revokedAt } }
    ).exec();
  }
}
