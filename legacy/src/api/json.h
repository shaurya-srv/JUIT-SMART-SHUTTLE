#ifndef API_JSON_H
#define API_JSON_H

#include <stddef.h>

// Minimal JSON support for the shuttle API: flat objects only
// (no nested objects/arrays). Enough for the scaffold endpoints;
// Phase 4 can swap in a real parser without touching handlers.

// Parse a JSON string value from `body` under key `key`.
// Copies up to bufsize-1 bytes into `out`, NUL-terminates.
// Returns 1 on success, 0 if the key is missing or not a string.
int json_get_string(const char *body, const char *key, char *out, size_t bufsize);

// Parse an integer value under `key`. Returns 1 on success, 0 otherwise.
int json_get_int(const char *body, const char *key, long *out);

// Escape `src` for embedding inside a JSON string literal
// (handles quote, backslash, control chars). Appends to `out` (capacity
// including NUL) and returns 0 on truncation, 1 otherwise.
int json_escape_to(const char *src, char *out, size_t outsz);

#endif // API_JSON_H
