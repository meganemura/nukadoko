// Evaluated at import. `settings` is an empty object, so reading `.url`
// throws before any step can be registered. Node's own message names the
// property and not this file.
const settings = {} as { server: { url: string } };
void settings.server.url;
