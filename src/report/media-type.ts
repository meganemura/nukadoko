// Responsibility: the one place a declared attachment's file extension
// becomes a media type (m3c-messages-emitter task spec, decision 2) — pulled
// up from src/report/allure/map-scenario.ts (its original home) into
// src/report/ itself because src/report/messages/map-scenario.ts now needs
// the exact same lookup for the exact same reason (a step's/hook's own
// `declared.attachments` file name is all either mapper ever has to guess a
// content type from). A third copy, rather than sharing this one, was the
// alternative this task's spec rejected.
//
// The reverse of src/compat/declared.ts's own `EXTENSION_BY_MEDIA_TYPE` —
// duplicated rather than imported so this module's own import list stays
// limited to plain data, and because the pair only needs to agree on a
// handful of common extensions, not stay byte-identical.

export const MEDIA_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".txt": "text/plain",
  ".html": "text/html",
  ".csv": "text/csv",
  ".json": "application/json",
  ".xml": "application/xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

export function contentTypeForFileName(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot === -1) {
    return "application/octet-stream";
  }
  const extension = fileName.slice(dot).toLowerCase();
  return MEDIA_TYPE_BY_EXTENSION[extension] ?? "application/octet-stream";
}
