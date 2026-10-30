export interface RolloutDescriptor {
  id: string;
  path: string;
  sourceRelativePath: string;
  archived: boolean;
  size: number;
  mtimeMs: number;
}
