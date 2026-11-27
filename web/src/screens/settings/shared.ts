// What the settings pages have in common.

/** A line of feedback under a section, and whether it reports a problem. */
export type Note = { text: string; isError: boolean };

export const UNITS = [{ value: 'kg', label: 'kg' }, { value: 'lb', label: 'lb' }] as const;

/** Text of a chosen file; exports from older apps aren't always UTF-8. */
export async function readText(file: File): Promise<string> {
  const bytes = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}
