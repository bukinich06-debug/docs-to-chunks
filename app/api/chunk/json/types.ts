import type { OutlineSectionImage } from "@/lib/outlineOutput";

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
  images?: OutlineSectionImage[];
}

export interface IJsonOutputChunk {
  text: string;
  images: OutlineSectionImage[];
}

export interface IJsonChunkOutputItem {
  number: string;
  label: string;
  title: string;
  parents: IJsonChunkParent[];
  sourceText: string;
  chunks: IJsonOutputChunk[];
}
