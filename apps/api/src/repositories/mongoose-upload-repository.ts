import { Types } from "mongoose";
import type { UploadedPart } from "@siv/shared";
import { UploadSession } from "../models/upload-session.js";
import type { UploadSessionRecord, UploadSessionRepository } from "../services/upload-service.js";

export class MongooseUploadSessionRepository implements UploadSessionRepository {
  async create(record: Omit<UploadSessionRecord, "id" | "parts">): Promise<UploadSessionRecord> {
    const { ownerId, videoId, ...sessionRecord } = record;
    const session = await UploadSession.create({
      ...sessionRecord,
      owner: ownerId,
      video: videoId,
      parts: [],
      status: "uploading"
    });
    return toRecord(session);
  }

  async findOwned(id: string, ownerId: string): Promise<UploadSessionRecord | null> {
    if (!Types.ObjectId.isValid(id) || !Types.ObjectId.isValid(ownerId)) return null;
    const session = await UploadSession.findOne({ _id: id, owner: ownerId })
      .select("+storageKey +storageUploadId")
      .exec();
    return session ? toRecord(session) : null;
  }

  async setParts(id: string, parts: UploadedPart[]): Promise<void> {
    await UploadSession.updateOne(
      { _id: id, status: "uploading" },
      { $set: { parts } }
    ).exec();
  }

  async setStatus(id: string, status: UploadSessionRecord["status"]): Promise<void> {
    await UploadSession.updateOne({ _id: id }, { $set: { status } }).exec();
  }

  async delete(id: string): Promise<void> {
    await UploadSession.deleteOne({ _id: id }).exec();
  }

  async findExpired(now: Date, limit: number): Promise<UploadSessionRecord[]> {
    const sessions = await UploadSession.find({
      expiresAt: { $lte: now },
      status: { $in: ["uploading", "completing", "failed"] }
    })
      .select("+storageKey +storageUploadId")
      .limit(limit)
      .exec();
    return sessions.map(toRecord);
  }
}

function toRecord(session: InstanceType<typeof UploadSession>): UploadSessionRecord {
  return {
    id: session.id,
    ownerId: session.owner.toString(),
    videoId: session.video.toString(),
    storageKey: session.storageKey,
    storageUploadId: session.storageUploadId,
    title: session.title,
    fileName: session.fileName,
    contentType: session.contentType as UploadSessionRecord["contentType"],
    fileSizeBytes: session.fileSizeBytes,
    partSizeBytes: session.partSizeBytes,
    expectedParts: session.expectedParts,
    transferMode: session.transferMode,
    status: session.status,
    parts: session.parts.map((part) => ({
      partNumber: part.partNumber,
      sizeBytes: part.sizeBytes,
      etag: part.etag,
      checksumSha256: part.checksumSha256
    })),
    expiresAt: session.expiresAt
  };
}
