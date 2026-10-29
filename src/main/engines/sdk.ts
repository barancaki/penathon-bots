// Load unpacked SDKs so their own native binary and helper PATH resolution stays intact.
export function sdkUrl(specifier: string): string {
  return import.meta.resolve(specifier).replace(/([/\\])app\.asar([/\\])/, '$1app.asar.unpacked$2');
}
