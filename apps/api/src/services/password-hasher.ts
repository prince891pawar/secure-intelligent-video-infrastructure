import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";

const BCRYPT_COST = 12;
const dummyHash = bcrypt.hash(randomBytes(32).toString("hex"), BCRYPT_COST);

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, passwordHash: string): Promise<boolean>;
  verifyUnknownUser(password: string): Promise<void>;
}

export const passwordHasher: PasswordHasher = {
  hash: (password) => bcrypt.hash(password, BCRYPT_COST),
  verify: (password, passwordHash) => bcrypt.compare(password, passwordHash),
  verifyUnknownUser: async (password) => {
    await bcrypt.compare(password, await dummyHash);
  }
};
