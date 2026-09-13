#ifndef API_HANDLERS_H
#define API_HANDLERS_H

// Endpoint handlers: parse the request, call core/db, produce a JSON body.
// All handlers run serialized under the db lock (see server.c) because the
// DAL's connection is not thread-safe.

#include <stddef.h>

// Initialize handler state (session table). Call once after db_init.
void api_handlers_init(void);

// Free handler state. Call before db_close.
void api_handlers_shutdown(void);

// Dispatch one API request.
//   method      : "GET" / "POST" (already uppercased)
//   path        : "/api/health", "/api/login", ...
//   query       : everything after '?', or ""
//   auth_header : raw Authorization header value, or ""
//   body        : raw request body (JSON), or ""
//   res_body    : output buffer for the JSON response body
//   res_size    : capacity of res_body
// Returns the HTTP status code to send (200, 201, 400, 401, 403, 404, 405,
// 409, 500, 503...).
int api_handle_request(const char *method, const char *path, const char *query,
                       const char *auth_header, const char *body,
                       char *res_body, size_t res_size);

#endif // API_HANDLERS_H
