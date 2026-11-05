import type {
  DecodedJsonl,
  IncrementalDecodedJsonl,
  JsonlCheckpoint,
} from "../shared/jsonl-decoder.js";
import { CheckpointedJsonlDecoder } from "../shared/jsonl-decoder.js";
import type { RolloutDescriptor } from "./rollout-descriptor.js";
export type {
  DecodedRecord,
  JsonlCheckpoint as RolloutCheckpoint,
  JsonlDecodeTelemetry as RolloutDecodeTelemetry,
  JsonlProbe as RolloutProbe,
} from "../shared/jsonl-decoder.js";
export { isObject } from "../shared/jsonl-decoder.js";
export interface DecodedRollout extends DecodedJsonl {
  descriptor: RolloutDescriptor;
}
export interface IncrementalDecodedRollout extends Omit<IncrementalDecodedJsonl, "fingerprint"> {
  descriptor: RolloutDescriptor;
}
export interface RolloutDecoder {
  decode(
    descriptor: RolloutDescriptor,
    checkpoint?: JsonlCheckpoint,
  ): Promise<IncrementalDecodedRollout>;
}
export class CheckpointedRolloutDecoder implements RolloutDecoder {
  private readonly decoder = new CheckpointedJsonlDecoder();
  async decode(
    descriptor: RolloutDescriptor,
    checkpoint?: JsonlCheckpoint,
  ): Promise<IncrementalDecodedRollout> {
    return { ...(await this.decoder.decode(descriptor, checkpoint)), descriptor };
  }
}
