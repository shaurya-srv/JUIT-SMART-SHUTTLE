// Minimal JSON helpers: flat-object string/int extraction and string
// escaping. Handles standard \" \\ \/ \b \f \n \r \t \uXXXX escapes when
// reading; emits simple escapes when writing. \u is decoded to a '?'
// placeholder (ASCII API strings only in this scaffold).

#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include "json.h"

// Find "key":"value" or "key":123 at the top level of a flat object.
// Returns pointer to the first char of the value, or NULL.
static const char *find_value(const char *body, const char *key) {
    if (body == NULL || key == NULL) return NULL;

    size_t klen = strlen(key);
    const char *p = body;
    while ((p = strchr(p, '"')) != NULL) {
        p++; // inside opening quote
        if (strncmp(p, key, klen) == 0 && p[klen] == '"') {
            const char *v = p + klen + 1;
            while (*v == ' ' || *v == '\t') v++;
            if (*v != ':') { continue; }
            v++;
            while (*v == ' ' || *v == '\t') v++;
            return (*v == '"' || (*v >= '-' && *v <= '9') || *v == 't' || *v == 'f' ||
                    *v == 'n') ? v : NULL;
        }
        // Skip this (non-matching) key string.
        const char *e = strchr(p, '"');
        if (!e) return NULL;
        p = e + 1;
    }
    return NULL;
}

// Read a JSON string literal starting at the opening quote into out.
static int read_string(const char **cursor, char *out, size_t bufsize) {
    const char *p = *cursor; // points at opening quote
    p++;
    size_t n = 0;
    while (*p && *p != '"') {
        char c = *p;
        if (c == '\\') {
            p++;
            switch (*p) {
                case '"':  c = '"';  break;
                case '\\': c = '\\'; break;
                case '/':  c = '/';  break;
                case 'b':  c = '\b'; break;
                case 'f':  c = '\f'; break;
                case 'n':  c = '\n'; break;
                case 'r':  c = '\r'; break;
                case 't':  c = '\t'; break;
                case 'u': { c = '?'; if (p[1]) p++; if (p[1]) p++; if (p[1]) p++; if (p[1]) p++; break; }
                default: return 0;
            }
        }
        if (n + 1 >= bufsize) return 0; // too long for caller's buffer
        out[n++] = c;
        p++;
    }
    if (*p != '"') return 0;
    out[n] = '\0';
    *cursor = p + 1;
    return 1;
}

int json_get_string(const char *body, const char *key, char *out, size_t bufsize) {
    if (out == NULL || bufsize == 0) return 0;
    out[0] = '\0';
    const char *v = find_value(body, key);
    if (v == NULL || *v != '"') return 0;
    return read_string(&v, out, bufsize);
}

int json_get_int(const char *body, const char *key, long *out) {
    if (out == NULL) return 0;
    const char *v = find_value(body, key);
    if (v == NULL) return 0;
    char *end;
    long val = strtol(v, &end, 10);
    if (end == v) return 0;
    *out = val;
    return 1;
}

int json_escape_to(const char *src, char *out, size_t outsz) {
    if (src == NULL || out == NULL || outsz == 0) return 0;
    size_t n = 0;
    for (const char *p = src; *p; p++) {
        char esc[8] = {0};   // fits \uXXXX (6) + NUL with room
        const char *rep = NULL;
        switch (*p) {
            case '"':  rep = "\\\""; break;
            case '\\': rep = "\\\\"; break;
            case '\b': rep = "\\b";  break;
            case '\f': rep = "\\f";  break;
            case '\n': rep = "\\n";  break;
            case '\r': rep = "\\r";  break;
            case '\t': rep = "\\t";  break;
            default:
                if ((unsigned char)*p < 0x20) {
                    snprintf(esc, sizeof(esc), "\\u%04x", (unsigned char)*p);
                    rep = esc;
                }
        }
        size_t len = rep ? strlen(rep) : 1;
        if (n + len + 1 > outsz) { out[n] = '\0'; return 0; }
        if (rep) { memcpy(out + n, rep, len); n += len; }
        else     { out[n++] = *p; }
    }
    out[n] = '\0';
    return 1;
}
