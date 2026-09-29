import { isMap, isScalar, isSeq, parseDocument, stringify } from "yaml";
import type { Pair } from "yaml";

/** One field of one record, as the renewal writes it: a new value, or none at all. */
export interface FieldEdit {
  readonly field: string;
  /** The value to write, or null to drop the field (with its whole line). */
  readonly value: string | null;
}

/** A YAML node's source range, when the parser recorded one. */
type Ranged = { range?: [number, number, number] } | null | undefined;

function rangeOf(node: unknown): [number, number, number] | null {
  const range = (node as Ranged)?.range;
  return range ?? null;
}

/**
 * The renewal's write: one record's fields edited where they are written, and
 * the rest of the document byte for byte as it was found. Never a
 * reserialization — a registry is a file people read, review, and carry
 * comments in, and a renewal that reflowed it would land a diff nobody asked
 * for. Never an append either: the record the renewal names is the record that
 * changes, so the pool it belongs to keeps its size and the hygiene check that
 * accuses an append-shaped renewal (`RENEWAL_BY_APPEND`) has nothing to say.
 *
 * Every edit is resolved against one parse of the original text and applied back
 * to front, so two edits in the same record (`type` and `expires`, the permanent
 * renewal's pair) cannot invalidate each other's offsets. An edit to a field the
 * record does not declare, or to a document the parser gives no offsets for, is
 * refused whole (null) — a half-applied renewal is worse than no renewal.
 */
export function editFields(
  raw: string,
  entryIndex: number,
  edits: readonly FieldEdit[],
): string | null {
  const doc = parseDocument(raw);
  const contents = doc.contents;
  if (!isSeq(contents)) return null;
  const item = contents.items[entryIndex - 1];
  if (!isMap(item)) return null;

  // Resolved back to front: the offsets stay valid as the later ones are cut.
  const cuts: Cut[] = [];
  for (const edit of edits) {
    const pair = item.items.find((candidate) => scalarKeyOf(candidate) === edit.field);
    if (pair === undefined) return null;
    const cut = edit.value === null ? removeField(raw, pair) : replaceValue(pair, edit.value);
    if (cut === null) return null;
    cuts.push(cut);
  }
  cuts.sort((a, b) => b.from - a.from);
  return cuts.reduce((text, cut) => text.slice(0, cut.from) + cut.text + text.slice(cut.to), raw);
}

/** One replacement: the bytes it spans, and what goes in their place. */
interface Cut {
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

/** A plain string key, or null for the shapes the registry format cannot carry. */
function scalarKeyOf(pair: Pair): string | null {
  const key = pair.key;
  return isScalar(key) && typeof key.value === "string" ? key.value : null;
}

/** A field's new value, replacing exactly the bytes the old value occupied. */
function replaceValue(pair: Pair, value: string): Cut | null {
  const range = rangeOf(pair.value);
  if (range === null) return null;
  return { from: range[0], to: range[1], text: encodeScalar(value) };
}

/**
 * The value as YAML spells it, spelled by the same writer the append path uses
 * (`yaml.stringify`): an in-place edit and an appended record must be the same
 * bytes for the same value, or a record would change shape depending on which
 * door wrote it. Quoting and line-folding are therefore that writer's decisions,
 * not a second guess at them here.
 */
function encodeScalar(value: string): string {
  const [line] = stringify(value, { lineWidth: 0 }).split("\n");
  return line ?? "";
}

/**
 * A dropped field takes its whole line with it, from the indentation in front of
 * its key to the end of the line — so a removal cannot leave a half-indented
 * remnant for the next field. A comment trailing the value is the author's, and
 * it stays: the cut stops before it and it keeps its line.
 */
function removeField(raw: string, pair: Pair): Cut | null {
  const keyRange = rangeOf(pair.key) ?? rangeOf(pair.value);
  const valueRange = rangeOf(pair.value);
  if (keyRange === null || valueRange === null) return null;
  const from = lineStart(raw, keyRange[0]);
  const end = lineEnd(raw, valueRange[1]);
  const tail = raw.slice(valueRange[1], end);
  // Nothing but whitespace left on the line: take the newline too, so the
  // removal does not leave a blank line where the field was.
  return tail.trim() === ""
    ? { from, to: end + newlineLength(raw, end), text: "" }
    : { from, to: end, text: "" };
}

/**
 * The two line-boundary offsets, shared by every module that has to name or cut
 * a span of the registry document. The read side (a delete-ready pointer naming
 * a record's lines) and the write side (a renewal cutting a field's line) must
 * agree on where a line begins and ends, or a pointer and the edit it invites
 * would describe different ranges.
 */

/** The offset where the line containing `offset` begins. */
export function lineStart(raw: string, offset: number): number {
  const before = raw.lastIndexOf("\n", offset - 1);
  return before === -1 ? 0 : before + 1;
}

/** The offset of the line terminator at or after `offset`, or the end of the text. */
export function lineEnd(raw: string, offset: number): number {
  const at = raw.indexOf("\n", offset);
  return at === -1 ? raw.length : at;
}

/** The offset just past the line containing `offset` — its whole text, terminator included. */
export function lineAfter(raw: string, offset: number): number {
  const at = raw.indexOf("\n", offset);
  return at === -1 ? raw.length : at + 1;
}

/** 1 for a bare newline, 2 for a CRLF — the whole terminator, or the removal leaves half of one. */
function newlineLength(raw: string, end: number): number {
  return end > 0 && raw[end - 1] === "\r" ? 2 : 1;
}

