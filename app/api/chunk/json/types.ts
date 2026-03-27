export interface IJsonChunkParent {
  number: string;
  label: string;
  title: string;
}

export interface IJsonChunkInputItem {
  number: string;
  label: string;
  title: string;
  text: string;
  parents: IJsonChunkParent[];
}

export interface IJsonChunkOutputItem {
  number: string;
  label: string;
  title: string;
  parents: IJsonChunkParent[];
  chunks: string[];
}