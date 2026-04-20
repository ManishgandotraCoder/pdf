/** Shared types for PDF design extraction UI (ported from React prototype). */

export interface TextStyle {
  fontFamily: string;
  fontSize: number;
  fontSizePx?: number;
  fontWeight: string;
  fontStyle: string;
  /** Hex colour sampled from the rendered PDF canvas, e.g. "#1a3c6e". Empty string = unknown. */
  color: string;
}

export interface TextElement {
  id: string;
  type: 'text';
  x: number;
  y: number;
  w: number;
  h: number;
  content: string;
  style: TextStyle;
}

export interface ShapeElement {
  id: string;
  type: 'shape';
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string | null;
  stroke: string | null;
}

export interface ImageElement {
  id: string;
  type: 'image';
  x: number;
  y: number;
  w: number;
  h: number;
  src?: string;
  _userAdded?: boolean;
}

export interface VideoElement {
  id: string;
  type: 'video';
  x: number;
  y: number;
  w: number;
  h: number;
  src: string;
  _userAdded?: boolean;
}

export interface TableElement {
  id: string;
  type: 'table';
  x: number;
  y: number;
  w: number;
  h: number;
  rows: number;
  cols: number;
  cells: string[][];
  _userAdded?: boolean;
}

export interface UserTextElement {
  id: string;
  type: 'userText';
  x: number;
  y: number;
  w: number;
  h: number;
  html: string;
  _userAdded?: boolean;
}

export type OverlayElement = TextElement | ShapeElement | ImageElement | VideoElement;

export interface PageData {
  pageNum: number;
  width: number;
  height: number;
  fullUrl: string;
  thumbUrl: string;
  bgColor: string;
  textElements: TextElement[];
  shapes: ShapeElement[];
  images: ImageElement[];
  allElements: OverlayElement[];
  docColors: string[];
  signature: string;
  templateId: string | null;
}

export interface TemplateCluster {
  id: string;
  sig: string;
  pageNums: number[];
}

export type EditsMap = Record<number, Record<string, string>>;
export type ImageEditsMap = Record<
  number,
  Record<string, { removed?: boolean; src?: string; x?: number; y?: number; w?: number; h?: number }>
>;

/** PDF text box geometry overrides (undo-friendly; merged in overlay). */
export type LayoutEditsMap = Record<
  number,
  Record<string, { x?: number; y?: number; w?: number; h?: number }>
>;

export type ResizeHandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export type AddedImagesMap = Record<number, ImageElement[]>;
export type AddedVideosMap = Record<number, VideoElement[]>;
export type AddedTablesMap = Record<number, TableElement[]>;
export type AddedRichTextsMap = Record<number, UserTextElement[]>;

export type SelElement =
  | TextElement
  | ShapeElement
  | ImageElement
  | VideoElement
  | TableElement
  | UserTextElement;

export interface DesignTokens {
  colors: string[];
  fonts: string[];
  sizes: number[];
}

export interface HistorySnapshot {
  edits: EditsMap;
  imageEdits: ImageEditsMap;
  layoutEdits: LayoutEditsMap;
  addedImages: AddedImagesMap;
  addedVideos: AddedVideosMap;
  addedTables: AddedTablesMap;
  addedRichTexts: AddedRichTextsMap;
}

export interface ImageDragState {
  pointerId: number;
  elId: string;
  pn: number;
  userAdded?: boolean;
  mediaKind?: 'video' | 'table' | 'userText' | 'text' | 'imageUser' | 'imagePdf';
  /** When set with `handle`, user is resizing instead of moving. */
  mode?: 'move' | 'resize';
  handle?: ResizeHandleId;
  startRect?: { x: number; y: number; w: number; h: number };
  grabDx: number;
  grabDy: number;
  pw: number;
  ph: number;
  elW: number;
  elH: number;
  startPx: number;
  startPy: number;
  latestNX: number;
  latestNY: number;
  moved: boolean;
  captured: boolean;
  extracting?: boolean;
  extractDone?: boolean;
  fullUrl?: string;
  pdfImageEl?: ImageElement | null;
}

export interface CropModalState {
  sourceUrl: string;
  resolve: (dataUrl: string) => void;
}
