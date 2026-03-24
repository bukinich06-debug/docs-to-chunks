export interface IJsonChunkParent {
  id: string;
  label: string;
  title: string;
}

export interface IJsonChunkInputItem {
  id: string;
  label: string;
  title: string;
  text: string;
  parents: IJsonChunkParent[];
}

export interface IJsonChunkOutputItem {
  id: string;
  label: string;
  title: string;
  parents: IJsonChunkParent[];
  chunks: string[];
}